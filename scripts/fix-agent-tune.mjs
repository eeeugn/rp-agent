// fix-agent-tune.mjs — 基于真实测试的 Agent 行为调整
import { readFileSync, writeFileSync } from "node:fs";

const file = "E:/rp-demo/rp-server.ts";
let c = readFileSync(file, "utf-8");
const NL = "\n";

// 1. add_worldinfo 工具加 public 参数
const oldAddTool = `    {
        name: "add_worldinfo",
        description: "向当前角色的世界书添加一条条目。keys 为触发关键词列表（用户输入包含任一关键词时自动注入），content 为条目内容。",
        parameters: Type.Object({
            keys: Type.Array(Type.String()),
            content: Type.String(),
        }),
    },`;
const newAddTool = `    {
        name: "add_worldinfo",
        description:
            "向当前角色的世界书添加一条条目。keys 为触发关键词列表（用户输入包含任一关键词时自动注入），content 为条目内容。public 为可见性：true=角色公开知识（默认），false=角色不知道的秘密（隐藏，需 reveal 揭示）。重要秘密/反派底细应设 false。",
        parameters: Type.Object({
            keys: Type.Array(Type.String()),
            content: Type.String(),
            public: Type.Optional(Type.Boolean()),
        }),
    },`;
if (!c.includes(oldAddTool)) throw new Error("add tool not found");
c = c.replace(oldAddTool, newAddTool);

// 2. applyTool add_worldinfo 支持 public
const oldAddCase = `        case "add_worldinfo": {
            const entry: WorldInfoEntry = {
                id: randomUUID(),
                characterId: currentChar.id,
                keys: Array.isArray(args.keys) ? args.keys.map(String) : [],
                content: String(args.content ?? ""),
                enabled: true,
            };`;
const newAddCase = `        case "add_worldinfo": {
            const entry: WorldInfoEntry = {
                id: randomUUID(),
                characterId: currentChar.id,
                keys: Array.isArray(args.keys) ? args.keys.map(String) : [],
                content: String(args.content ?? ""),
                enabled: true,
                public: args.public !== false,
            };`;
if (!c.includes(oldAddCase)) throw new Error("add case not found");
c = c.replace(oldAddCase, newAddCase);

// 3. MANAGER_PROMPT 强化：advance 限次 + 建档分可见性
const oldMgrText = `    const modeText =
        agentSettings.evolutionMode === "active"
            ? "鼓励主动演化：多调用 advance_world 推演世界、多为新人物/地点建档、主动制造可呼应的事件线索。"
            : agentSettings.evolutionMode === "minimal"
              ? "克制：仅在出现明显事件、新人物或剧情矛盾时才行动，其余时间回复'无需调整'。"
              : "平衡：按需行动，不放过明显事件，也不过度干预。";`;
const newMgrText = `    const modeText =
        agentSettings.evolutionMode === "active"
            ? "鼓励主动演化：世界有明确变化时推进一次、多为新人物/地点建档、主动制造可呼应的事件线索。"
            : agentSettings.evolutionMode === "minimal"
              ? "克制：仅在出现明显事件、新人物或剧情矛盾时才行动，其余时间回复'无需调整'。"
              : "平衡：按需行动，不放过明显事件，也不过度干预。";`;
if (!c.includes(oldMgrText)) throw new Error("mgr text not found");
c = c.replace(oldMgrText, newMgrText);

// 4. runAgentLoop：advance_world 限 1 次 + 上限错误优雅化
const oldLoop = `        const { final } = await generate(
            msgs,
            {
                onToolCall: async (name, args) => {
                    console.log("[agent-loop] 调用工具:", name, JSON.stringify(args));
                    const result = await applyTool(name, args);
                    saveSession();
                    actions.push(\`🔧 \${name}(\${Object.keys(args).slice(0, 2).map((k) => k + "=" + String(args[k]).slice(0, 20)).join(", ")})\`);
                    return result;
                },
            },
            AbortSignal.timeout(150000), // 150s 超时，防止模型挂起卡死
            TOOLS,
            buildManagerPrompt(),
        );
        const text = textOf(final);
        if (text && !/无需调整|不需要调整|不需要操作|无需操作/.test(text)) {
            actions.push(text.slice(0, 120));
        }
        if (actions.length) {
            saveSession();
        }
    } catch (e) {
        console.error("[agent-loop] 失败:", e);
        actions.push("⚠ Agent 评估失败：" + (e instanceof Error ? e.message : String(e)));
    }
    return actions;
}`;
const newLoop = `        let advanceUsed = false;
        const { final } = await generate(
            msgs,
            {
                onToolCall: async (name, args) => {
                    // 限流：同一评估周期内 advance_world 最多一次（防止重复推演拖垮评估）
                    if (name === "advance_world") {
                        if (advanceUsed) {
                            return "本评估周期已推进过世界，不要重复推进。如需微调单个 NPC 请用 update_npc/add_npc，调整时间用 set_world_time。";
                        }
                        advanceUsed = true;
                    }
                    console.log("[agent-loop] 调用工具:", name, JSON.stringify(args));
                    const result = await applyTool(name, args);
                    saveSession();
                    actions.push(\`🔧 \${name}(\${Object.keys(args).slice(0, 2).map((k) => k + "=" + String(args[k]).slice(0, 20)).join(", ")})\`);
                    return result;
                },
            },
            AbortSignal.timeout(150000), // 150s 超时，防止模型挂起卡死
            TOOLS,
            buildManagerPrompt(),
        );
        const text = textOf(final);
        if (text && !/无需调整|不需要调整|不需要操作|无需操作/.test(text)) {
            actions.push(text.slice(0, 120));
        }
        if (actions.length) {
            saveSession();
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 工具上限截断不是失败：保留已执行的 actions
        if (!/工具调用超过/.test(msg)) {
            console.error("[agent-loop] 失败:", e);
            actions.push("⚠ Agent 评估失败：" + msg);
        }
    }
    return actions;
}`;
if (!c.includes(oldLoop)) throw new Error("loop not found");
c = c.replace(oldLoop, newLoop);

writeFileSync(file, c, "utf-8");
console.log("rp-server.ts ✓ (Agent 行为调整就绪)");
