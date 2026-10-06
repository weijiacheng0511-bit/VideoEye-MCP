import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { AnalyzeRequest, VideoObservation, VideoWorker } from "./worker";

export const GEMINI_VIDEO_MODEL = "gemini-3.8-flash";

const resultSchema = z.object({
  answer: z.string(),
  summary: z.string(),
  important_events: z.array(z.object({ timestamp: z.string(), event: z.string() })),
  visual_description: z.string(),
  spoken_content_summary: z.string(),
});

const responseSchema = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Direct answer to the user's question, based only on the video." },
    summary: { type: "string", description: "Summary of the entire video." },
    important_events: {
      type: "array", items: { type: "object", properties: {
        timestamp: { type: "string", description: "Time within the video as MM:SS or HH:MM:SS." },
        event: { type: "string", description: "What is seen or heard at that time." },
      }, required: ["timestamp", "event"] },
    },
    visual_description: { type: "string", description: "Important visual details in the video." },
    spoken_content_summary: { type: "string", description: "Summary of the video's speech; do not invent inaudible words." },
  },
  required: ["answer", "summary", "important_events", "visual_description", "spoken_content_summary"],
};

function seconds(timestamp: string): number | null {
  const parts = timestamp.split(":").map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

export class GeminiVideoWorker implements VideoWorker {
  readonly model = GEMINI_VIDEO_MODEL;
  lastFileState: string | null = null;
  lastFileName: string | null = null;
  uploaded = false;

  async analyze(request: AnalyzeRequest): Promise<VideoObservation> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("等待 API Key：请设置 GEMINI_API_KEY");
    const ai = new GoogleGenAI({ apiKey });
    await request.onProgress?.("provider_upload");
    const uploaded = await ai.files.upload({ file: request.videoPath, config: { mimeType: "video/mp4" } });
    this.uploaded = true;
    this.lastFileName = uploaded.name ?? null;
    if (!uploaded.name) throw new Error("Gemini Files API 未返回文件名");

    let file = uploaded;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (true) {
      this.lastFileState = file.state ?? null;
      if (file.state === "ACTIVE") break;
      if (file.state === "FAILED") throw new Error("Gemini 文件处理失败（FAILED）");
      if (Date.now() >= deadline) throw new Error(`等待 Gemini 文件 ACTIVE 超时，当前状态：${file.state ?? "UNKNOWN"}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      file = await ai.files.get({ name: uploaded.name });
    }
    if (!file.uri) throw new Error("Gemini ACTIVE 文件缺少 URI");
    await request.onProgress?.("provider_inference");

    const focus = request.startTime === undefined && request.endTime === undefined ? "" :
      `重点回答时间区间 ${request.startTime ?? 0} 至 ${request.endTime ?? "视频结尾"} 秒的问题，但仍以完整视频为上下文。`;
    const context = request.previousContext === undefined ? "" :
      `前文上下文：${JSON.stringify(request.previousContext)}\n`;
    const prompt = `请直接观察所附完整视频的画面和声音，依据视频回答。不要依据标题猜测；无法辨认的内容明确说无法辨认。\n` +
      `视频 ID：${request.videoId}\n用户问题：${request.question}\n${focus}\n${context}` +
      `请返回 answer、完整视频 summary、带视频内时间点的 important_events、visual_description、spoken_content_summary。`;
    const interaction = await ai.interactions.create({
      model: this.model,
      input: [
        { type: "video", uri: file.uri, mime_type: "video/mp4", processing: "agentic" },
        { type: "text", text: prompt },
      ],
      response_format: { type: "text", mime_type: "application/json", schema: responseSchema },
    });
    if (!interaction.output_text) throw new Error("Gemini 未返回分析文本");
    await request.onProgress?.("finalize");
    const parsed = resultSchema.parse(JSON.parse(interaction.output_text));
    return {
      ...parsed,
      observations: parsed.important_events.map(item => `${item.timestamp} ${item.event}`),
      timestamps: parsed.important_events.map(item => seconds(item.timestamp)).filter((n): n is number => n !== null),
      provider: "gemini",
      model: this.model,
      file_state: this.lastFileState,
      gemini_file_name: this.lastFileName,
    };
  }
}
