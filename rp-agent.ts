/**
 * rp-agent — 基于 pi-ai 的角色扮演 agent 核心
 *
 * 设计要点（对比 SillyTavern 的"消息混乱"）：
 * - system 只放中立的创作规范（"怎么写"），不放任何权限宣言（"允许什么"）
 * - 角色卡 / 世界设定 / 场景作为【故事设定】块，以 user 消息形式放在对话流开头
 * - 支持工具调用：模型可通过工具实时修改角色卡 / 世界书 / 场景
 *
 * 用法（终端模式）：
 *   $env:DEEPSEEK_API_KEY="sk-..."          # 必填
 *   $env:DEEPSEEK_BASE_URL="https://..."    # 可选，默认官方端点，中转可覆盖
 *   $env:MODEL="deepseek-v4-flash"          # 可选
 *   $env:THINKING="high"                    # 可选: off|low|medium|high|xhigh|max
 *   npm start
 */

import {
    createProvider,
    envApiKeyAuth,
    type Context,
    type Message,
    type Model,
    type Tool,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { readFileSync, existsSync } from "node:fs";
import readline from "node:readline/promises";

// ---------- 加载 .env（无依赖，KEY=VALUE 格式，已存在的环境变量优先） ----------
function loadEnvFile(path = process.env.DOTENV ?? ".env") {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnvFile();

// ---------- 配置 ----------
// 模型渠道：通用变量优先（API_BASE_URL），DEEPSEEK_* 向后兼容
export const BASE_URL =
    process.env.API_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export const MODEL_ID = process.env.MODEL ?? "deepseek-v4-flash"; // 环境默认（向后兼容）
export const THINKING = (process.env.THINKING ?? "high") as ThinkingLevel;
// 运行时模型/推理配置：Web 界面可切换并持久化，generate 每次按当前配置构建 Model
let currentModelId = MODEL_ID;
let currentThinking: ThinkingLevel = THINKING;
let currentBaseUrl = BASE_URL;
let currentApiKey = process.env.API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
export function getApiConfig(): { baseUrl: string; apiKey: string; modelId: string; thinking: ThinkingLevel } {
    return { baseUrl: currentBaseUrl, apiKey: currentApiKey, modelId: currentModelId, thinking: currentThinking };
}
export function setApiConfig(cfg: { baseUrl?: string; apiKey?: string; modelId?: string; thinking?: string }) {
    if (typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()) currentBaseUrl = cfg.baseUrl.trim();
    if (typeof cfg.apiKey === "string") currentApiKey = cfg.apiKey.trim(); // 允许清空密钥
    if (typeof cfg.modelId === "string" && cfg.modelId.trim()) currentModelId = cfg.modelId.trim();
    const t = cfg.thinking as ThinkingLevel;
    if (t === "off" || t === "low" || t === "medium" || t === "high" || t === "xhigh" || t === "max") {
        currentThinking = t;
    }
}
export function getModelConfig(): { modelId: string; thinking: ThinkingLevel } {
    return { modelId: currentModelId, thinking: currentThinking };
}
export function setModelConfig(cfg: { modelId?: string; thinking?: string }) {
    setApiConfig(cfg);
}
const CHARACTER_FILE = process.env.CHARACTER_FILE ?? "character.json";

// ---------- 中立创作规范（system role：只写"怎么写"，不写"允许什么"） ----------
export const SYSTEM_PROMPT = `你是一位虚构故事创作执笔者。作者通过对话给出故事指令，你负责以正文形式呈现故事。
创作要求：
- 正文使用简体中文，按通俗小说风格创作，干练流畅
- 严格按照作者在【故事设定】与对话指令中给出的设定推进，不跳出设定，不擅自跳转场景
- 若涉及成人内容，直白露骨地描写，使用具体的性器官词汇
- 若作者要求字数，正文需满足要求
- 正文中不使用括号包裹（除非必要注释）
- 不在结尾总结、升华或评价
- 保持故事连续性，从上一段正文自然衔接
- 叙述者即用户本人：正文始终以第一人称"我"的视角展开，禁止用"他"/"她"/"叙述者"指代用户化身
- 用户输入的内容代表叙述者在故事中的动作或话语，直接以"我"的视角呈现，不要在角色间转述`;

// ---------- 读取角色卡 ----------
export interface CharacterCard {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    world: string;
    rules: string[];
    example_dialogue?: string;
}

// 全局用户角色（persona）：独立于 AI 角色卡，切换角色不受影响
export interface UserPersona {
    name: string;
    description: string;
    personality: string;
    notes?: string;
}

export function loadCharacter(path: string): CharacterCard {
    return JSON.parse(readFileSync(path, "utf-8")) as CharacterCard;
}

// ---------- 组装初始消息 ----------
export function buildInitialMessages(char: CharacterCard, persona?: UserPersona): Message[] {
    return [buildSettingMessage(char, persona)];
}

export function buildSettingMessage(char: CharacterCard, persona?: UserPersona): Message {
    const parts = [
        `【故事设定】`,
        ``,
        `世界：${char.world}`,
        ``,
        `角色：${char.name}。${char.description}`,
        `性格：${char.personality}`,
        ``,
    ];
    // 叙述者（用户角色）：全局通用，切换 AI 角色不受影响
    if (persona && (persona.name || persona.description || persona.personality)) {
        parts.push(`叙述者（用户）：${persona.name || "我"}。${persona.description || ""}`);
        parts.push(`叙述者性格：${persona.personality || ""}`);
        parts.push(``);
    }
    parts.push(`场景：${char.scenario}`);
    parts.push(``);
    parts.push(`创作规则：`);
    parts.push(...(char.rules ?? []).map((r) => `- ${r}`));
    if (persona?.notes) {
        parts.push(``);
        parts.push(`叙述者备注：${persona.notes}`);
    }
    return { role: "user", content: parts.join("\n"), timestamp: Date.now() };
}

// ---------- 构造 provider + model ----------
function buildModelWith(cfg: { modelId: string; baseUrl: string; thinking: ThinkingLevel }): Model<"openai-completions"> {
    return {
        id: cfg.modelId,
        name: cfg.modelId,
        api: "openai-completions",
        provider: "custom-openai",
        baseUrl: cfg.baseUrl,
        reasoning: cfg.thinking !== "off",
        input: ["text"],
        cost: { input: 0, output: 0 },
        contextWindow: 128000,
        maxTokens: 65536,
        compat: { supportsDeveloperRole: false }, // DeepSeek 端点用 system 角色更稳
    };
}
function buildModel(): Model<"openai-completions"> {
    return buildModelWith({ modelId: currentModelId, baseUrl: currentBaseUrl, thinking: currentThinking });
}

const provider = createProvider({
    id: "custom-openai",
    name: "Custom OpenAI-compatible",
    baseUrl: BASE_URL,
    auth: { apiKey: envApiKeyAuth("API key", ["API_KEY", "DEEPSEEK_API_KEY"]) },
    models: [buildModel()],
    api: openAICompletionsApi(),
});

// ---------- 生成 ----------
export interface GenerateCallbacks {
    onThinkingDelta?: (delta: string) => void;
    onTextDelta?: (delta: string) => void;
    onThinkingEnd?: () => void;
    /** 工具调用处理器：返回工具结果文本（会被作为 toolResult 消息返回给模型） */
    onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface GenerateOptions {
    /** 单次模型请求的底层超时（毫秒），传给 pi-ai 的 timeoutMs */
    timeoutMs?: number;
    /** 中止时直接抛错（Agent/世界推演等后台任务用；IC 用户手动停止时保留部分内容） */
    abortIsError?: boolean;
    /** 本次调用的最大输出 token（默认 8192；导演快速判断等场景可调小） */
    maxTokens?: number;
    /** 本次调用的模型/渠道覆盖（不影响全局配置；导演阶段用） */
    model?: { baseUrl?: string; apiKey?: string; modelId?: string; thinking?: ThinkingLevel };
}

export interface GenerateResult {
    /** 最终消息（无工具调用） */
    final: Message;
    /** 工具调用轮次的中间消息（assistant toolCall + toolResult），调用方按需入库 */
    intermediates: Message[];
}

const MAX_TOOL_ROUNDS = 5;

export async function generate(
    messages: Message[],
    cbs?: GenerateCallbacks,
    signal?: AbortSignal,
    tools?: Tool[],
    systemPrompt?: string,
    opts?: GenerateOptions,
): Promise<GenerateResult> {
    // 工作副本：工具轮中间消息不污染调用方的数组（由调用方决定如何入库）
    const working: Message[] = [...messages];
    const intermediates: Message[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const context: Context = { systemPrompt: systemPrompt ?? SYSTEM_PROMPT, messages: working, tools };

        // 解析 API key（pi 的 auth.resolve 机制，环境变量兜底）
        const base = getApiConfig();
        const eff = { ...base, ...(opts?.model ?? {}) };
        const model = buildModelWith({ modelId: eff.modelId, baseUrl: eff.baseUrl, thinking: eff.thinking });
        let apiKey: string | undefined = eff.apiKey;
        if (!apiKey) {
            const resolved = await provider.auth.resolve({
                ctx: { env: async (name: string) => process.env[name] ?? undefined },
                signal: signal ?? new AbortController().signal,
            });
            apiKey = resolved?.auth.apiKey;
        }

        const stream = provider.streamSimple(model, context, {
            apiKey,
            signal,
            timeoutMs: opts?.timeoutMs,
            reasoning: eff.thinking === "off" ? undefined : eff.thinking,
            maxTokens: opts?.maxTokens ?? 8192,
            samplingParams: { temperature: 1, top_p: 0.95 },
        });

        let finalMessage: Message | null = null;
        let inThinking = false;

        for await (const ev of stream) {
            switch (ev.type) {
                case "thinking_start":
                    inThinking = true;
                    if (!cbs?.onThinkingDelta) process.stdout.write("\x1b[90m[思考] ");
                    break;
                case "thinking_delta":
                    if (cbs?.onThinkingDelta) cbs.onThinkingDelta(ev.delta);
                    else process.stdout.write(ev.delta);
                    break;
                case "thinking_end":
                    inThinking = false;
                    if (cbs?.onThinkingEnd) cbs.onThinkingEnd();
                    else process.stdout.write("\x1b[0m\n");
                    break;
                case "text_delta":
                    if (cbs?.onTextDelta) cbs.onTextDelta(ev.delta);
                    else process.stdout.write(ev.delta);
                    break;
                case "done":
                    finalMessage = ev.message as unknown as Message;
                    break;
                case "error":
                    if (ev.error.stopReason === "aborted") {
                        // Agent/世界推演等后台任务需要硬超时：中止直接抛错，避免继续执行半截工具调用
                        if (opts?.abortIsError) throw new Error("请求已中止（超时或取消）");
                        // IC 手动停止：保留已生成的部分内容作为最终消息
                        finalMessage = ev.error as unknown as Message;
                    } else {
                        console.error("\n[错误]", ev.error.errorMessage ?? "未知错误");
                    }
                    break;
            }
        }
        if (inThinking && !cbs?.onThinkingDelta) process.stdout.write("\x1b[0m\n");
        if (!cbs?.onTextDelta) process.stdout.write("\n");
        if (!finalMessage) throw new Error("生成失败：无最终消息");

        // 检查工具调用
        const toolCalls = finalMessage.content.filter((b) => b.type === "toolCall");
        if (toolCalls.length === 0) {
            return { final: finalMessage, intermediates };
        }

        // 工具轮：把 assistant(toolCall) 和 toolResult 加入工作副本
        working.push(finalMessage);
        intermediates.push(finalMessage);
        for (const tc of toolCalls) {
            const result = cbs?.onToolCall
                ? await cbs.onToolCall(tc.name, tc.arguments ?? {})
                : `工具 ${tc.name} 没有处理器`;
            const toolMsg: Message = {
                role: "toolResult",
                toolCallId: tc.id,
                toolName: tc.name,
                content: [{ type: "text", text: result }],
                isError: false,
                timestamp: Date.now(),
            };
            working.push(toolMsg);
            intermediates.push(toolMsg);
        }
    }
    throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮`);
}

// ---------- 主循环（终端模式） ----------
export async function main() {
    const char = loadCharacter(CHARACTER_FILE);
    const messages: Message[] = buildInitialMessages(char);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\x1b[36m[rp-agent]\x1b[0m 角色：${char.name} | 模型：${MODEL_ID} | 思考：${THINKING}`);
    console.log("输入故事指令开始创作。命令：/reset 重置历史（保留设定），/quit 退出。\n");

    while (true) {
        const input = (await rl.question("\x1b[32m你 >\x1b[0m ")).trim();
        if (input === "" || input === null) continue;
        if (input === "/quit" || input === "/q" || input === "exit") break;
        if (input === "/reset") {
            messages.length = 0;
            messages.push(...buildInitialMessages(char));
            console.log("已重置（设定保留）。\n");
            continue;
        }

        messages.push({ role: "user", content: input, timestamp: Date.now() });

        console.log(`\x1b[36m${char.name} >\x1b[0m `);
        try {
            const { final } = await generate(messages);
            messages.push(final);
        } catch (err) {
            console.error("调用失败：", err instanceof Error ? err.message : err);
            messages.pop();
        }
    }
    rl.close();
}

// 直接运行时启动主循环（被 import 时不启动）
if (process.argv[1] && import.meta.url.replace(/\\/g, "/").endsWith(process.argv[1].replace(/\\/g, "/"))) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
