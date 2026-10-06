import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AnalyzeRequest, VideoObservation, VideoWorker } from "./worker";

export const QWEN_VIDEO_MODEL = "qwen3.8-omni-flash";

const evidenceSchema = z.enum(["audio", "visual", "both", "unknown"]);
const confidenceSchema = z.enum(["high", "medium", "low"]);

const dialogueSchema = z.object({
  speaker: z.string().default("unknown"),
  text: z.string().default(""),
  tone: z.string().default(""),
  uncertain: z.boolean().default(false),
});

const eventSchema = z.object({
  timestamp: z.string().default(""),
  event: z.string().default(""),
  evidence: evidenceSchema.default("unknown"),
  people: z.array(z.string()).default([]),
  dialogue: z.array(dialogueSchema).default([]),
  actions: z.array(z.string()).default([]),
  visuals: z.array(z.string()).default([]),
  screen_text: z.array(z.string()).default([]),
  audio_events: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
});

const personSchema = z.object({
  person_id: z.string().default(""),
  identity: z.string().default("unknown"),
  identity_confidence: confidenceSchema.default("low"),
  identity_evidence: z.array(z.string()).default([]),
  appearance: z.string().default(""),
});

const recognizedEntitySchema = z.object({
  type: z.enum(["person", "brand", "product", "vehicle", "location", "software_ui", "film_tv", "organization", "other"]).default("other"),
  name: z.string().default(""),
  confidence: confidenceSchema.default("low"),
  evidence: z.array(z.string()).default([]),
});

const resultSchema = z.object({
  // Compatibility fields retained for the existing VideoEye pipeline.
  answer: z.string().default(""),
  summary: z.string().default(""),
  important_events: z.array(eventSchema).default([]),
  visual_description: z.string().default(""),
  spoken_content_summary: z.string().default(""),
  screen_text: z.array(z.string()).default([]),
  visual_only_information: z.array(z.string()).default([]),
  people_actions: z.array(z.string()).default([]),
  uncertain_points: z.array(z.string()).default([]),

  // Observer-mode fields.
  objective_observation_summary: z.string().default(""),
  timeline: z.array(eventSchema).default([]),
  people: z.array(personSchema).default([]),
  recognized_entities: z.array(recognizedEntitySchema).default([]),
  uncertain_observations: z.array(z.string()).default([]),
});

type QwenResult = z.infer<typeof resultSchema>;
export interface QwenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: unknown;
  completion_tokens_details?: unknown;
}
export type QwenObservation = VideoObservation & QwenResult & {
  usage: QwenUsage | null;
  elapsed_ms: number;
  video_bytes: number;
  input_method: "complete_mp4_oss_video_url";
  raw_provider_result: unknown;
  provider_parse_warnings: string[];
};

const hosts: Record<string, string> = {
  "cn-beijing": "dashscope.aliyuncs.com",
  "ap-southeast-1": "dashscope-intl.aliyuncs.com",
};

function endpoint(): string {
  const region = process.env.DASHSCOPE_REGION ?? "cn-beijing";
  const host = hosts[region];
  if (!host) throw new Error("DASHSCOPE_REGION 必须为 cn-beijing 或 ap-southeast-1");
  return `https://${host}`;
}

function safeError(message: string, key: string): string {
  return message.replaceAll(key, "[REDACTED]").slice(0, 600);
}

async function checkedResponse(response: Response, action: string, key: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    const body = await response.json() as { code?: string; message?: string };
    detail = ` ${String(body.code ?? "")} ${String(body.message ?? "")}`;
  } catch { /* The status still identifies the failing stage. */ }
  throw new Error(safeError(`${action} HTTP ${response.status}${detail}`, key));
}

