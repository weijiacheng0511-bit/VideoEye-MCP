import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { buildClipPlan, cleanupInspectionClip, createInspectionClip, remapInspectionTimeline, shiftTimestampText } =
  await import("../src/videoeye/clip.ts");

const p1 = buildClipPlan(109, 28, 32);
assert.deepEqual(p1, { requestedStartTime: 28, requestedEndTime: 32, clipStart: 25, clipEnd: 35, clipDuration: 10 });
const p2 = buildClipPlan(109, 0, 30);
assert.deepEqual(p2, { requestedStartTime: 0, requestedEndTime: 30, clipStart: 0, clipEnd: 33, clipDuration: 33 });
const p3 = buildClipPlan(184, 175, 184);
assert.deepEqual(p3, { requestedStartTime: 175, requestedEndTime: 184, clipStart: 172, clipEnd: 184, clipDuration: 12 });
assert.throws(() => buildClipPlan(109, 32, 28), /end_time/);
assert.throws(() => buildClipPlan(109, 109, 110), /start_time/);

assert.equal(shiftTimestampText("00:04 发生 A，00:06-00:08 发生 B", 25, 10), "00:29 发生 A，00:31-00:33 发生 B");
// Already-original timestamps outside a 10-second local clip should not be shifted twice.
assert.equal(shiftTimestampText("00:29 发生 A", 25, 10), "00:29 发生 A");

const mapped = remapInspectionTimeline({
  answer: "00:04 左右发生 A",
  observations: ["00:04 [both] A"],
  timestamps: [4],
  provider: "mock",
  important_events: [{ timestamp: "00:04-00:06", event: "A", evidence: "both" }],
  timeline: [{ timestamp: "00:04-00:06", event: "A", evidence: "both", dialogue: [{ speaker: "p1", text: "00:04 是屏幕显示的文字" }] }],
  summary: "00:04 发生 A",
  objective_observation_summary: "00:04 发生 A",
}, 25, 10);
assert.equal(mapped.answer, "00:29 左右发生 A");
assert.equal(mapped.important_events[0].timestamp, "00:29-00:31");
assert.deepEqual(mapped.timestamps, [29]);
assert.equal(mapped.timeline[0].timestamp, "00:29-00:31");
assert.equal(mapped.timeline[0].dialogue[0].text, "00:04 是屏幕显示的文字");
assert.equal(mapped.summary, "00:29 发生 A");
assert.equal(mapped.objective_observation_summary, "00:29 发生 A");
assert.match(mapped.observations[0], /^00:29-00:31/);

const ffmpegCheck = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpegCheck.status !== 0) throw new Error("Local ffmpeg is required for inspect clipping smoke test");

const root = await mkdtemp(path.join(os.tmpdir(), "videoeye-clip-smoke-"));
const source = path.join(root, "source.mp4");
const generate = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24",
  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
  "-t", "12",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
  "-c:a", "aac", "-b:a", "64k", "-pix_fmt", "yuv420p",
  source,
], { encoding: "utf8" });
if (generate.status !== 0) throw new Error(`Failed to generate smoke MP4: ${generate.stderr}`);

let clip = null;
try {
  const plan = buildClipPlan(12, 4, 6);
  clip = await createInspectionClip(source, plan, "job_0123456789abcdef01234567");
  const sourceStat = await stat(source);
  assert(clip.bytes > 12);
  assert(clip.bytes < sourceStat.size, `clip should be smaller than source: ${clip.bytes} vs ${sourceStat.size}`);
  console.log(JSON.stringify({
    ok: true,
    ffmpeg: ffmpegCheck.stdout.split("\n")[0],
    plans: { range_28_32: p1, range_0_30: p2, range_175_184: p3 },
    timestamp_mapping: mapped,
    synthetic_source_bytes: sourceStat.size,
    synthetic_clip_bytes: clip.bytes,
    synthetic_clip_elapsed_ms: clip.elapsedMs,
  }, null, 2));
} finally {
  if (clip) await cleanupInspectionClip(clip.path);
  await rm(root, { recursive: true, force: true });
}
