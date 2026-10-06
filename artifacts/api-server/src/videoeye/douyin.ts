export function extractDouyinUrl(text: string): string {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。；;）)]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,!?。！？]+$/, ""));
      const host = url.hostname.toLowerCase();
      if (url.protocol === "https:" && !url.username && !url.password &&
          (host === "douyin.com" || host.endsWith(".douyin.com"))) return url.href;
    } catch { /* Ignore malformed share text. */ }
  }
  throw new Error("分享文本中没有有效的抖音 HTTPS 链接");
}

export interface ResolvedVideo {
  videoId: string;
  sourceUrl: string;
  title: string;
  author: string;
  duration: number;
  mp4Url: string;
}

export interface VideoResolver {
  resolve(sourceUrl: string): Promise<ResolvedVideo>;
}

export class CanxiangResolver implements VideoResolver {
  private readonly token: string | undefined;
  constructor(token = process.env.CANXIANG_API_TOKEN) { this.token = token; }

  async resolve(sourceUrl: string): Promise<ResolvedVideo> {
    if (!this.token) throw new Error("缺少 CANXIANG_API_TOKEN，无法调用残像 API");
    const endpoint = new URL("https://api.cxzja.cn/api/douyin");
    endpoint.searchParams.set("url", sourceUrl);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`残像 API HTTP ${response.status}`);
    const payload = await response.json() as Record<string, any>;
    if (payload.code !== 200 || !payload.data) throw new Error(`残像 API 解析失败: ${String(payload.msg ?? payload.message ?? payload.code)}`);
    const data = payload.data;
    const videoId = String(data.aweme_id ?? "");
    const mp4Url = String(data.url ?? "");
    if (!/^\d{10,25}$/.test(videoId) || !mp4Url) throw new Error("残像 API 缺少 aweme_id 或 MP4 地址");
    return {
      videoId, sourceUrl,
      title: String(data.title ?? ""),
      author: typeof data.author === "string" ? data.author : String(data.author?.nickname ?? data.author?.name ?? ""),
      duration: Number(data.duration_seconds ?? data.duration ?? 0),
      mp4Url,
    };
  }
}