async function uploadMp4(videoPath: string, apiKey: string, base: string): Promise<string> {
  const policyUrl = new URL("/api/v1/uploads", base);
  policyUrl.searchParams.set("action", "getPolicy");
  policyUrl.searchParams.set("model", QWEN_VIDEO_MODEL);
  const policyResponse = await fetch(policyUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  await checkedResponse(policyResponse, "百炼上传凭证", apiKey);
  const payload = await policyResponse.json() as { data?: Record<string, string> };
  const policy = payload.data;
  if (!policy || !policy.upload_host || !policy.upload_dir || !policy.policy || !policy.signature || !policy.oss_access_key_id) {
    throw new Error("百炼上传凭证缺少必要字段");
  }
  const uploadHost = new URL(policy.upload_host);
  if (uploadHost.protocol !== "https:" || !uploadHost.hostname.endsWith(".aliyuncs.com") ||
      uploadHost.username || uploadHost.password || uploadHost.port) throw new Error("百炼上传地址无效");
  const fileName = path.basename(videoPath);
  const objectKey = `${policy.upload_dir}/${fileName}`;
  const bytes = await readFile(videoPath);
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("上传文件不是完整 MP4 容器");
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id);
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("x-oss-object-acl", policy.x_oss_object_acl ?? "private");
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite ?? "true");
  form.append("key", objectKey);
  form.append("success_action_status", "200");
  form.append("file", new Blob([bytes], { type: "video/mp4" }), fileName);
  const uploadResponse = await fetch(uploadHost, {
    method: "POST", body: form, signal: AbortSignal.timeout(300000),
  });
  await checkedResponse(uploadResponse, "百炼临时 MP4 上传", apiKey);
  return `oss://${objectKey}`;
}

async function readCompletion(response: Response): Promise<{ content: string; usage: QwenUsage | null }> {
  if (!response.body) throw new Error("百炼未返回响应体");
  let buffer = "";
  let content = "";
  let usage: QwenUsage | null = null;
  const decoder = new TextDecoder();
  const consume = (event: string) => {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as {
      choices?: { delta?: { content?: string | null } }[];
      usage?: QwenUsage | null;
      error?: { message?: string };
    };
    if (chunk.error) throw new Error(`百炼流式响应失败：${chunk.error.message ?? "unknown"}`);
    content += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = chunk.usage;
  };
  for await (const part of response.body) {
    buffer = (buffer + decoder.decode(part, { stream: true })).replaceAll("\r\n", "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  return { content, usage };
}

function seconds(timestamp: string): number | null {
  const parts = timestamp.split("-")[0].trim().split(":").map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(records: Record<string, unknown>[], keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function confidenceValue(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function entityTypeValue(value: unknown): z.infer<typeof recognizedEntitySchema>["type"] {
  return value === "person" || value === "brand" || value === "product" || value === "vehicle" ||
    value === "location" || value === "software_ui" || value === "film_tv" || value === "organization"
    ? value : "other";
}

function normalizeDialogue(value: unknown): z.infer<typeof dialogueSchema>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === "string") return [{ speaker: "unknown", text: item, tone: "", uncertain: false }];
    if (!isRecord(item)) return [];
    const text = stringValue(item.text) ?? stringValue(item.quote) ?? "";
    if (!text) return [];
    return [{
      speaker: stringValue(item.speaker) ?? "unknown",
      text,
      tone: stringValue(item.tone) ?? "",
      uncertain: item.uncertain === true,
    }];
  });
}

function normalizeEvents(value: unknown): QwenResult["important_events"] {
  if (!Array.isArray(value)) return [];
  const events: QwenResult["important_events"] = [];
  for (const item of value) {
    if (typeof item === "string") {
      events.push({ timestamp: "", event: item, evidence: "unknown", people: [], dialogue: [], actions: [], visuals: [], screen_text: [], audio_events: [], entities: [] });
      continue;
    }
    if (!isRecord(item)) continue;
    const timestamp = typeof item.timestamp === "string" ? item.timestamp :
      typeof item.time === "string" ? item.time : "";
    const event = typeof item.event === "string" ? item.event :
      typeof item.description === "string" ? item.description :
      typeof item.text === "string" ? item.text : "";
    const evidence = item.evidence === "audio" || item.evidence === "visual" || item.evidence === "both"
      ? item.evidence : "unknown";
    events.push(eventSchema.parse({
      timestamp,
      event,
      evidence,
      people: stringArray(item.people),
      dialogue: normalizeDialogue(item.dialogue),
      actions: stringArray(item.actions),
      visuals: stringArray(item.visuals),
      screen_text: stringArray(item.screen_text),
      audio_events: stringArray(item.audio_events),
      entities: stringArray(item.entities),
    }));
  }
  return events;
}

function normalizePeople(value: unknown): QwenResult["people"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const namingEvidence = stringArray(item.identity_evidence ?? item.evidence);
    const identity = stringValue(item.identity) ?? "unknown";
    const hasNamingEvidence = identity !== "unknown" && namingEvidence.length > 0;
    return [personSchema.parse({
      person_id: stringValue(item.person_id) ?? stringValue(item.id) ?? "",
      identity: hasNamingEvidence ? identity : "unknown",
      identity_confidence: hasNamingEvidence ? confidenceValue(item.identity_confidence ?? item.confidence) : "low",
      identity_evidence: namingEvidence,
      appearance: stringValue(item.appearance) ?? "",
    })];
  });
}

