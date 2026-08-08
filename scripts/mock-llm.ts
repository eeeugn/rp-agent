/**
 * mock-llm.ts — 本地 mock OpenAI SSE 服务器（持续服务，测试 Web 界面用）
 * MOCK_TOOL=1 时：第一轮返回工具调用（update_character），后续返回正常文本
 *
 * 运行：node --experimental-strip-types mock-llm.ts
 * 然后：$env:DEEPSEEK_BASE_URL="http://127.0.0.1:18080/v1"; $env:DEEPSEEK_API_KEY="test"; npm run web
 */
import http from "node:http";

let requestCount = 0;
const MOCK_TOOL = process.env.MOCK_TOOL === "1" || process.env.MOCK_TOOL === "web";
const MOCK_WEB = process.env.MOCK_TOOL === "web";

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const n = requestCount++;
        console.log(`[mock-llm] #${n} ${req.method} ${req.url} | model=${parsed.model} | messages=${parsed.messages?.length ?? 0} | tools=${parsed.tools?.length ?? 0}`);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

        const chunk = (payload) => {
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Date.now(), model: parsed.model, choices: [{ index: 0, ...payload }] })}\n\n`);
        };

        // 工具模拟：MOCK_TOOL 且当前请求消息里还没有 toolResult（第一轮）
        const hasToolResult = (parsed.messages ?? []).some((m) => m.role === "tool");
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        if (MOCK_TOOL && hasTools && !hasToolResult) {
            // 第一轮：返回工具调用
            chunk({
                delta: {
                    tool_calls: [
                        {
                            index: 0,
                            id: "call_mock_1",
                            type: "function",
                            function: {
                                name: MOCK_WEB ? "web_search" : "update_character",
                                arguments: MOCK_WEB ? '{"query":"hello world","max_results":2}' : '{"field":"scenario","value":"测试新场景：午后的小公园"}',
                            },
                        },
                    ],
                },
                finish_reason: null,
            });
            chunk({ delta: {}, finish_reason: "tool_calls" });
            res.write("data: [DONE]\n\n");
            res.end();
            return;
        }

        // 正常文本流
        const content = "傍晚的雨刚停，老街的石板路上还汪着一层薄薄的水光。林默把门口的书架往里搬了搬，抬头看见你站在屋檐下，镜片后的眼睛弯了弯：“进来坐？炉子上还温着茶，刚泡的。”";
        for (let i = 0; i < content.length; i += 12) {
            chunk({ delta: { content: content.slice(i, i + 12) }, finish_reason: null });
        }
        chunk({ delta: {}, finish_reason: "stop" });
        res.write("data: [DONE]\n\n");
        res.end();
    });
});

server.listen(18080, "127.0.0.1", () => {
    console.log(`[mock-llm] http://127.0.0.1:18080 持续服务中（MOCK_TOOL=${MOCK_TOOL ? "1" : "0"}，Ctrl+C 退出）`);
});
