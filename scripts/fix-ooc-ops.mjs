// fix-ooc-ops.mjs — OOC 消息操作：编辑/删除/重生成
import { readFileSync, writeFileSync } from "node:fs";

const file = "E:/rp-demo/rp-server.ts";
let c = readFileSync(file, "utf-8");

// 1. 拆分 buildAgentSnapshot（重生成时不需要追加新 user 消息）
const oldBuild = `function buildAgentContext(userContent: string): Message[] {
    const snapshot = [
        \`【角色卡】\`,
        \`名称：\${currentChar.name}\`,
        \`描述：\${currentChar.description}\`,
        \`性格：\${currentChar.personality}\`,
        \`场景：\${currentChar.scenario}\`,
        \`世界：\${currentChar.world}\`,
        \`规则：\${currentChar.rules.join("；")}\`,
        \`【世界书】\`,
        currentWorldInfo().length
            ? currentWorldInfo().map((e) => \`- [\${e.keys.join("/")}] \${e.enabled ? "" : "(已禁用) "}\${e.content}\`).join("\\n")
            : "（空）",
    ].join("\\n");
    return [
        { role: "user", content: snapshot, timestamp: Date.now() },
        ...oocMessages,
        { role: "user", content: userContent, timestamp: Date.now() },
    ];
}`;
const newBuild = `function buildAgentSnapshot(): Message {
    const snapshot = [
        \`【角色卡】\`,
        \`名称：\${currentChar.name}\`,
        \`描述：\${currentChar.description}\`,
        \`性格：\${currentChar.personality}\`,
        \`场景：\${currentChar.scenario}\`,
        \`世界：\${currentChar.world}\`,
        \`规则：\${currentChar.rules.join("；")}\`,
        \`【世界书】\`,
        currentWorldInfo().length
            ? currentWorldInfo().map((e) => \`- [\${e.keys.join("/")}] \${e.enabled ? "" : "(已禁用) "}\${e.content}\`).join("\\n")
            : "（空）",
    ].join("\\n");
    return { role: "user", content: snapshot, timestamp: Date.now() };
}

function buildAgentContext(userContent: string): Message[] {
    return [
        buildAgentSnapshot(),
        ...oocMessages,
        { role: "user", content: userContent, timestamp: Date.now() },
    ];
}

// OOC 生成（流式）。userContent 非 null 时生成后入库 user+final；null 时（重生成）只入库 final
async function generateOocToSSE(res: http.ServerResponse, ctx: Message[], userContent: string | null): Promise<void> {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const ac = new AbortController();
    currentAbort = ac;
    try {
        const { final } = await generate(
            ctx,
            {
                onThinkingDelta: (d) => sse(res, { type: "thinking", delta: d }),
                onTextDelta: (d) => sse(res, { type: "text", delta: d }),
                onThinkingEnd: () => sse(res, { type: "thinking_end" }),
                onToolCall: async (name, args) => {
                    console.log("[tool:ooc] " + name, JSON.stringify(args));
                    sse(res, { type: "tool", name, args });
                    const result = applyTool(name, args);
                    saveSession();
                    return result;
                },
            },
            ac.signal,
            TOOLS,
        );
        if (userContent) {
            oocMessages.push({ role: "user", content: userContent, timestamp: Date.now() });
        }
        oocMessages.push(final);
        if (oocMessages.length > OOC_MAX * 2) oocMessages.splice(0, oocMessages.length - OOC_MAX * 2);
        sse(res, {
            type: "done",
            message: {
                id: "ooc-" + (oocMessages.length - 1),
                role: "assistant",
                content: textOf(final),
                thinking: thinkingOf(final),
                ooc: true,
                versions: [],
                timestamp: Date.now(),
            },
        });
    } catch (err) {
        sse(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
        if (currentAbort === ac) currentAbort = null;
        saveSession();
        res.end();
    }
}`;
if (!c.includes(oldBuild)) throw new Error("buildAgentContext not found");
c = c.replace(oldBuild, newBuild);

