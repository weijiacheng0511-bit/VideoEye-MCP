import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// MCP standard tool result ResourceLink and EmbeddedResource, without uploadFile.
// Specs: /specification/2025-11-25/server/{tools,resources} at modelcontextprotocol.io.
const FILE_NAME = "douyin-test.mp4";
const MIME = "video/mp4";
const EXPECTED_SIZE = 14570580;
const EXPECTED_SHA = "3bb0ebd4c5ca9e33e1fbd0ec00378e668380e5b8c478aa43c9c58c66e23d254b";

async function existingMp4(): Promise<Buffer> {
  const port = Number(process.env["PORT"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid API server port");
  // Reuse the proven downloader without changing its logic or source URL.
  const response = await fetch("http://127.0.0.1:" + port + "/api/mp4-proxy", { signal: AbortSignal.timeout(95000) });
  if (!response.ok) throw new Error("Existing MP4 endpoint failed: HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.headers.get("content-type")?.split(";")[0] !== MIME || bytes.length !== EXPECTED_SIZE || createHash("sha256").update(bytes).digest("hex") !== EXPECTED_SHA) throw new Error("MP4 integrity check failed; no resource was returned");
  return bytes;
}

export function registerMp4ResourceTools(server: McpServer, base: string): void {
  const uri = base + "/api/mp4-proxy";
  const resourceInfo = { name: FILE_NAME, title: "MP4 test file", description: "Original MP4 test file. No transcription, OCR, frame extraction, or alternate model analysis.", mimeType: MIME, size: EXPECTED_SIZE };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const outputSchema = { delivery: z.enum(["resource_link", "embedded_resource"]), resourceUri: z.string(), fileName: z.string(), mimeType: z.literal("video/mp4"), bytes: z.number().int(), sha256: z.string(), hostAcceptance: z.literal("unverified"), modelAccess: z.literal("unverified") };
  function resultInfo(delivery: "resource_link" | "embedded_resource") {
    return { delivery, resourceUri: uri, fileName: FILE_NAME, mimeType: MIME, bytes: EXPECTED_SIZE, sha256: EXPECTED_SHA, hostAcceptance: "unverified" as const, modelAccess: "unverified" as const };
  }
  const guidance = "This is the original video/mp4 resource. A valid MCP resource is not proof that ChatGPT imported it or that the model can read video. Report actual host acceptance and direct model access separately; if unavailable, say so. Do not infer content from the URL or filename. Do not transcribe, OCR, extract frames, or call another model.";
  server.registerResource(FILE_NAME, uri, resourceInfo, async () => ({
    contents: [{ uri, mimeType: MIME, blob: (await existingMp4()).toString("base64") }]
  }));
  server.registerTool("get_mp4_file_reference", {
    title: "Return MP4 file reference",
    description: "Return the verified original MP4 as an official MCP resource_link (video/mp4), directly in the tool result. Use this first to test ChatGPT host file-reference acceptance. No browser upload and no analysis.",
    inputSchema: {}, outputSchema, annotations
  }, async () => {
    await existingMp4();
    const info = resultInfo("resource_link");
    return { content: [
      { type: "resource_link" as const, uri, ...resourceInfo, annotations: { audience: ["user" as const, "assistant" as const], priority: 1 } },
      { type: "text" as const, text: JSON.stringify(info) + "\n" + guidance }
    ], structuredContent: info };
  });
  server.registerTool("get_mp4_embedded_resource", {
    title: "Return original MP4 as binary resource",
    description: "Explicit compatibility test: return the complete unchanged video/mp4 as an official MCP embedded resource with base64 blob. The binary is 14,570,580 bytes; JSON is approximately 19.4 MB. Use only when specifically testing embedded binary resource acceptance. Does not call uploadFile or analyze video.",
    inputSchema: {}, outputSchema, annotations
  }, async () => {
    const bytes = await existingMp4();
    const info = resultInfo("embedded_resource");
    return { content: [
      { type: "resource" as const, resource: { uri, mimeType: MIME, blob: bytes.toString("base64") }, annotations: { audience: ["user" as const, "assistant" as const], priority: 1 } },
      { type: "text" as const, text: JSON.stringify(info) + "\n" + guidance }
    ], structuredContent: info };
  });
}
