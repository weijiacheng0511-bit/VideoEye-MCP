import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedVideo } from "./douyin";
import type { Mp4Downloader } from "./mp4";

export interface VideoMetadata {
  video_id: string;
  source_url: string;
  title: string;
  author: string;
  duration: number;
  mp4_path: string;
  created_at: string;
  mp4_bytes: number;
  sha256: string;
}

export class VideoCache {
  private readonly inFlight = new Map<string, Promise<{ metadata: VideoMetadata; cacheHit: boolean }>>();
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async getOrDownload(video: ResolvedVideo, downloader: Mp4Downloader): Promise<{ metadata: VideoMetadata; cacheHit: boolean }> {
    if (!/^\d{10,25}$/.test(video.videoId)) throw new Error("无效 aweme_id");
    const active = this.inFlight.get(video.videoId);
    if (active) return active.then(({ metadata }) => ({ metadata, cacheHit: true }));
    const work = this.loadOrDownload(video, downloader);
    this.inFlight.set(video.videoId, work);
    try { return await work; }
    finally { this.inFlight.delete(video.videoId); }
  }

  private async loadOrDownload(video: ResolvedVideo, downloader: Mp4Downloader): Promise<{ metadata: VideoMetadata; cacheHit: boolean }> {
    const mp4Path = path.resolve(this.root, "videos", `${video.videoId}.mp4`);
    const metadataPath = path.resolve(this.root, "metadata", `${video.videoId}.json`);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as VideoMetadata;
      const file = await stat(mp4Path);
      if (metadata.video_id === video.videoId && file.size === metadata.mp4_bytes && file.size >= 12) {
        const bytes = await readFile(mp4Path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (bytes.toString("ascii", 4, 8) === "ftyp" && sha256 === metadata.sha256) {
          const refreshed = { ...metadata, mp4_path: mp4Path, source_url: video.sourceUrl,
            title: video.title || metadata.title, author: video.author || metadata.author,
            duration: video.duration || metadata.duration };
          if (JSON.stringify(refreshed) !== JSON.stringify(metadata)) {
            await writeFile(metadataPath, JSON.stringify(refreshed, null, 2) + "\n");
          }
          return { metadata: refreshed, cacheHit: true };
        }
      }
    } catch { /* Missing or damaged cache entry: download afresh. */ }

    const { bytes, sha256 } = await downloader.download(video.mp4Url);
    if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("下载结果不是 MP4");
    await mkdir(path.dirname(mp4Path), { recursive: true });
    await mkdir(path.dirname(metadataPath), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}`;
    const tmpMp4 = `${mp4Path}.${suffix}.tmp`;
    const tmpMetadata = `${metadataPath}.${suffix}.tmp`;
    const metadata: VideoMetadata = {
      video_id: video.videoId, source_url: video.sourceUrl, title: video.title,
      author: video.author, duration: video.duration, mp4_path: mp4Path,
      created_at: new Date().toISOString(), mp4_bytes: bytes.length, sha256,
    };
    try {
      await writeFile(tmpMp4, bytes);
      await writeFile(tmpMetadata, JSON.stringify(metadata, null, 2) + "\n");
      await rename(tmpMp4, mp4Path);
      await rename(tmpMetadata, metadataPath);
    } finally {
      await Promise.all([rm(tmpMp4, { force: true }), rm(tmpMetadata, { force: true })]);
    }
    return { metadata, cacheHit: false };
  }
}
