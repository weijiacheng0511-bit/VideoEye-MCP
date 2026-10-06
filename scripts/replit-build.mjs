import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file is the one-time bootstrap in the existing Replit project. Product
// source and dependencies always come from GitHub main during publishing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = process.env.VIDEOEYE_BUILD_REPOSITORY || "https://github.com/weijiacheng0511-bit/VideoEye-MCP.git";
const release = path.join(root, ".videoeye-release");
const lock = path.join(root, ".videoeye-build.lock");
const stamp = path.join(release, ".build-complete.json");

function command(executable, args, cwd = root, extraEnv = {}, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...extraEnv },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true, shell: process.platform === "win32" && ["pnpm", "npm"].includes(executable) });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} exited with ${code}`)));
  });
}

let handle;
const deadline = Date.now() + 15 * 60_000;
while (!handle) {
  try { handle = await open(lock, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

try {
  const remoteHead = await command("git", ["ls-remote", repository, "refs/heads/main"], root, {}, true);
  const commit = remoteHead.split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot resolve GitHub main; refusing to deploy stale workspace code");
  let built;
  try { built = JSON.parse(await readFile(stamp, "utf8")); } catch { /* fresh build */ }
  if (built?.source_commit !== commit) {
    await rm(release, { recursive: true, force: true });
    await mkdir(release, { recursive: true });
    await command("git", ["init", "--quiet"], release);
    await command("git", ["fetch", "--depth=1", repository, commit], release);
    await command("git", ["checkout", "--detach", "FETCH_HEAD"], release);
    const environment = { CI: "true", BASE_PATH: "/", PORT: "8080", VIDEOEYE_SOURCE_COMMIT: commit };
    // Replit's global pnpm can recurse while switching to the packageManager pin.
    // npm exec selects the exact CLI independently and caches it for later steps.
    // A CLI path override supports hosts that already provide pnpm as a JS file.
    const pnpmCommand = (args, capture = false) => process.env.VIDEOEYE_PNPM_CLI
      ? command(process.execPath, [process.env.VIDEOEYE_PNPM_CLI, ...args], release, environment, capture)
      : command("npm", ["exec", "--yes", "--package=pnpm@11.19.0", "--", "pnpm", ...args], release, environment, capture);
    const pnpm = (...args) => pnpmCommand(args);
    const installedVersion = await pnpmCommand(["--version"], true);
    if (installedVersion !== "11.19.0") throw new Error(`Expected pnpm 11.19.0, received ${installedVersion}`);
    await command(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
    await pnpm("install", "--frozen-lockfile", "--prod=false");
    await pnpm("run", "build");
    await pnpm("--filter", "@workspace/api-server", "run", "videoeye:smoke", "offline");
    for (const test of ["videoeye:mcp-smoke", "videoeye:qwen-normalize-smoke", "videoeye:inspect-clip-smoke"]) {
      await pnpm("--filter", "@workspace/api-server", "run", test);
    }
    await writeFile(stamp, JSON.stringify({ source_commit: commit, built_at: new Date().toISOString() }) + "\n");
    await rm(path.join(release, ".git"), { recursive: true, force: true });
  }
  console.log(JSON.stringify({ event: "videoeye_build_verified", source_commit: commit, release }));
} finally {
  await handle.close();
  await rm(lock, { force: true });
}
