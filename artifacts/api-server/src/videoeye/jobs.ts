import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

export const VIDEOEYE_APP_VERSION = "1.1.4-video-observer";

export type VideoJobKind = "analysis" | "inspection";
export type VideoJobStatus = "queued" | "processing" | "completed" | "failed";
export type VideoJobStage =
  | "received"
  | "resolve"
  | "download"
  | "cache_hit"
  | "clip"
  | "provider_upload"
  | "provider_inference"
  | "finalize"
  | "completed"
  | "failed";

export interface VideoJobRecord {
  job_id: string;
  request_key: string;
  kind: VideoJobKind;
  status: VideoJobStatus;
  stage: VideoJobStage;
  progress: number;
  provider: string;
  video_id?: string;
  cache_hit?: boolean;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  expires_at: string;
  process_instance_id: string;
  stage_started_at: string;
  stage_timings_ms: Partial<Record<VideoJobStage, number>>;
  result?: Record<string, unknown>;
  error_stage?: VideoJobStage;
  error_message?: string;
  retryable?: boolean;
}

export interface JobContext {
  readonly jobId: string;
  setStage(stage: VideoJobStage, patch?: Partial<Pick<VideoJobRecord, "video_id" | "cache_hit" | "provider">>): Promise<void>;
  complete(result: Record<string, unknown>, patch?: Partial<Pick<VideoJobRecord, "video_id" | "cache_hit" | "provider">>): Promise<void>;
}

type Runner = (context: JobContext) => Promise<void>;

const PROCESS_INSTANCE_ID = randomUUID();
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const PROGRESS: Record<VideoJobStage, number> = {
  received: 2,
  resolve: 10,
  download: 25,
  cache_hit: 30,
  clip: 40,
  provider_upload: 50,
  provider_inference: 65,
  finalize: 90,
  completed: 100,
  failed: 100,
};

function nowIso(): string { return new Date().toISOString(); }
function elapsedSince(iso: string): number { return Math.max(0, Date.now() - Date.parse(iso)); }

function redact(message: string): string {
  let output = message;
  for (const secret of [process.env.CANXIANG_API_TOKEN, process.env.DASHSCOPE_API_KEY, process.env.GEMINI_API_KEY]) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output.slice(0, 1200);
}

function retryableError(message: string): boolean {
  return /timeout|timed out|HTTP 4(?!00|01|03|04)|HTTP 5|429|rate|temporar|network|fetch|连接|超时|限流|稍后/i.test(message);
}

function jobSummary(job: VideoJobRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    provider: job.provider,
    video_id: job.video_id ?? null,
    cache_hit: job.cache_hit ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
  };
  if (job.status === "completed") base.result = job.result ?? {};
  if (job.status === "failed") {
    base.error_stage = job.error_stage ?? "failed";
    base.error_message = job.error_message ?? "Unknown VideoEye job error";
    base.retryable = job.retryable ?? false;
  }
  return base;
}

export function makeRequestKey(kind: VideoJobKind, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind, payload })).digest("hex");
}

export class VideoJobManager {
  readonly root: string;
  private readonly jobsDir: string;
  private readonly jobs = new Map<string, VideoJobRecord>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly ttlMs: number;

  constructor(cacheRoot: string, ttlMs = Number(process.env.VIDEOEYE_JOB_TTL_MS ?? DEFAULT_TTL_MS)) {
    this.root = path.resolve(cacheRoot);
    this.jobsDir = path.resolve(this.root, "jobs");
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 60_000 ? ttlMs : DEFAULT_TTL_MS;
    const timer = setInterval(() => { void this.cleanup(); }, Math.min(this.ttlMs, 15 * 60 * 1000));
    timer.unref();
  }

  private file(jobId: string): string { return path.resolve(this.jobsDir, `${jobId}.json`); }