function normalizeEntities(value: unknown): QwenResult["recognized_entities"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    return [recognizedEntitySchema.parse({
      type: entityTypeValue(item.type),
      name: stringValue(item.name) ?? "",
      confidence: confidenceValue(item.confidence),
      evidence: stringArray(item.evidence),
    })];
  }).filter(item => item.name.length > 0);
}

/** Normalize Qwen's observer JSON into VideoEye's stable compatibility shape. */
export function normalizeQwenProviderResult(raw: unknown, rawText = ""): { result: QwenResult; warnings: string[] } {
  const warnings: string[] = [];
  const root = isRecord(raw) ? raw : {};
  const analysis = isRecord(root.analysis) ? root.analysis : null;
  const records = analysis ? [root, analysis] : [root];

  const objectiveSummary = stringValue(pick(records, ["objective_observation_summary", "answer", "summary", "overview", "video_summary"])) ?? rawText;
  const importantEvents = normalizeEvents(pick(records, ["timeline", "important_events", "events", "key_events"]));
  const uncertainObservations = stringArray(pick(records, ["uncertain_observations", "uncertain_points"]));
  const globalScreenText = stringArray(pick(records, ["screen_text"]));

  if (!objectiveSummary) warnings.push("objective_observation_summary_missing_defaulted");
  if (importantEvents.length === 0) warnings.push("timeline_missing_or_empty_defaulted");

  const result = resultSchema.parse({
    // Legacy fields: intentionally minimized to prevent duplicate analysis prose.
    answer: objectiveSummary,
    summary: objectiveSummary,
    important_events: importantEvents,
    visual_description: "",
    spoken_content_summary: "",
    screen_text: globalScreenText,
    visual_only_information: [],
    people_actions: [],
    uncertain_points: uncertainObservations,

    objective_observation_summary: objectiveSummary,
    timeline: importantEvents,
    people: normalizePeople(pick(records, ["people"])),
    recognized_entities: normalizeEntities(pick(records, ["recognized_entities", "entities"])),
    uncertain_observations: uncertainObservations,
  });
  return { result, warnings };
}

const OBSERVER_SYSTEM_PROMPT = `You are Video Observer: a professional video perception worker, not a critic, psychologist, commentator, storyteller, or opinion analyst.
Report what can be directly observed or reliably identified from the video's visual and audio content. Prefer precise timestamps, verbatim speech, visible actions, scene changes, on-screen text, audio events, objects, brands, products, vehicles, locations, software/UI, public organizations, and uncertainty.
Do not infer themes, symbolism, hidden meanings, motives, moral lessons, correctness, humor, persuasion strategy, or what the creator "wants to express" unless the video explicitly states it. Do not label a worldview or ideology from the content.
Describe expressions behaviorally (for example: eyebrows furrow, mouth corners rise, pauses for about 2 seconds) rather than assigning hidden emotions.
For real people, do NOT identify a person from facial appearance, voice similarity, or biometric resemblance. A person name may be recorded only when the video explicitly provides it through a visible name label, spoken self-identification, or other explicit non-biometric naming evidence; otherwise use identity="unknown" and identity_confidence="low". Quote the naming evidence and its timestamp. Never guess a person's identity, including in recognized_entities, dialogue speaker names, or event text; use stable person_id labels throughout instead.
Non-person entity recognition should remain strong: identify brands, products, vehicle models, locations, software/UI, film/TV works and organizations when evidence is sufficient; mark confidence and evidence.
Uncertain observations must be explicitly marked rather than guessed.
Return factual observation data, not an essay.`;

export class QwenVideoWorker implements VideoWorker {
  readonly model = QWEN_VIDEO_MODEL;
  uploaded = false;