// 2. /api/ooc 路由改用 generateOocToSSE
const oldOocRoute = `        if (req.method === "POST" && pathname === "/api/ooc") {
            const { content } = await readBody();
            if (typeof content !== "string" || !content.trim()) {
                json(400, { error: "content required" });
                return;
            }
            const oocCtx = buildAgentContext(content.trim());
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            const ac = new AbortController();
            currentAbort = ac;
            try {
                const { final } = await generate(
                    oocCtx,
                    {
                        onThinkingDelta: (d) => sse(res, { type: "thinking", delta: d }),
                        onTextDelta: (d) => sse(res, { type: "text", delta: d }),
                        onThinkingEnd: () => sse(res, { type: "thinking_end" }),
                        onToolCall: async (name, args) => {
                            console.log("[tool:ooc] " + name, JSON.stringify(args));
                            sse(res, { type: "tool", name, args });
                            const result = applyTool(name, args);
                            saveSession();
                            return result;
                        },
                    },
                    ac.signal,
                    TOOLS,
                );
                oocMessages.push({ role: "user", content: content.trim(), timestamp: Date.now() });
                oocMessages.push(final);
                if (oocMessages.length > OOC_MAX * 2) oocMessages.splice(0, oocMessages.length - OOC_MAX * 2);
                sse(res, {
                    type: "done",
                    message: {
                        id: "ooc-" + (oocMessages.length - 1),
                        role: "assistant",
                        content: textOf(final),
                        thinking: thinkingOf(final),
                        ooc: true,
                        versions: [],
                        timestamp: Date.now(),
                    },
                });
            } catch (err) {
                sse(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
            } finally {
                if (currentAbort === ac) currentAbort = null;
                saveSession();
                res.end();
            }
            return;
        }`;
const newOocRoute = `        if (req.method === "POST" && pathname === "/api/ooc") {
            const { content } = await readBody();
            if (typeof content !== "string" || !content.trim()) {
                json(400, { error: "content required" });
                return;
            }
            const oocCtx = buildAgentContext(content.trim());
            await generateOocToSSE(res, oocCtx, content.trim());
            return;
        }

        // POST /api/ooc/messages/:index/delete — 删除该条及之后所有 OOC 消息
        const oocDelMatch = pathname.match(/^\\/api\\/ooc\\/messages\\/(\\d+)\\/delete$/);
        if (req.method === "POST" && oocDelMatch) {
            const idx = Number(oocDelMatch[1]);
            if (idx < 0 || idx >= oocMessages.length) {
                json(404, { error: "ooc message not found" });
                return;
            }
            oocMessages.splice(idx);
            saveSession();
            json(200, { ok: true });
            return;
        }

        // POST /api/ooc/messages/:index/edit {content} — 编辑 OOC user 消息并删除后续
        const oocEditMatch = pathname.match(/^\\/api\\/ooc\\/messages\\/(\\d+)\\/edit$/);
        if (req.method === "POST" && oocEditMatch) {
            const idx = Number(oocEditMatch[1]);
            if (idx < 0 || idx >= oocMessages.length) {
                json(404, { error: "ooc message not found" });
                return;
            }
            if (oocMessages[idx].role !== "user") {
                json(400, { error: "only user messages can be edited" });
                return;
            }
            const { content } = await readBody();
            if (typeof content !== "string" || !content.trim()) {
                json(400, { error: "content required" });
                return;
            }
            oocMessages[idx] = { role: "user", content: content.trim(), timestamp: oocMessages[idx].timestamp };
            oocMessages.splice(idx + 1);
            saveSession();
            json(200, { ok: true });
            return;
        }

        // POST /api/ooc/messages/:index/regenerate — 重生成该条 OOC assistant 消息（SSE）
        const oocRegenMatch = pathname.match(/^\\/api\\/ooc\\/messages\\/(\\d+)\\/regenerate$/);
        if (req.method === "POST" && oocRegenMatch) {
            const idx = Number(oocRegenMatch[1]);
            if (idx < 0 || idx >= oocMessages.length) {
                json(404, { error: "ooc message not found" });
                return;
            }
            if (oocMessages[idx].role !== "assistant") {
                json(400, { error: "only assistant messages can be regenerated" });
                return;
            }
            oocMessages.splice(idx);
            saveSession();
            const ctx = [buildAgentSnapshot(), ...oocMessages];
            await generateOocToSSE(res, ctx, null);
            return;
        }`;
if (!c.includes(oldOocRoute)) throw new Error("ooc route not found");
c = c.replace(oldOocRoute, newOocRoute);

writeFileSync(file, c, "utf-8");
console.log("rp-server.ts ✓ (OOC 消息操作 API)");
