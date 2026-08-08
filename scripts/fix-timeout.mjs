// fix-timeout.mjs — Agent 评估与世界推演加超时保护
import { readFileSync, writeFileSync } from "node:fs";

const file = "E:/rp-demo/rp-server.ts";
let c = readFileSync(file, "utf-8");

// 1. runAgentLoop 的 generate 加 150s 超时
const oldRun = `        const { final } = await generate(
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
            undefined,
            TOOLS,
            buildManagerPrompt(),
        );`;
const newRun = `        const { final } = await generate(
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
        );`;
if (!c.includes(oldRun)) throw new Error("run not found");
c = c.replace(oldRun, newRun);

// 2. advanceWorld 的 generate 加 120s 超时
const oldAdv = `        const { final } = await generate(msgs, {}, undefined, undefined, WORLD_SIM_PROMPT);`;
const newAdv = `        const { final } = await generate(msgs, {}, AbortSignal.timeout(120000), undefined, buildWorldSimPrompt());`;
if (!c.includes(oldAdv)) throw new Error("adv not found");
c = c.replace(oldAdv, newAdv);

writeFileSync(file, c, "utf-8");
console.log("rp-server.ts ✓ (超时保护)");
