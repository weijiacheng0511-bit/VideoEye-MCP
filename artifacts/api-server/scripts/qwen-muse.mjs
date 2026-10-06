import { registerHooks } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/") ? `${specifier}.ts` : specifier, context);
  },
});

const { VideoEye, VideoCache, QwenVideoWorker } = await import("../src/videoeye/index.ts");
const videoId = "7688589832758594854";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cache = new VideoCache(process.env.VIDEOEYE_CACHE_DIR ?? path.join(projectRoot, "data/videoeye"));
const metadataPath = path.resolve(cache.root, "metadata", `${videoId}.json`);
const question = `完整观看并理解这条视频。同时关注：主讲人说了什么；视频画面展示了什么；UI、动画、图表、屏幕文字；口播没有明确说出但画面提供的重要信息；人物动作和明显视觉变化；重要内容尽量附时间戳。不要只做语音转录摘要。`;
const started = performance.now();
const report = { video_id: videoId, cache_hit: false, mp4_bytes: null, uploaded: false,
  model: "qwen3.8-omni-flash", input_method: null, usage: null, total_elapsed_ms: null };
let worker;

try {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (metadata.video_id !== videoId) throw new Error("Muse 缓存的 video_id 不匹配");
  const resolved = {
    videoId, sourceUrl: metadata.source_url, title: metadata.title,
    author: metadata.author, duration: metadata.duration, mp4Url: "",
  };
  const downloader = { async download() { throw new Error("Muse MP4 缓存缺失；停止测试以避免重复下载"); } };
  const cached = await cache.getOrDownload(resolved, downloader);
  report.cache_hit = cached.cacheHit;
  report.mp4_path = cached.metadata.mp4_path;
  report.mp4_bytes = (await stat(report.mp4_path)).size;
  if (!cached.cacheHit) throw new Error("Muse MP4 未命中缓存");
  if (!process.env.DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY.includes("<把你的百炼 Key 粘在这里>")) {
    throw new Error("等待 API Key：当前进程尚未设置真实的 DASHSCOPE_API_KEY");
  }

  process.env.VIDEO_WORKER = "qwen";
  const eye = new VideoEye({ cache, downloader, resolver: { async resolve() { return resolved; } } });
  worker = eye.worker;
  if (!(worker instanceof QwenVideoWorker)) throw new Error("未选中 QwenVideoWorker");
  const analyzed = await eye.analyze(resolved.sourceUrl, question);
  report.cache_hit = analyzed.cacheHit;
  report.uploaded = worker.uploaded;
  report.input_method = analyzed.result.input_method;
  report.usage = analyzed.result.usage;
  report.result = analyzed.result;
  report.total_elapsed_ms = Math.round(performance.now() - started);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.uploaded = worker?.uploaded ?? false;
  report.total_elapsed_ms = Math.round(performance.now() - started);
  report.error = String(error instanceof Error ? error.message : error)
    .replaceAll(process.env.DASHSCOPE_API_KEY ?? "\0", "[REDACTED]");
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
