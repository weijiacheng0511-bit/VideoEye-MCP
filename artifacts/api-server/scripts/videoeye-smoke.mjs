import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";

// Node 24 strips TypeScript types; this resolver maps local extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { VideoEye, VideoCache, MockVideoWorker } = await import("../src/videoeye/index.ts");
const mode = process.argv[2] ?? "muse";
const museId = "7688589832758594854";
const museUrl = "https://v.douyin.com/kGP5ghGEu3s/";
const directUrl = "https://api-play.amemv.com/aweme/v1/play/?video_id=v0d00fg10000daplji7og65q66shuom0&line=0&ratio=1080p&aid=1967";
const mock = new MockVideoWorker();
let downloads = 0;
let root = process.env.VIDEOEYE_CACHE_DIR;
if (mode === "offline") root = await mkdtemp(path.join(os.tmpdir(), "videoeye-smoke-"));
const options = { cache: new VideoCache(root ?? path.resolve("data/videoeye")), worker: mock };
if (mode === "offline" || mode === "muse-direct") {
  options.resolver = { async resolve(sourceUrl) {
    return { videoId: museId, sourceUrl, title: "Muse 测试视频", author: "", duration: 0, mp4Url: directUrl };
  } };
}
if (mode === "offline") {
  const bytes = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom"), Buffer.alloc(128)]);
  options.downloader = { async download() {
    downloads++;
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } };
}

try {
  const eye = new VideoEye(options);
  const first = await eye.analyze(`复制打开抖音 ${museUrl} 测试`, "这段视频讲了什么？");
  const second = await eye.analyze(museUrl, "再看一次");
  const actual = await stat(first.metadata.mp4_path);
  const contents = await readFile(first.metadata.mp4_path);
  console.log(JSON.stringify({
    mode, video_id: first.videoId, mp4_path: first.metadata.mp4_path,
    mp4_bytes: actual.size, mp4_signature: contents.toString("ascii", 4, 8),
    first_cache_hit: first.cacheHit, second_cache_hit: second.cacheHit,
    downloads: mode === "offline" ? downloads : undefined,
    worker_calls: mock.calls.length, provider: first.result.provider,
    metadata_path: path.join(eye.cache.root, "metadata", `${first.videoId}.json`),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ mode, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  if (mode === "offline" && root) await rm(root, { recursive: true, force: true });
}
