import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VideoObservation } from "./worker";

export interface ClipPlan {
  requestedStartTime: number;
  requestedEndTime: number;
  clipStart: number;
  clipEnd: number;
  clipDuration: number;
}

export interface ClipResult {
  path: string;
  bytes: number;
  elapsedMs: number;
}

let ffmpegExecutable: string | null = null;

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`FFmpeg 超时（>${timeoutMs}ms）`));
      }
    }, timeoutMs);
    timer.unref?.();

    child.stderr.on("data", chunk => {
      if (stderr.length < 8000) stderr += String(chunk);
    });
    child.on("error", error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stderr });
      else reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.trim().slice(-1200) || "unknown error"}`));
    });
  });
}

async function resolveFfmpeg(): Promise<string> {
  if (ffmpegExecutable) return ffmpegExecutable;
  const candidate = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  try {
    await runProcess(candidate, ["-version"], 15_000);
    ffmpegExecutable = candidate;
    return candidate;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FFmpeg 不可用：当前运行环境无法执行 ${candidate}。请安装本地 FFmpeg 或设置 FFMPEG_PATH。${message.includes("ENOENT") ? "" : ` 原因：${message}`}`);
  }
}

export function buildClipPlan(videoDuration: number, startTime?: number, endTime?: number, paddingSeconds = 3): ClipPlan | null {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) throw new Error("缓存 metadata 的视频时长无效");
  if (startTime === undefined && endTime === undefined) return null;
  const requestedStartTime = startTime ?? 0;
  const requestedEndTime = endTime ?? videoDuration;
  if (!Number.isFinite(requestedStartTime) || requestedStartTime < 0) throw new Error("start_time 必须为非负有限数字");
  if (!Number.isFinite(requestedEndTime) || requestedEndTime < 0) throw new Error("end_time 必须为非负有限数字");
  if (requestedEndTime <= requestedStartTime) throw new Error("end_time 必须大于 start_time");
  if (requestedStartTime >= videoDuration) throw new Error(`start_time 超出视频时长（${videoDuration}s）`);

  const boundedEnd = Math.min(videoDuration, requestedEndTime);
  if (boundedEnd <= requestedStartTime) throw new Error(`请求区间超出视频时长（${videoDuration}s）`);
  const clipStart = Math.max(0, requestedStartTime - paddingSeconds);
  const clipEnd = Math.min(videoDuration, boundedEnd + paddingSeconds);
  const clipDuration = clipEnd - clipStart;
  if (clipDuration <= 0) throw new Error("计算出的裁剪区间无效");
  return { requestedStartTime, requestedEndTime, clipStart, clipEnd, clipDuration };
}

export async function createInspectionClip(sourcePath: string, plan: ClipPlan, jobId: string): Promise<ClipResult> {
  const ffmpeg = await resolveFfmpeg();
  const directory = path.join(os.tmpdir(), "videoeye-inspect");
  await mkdir(directory, { recursive: true });
  const outputPath = path.join(directory, `${jobId}-${randomUUID()}.mp4`);
  const started = performance.now();
  try {
    await runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", formatNumber(plan.clipStart),
      "-i", sourcePath,
      "-t", formatNumber(plan.clipDuration),
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-sn", "-dn",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-avoid_negative_ts", "make_zero",
      outputPath,
    ], 180_000);
    const info = await stat(outputPath);
    if (!info.isFile() || info.size < 12) throw new Error("FFmpeg 裁剪结果为空或无效");
    return { path: outputPath, bytes: info.size, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupInspectionClip(clipPath: string | null | undefined): Promise<void> {
  if (!clipPath) return;
  await rm(clipPath, { force: true }).catch(() => {});
}

function parseClockToken(token: string): number | null {
  const parts = token.split(":").map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  if (parts.slice(1).some(n => n >= 60)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function formatClock(seconds: number, preferHours: boolean): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (preferHours || hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const totalMinutes = Math.floor(rounded / 60);
  return `${String(totalMinutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Shift colon-formatted timestamps from clip-local time back to the original video.
 * If Qwen already emitted an original-video timestamp that is clearly outside the
 * clip-local duration, keep it unchanged to avoid double shifting.
 */
export function shiftTimestampText(text: string, offsetSeconds: number, clipDuration: number): string {
  if (!text || offsetSeconds === 0) return text;
  const tolerance = Math.max(2, Math.min(5, clipDuration * 0.1));
  return text.replace(/(?<!\d)(\d{1,2}:\d{2}(?::\d{2})?)(?!\d)/g, token => {
    const local = parseClockToken(token);
    if (local === null) return token;
    if (local > clipDuration + tolerance) return token;
    return formatClock(local + offsetSeconds, token.split(":").length === 3);
  });
}

export function remapInspectionTimeline<T extends VideoObservation>(result: T, clipStart: number, clipDuration: number): T {
  if (clipStart === 0) return result;
  const mappedEvents = result.important_events?.map(item => ({
    ...item,
    timestamp: shiftTimestampText(item.timestamp, clipStart, clipDuration),
  }));
  const mappedTimestamps = result.timestamps.map(value =>
    Number.isFinite(value) && value <= clipDuration + 2 ? value + clipStart : value,
  );
  const mappedObservations = mappedEvents?.length
    ? mappedEvents.map(item => {
      const evidence = (item as { evidence?: string }).evidence;
      return `${item.timestamp}${evidence ? ` [${evidence}]` : ""} ${item.event}`.trim();
    })
    : result.observations.map(item => shiftTimestampText(item, clipStart, clipDuration));

  return {
    ...result,
    answer: shiftTimestampText(result.answer, clipStart, clipDuration),
    summary: result.summary === undefined ? undefined : shiftTimestampText(result.summary, clipStart, clipDuration),
    objective_observation_summary: result.objective_observation_summary === undefined ? undefined : shiftTimestampText(result.objective_observation_summary, clipStart, clipDuration),
    timeline: result.timeline?.map(item => ({ ...item, timestamp: shiftTimestampText(item.timestamp, clipStart, clipDuration) })),
    important_events: mappedEvents,
    observations: mappedObservations,
    timestamps: mappedTimestamps,
  };
}

export function videoTokensFromResult(result: VideoObservation): number | null {
  const usage = (result as VideoObservation & { usage?: { prompt_tokens_details?: unknown } }).usage;
  const details = usage?.prompt_tokens_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>).video_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
