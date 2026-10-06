import { createHash } from "node:crypto";

// Shared with the existing MP4 proof-of-concept route: official hosts,
// manual redirect validation, complete range and size checks, and MP4 signature.
export function allowedMp4Url(raw: string): URL {
  if (raw.length > 8192) throw new Error("视频地址过长");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const allowed = ["douyin.com", "douyinvod.com", "amemv.com"].some(domain => host === domain || host.endsWith("." + domain));
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed) throw new Error("仅允许抖音官方 HTTPS 视频地址");
  return url;
}

export interface DownloadedMp4 { bytes: Buffer; sha256: string }
export interface Mp4Downloader { download(url: string): Promise<DownloadedMp4> }

export class OfficialMp4Downloader implements Mp4Downloader {
  private readonly maxBytes: number;
  constructor(maxBytes = 500 * 1024 * 1024) { this.maxBytes = maxBytes; }

  async download(raw: string): Promise<DownloadedMp4> {
    let url = allowedMp4Url(raw);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      let upstream: Response | undefined;
      for (let hop = 0; hop <= 5; hop++) {
        upstream = await fetch(url, { headers: { Range: "bytes=0-" }, redirect: "manual", signal: controller.signal });
        if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
        const location = upstream.headers.get("location");
        await upstream.body?.cancel();
        if (!location || hop === 5) throw new Error("视频重定向异常");
        url = allowedMp4Url(new URL(location, url).href);
      }
      if (!upstream?.ok || !upstream.body) throw new Error(`视频源返回 HTTP ${upstream?.status}`);
      const length = Number(upstream.headers.get("content-length") || 0);
      if (length > this.maxBytes) throw new Error("视频超过下载上限");
      const range = upstream.headers.get("content-range");
      const rangeMatch = range?.match(/^bytes 0-(\d+)\/(\d+)$/);
      if (upstream.status === 206 && (!rangeMatch || Number(rangeMatch[1]) + 1 !== Number(rangeMatch[2]))) throw new Error("视频源没有返回完整文件");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of upstream.body) {
        size += part.length;
        if (size > this.maxBytes) throw new Error("视频超过下载上限");
        chunks.push(Buffer.from(part));
      }
      if ((length && size !== length) || (rangeMatch && size !== Number(rangeMatch[2]))) throw new Error("视频下载不完整");
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("视频源返回了错误页或非 MP4 内容");
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
