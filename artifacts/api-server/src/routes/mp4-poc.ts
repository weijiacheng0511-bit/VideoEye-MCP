import { registerVideoEyeTools } from "../videoeye/mcp-tools";
import { Router, type IRouter, type Request } from "express";
import { OfficialMp4Downloader, allowedMp4Url } from "../videoeye/mp4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const router: IRouter = Router();
const DEFAULT = "https://api-play.amemv.com/aweme/v1/play/?video_id=v0d00fg10000daplji7og65q66shuom0&line=0&ratio=1080p&aid=1967";
const PUBLIC = "https://bumpy-untidy-equation--weijiacheng0511.replit.app";
const RESOURCE = "ui://widget/mp4-upload-test-v1.html";
const MAX_BYTES = 50 * 1024 * 1024;
const HTML = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>MP4 上传测试</title><style>body{font:15px system-ui,sans-serif;background:#f4f6f8;color:#17212b;margin:0;padding:24px}main{max-width:760px;margin:auto;background:white;padding:24px;border-radius:16px}h1{font-size:24px;margin-top:0}p{line-height:1.6;color:#4d5c69}label{display:block;font-weight:600;margin:20px 0 8px}textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab6c2;border-radius:8px;resize:vertical;font:13px monospace}button{padding:12px 16px;border:0;border-radius:8px;background:#116a58;color:white;font:inherit;cursor:pointer;margin:12px 8px 0 0}button:disabled{opacity:.45;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eff4f3;padding:16px;border-radius:8px;line-height:1.6}small{color:#52616c}video{width:100%;max-height:280px;margin-top:16px}</style><main><h1>MP4 上传测试</h1><p>分步核验：获取完整视频 → 上传到 ChatGPT → 检查模型能否读取。每一步单独记录结果。</p><small id=\"env\"></small><label for=\"source\">抖音视频直链</label><textarea id=\"source\" rows=\"4\"></textarea><button id=\"fetch\">1. 获取并检查 MP4</button><button id=\"upload\" disabled>2. 上传到 ChatGPT</button><button id=\"verify\" disabled>3. 请求读取验证</button><pre id=\"result\" role=\"status\" aria-live=\"polite\">等待测试</pre><video id=\"video\" controls hidden></video></main><script>\nconst BASE=__BASE__, DEFAULT=__DEFAULT__;\nconst $=id=>document.getElementById(id);\n$('source').value=DEFAULT;\nlet file=null,objectUrl=null,report={},busy=false,nextId=1; const pending=new Map();\nfunction bridge(method,params){return new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('宿主接口未响应'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}\nwindow.addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.jsonrpc!=='2.0')return;const item=pending.get(e.data.id);if(item){clearTimeout(item.timer);pending.delete(e.data.id);e.data.error?item.reject(new Error(e.data.error.message)):item.resolve(e.data.result);}});\nif(parent!==window)bridge('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'mp4-upload-test',version:'1.0.0'},appCapabilities:{}}).then(()=>parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*')).catch(()=>{});\nfunction render(){const host=typeof window.openai?.uploadFile==='function';$('env').textContent=host?'已检测到 ChatGPT 上传接口':'普通浏览器环境：可以验证视频；上传步骤须在 ChatGPT 插件卡片中执行。';$('fetch').disabled=busy;$('upload').disabled=busy||!file||!host;$('verify').disabled=busy||!report.fileId;$('result').textContent=JSON.stringify(report,null,2);}\nwindow.addEventListener('openai:set_globals',render);\nfunction reset(){file=null;report={};if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;$('video').removeAttribute('src');$('video').hidden=true;}\n$('source').addEventListener('input',()=>{reset();render();});\n$('fetch').onclick=async()=>{reset();busy=true;report={fetch:'正在获取完整视频…',upload:'未测试',modelAccess:'未测试'};render();try{const response=await fetch(BASE+'/api/mp4-proxy?url='+encodeURIComponent($('source').value.trim()),{signal:AbortSignal.timeout(100000)});if(!response.ok){const detail=await response.json().catch(()=>({error:'HTTP '+response.status}));throw new Error(detail.error);}const bytes=await response.arrayBuffer();if(bytes.byteLength<12||new TextDecoder().decode(bytes.slice(4,8))!=='ftyp')throw new Error('返回内容不是 MP4');const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');const expected=response.headers.get('X-MP4-SHA256');if(expected&&expected!==sha)throw new Error('传输校验不一致');file=new File([bytes],'douyin-test.mp4',{type:'video/mp4'});report={fetch:'通过：完整 MP4 已获取',bytes:file.size,sha256:sha,upload:'未测试',modelAccess:'未测试'};objectUrl=URL.createObjectURL(file);$('video').src=objectUrl;$('video').hidden=false;}catch(e){report.fetch='失败：'+e.message;}finally{busy=false;render();}};\n$('upload').onclick=async()=>{busy=true;delete report.fileId;report.upload='上传中…';report.modelAccess='未测试';render();try{const result=await window.openai.uploadFile(file);if(typeof result?.fileId!=='string'||!result.fileId)throw new Error('宿主未返回真实 fileId');report.fileId=result.fileId;report.upload='通过：宿主已返回 fileId';report.modelAccess='尚未验证，fileId 不代表模型已读取视频';window.openai.setWidgetState?.({modelContent:report,privateContent:{},imageIds:[]});if(parent!==window)bridge('ui/update-model-context',{content:[{type:'text',text:JSON.stringify(report)}]}).catch(()=>{});}catch(e){report.upload='失败：'+(e.message||String(e));}finally{busy=false;render();}};\n$('verify').onclick=async()=>{busy=true;render();try{await bridge('ui/message',{role:'user',content:[{type:'text',text:'MP4 上传测试返回 '+JSON.stringify(report)+'。请实际检查能否读取这个文件中的视频画面和音频；能读时描述开头的具体可见细节；无法读取请明确说无法读取，不要根据链接、标题或 fileId 推测内容。'}]});report.modelAccess='验证请求已发送，等待模型实际检查';}catch(e){report.modelAccess='请求失败：'+e.message;}finally{busy=false;render();}};render();\n</script></html>";
let active = 0;
let windowStart = 0;
let requests = 0;
function origin(req: Request): string {
  const host = req.get("host");
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  return dev && host === dev ? "https://" + dev : PUBLIC;
}
function html(base: string): string {
  return HTML.replace("__BASE__", JSON.stringify(base)).replace("__DEFAULT__", JSON.stringify(DEFAULT));
}
router.get("/mp4-test", (req, res) => { res.set("Cache-Control", "no-store").type("html").send(html(origin(req))); });
router.get("/mp4-proxy", async (req, res) => {
  let url: URL;
  try { url = allowedMp4Url(typeof req.query.url === "string" ? req.query.url : DEFAULT); }
  catch (error) { res.status(400).json({error: error instanceof Error ? error.message : "无效地址"}); return; }
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; requests = 0; }
  if (active >= 2 || requests >= 12) { res.status(429).json({error:"测试请求过于频繁，请稍后重试"}); return; }
  active++; requests++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnect);
  try {
    const { bytes, sha256 } = await new OfficialMp4Downloader(MAX_BYTES).download(url.href);
    res.set({"Content-Type":"video/mp4","Cache-Control":"no-store","Content-Disposition":"inline; filename=douyin-test.mp4","X-Content-Type-Options":"nosniff","X-MP4-SHA256":sha256,"Access-Control-Expose-Headers":"X-MP4-SHA256, Content-Length"}).send(bytes);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) res.status(502).json({error:controller.signal.aborted ? "视频获取超时或连接已中断" : error instanceof Error ? error.message : "视频获取失败"});
  } finally { controller.abort(); clearTimeout(timeout); res.off("close",disconnect); active--; }
});
function createServer(base: string): McpServer {
  const server = new McpServer({name:"videoeye-mcp",version:"1.1.0"});
  server.registerResource("mp4-upload-test",RESOURCE,{},async()=>({contents:[{uri:RESOURCE,mimeType:"text/html;profile=mcp-app",text:html(base),_meta:{ui:{prefersBorder:true,csp:{connectDomains:[base],resourceDomains:[]}},"openai/widgetDescription":"Minimal MP4 fetch and ChatGPT upload test. A fileId does not establish model access.","openai/widgetCSP":{connect_domains:[base],resource_domains:[]}}}]}));
  registerVideoEyeTools(server);
  return server;
}
router.post("/mcp", async(req,res)=>{
  const server = createServer(origin(req));
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on("close",()=>{void transport.close();void server.close();});
  try { await server.connect(transport); await transport.handleRequest(req,res,req.body); }
  catch { if(!res.headersSent)res.status(500).json({jsonrpc:"2.0",id:null,error:{code:-32603,message:"MCP request failed"}}); }
});
router.all("/mcp",(_req,res)=>{res.set("Allow","POST").status(405).json({jsonrpc:"2.0",id:null,error:{code:-32000,message:"Use POST for this stateless MCP endpoint"}});});
export default router;
