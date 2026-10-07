import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VideoEye, extractDouyinUrl } from "./index";
import type { ResolvedVideo } from "./douyin";
import type { VideoMetadata } from "./cache";
import type { Mp4Downloader } from "./mp4";
import type { VideoObservation } from "./worker";
import { getVideoJobManager, makeRequestKey } from "./jobs";
import { buildClipPlan, cleanupInspectionClip, createInspectionClip, remapInspectionTimeline, videoTokensFromResult } from "./clip";

const videoIdSchema = z.string().regex(/^\d{10,25}$/, "无效 video_id");
const jobIdSchema = z.string().regex(/^job_[a-f0-9]{24}$/, "无效 job_id");
const cachedOnlyDownloader: Mp4Downloader = {
  async download() { throw new Error("视频缓存不存在或已损坏；inspect_video 不会重新下载"); },
};

function metadataFile(eye: VideoEye, videoId: string): string {
  return path.resolve(eye.cache.root, "metadata", `${videoId}.json`);
}

function analysisFile(eye: VideoEye, videoId: string): string {
  return path.resolve(eye.cache.root, "analysis", `${videoId}.json`);
}

async function readMetadata(eye: VideoEye, videoId: string): Promise<VideoMetadata> {
  const raw = await readFile(metadataFile(eye, videoId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("未找到该 video_id 的缓存 metadata");
    throw error;
  });
  const metadata = JSON.parse(raw) as VideoMetadata;
  if (metadata.video_id !== videoId || !metadata.source_url || typeof metadata.mp4_bytes !== "number") {
    throw new Error("缓存 metadata 无效");
  }
  return metadata;
}

async function cachedVideo(eye: VideoEye, metadata: VideoMetadata): Promise<VideoMetadata> {
  const video: ResolvedVideo = {
    videoId: metadata.video_id,
    sourceUrl: metadata.source_url,
    title: metadata.title,
    author: metadata.author,
    duration: metadata.duration,
    mp4Url: "",
  };
  const cached = await eye.cache.getOrDownload(video, cachedOnlyDownloader);
  return cached.metadata;
}