  private async persist(job: VideoJobRecord): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await writeFile(this.file(job.job_id), JSON.stringify(job, null, 2) + "\n", "utf8");
  }

  private async load(jobId: string): Promise<VideoJobRecord | null> {
    const memory = this.jobs.get(jobId);
    if (memory) return memory;
    try {
      const job = JSON.parse(await readFile(this.file(jobId), "utf8")) as VideoJobRecord;
      if (job.job_id !== jobId) return null;
      if ((job.status === "queued" || job.status === "processing") && job.process_instance_id !== PROCESS_INSTANCE_ID) {
        const previousStage = job.stage;
        job.status = "failed";
        job.stage = "failed";
        job.progress = 100;
        job.error_stage = previousStage;
        job.error_message = "部署进程在任务完成前重启或停止；请重新提交原始分析请求。";
        job.retryable = true;
        job.completed_at = nowIso();
        job.updated_at = job.completed_at;
        job.stage_timings_ms[previousStage] = (job.stage_timings_ms[previousStage] ?? 0) + elapsedSince(job.stage_started_at);
        job.stage_started_at = job.completed_at;
        await this.persist(job);
      }
      this.jobs.set(jobId, job);
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async submit(kind: VideoJobKind, requestKey: string, provider: string, runner: Runner): Promise<Record<string, unknown>> {
    const jobId = `job_${requestKey.slice(0, 24)}`;
    const existing = await this.load(jobId);
    if (existing && existing.request_key === requestKey && Date.parse(existing.expires_at) > Date.now()) {
      if (existing.status === "queued" || existing.status === "processing" || existing.status === "completed") {
        return { ...jobSummary(existing), reused_job: true, next_action: existing.status === "completed" ? "read result" : "call get_analysis_job with this job_id" };
      }
      // A fresh submit is an explicit retry of a failed deterministic job.
      await rm(this.file(jobId), { force: true });
      this.jobs.delete(jobId);
    }

    const created = nowIso();
    const job: VideoJobRecord = {
      job_id: jobId,
      request_key: requestKey,
      kind,
      status: "queued",
      stage: "received",
      progress: PROGRESS.received,
      provider,
      created_at: created,
      updated_at: created,
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
      process_instance_id: PROCESS_INSTANCE_ID,
      stage_started_at: created,
      stage_timings_ms: {},
    };
    this.jobs.set(jobId, job);
    await this.persist(job);
    logger.info({ event: "videoeye_job", job_id: jobId, kind, provider, stage: "received", status: "queued" }, "VideoEye job accepted");

    const promise = Promise.resolve().then(async () => {
      const started = nowIso();
      job.status = "processing";
      job.started_at = started;
      job.updated_at = started;
      await this.persist(job);
      try {
        await runner({
          jobId,
          setStage: async (stage, patch = {}) => { await this.setStage(jobId, stage, patch); },
          complete: async (result, patch = {}) => { await this.complete(jobId, result, patch); },
        });
        const current = await this.load(jobId);
        if (current && current.status !== "completed") {
          throw new Error("后台任务结束但未写入 completed 结果");
        }
      } catch (error) {
        await this.fail(jobId, error);
      } finally {
        this.active.delete(jobId);
      }
    });
    this.active.set(jobId, promise);

    return { ...jobSummary(job), reused_job: false, next_action: "call get_analysis_job with this job_id" };
  }

  async setStage(jobId: string, stage: VideoJobStage, patch: Partial<Pick<VideoJobRecord, "video_id" | "cache_hit" | "provider">> = {}): Promise<void> {
    const job = await this.load(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return;
    const now = nowIso();
    const previousStage = job.stage;
    const stageElapsed = elapsedSince(job.stage_started_at);
    job.stage_timings_ms[previousStage] = (job.stage_timings_ms[previousStage] ?? 0) + stageElapsed;
    Object.assign(job, patch);
    job.status = "processing";
    job.stage = stage;
    job.progress = PROGRESS[stage];
    job.stage_started_at = now;
    job.updated_at = now;
    await this.persist(job);
    logger.info({
      event: "videoeye_job", job_id: jobId, kind: job.kind, video_id: job.video_id,
      provider: job.provider, stage, previous_stage: previousStage, previous_stage_ms: stageElapsed,
      status: job.status, cache_hit: job.cache_hit,
    }, "VideoEye job stage");
  }

  async complete(jobId: string, result: Record<string, unknown>, patch: Partial<Pick<VideoJobRecord, "video_id" | "cache_hit" | "provider">> = {}): Promise<void> {
    const job = await this.load(jobId);
    if (!job) throw new Error("VideoEye job 不存在");
    const now = nowIso();
    const stageElapsed = elapsedSince(job.stage_started_at);
    job.stage_timings_ms[job.stage] = (job.stage_timings_ms[job.stage] ?? 0) + stageElapsed;
    Object.assign(job, patch);
    job.status = "completed";
    job.stage = "completed";
    job.progress = 100;
    job.result = result;
    job.updated_at = now;
    job.completed_at = now;
    job.stage_started_at = now;
    await this.persist(job);
    logger.info({
      event: "videoeye_job", job_id: jobId, kind: job.kind, video_id: job.video_id,
      provider: job.provider, stage: "completed", status: "completed",
      total_ms: job.started_at ? elapsedSince(job.started_at) : null, stage_timings_ms: job.stage_timings_ms,
    }, "VideoEye job completed");
  }

  private async fail(jobId: string, error: unknown): Promise<void> {
    const job = await this.load(jobId);
    if (!job || job.status === "completed") return;
    const now = nowIso();
    const failedAt = job.stage;
    const message = redact(error instanceof Error ? error.message : String(error));
    job.stage_timings_ms[failedAt] = (job.stage_timings_ms[failedAt] ?? 0) + elapsedSince(job.stage_started_at);
    job.status = "failed";
    job.stage = "failed";
    job.progress = 100;
    job.error_stage = failedAt;
    job.error_message = message;
    job.retryable = retryableError(message);
    job.updated_at = now;
    job.completed_at = now;
    job.stage_started_at = now;
    await this.persist(job);
    logger.error({
      event: "videoeye_job", job_id: jobId, kind: job.kind, video_id: job.video_id,
      provider: job.provider, stage: failedAt, status: "failed", error_type: error instanceof Error ? error.name : typeof error,
      error_message: message, retryable: job.retryable,
      total_ms: job.started_at ? elapsedSince(job.started_at) : null, stage_timings_ms: job.stage_timings_ms,
    }, "VideoEye job failed");
  }

  async get(jobId: string, waitMs = 0): Promise<Record<string, unknown> | null> {
    let job = await this.load(jobId);
    if (!job) return null;
    const running = this.active.get(jobId);
    if (running && waitMs > 0 && job.status !== "completed" && job.status !== "failed") {
      // A bounded long poll keeps an actual result request in flight on Autoscale.
      // Waiting observes the existing runner; it never submits another model call.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running,
          new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(waitMs, 20_000)); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      job = await this.load(jobId);
      if (!job) return null;
    }
    return { ...jobSummary(job), next_action: job.status === "completed" ? "use result" : job.status === "failed" ? "retry original request if retryable" : "call get_analysis_job again after a short wait" };
  }

  async diagnostics(provider: string): Promise<Record<string, unknown>> {
    let cacheWritable = false;
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.W_OK);
      cacheWritable = true;
    } catch { cacheWritable = false; }

    const recent = [...this.jobs.values()]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 5)
      .map(job => ({ job_id: job.job_id, kind: job.kind, status: job.status, stage: job.stage, video_id: job.video_id ?? null, updated_at: job.updated_at }));

    return {
      app_version: VIDEOEYE_APP_VERSION,
      source_commit: process.env.VIDEOEYE_SOURCE_COMMIT ?? null,
      video_worker: provider,
      canxiang_api_token_present: Boolean(process.env.CANXIANG_API_TOKEN),
      dashscope_api_key_present: Boolean(process.env.DASHSCOPE_API_KEY),
      gemini_api_key_present: Boolean(process.env.GEMINI_API_KEY),
      cache_root: this.root,
      cache_writable: cacheWritable,
      active_jobs: this.active.size,
      recent_jobs: recent,
      background_execution: "in_process",
      job_state_persistence: "local_json_files",
      process_instance_id: PROCESS_INSTANCE_ID.slice(0, 8),
    };
  }

  private async cleanup(): Promise<void> {
    const cutoff = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (Date.parse(job.expires_at) <= cutoff && !this.active.has(jobId)) {
        this.jobs.delete(jobId);
        await rm(this.file(jobId), { force: true }).catch(() => {});
      }
    }
    try {
      const names = await readdir(this.jobsDir);
      await Promise.all(names.filter(name => /^job_[a-f0-9]{24}\.json$/.test(name)).map(async name => {
        const file = path.resolve(this.jobsDir, name);
        try {
          const info = await stat(file);
          if (info.mtimeMs + this.ttlMs <= cutoff) await rm(file, { force: true });
        } catch { /* best-effort cleanup */ }
      }));
    } catch { /* jobs directory may not exist yet */ }
  }
}

const managers = new Map<string, VideoJobManager>();
export function getVideoJobManager(cacheRoot: string): VideoJobManager {
  const root = path.resolve(cacheRoot);
  let manager = managers.get(root);
  if (!manager) {
    manager = new VideoJobManager(root);
    managers.set(root, manager);
  }
  return manager;
}