  async analyze(request: AnalyzeRequest): Promise<QwenObservation> {
    const started = performance.now();
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey || apiKey.includes("<把你的百炼 Key 粘在这里>")) {
      throw new Error("等待 API Key：请在当前运行环境设置真实的 DASHSCOPE_API_KEY");
    }
    const file = await stat(request.videoPath);
    if (!file.isFile() || file.size < 12) throw new Error("缓存 MP4 不存在或为空");
    const base = endpoint();
    await request.onProgress?.("provider_upload");
    const videoUrl = await uploadMp4(request.videoPath, apiKey, base);
    this.uploaded = true;
    await request.onProgress?.("provider_inference");

    const focus = request.startTime === undefined && request.endTime === undefined ? "" :
      `重点观察 ${request.startTime ?? 0} 至 ${request.endTime ?? "视频结尾"} 秒；如果系统提供的是完整视频仍须观看完整视频。`;
    const previous = request.previousContext === undefined ? "" :
      `此前对话背景仅用于指代消歧，不得据此补造视频事实，也不得把其中的人名当作身份识别证据：${JSON.stringify(request.previousContext)}。`;
    const prompt = `完整观看所附 MP4，同时使用画面和内嵌音频。${focus}${previous}` +
      `视频 ID：${request.videoId}。用户问题：${request.question}\n` +
      `请返回 JSON 对象，优先字段：` +
      `objective_observation_summary（只写客观事实摘要，禁止主题/寓意/评价）；` +
      `people（person_id、identity、identity_confidence、identity_evidence、appearance；真人姓名只能来自视频中的明确非生物识别命名证据）；` +
      `timeline（按所附 MP4 的时间顺序，尽可能完整。每项包含 timestamp、event、evidence、people、dialogue、actions、visuals、screen_text、audio_events、entities；每一句能听清的对白都尽量记录到 dialogue，保留 speaker 和接近原话的 text，不要改写成观点；明显语气写 tone，不确定写 uncertain）；` +
      `screen_text（全局去重后的重要可见文字）；` +
      `recognized_entities（type、name、confidence、evidence；强识别非人物实体，不确定就降 confidence）；` +
      `uncertain_observations。` +
      `不要返回观点分析、主题判断、笑点解释、象征意义、作者意图、心理动机或价值评价。` +
      `不要为了文字漂亮而重复同一信息：完整细节放 timeline，objective_observation_summary 只做短摘要。`;
    const response = await fetch(new URL("/compatible-mode/v1/chat/completions", base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-OssResourceResolve": "enable",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: OBSERVER_SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "video_url", video_url: { url: videoUrl } },
            { type: "text", text: prompt },
          ] },
        ],
        modalities: ["text"],
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(900000),
    });
    await checkedResponse(response, "百炼视频分析", apiKey);
    const { content, usage } = await readCompletion(response);
    await request.onProgress?.("finalize");
    if (!content) throw new Error("百炼没有返回视频分析文本");

    let rawProviderResult: unknown = content;
    const parseWarnings: string[] = [];
    try {
      rawProviderResult = JSON.parse(content);
    } catch (error) {
      parseWarnings.push(`provider_json_parse_failed:${error instanceof Error ? error.message : String(error)}`);
    }

    let normalized: QwenResult;
    let normalizeWarnings: string[];
    try {
      const output = normalizeQwenProviderResult(rawProviderResult, content);
      normalized = output.result;
      normalizeWarnings = output.warnings;
    } catch (error) {
      normalized = resultSchema.parse({ answer: content, summary: content, objective_observation_summary: content });
      normalizeWarnings = [`normalize_failed_fallback:${error instanceof Error ? error.message : String(error)}`];
    }
    const warnings = [...parseWarnings, ...normalizeWarnings];

    return {
      ...normalized,
      observations: normalized.important_events.map(item => {
        const factual = item.event || item.actions[0] || item.visuals[0] || item.dialogue[0]?.text || "";
        return item.evidence === "unknown" ? `${item.timestamp} ${factual}`.trim() : `${item.timestamp} [${item.evidence}] ${factual}`.trim();
      }).filter(Boolean),
      timestamps: normalized.important_events.map(item => seconds(item.timestamp)).filter((n): n is number => n !== null),
      provider: "qwen", model: this.model, usage,
      elapsed_ms: Math.round(performance.now() - started),
      video_bytes: file.size, input_method: "complete_mp4_oss_video_url",
      raw_provider_result: rawProviderResult,
      provider_parse_warnings: warnings,
    };
  }
}
