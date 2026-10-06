# VideoEye MCP V1.1 — async-job deployment notes

Requires Node.js and pnpm. Configure secrets in the deployment platform's environment settings, never in the source archive or Git.

Required for new Douyin links:

- `CANXIANG_API_TOKEN`: bearer token for the existing `https://api.cxzja.cn/api/douyin` resolver.
- `DASHSCOPE_API_KEY`: Qwen video analysis key.
- `PORT`: API server listening port, for example `5000`.

`VIDEO_WORKER` defaults to `qwen`, using `qwen3.8-omni-flash`. Set it to `mock` for local pipeline testing or `gemini` to use the retained Gemini worker (which then requires `GEMINI_API_KEY`). `VIDEOEYE_CACHE_DIR` defaults to `./data/videoeye`; set it to a persistent writable directory in production. `DASHSCOPE_REGION` defaults to `cn-beijing`. `VIDEOEYE_JOB_TTL_MS` optionally controls how long completed/failed job metadata is retained; the default is 6 hours.

```sh
pnpm install --frozen-lockfile
PORT=5000 BASE_PATH=/ pnpm run build
PORT=5000 pnpm --filter @workspace/api-server run start
```

The MCP endpoint is `POST /api/mcp`.

Production MCP tool discovery now contains:

- `analyze_douyin_video`: validates the share link, starts a background analysis job, and returns `job_id` quickly instead of waiting for Qwen.
- `inspect_video`: starts a background re-inspection job for a cached video and returns `job_id` quickly.
- `get_analysis_job`: returns queued/processing/completed/failed status. A completed job includes the full result.
- `runtime_diagnostics`: fast non-secret runtime diagnostics including selected worker, whether required keys exist, cache writability, active jobs, and recent job summaries.
- `get_video_context`: cached metadata and the most recent completed analysis for a `video_id`.

The old MP4 host-compatibility test tools are no longer registered on the production MCP endpoint, so ChatGPT cannot accidentally select them instead of VideoEye.

## Job stages and logs

Structured server logs use the `videoeye_job` event and include the job ID, video ID when known, provider, stage, stage duration, total duration, success/failure, and a redacted error message. Secrets and Authorization headers are never intentionally logged.

Typical stages:

`received -> resolve -> download/cache_hit -> provider_upload -> provider_inference -> finalize -> completed`

Failed jobs include `error_stage`, `error_message`, and `retryable` in `get_analysis_job`.

Job status is written under `VIDEOEYE_CACHE_DIR/jobs`. If the deployment process restarts while a job is still queued/processing, a later status query marks that stale job failed and tells the client to resubmit instead of leaving it stuck forever.

## Hosting note

The background worker runs in the API process. A host that suspends or terminates the process immediately after the MCP HTTP response can interrupt a long Qwen job. For reliable long-running production use, choose a deployment mode that keeps the process alive while jobs are running, or move the worker to a durable queue/worker service. The diagnostics tool reports the current execution/persistence mode so this is visible during testing.

## Offline smoke test

Run:

```sh
pnpm --filter @workspace/api-server run videoeye:mcp-smoke
```

It verifies tool discovery, fast job creation, job polling, cached re-inspection, one-download reuse, and diagnostics using `MockVideoWorker`; it does not call Canxiang or Qwen.