async function saveAnalysis(eye: VideoEye, videoId: string, result: VideoObservation): Promise<void> {
  const target = analysisFile(eye, videoId);
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ analyzed_at: new Date().toISOString(), result }, null, 2) + "\n");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function latestAnalysis(eye: VideoEye, videoId: string): Promise<VideoObservation | null> {
  try {
    const record = JSON.parse(await readFile(analysisFile(eye, videoId), "utf8")) as { result?: VideoObservation };
    return record.result ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function providerOf(eye: VideoEye): string {
  const name = eye.worker.constructor.name.toLowerCase();
  if (name.includes("qwen")) return "qwen";
  if (name.includes("gemini")) return "gemini";
  if (name.includes("mock")) return "mock";
  return process.env.VIDEO_WORKER ?? "unknown";
}

function reply(output: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
}

function failure(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [process.env.CANXIANG_API_TOKEN, process.env.DASHSCOPE_API_KEY, process.env.GEMINI_API_KEY]) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return { isError: true as const, content: [{ type: "text" as const, text: message.slice(0, 800) }] };
}

/** Registers the production VideoEye tools. Long video-model work runs as background jobs. */
export function registerVideoEyeTools(server: McpServer, createEye: () => VideoEye = () => new VideoEye()): void {
  server.registerTool("analyze_douyin_video", {
    title: "Start Douyin video analysis",
    description: "Start analysis of a complete Douyin video as a background job. Returns quickly with job_id; call get_analysis_job until completed.",
    inputSchema: { url: z.string().min(1), question: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ url, question }) => {
    try {
      // Validate the share text before accepting a job, but do not call external services here.
      const sourceUrl = extractDouyinUrl(url);
      const seedEye = createEye();
      const manager = getVideoJobManager(seedEye.cache.root);
      const provider = providerOf(seedEye);
      const requestKey = makeRequestKey("analysis", { sourceUrl, question });
      const job = await manager.submit("analysis", requestKey, provider, async context => {
        const eye = createEye();
        await context.setStage("resolve", { provider: providerOf(eye) });
        const video = await eye.resolver.resolve(sourceUrl);
        await context.setStage("download", { video_id: video.videoId });
        const { metadata, cacheHit } = await eye.cache.getOrDownload(video, eye.downloader);
        if (cacheHit) await context.setStage("cache_hit", { video_id: video.videoId, cache_hit: true });
        const result = await eye.worker.analyze({
          videoId: video.videoId,
          videoPath: metadata.mp4_path,
          question,
          onProgress: async stage => {
            await context.setStage(stage, { video_id: video.videoId, cache_hit: cacheHit, provider: providerOf(eye) });
          },
        });
        await saveAnalysis(eye, video.videoId, result);
        await context.complete({
          video_id: video.videoId,
          title: metadata.title,
          author: metadata.author,
          duration: metadata.duration,
          cache_hit: cacheHit,
          ...result,
        }, { video_id: video.videoId, cache_hit: cacheHit, provider: result.provider || providerOf(eye) });
      });
      return reply(job);
    } catch (error) { return failure(error); }
  });

  server.registerTool("inspect_video", {
    title: "Start inspection of a cached video",
    description: "Start a background re-inspection of a cached video. When a time range is provided, VideoEye crops a padded local MP4 and sends only that clip to the provider. Returns quickly with job_id; call get_analysis_job until completed.",
    inputSchema: {
      video_id: videoIdSchema,
      question: z.string().min(1),
      start_time: z.number().nonnegative().optional(),
      end_time: z.number().nonnegative().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ video_id, question, start_time, end_time }) => {
    try {
      if (start_time !== undefined && end_time !== undefined && end_time <= start_time) {
        throw new Error("end_time 必须大于 start_time");
      }
      const seedEye = createEye();
      const manager = getVideoJobManager(seedEye.cache.root);
      const provider = providerOf(seedEye);
      const requestKey = makeRequestKey("inspection", { video_id, question, start_time: start_time ?? null, end_time: end_time ?? null });
      const job = await manager.submit("inspection", requestKey, provider, async context => {
        const eye = createEye();
        const inspectionStarted = performance.now();
        await context.setStage("cache_hit", { video_id, cache_hit: true, provider: providerOf(eye) });
        const metadata = await cachedVideo(eye, await readMetadata(eye, video_id));
        const clipPlan = buildClipPlan(metadata.duration, start_time, end_time);
        let clipPath: string | null = null;
        try {
          if (!clipPlan) {
            // Preserve the existing full-video behavior when no time range is requested.
            const result = await eye.worker.analyze({
              videoId: video_id,
              videoPath: metadata.mp4_path,
              question,
              previousContext: await latestAnalysis(eye, video_id),
              onProgress: async stage => {
                await context.setStage(stage, { video_id, cache_hit: true, provider: providerOf(eye) });
              },
            });
            await saveAnalysis(eye, video_id, result);
            await context.complete({ video_id, cache_hit: true, ...result }, { video_id, cache_hit: true, provider: result.provider || providerOf(eye) });
            return;
          }

          await context.setStage("clip", { video_id, cache_hit: true, provider: providerOf(eye) });
          const clip = await createInspectionClip(metadata.mp4_path, clipPlan, context.jobId);
          clipPath = clip.path;
          const localTimelineInstruction =
            `系统已从原视频 ${clipPlan.clipStart.toFixed(3)}-${clipPlan.clipEnd.toFixed(3)} 秒裁出当前小片段。` +
            `请只分析所附小片段；timeline、important_events 以及摘要中使用 mm:ss/HH:mm:ss 表示的时间点必须使用“小片段本地时间轴”，即片段第一帧=00:00。` +
            `不要自行把时间戳换算回原视频，系统会在返回前统一映射。用户原问题：${question}`;
          const rawResult = await eye.worker.analyze({
            videoId: video_id,
            videoPath: clip.path,
            question: localTimelineInstruction,
            previousContext: await latestAnalysis(eye, video_id),
            onProgress: async stage => {
              await context.setStage(stage, { video_id, cache_hit: true, provider: providerOf(eye) });
            },
          });
          const result = remapInspectionTimeline(rawResult, clipPlan.clipStart, clipPlan.clipDuration);
          const debug = {
            requested_start_time: start_time ?? null,
            requested_end_time: end_time ?? null,
            clip_start: clipPlan.clipStart,
            clip_end: clipPlan.clipEnd,
            clip_duration: clipPlan.clipDuration,
            source_video_bytes: metadata.mp4_bytes,
            clip_video_bytes: clip.bytes,
            video_tokens: videoTokensFromResult(result),
            cache_hit: true,
            input_method: "clipped_mp4_oss_video_url",
            timestamp_offset_seconds: clipPlan.clipStart,
            clip_elapsed_ms: clip.elapsedMs,
            inspection_elapsed_ms: Math.round(performance.now() - inspectionStarted),
          };
          const finalResult = { ...result, ...debug };
          await saveAnalysis(eye, video_id, finalResult);
          await context.complete({ video_id, ...finalResult }, { video_id, cache_hit: true, provider: result.provider || providerOf(eye) });
        } finally {
          await cleanupInspectionClip(clipPath);
        }
      });
      return reply(job);
    } catch (error) { return failure(error); }
  });

  server.registerTool("get_analysis_job", {
    title: "Get VideoEye analysis job",
    description: "Get the current status or completed result of an analyze_douyin_video / inspect_video background job without starting another model request. On Autoscale, active jobs use a bounded 20-second long poll by default so CPU-intensive clipping can continue even when clients do not expose wait_ms. Completed/failed jobs still return immediately.",
    inputSchema: { job_id: jobIdSchema, wait_ms: z.number().int().min(0).max(20_000).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ job_id, wait_ms }) => {
    try {
      const eye = createEye();
      const manager = getVideoJobManager(eye.cache.root);
      const job = await manager.get(job_id, wait_ms ?? 20_000);
      if (!job) throw new Error("未找到该 job_id；任务可能已过期，或部署进程/存储已被重置");
      return reply(job);
    } catch (error) { return failure(error); }
  });

  server.registerTool("runtime_diagnostics", {
    title: "VideoEye runtime diagnostics",
    description: "Return fast non-secret diagnostics: app version, selected worker, whether required API keys are present, cache writability, and recent job states.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try {
      const eye = createEye();
      const manager = getVideoJobManager(eye.cache.root);
      return reply(await manager.diagnostics(providerOf(eye)));
    } catch (error) { return failure(error); }
  });

  server.registerTool("get_video_context", {
    title: "Get cached video context",
    description: "Return metadata, cache status, and the most recent completed analysis for a video ID. Does not call a video model or download media.",
    inputSchema: { video_id: videoIdSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ video_id }) => {
    try {
      const eye = createEye();
      const metadata = await readMetadata(eye, video_id);
      let cacheStatus: "available" | "missing_or_invalid" = "available";
      try { await cachedVideo(eye, metadata); }
      catch { cacheStatus = "missing_or_invalid"; }
      return reply({
        video_id, title: metadata.title, author: metadata.author,
        duration: metadata.duration, source_url: metadata.source_url,
        cache_status: cacheStatus, latest_analysis: await latestAnalysis(eye, video_id),
      });
    } catch (error) { return failure(error); }
  });
}
