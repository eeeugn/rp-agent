/**
 * test-mock.ts — 用本地 mock OpenAI SSE 服务器验证 rp-agent 完整调用链
 * 不需要真实 API key，零成本验证：HTTP 请求格式、消息组装、流式解析、事件处理。
 */

// 必须在 import rp-agent 之前设置环境变量（provider 在模块加载时构造）
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:18080/v1";
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.MODEL = "deepseek-v4-flash";
process.env.THINKING = "high";

import http from "node:http";

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const parsed = JSON.parse(body);
        console.log("\n[mock] 收到 " + req.method + " " + req.url);
        console.log("[mock] model:", parsed.model);
        console.log("[mock] messages 条数:", parsed.messages.length);
        console.log("[mock] 首条消息 role:", parsed.messages[0]?.role, "| 前60字:", String(parsed.messages[0]?.content ?? "").slice(0, 60));
        const systemMsgs = parsed.messages.filter((m) => m.role === "system" || m.role === "developer");
        console.log("[mock] 请求体里 system 角色消息数:", systemMsgs.length);
        console.log("[mock] reasoning_effort:", parsed.reasoning_effort ?? "(未传)");
        console.log("[mock] max_tokens:", parsed.max_tokens ?? parsed.max_completion_tokens ?? "(未传)");

        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
        });

        const content = "夜深了，娃娃蹲在床沿，手指在睡裙下摆里轻轻动着，咕啾咕啾的水声在黑暗里格外清楚。";
        for (let i = 0; i < content.length; i += 12) {
            const chunk = content.slice(i, i + 12);
            const payload = {
                id: "chatcmpl-mock-1",
                object: "chat.completion.chunk",
                created: Date.now(),
                model: parsed.model,
                choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
        res.write(
            `data: ${JSON.stringify({
                id: "chatcmpl-mock-1",
                object: "chat.completion.chunk",
                created: Date.now(),
                model: parsed.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
    });
});

await new Promise((r) => server.listen(18080, "127.0.0.1", r));
console.log("[mock] 服务器已启动 127.0.0.1:18080");

const { generate, buildInitialMessages, loadCharacter } = await import("../rp-agent.ts");

const messages = buildInitialMessages(loadCharacter("character.json"));
messages.push({ role: "user", content: "我搂过娃娃。", timestamp: Date.now() });

console.log("\n=== 调用 generate（输出即流式渲染） ===");
const reply = await generate(messages);
console.log("=== 返回消息结构 ===");
console.log("role:", reply.role, "| stopReason:", reply.stopReason);
const text = reply.content
    .map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? `[思考:${b.thinking.slice(0, 30)}...]` : `[${b.type}]`))
    .join("");
console.log("内容:", text);

server.close();
console.log("\n=== 验证通过：完整调用链正常 ===");
