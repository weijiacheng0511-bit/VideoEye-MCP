import { CanxiangResolver, extractDouyinUrl, type VideoResolver } from "./douyin";
import { OfficialMp4Downloader, type Mp4Downloader } from "./mp4";
import { VideoCache } from "./cache";
import { MockVideoWorker, type VideoWorker } from "./worker";
import { GeminiVideoWorker } from "./gemini-worker";
import { QwenVideoWorker } from "./qwen-worker";

export interface VideoEyeOptions {
  resolver?: VideoResolver;
  downloader?: Mp4Downloader;
  cache?: VideoCache;
  worker?: VideoWorker;
}

export class VideoEye {
  readonly resolver: VideoResolver;
  readonly downloader: Mp4Downloader;
  readonly cache: VideoCache;
  readonly worker: VideoWorker;

  constructor(options: VideoEyeOptions = {}) {
    this.resolver = options.resolver ?? new CanxiangResolver();
    this.downloader = options.downloader ?? new OfficialMp4Downloader();
    this.cache = options.cache ?? new VideoCache(process.env.VIDEOEYE_CACHE_DIR ?? "./data/videoeye");
    const selectedWorker = process.env.VIDEO_WORKER ?? "qwen";
    if (!options.worker && selectedWorker !== "mock" && selectedWorker !== "gemini" && selectedWorker !== "qwen") {
      throw new Error("VIDEO_WORKER 必须为 mock、gemini 或 qwen");
    }
    this.worker = options.worker ?? (selectedWorker === "gemini" ? new GeminiVideoWorker() :
      selectedWorker === "qwen" ? new QwenVideoWorker() : new MockVideoWorker());
  }

  async analyze(shareText: string, question: string, extra: { startTime?: number; endTime?: number; previousContext?: unknown } = {}) {
    const sourceUrl = extractDouyinUrl(shareText);
    const video = await this.resolver.resolve(sourceUrl);
    const { metadata, cacheHit } = await this.cache.getOrDownload(video, this.downloader);
    const result = await this.worker.analyze({
      videoId: video.videoId, videoPath: metadata.mp4_path, question, ...extra,
    });
    return { videoId: video.videoId, metadata, cacheHit, result };
  }
}

export { CanxiangResolver, extractDouyinUrl, OfficialMp4Downloader, VideoCache, MockVideoWorker, GeminiVideoWorker, QwenVideoWorker };
export type { VideoResolver, Mp4Downloader, VideoWorker };
