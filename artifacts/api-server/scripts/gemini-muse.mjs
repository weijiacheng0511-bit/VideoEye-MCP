import { registerHooks } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/") ? `${specifier}.ts` : specifier, context);
  },
});

const { VideoEye, VideoCache, GeminiVideoWorker } = await import("../src/videoeye/index.ts");
const videoId = "7688589832758594854";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cache = new VideoCache(process.env.VIDEOEYE_CACHE_DIR ?? path.join(projectRoot, "data/videoeye"));
const metadataPath = path.resolve(cache.root, "metadata", `${videoId}.json`);
const report = { video_id: videoId, cache_hit: false, gemini_uploaded: false, gemini_file_state: null, model: null, complete_video_analyzed: false };

try {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (metadata.video_id !== videoId) throw new Error("Muse 缓存的 video_id 不匹配");
  const resolved = {
    videoId, sourceUrl: metadata.source_url, title: metadata.title,
    author: metadata.author, duration: metadata.duration, mp4Url: "",
  };
  const downloader = { async download() { throw new Error("Muse 缓存缺失；禁止重新下载抖音视频"); } };
  const cached = await cache.getOrDownload(resolved, downloader);
  report.cache_hit = cached.cacheHit;
  report.mp4_path = cached.metadata.mp4_path;
  report.mp4_bytes = (await stat(report.mp4_path)).size;
  if (!cached.cacheHit) throw new Error("Muse MP4 未命中缓存");

  process.env.VIDEO_WORKER ??= "gemini";
  if (process.env.VIDEO_WORKER === "gemini" && !process.env.GEMINI_API_KEY) {
    report.status = "等待 API Key：设置 GEMINI_API_KEY 后再运行";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
  } else {
    const eye = new VideoEye({ cache, downloader, resolver: { async resolve() { return resolved; } } });
    const worker = eye.worker;
    report.model = worker instanceof GeminiVideoWorker ? worker.model : "mock";
    try {
      const analyzed = await eye.analyze(resolved.sourceUrl, "完整观看 Muse 视频，作者具体讲了什么？请区分画面与口述内容。");
      report.cache_hit = analyzed.cacheHit;
      report.gemini_uploaded = worker instanceof GeminiVideoWorker && worker.uploaded;
      report.gemini_file_state = worker instanceof GeminiVideoWorker ? worker.lastFileState : null;
      report.complete_video_analyzed = worker instanceof GeminiVideoWorker && analyzed.result.provider === "gemini";
      report.result = analyzed.result;
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      report.gemini_uploaded = worker instanceof GeminiVideoWorker && worker.uploaded;
      report.gemini_file_state = worker instanceof GeminiVideoWorker ? worker.lastFileState : null;
      throw error;
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
