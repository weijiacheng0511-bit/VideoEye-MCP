# VideoEye MCP

Current product version: **1.1.4-video-observer**.

GitHub `main` contains the complete maintainable source. Historical ZIPs and
`v114-overlay` are retained as backups; they are not production source inputs.

Existing Replit project: `919a9f87-aa50-4969-a390-fccdae49d54c` (VideoEye-MCP).
Production URL: https://video-eye-mcp--weijiacheng0511.replit.app
MCP endpoint: `POST /api/mcp` at that same host.

## Development and validation

Use Node.js 24 and pnpm 11.19.0. Copy variable names from `.env.example` and
configure actual credentials in your environment; never commit keys or caches.

```sh
pnpm install --frozen-lockfile
BASE_PATH=/ PORT=5000 pnpm run build
pnpm --filter @workspace/api-server run videoeye:smoke offline
pnpm --filter @workspace/api-server run videoeye:mcp-smoke
pnpm --filter @workspace/api-server run videoeye:qwen-normalize-smoke
pnpm --filter @workspace/api-server run videoeye:inspect-clip-smoke
```

FFmpeg must be available (or `FFMPEG_PATH` must name it). `replit.nix` retains
`pkgs.ffmpeg` and adds Git for the deployment fetch. GitHub Actions runs the
same validation without production credentials. The default `videoeye:smoke`
mode calls the existing Douyin resolver; use `offline` for deterministic CI.

## Replit publishing

The repository prepares this repeatable publishing chain:

`GitHub main → Publish existing Replit app → fetch main → frozen dependency
install → TypeScript/build → smoke tests → existing deployment → MCP checks`.

`scripts/replit-build.mjs` fetches main into `.videoeye-release` and builds it
there. The API and web service manifests use this same verified release. A
build lock prevents concurrent service builds from interfering. Fetch or test
failure stops publishing; stale workspace source is not used as a fallback.
Production starts `.videoeye-release/artifacts/api-server/dist/index.mjs`.
The web service serves `.videoeye-release/artifacts/douyin-reader/dist/public`.
The API build embeds the GitHub commit in `runtime_diagnostics.source_commit`.

This needs one initial bootstrap/configuration of the **existing** Replit
project: install these source files and production service settings there,
retain `replit.nix`, and retain its current Secrets and deployment URL.
Committing the configuration to GitHub alone does not apply it to Replit.
After bootstrap is verified, subsequent product changes require only a GitHub
main update and Publish; no manual Shell synchronization or ZIP transfer.
Changes to Replit's bootstrap, system packages, or service routing still need
the existing project's settings updated before publishing.

Replit's Git pane can also link this repository, but a linked repository alone
does not establish that every GitHub push automatically republishes the app.
The build-time fetch is the explicit source synchronization mechanism here.

`VIDEOEYE_BUILD_REPOSITORY` is an optional local build-test override. Leave it
unset in production so the fixed GitHub repository is used. The existing
`VIDEOEYE_CACHE_DIR` is resolved from the workspace, outside the release tree;
publishing does not delete that cache. Replit deployment-local storage can
still be reset by the platform. The in-process async worker and local JSON
job persistence are retained; platform suspension may interrupt long jobs.

## Production acceptance

After publishing, require `runtime_diagnostics` to report:

- `app_version = 1.1.4-video-observer`
- `source_commit` equal to the intended GitHub main commit
- `video_worker = qwen`, `dashscope_api_key_present = true`, `cache_writable = true`

Then analyze https://v.douyin.com/J7FNDFSkD1U/ and poll `get_analysis_job` to
completion. Review the actual dialogue, people, visual/animation transitions,
screen text, audio events, entities, uncertainty, and objective summary.
Provider/model/token/byte/timing metadata are preserved in the result.

For cached video `7689817989819149681`, inspect `start_time=28`, `end_time=32`.
Require a 25–35 second clip, `cache_hit=true`, substantially fewer bytes and
video tokens than the full 109-second input, and
`input_method=clipped_mp4_oss_video_url`. Check original-video timestamps in
both `timeline` and `important_events`. If the deployment has no cache for
that ID, cache the full video with a normal analysis before inspection.

Qwen is a Video Observer: dialogue, actions, visuals, audio, explicit naming
evidence and entity recognition. It does not provide creator-intent analysis,
symbolism, hidden psychological judgments, or value judgments. Unsupported
real-person names default to `unknown` with `low` confidence. ChatGPT handles
interpretation using the returned observations.
