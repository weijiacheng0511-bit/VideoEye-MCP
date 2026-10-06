import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { VideoEye, VideoCache, MockVideoWorker } = await import("../src/videoeye/index.ts");
const { registerVideoEyeTools } = await import("../src/videoeye/mcp-tools.ts");
const root = await mkdtemp(path.join(os.tmpdir(), "videoeye-mcp-"));
const videoId = "7688589832758594854";
const share = "复制打开抖音 https://v.douyin.com/kGP5ghGEu3s/ 看看视频";
const worker = new MockVideoWorker();
let downloads = 0;
const fakeMp4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom"), Buffer.alloc(128)]);
const eye = new VideoEye({
  cache: new VideoCache(root),
  worker,
  resolver: { async resolve(sourceUrl) {
    return { videoId, sourceUrl, title: "Muse 测试视频", author: "测试作者", duration: 129, mp4Url: "https://api-play.amemv.com/test.mp4" };
  } },
  downloader: { async download() {
    downloads++;
    return { bytes: fakeMp4, sha256: createHash("sha256").update(fakeMp4).digest("hex") };
  } },
});
const server = new McpServer({ name: "videoeye-mcp-smoke", version: "1.1.0" });
registerVideoEyeTools(server, () => eye);
const client = new Client({ name: "videoeye-test-client", version: "1.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

async function waitForJob(jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.callTool({ name: "get_analysis_job", arguments: { job_id: jobId } });
    assert.equal(response.isError, undefined);
    if (response.structuredContent.status === "completed" || response.structuredContent.status === "failed") return response.structuredContent;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const discovered = new Set((await client.listTools()).tools.map(tool => tool.name));
  for (const name of ["analyze_douyin_video", "inspect_video", "get_analysis_job", "runtime_diagnostics", "get_video_context"]) {
    assert(discovered.has(name), `Missing MCP tool: ${name}`);
  }
  assert(!discovered.has("get_mp4_file_reference"));
  assert(!discovered.has("get_mp4_embedded_resource"));

  const started = Date.now();
  const first = await client.callTool({ name: "analyze_douyin_video", arguments: { url: share, question: "整段讲什么？" } });
  assert.equal(first.isError, undefined);
  assert.match(first.structuredContent.job_id, /^job_[a-f0-9]{24}$/);
  assert(["queued", "processing", "completed"].includes(first.structuredContent.status));
  assert(Date.now() - started < 1000, "analyze_douyin_video should return a job quickly with Mock worker");
  const firstJob = await waitForJob(first.structuredContent.job_id);
  assert.equal(firstJob.status, "completed");
  assert.equal(firstJob.result.video_id, videoId);
  assert.equal(firstJob.result.cache_hit, false);
  assert.equal(firstJob.result.provider, "mock");

  const inspected = await client.callTool({ name: "inspect_video", arguments: {
    video_id: videoId, question: "再次检查这个缓存视频",
  } });
  assert.equal(inspected.isError, undefined);
  const inspectedJob = await waitForJob(inspected.structuredContent.job_id);
  assert.equal(inspectedJob.status, "completed");
  assert.equal(inspectedJob.result.video_id, videoId);
  assert.equal(worker.calls.at(-1).startTime, undefined);
  assert.equal(worker.calls.at(-1).endTime, undefined);
  assert.equal(downloads, 1);

  const context = await client.callTool({ name: "get_video_context", arguments: { video_id: videoId } });
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.cache_status, "available");
  assert.equal(context.structuredContent.latest_analysis.provider, "mock");
  assert.equal(downloads, 1);

  const diagnostics = await client.callTool({ name: "runtime_diagnostics", arguments: {} });
  assert.equal(diagnostics.isError, undefined);
  assert.equal(diagnostics.structuredContent.video_worker, "mock");
  assert.equal(diagnostics.structuredContent.cache_writable, true);

  console.log(JSON.stringify({
    discovery: [...discovered].sort(),
    first_job_id: first.structuredContent.job_id,
    first_job_status: firstJob.status,
    inspection_job_status: inspectedJob.status,
    mp4_downloads: downloads,
    mock_worker_calls: worker.calls.length,
    no_range_preserves_full_video_path: worker.calls.at(-1).startTime === undefined && worker.calls.at(-1).endTime === undefined,
    diagnostics_version: diagnostics.structuredContent.app_version,
  }, null, 2));
} finally {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
