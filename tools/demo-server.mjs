import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const demoPath = fileURLToPath(new URL("../demo/index.html", import.meta.url));
export function createDemoServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (["/", "/demo"].includes(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await readFile(demoPath)); return;
    }
    // A deterministic mock endpoint; it runs only on the local test server.
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      server.aiRequests++;
      let input = "";
      for await (const chunk of req) { input += chunk; if (input.length > 100000) { res.writeHead(413).end(); return; } }
      let body;
      try { body = JSON.parse(input); } catch { res.writeHead(400).end(); return; }
      if (req.headers.authorization !== "Bearer demo-key") { res.writeHead(401).end(); return; }
      let question;
      try { question = JSON.parse(body.messages?.at(-1)?.content); } catch { res.writeHead(400).end(); return; }
      const stem = question.stem || "";
      const answers = /质数/.test(stem) ? ["A", "C"] : /地球/.test(stem) ? ["B"] : ["A"];
      if (body.model === "demo-slow") await new Promise(resolve => setTimeout(resolve, 1800));
      if (body.model === "demo-timeout") await new Promise(resolve => setTimeout(resolve, 4500));
      const data = { answers, confidence: body.model === "demo-low" ? 0.4 : 0.99, explanation: "本地演示固定答案，仅验证扩展操作流程。" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }] })); return;
    }
    res.writeHead(404).end("Not found");
  });
  server.aiRequests = 0;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDemoServer().listen(8765, "127.0.0.1", () => console.log("模拟页：http://127.0.0.1:8765/demo\n本地测试 API：http://127.0.0.1:8765/v1/chat/completions\n模型：demo；密钥：demo-key\n按 Ctrl+C 停止。"));
}
