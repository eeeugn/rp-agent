/**
 * rp-server — 角色扮演 agent 的 Web 服务
 *
 * 功能：
 * - 聊天（SSE 流式）+ 消息操作（删除/编辑/重新生成/停止）
 * - 角色卡实时 CRUD（data/characters.json，切换即重建上下文）
 * - 世界书（data/worldinfo.json，按角色隔离 + 关键词触发注入）
 * - ST 角色卡导入（PNG tEXt chunk 解析，chara_card_v2/v3）
 * - Agent 化：模型可通过工具调用实时修改角色卡/世界书/场景
 *
 * 运行：npm run web   （默认 http://localhost:3200）
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import {
    generate,
    buildSettingMessage as buildSettingBase,
    getApiConfig,
    setApiConfig,
    getModelConfig,
    type CharacterCard,
    type ThinkingLevel,
    type UserPersona,
} from "./rp-agent.ts";

const PORT = Number(process.env.PORT ?? 3200);
const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const DATA_DIR = path.join(import.meta.dirname, "data");
const CHARACTERS_FILE = path.join(DATA_DIR, "characters.json");
const WORLDINFO_FILE = path.join(DATA_DIR, "worldinfo.json");
const PERSONA_FILE = path.join(DATA_DIR, "persona.json");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const MODEL_CONFIG_FILE = path.join(DATA_DIR, "model-config.json");
const CREDENTIALS_FILE = path.join(DATA_DIR, "credentials.json");
const API_PROFILES_FILE = path.join(DATA_DIR, "api-profiles.json");
const DIRECTOR_CONFIG_FILE = path.join(DATA_DIR, "director-config.json");
const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");

// ---------- 数据模型 ----------
interface StoredCharacter extends CharacterCard {
    id: string;
    initialScenario?: string; // 清理对话时恢复的开场场景（不被 Agent set_scene 覆盖）
    // ST 角色卡扩展字段（导入保留，用于构建设定/后续导出）
    first_mes?: string;
    alternate_greetings?: string[];
    mes_example?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    creator_notes?: string;
    tags?: string[];
    imported?: boolean;
}
// ---------- 模拟世界状态 ----------
interface WorldNpc {
    name: string;
    goal: string;       // 当前目标
    action: string;     // 正在做的事
    location: string;   // 所在位置
}
interface WorldState {
    time: string;       // 世界时间
    npcs: WorldNpc[];   // 主角之外的 NPC
    log: { text: string; known: boolean }[]; // 世界事件日志；known=主角在当场能直接感知/被告知
}
const WORLDSTATES_DIR = path.join(DATA_DIR, "worldstates");
let worldState: WorldState = { time: "第一天 傍晚", npcs: [], log: [] };
function worldStateFile(charId: string): string {
    return path.join(WORLDSTATES_DIR, charId + ".json");
}
function loadWorldStateFor(charId: string) {
    worldState = loadJson(worldStateFile(charId), { time: "第一天 傍晚", npcs: [], log: [] });
}
function saveWorldState() {
    try {
        saveJson(worldStateFile(currentChar.id), worldState);
    } catch (e) {
        console.error("世界状态保存失败:", e);
    }
}

// ---------- 演化策略设置 ----------
interface AgentSettings {
    evolutionMode: "active" | "balanced" | "minimal"; // 激进 / 平衡 / 保守
    evolutionDirection: string; // 演化方向 / 主线剧情
    advanceInterval: number; // 自动推演间隔（轮数）
}
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
let agentSettings: AgentSettings = { evolutionMode: "balanced", evolutionDirection: "", advanceInterval: 3 };
function settingsFile(charId: string): string {
    return path.join(SETTINGS_DIR, charId + ".json");
}
function loadSettingsFor(charId: string) {
    agentSettings = loadJson(settingsFile(charId), { evolutionMode: "balanced", evolutionDirection: "", advanceInterval: 3 });
}
function saveSettings() {
    try {
        saveJson(settingsFile(currentChar.id), agentSettings);
    } catch (e) {
        console.error("设置保存失败:", e);
    }
}

interface WorldInfoEntry {
    id: string;
    characterId: string; // 角色隔离：条目属于哪个角色
    keys: string[];
    content: string;
    enabled: boolean;
    public: boolean; // true=角色公开知识（默认注入）；false=隐藏（默认不注入，由 Agent reveal 揭示）
}

const DEFAULT_CHARACTER: StoredCharacter = {
    id: "default",
    name: "林默",
    description: "住在城南老街的年轻人，性格温和，喜欢读书，愿意倾听。",
    personality: "温和、耐心、好奇心强，说话平实，偶尔开点小玩笑。",
    scenario: "傍晚，老街的旧书店里，你推门进来，他抬起头看了你一眼，笑了笑。",
    world: "南方小城的老街，生活节奏慢，邻里熟悉，黄昏时分街上很安静。",
    rules: [
        "正文以第一人称「我」的视角展开，我的言行即用户输入，林默是故事中的另一角色，他的言行由作者补全。",
        "通俗小说风格，干练流畅，不堆砌辞藻。",
        "严格遵循场景与设定，不擅自跳转。",
    ],
    example_dialogue: "",
};

// ---------- JSON 持久化 ----------
function loadJson<T>(file: string, fallback: T): T {
    try {
        return JSON.parse(readFileSync(file, "utf-8")) as T;
    } catch {
        return fallback;
    }
}
function saveJson(file: string, data: unknown) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

const DEFAULT_PERSONA: UserPersona = {
    name: "我",
    description: "普通年轻人，独自生活。",
    personality: "平静、随和，观察力强。",
    notes: "",
};
let persona: UserPersona = loadJson(PERSONA_FILE, DEFAULT_PERSONA);

let characters: StoredCharacter[] = loadJson(CHARACTERS_FILE, [DEFAULT_CHARACTER]);
if (characters.length === 0) characters = [DEFAULT_CHARACTER];
let worldInfo: WorldInfoEntry[] = loadJson(WORLDINFO_FILE, []);
// 数据迁移：旧条目无 characterId → 归属 default 角色
for (const e of worldInfo) {
    if (!e.characterId) e.characterId = "default";
    if (e.public === undefined) e.public = true; // 旧数据默认公开
}
let currentChar: StoredCharacter = characters[0];
loadWorldStateFor(currentChar.id);
loadSettingsFor(currentChar.id);

// ---------- 会话状态 ----------
const context: Message[] = [];
const ids: string[] = [];
const hiddenIds = new Set<string>();
const versions = new Map<string, { content: string; thinking: string; ts: number }[]>();
// Agent 完整过程 trace：消息 id → 工具轮记录（思考/工具调用/结果）
interface TraceEntry {
    round: number;
    thinking?: string;
    toolCall?: { name: string; args: Record<string, unknown> };
    toolResult?: string;
}
const traceMap = new Map<string, TraceEntry[]>();
const agentLog = new Map<string, string[]>();
const injectedWorldInfo = new Set<string>();
const revealedWorldInfo = new Set<string>(); // 已向角色揭示的隐藏条目（角色已知信息）
let currentAbort: AbortController | null = null;

// ---------- 消息管理 ----------
function pushMessage(msg: Message, hidden = false): string {
    const id = randomUUID();
    context.push(msg);
    ids.push(id);
    if (hidden) hiddenIds.add(id);
    return id;
}

function deleteFromContext(index: number) {
    for (let i = index; i < ids.length; i++) {
        versions.delete(ids[i]);
        traceMap.delete(ids[i]);
        agentLog.delete(ids[i]);
        hiddenIds.delete(ids[i]);
    }
    context.splice(index);
    ids.splice(index);
}

// 设定消息（含 ST 扩展指令）
function buildSettingMessage(char: StoredCharacter): Message {
    const base = buildSettingBase(char, persona);
    if (typeof base.content !== "string") return base;
    const parts: string[] = [base.content];
    if (char.system_prompt) parts.push("", "【系统指令】", char.system_prompt);
    if (char.post_history_instructions) parts.push("", "【后续指令】", char.post_history_instructions);
    return { role: "user", content: parts.join("\n"), timestamp: Date.now() };
}

// ---------- 会话持久化（按角色隔离，data/sessions/<charId>.json） ----------
function saveSession() {
    try {
        const data = {
            characterId: currentChar.id,
            updatedAt: Date.now(),
            messages: context.map((msg, i) => ({ id: ids[i], hidden: hiddenIds.has(ids[i]), msg })),
            oocMessages,
            versions: Object.fromEntries(versions),
            trace: Object.fromEntries(traceMap),
            agentLog: Object.fromEntries(agentLog),
            injectedWorldInfo: [...injectedWorldInfo],
            revealedWorldInfo: [...revealedWorldInfo],
        };
        mkdirSync(SESSIONS_DIR, { recursive: true });
        writeFileSync(path.join(SESSIONS_DIR, currentChar.id + ".json"), JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        console.error("会话保存失败:", e);
    }
}

interface SessionData {
    messages: { id: string; hidden: boolean; msg: Message }[];
    oocMessages: Message[];
    versions: Record<string, { content: string; thinking: string; ts: number }[]>;
    injectedWorldInfo: string[];
    agentLog?: Record<string, string[]>;
}

function loadSession(charId: string): boolean {
    const file = path.join(SESSIONS_DIR, charId + ".json");
    try {
        const data = JSON.parse(readFileSync(file, "utf-8")) as SessionData;
        context.length = 0;
        ids.length = 0;
        hiddenIds.clear();
        versions.clear();
        injectedWorldInfo.clear();
        oocMessages.length = 0;
        traceMap.clear();
        agentLog.clear();
        revealedWorldInfo.clear();
        for (const m of data.messages ?? []) {
            context.push(m.msg);
            ids.push(m.id);
            if (m.hidden) hiddenIds.add(m.id);
        }
        // 防御：会话文件为空/损坏时视为无会话，走 resetContext
        if (context.length === 0) {
            context.length = 0;
            ids.length = 0;
            hiddenIds.clear();
            versions.clear();
            injectedWorldInfo.clear();
            return false;
        }
        oocMessages.length = 0;
        oocMessages.push(...(data.oocMessages ?? []));
        for (const [k, v] of Object.entries(data.versions ?? {})) versions.set(k, v);
        traceMap.clear();
        for (const [k, v] of Object.entries((data as { trace?: Record<string, TraceEntry[]> }).trace ?? {})) traceMap.set(k, v);
        agentLog.clear();
        for (const [k, v] of Object.entries(data.agentLog ?? {})) agentLog.set(k, v);
        revealedWorldInfo.clear();
        for (const id of (data as { revealedWorldInfo?: string[] }).revealedWorldInfo ?? []) revealedWorldInfo.add(id);
        for (const id of data.injectedWorldInfo ?? []) injectedWorldInfo.add(id);
        refreshSetting(); // 设定消息与当前角色卡 + persona 保持一致
        return true;
    } catch {
        return false;
    }
}

function resetContext() {
    context.length = 0;
    ids.length = 0;
    hiddenIds.clear();
    versions.clear();
    traceMap.clear();
    agentLog.clear();
    injectedWorldInfo.clear();
    lastDirectorNotes = null;
    pushMessage(buildSettingMessage(currentChar), true);
    // ST 角色卡开场白：切换角色后作为第一条 assistant 消息
    const greeting = currentChar.first_mes?.trim() || currentChar.alternate_greetings?.[0]?.trim();
    if (greeting) {
        pushMessage(
            {
                role: "assistant",
                content: [{ type: "text", text: greeting }],
                api: "openai-completions",
                provider: "custom-openai",
                model: getModelConfig().modelId,
                usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0 } },
                stopReason: "stop",
                timestamp: Date.now(),
            },
            false,
        );
    }
}

function refreshSetting() {
    if (context.length > 0) context[0] = buildSettingMessage(currentChar);
}

// ---------- 世界书（按角色隔离） ----------
function currentWorldInfo(): WorldInfoEntry[] {
    return worldInfo.filter((e) => e.characterId === currentChar.id);
}

function injectWorldInfo(userContent: string) {
    for (const entry of currentWorldInfo()) {
        if (!entry.enabled || injectedWorldInfo.has(entry.id)) continue;
        // 防全知：隐藏条目未揭示时不注入（角色不知道的秘密）
        if (!entry.public && !revealedWorldInfo.has(entry.id)) continue;
        if (entry.keys.some((k) => k && userContent.includes(k))) {
            injectedWorldInfo.add(entry.id);
            pushMessage(
                {
                    role: "user",
                    content: `【世界书·${entry.keys.join("/")}】\n${entry.content}`,
                    timestamp: Date.now(),
                },
                true,
            );
        }
    }
}

// ---------- UI 可见性 ----------
function isUiVisible(index: number): boolean {
    const id = ids[index];
    if (hiddenIds.has(id)) return false;
    const msg = context[index];
    if (msg.role === "toolResult") return false;
    if (msg.role === "assistant" && msg.content.some((b) => b.type === "toolCall")) return false;
    return true;
}

function textOf(msg: Message): string {
    if (msg.role === "user") {
        return typeof msg.content === "string" ? msg.content : msg.content.map((b) => (b.type === "text" ? b.text : "[图片]")).join("");
    }
    return msg.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("");
}

function thinkingOf(msg: Message): string {
    if (msg.role !== "assistant") return "";
    return msg.content.filter((b) => b.type === "thinking").map((b) => (b.type === "thinking" ? b.thinking : "")).join("");
}

// ---------- 世界推演 ----------
function buildWorldSimPrompt(): string {
    const modeText =
        agentSettings.evolutionMode === "active"
            ? "推演要更激进：NPC 主动推进事件、制造新的冲突或机遇，时间可以大幅推进，让世界充满变化。"
            : agentSettings.evolutionMode === "minimal"
              ? "只处理明显事件：NPC 保持现状，仅在剧情明确指向时行动，最小化推演与世界变化。"
              : "平衡推进：NPC 正常生活，事件自然发生，不刻意制造戏剧性。";
    const dir = agentSettings.evolutionDirection?.trim()
        ? "\n主线方向：" + agentSettings.evolutionDirection + "。NPC 的行动与事件应呼应这条主线。"
        : "";
    return "你是世界模拟器，负责推演主角视线之外的世界运行，让世界保持鲜活。\n" + modeText + dir + "\n当前世界时间：" + worldState.time;
}

function buildWorldSimFullPrompt(): string {
    return `你是世界模拟器，负责推演主角视线之外的世界运行，让世界保持鲜活。
当前世界时间：${worldState.time}
主角之外的 NPC：
${worldState.npcs.length ? worldState.npcs.map((n) => `- ${n.name}（位置：${n.location}）目标：${n.goal} 正在：${n.action}`).join("\n") : "（尚无，请在推演中基于故事背景创建 1-3 个合理的 NPC）"}
故事背景：${currentChar.world}
当前场景：${currentChar.scenario}
注意：NPC 仅指主角与当前角色之外的居民；不要把当前角色列入 NPC，也不要推演当前角色的离线行动。
禁止编造主角或当前角色做过/没做过的事（如扔石头、说话、进入某地）；主角未做的动作不得写成事件。
请推演时间推进后每个 NPC 的离线行动与内心活动，以及可能产生的世界事件。
输出要求（最高优先级，违反即失败）：只输出一个 JSON 对象，禁止输出任何散文、解释、Markdown、代码块或额外文字。直接以 { 开头，以 } 结尾。格式严格如下：
{"time":"推进后的时间","npcs":[{"name":"名字","goal":"新目标","action":"正在做的事","location":"位置"}],"events":[{"text":"事件摘要（含谁在哪做了什么）","known":true或false}, ...]}
known 规则：仅当主角在当场能直接看到/听到/被人告知的事件才写 true；主角视线之外、独处时发生的私密事一律 false。
`;
}

// 从模型输出中提取 JSON：优先取 ```json 代码块，否则取首尾大括号之间的内容
function extractJsonText(text: string): string | null {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return candidate.slice(start, end + 1).trim();
}

async function advanceWorld(note?: string): Promise<string> {
    const prompt =
        buildWorldSimPrompt() + (note ? `\n额外推演要求：${note}` : "");
    const msgs: Message[] = [
        { role: "user", content: prompt, timestamp: Date.now() },
    ];
    try {
        const { final } = await generate(
            msgs,
            { onThinkingDelta: () => {}, onTextDelta: () => {}, onThinkingEnd: () => {} },
            AbortSignal.timeout(120000),
            undefined,
            buildWorldSimFullPrompt(),
            { timeoutMs: 100000, abortIsError: true },
        );
        let text = textOf(final);
        let jsonText = extractJsonText(text);
        if (!jsonText) {
            // 重试一次：明确要求只输出 JSON
            const retryMsgs: Message[] = [
                { role: "user", content: "你刚才的回答不是严格 JSON。现在只输出 JSON 对象，禁止任何其他文字，直接以 { 开头：\n" + prompt, timestamp: Date.now() },
            ];
            const { final: final2 } = await generate(
                retryMsgs,
                { onThinkingDelta: () => {}, onTextDelta: () => {}, onThinkingEnd: () => {} },
                AbortSignal.timeout(60000),
                undefined,
                buildWorldSimFullPrompt(),
                { timeoutMs: 60000, abortIsError: true },
            );
            text = textOf(final2);
            jsonText = extractJsonText(text);
        }
        if (!jsonText) return "世界推演失败：模型两次均未返回可解析的 JSON（第二次输出前 120 字：" + text.replace(/\s+/g, " ").slice(0, 120) + "）";
        let parsed: { time?: unknown; npcs?: unknown; events?: unknown };
        try {
            parsed = JSON.parse(jsonText) as { time?: unknown; npcs?: unknown; events?: unknown };
        } catch {
            return "世界推演失败：模型返回的 JSON 无法解析（提取内容前 120 字：" + jsonText.replace(/\s+/g, " ").slice(0, 120) + "）";
        }
        const events: { text: string; known: boolean }[] = [];
        if (typeof parsed.time === "string") worldState.time = parsed.time;
        if (Array.isArray(parsed.npcs)) {
            // 合并更新：模型返回的 NPC 更新/新增，未返回的已有 NPC 保留（防止意外丢失）
            for (const n of parsed.npcs) {
                if (!n || typeof n.name !== "string" || !n.name.trim()) continue;
                const nm = n.name.trim();
                if (nm === currentChar.name || nm === persona.name || nm === "我") continue; // 当前角色/用户不是 NPC
                const npc = {
                    name: nm,
                    goal: String(n.goal ?? ""),
                    action: String(n.action ?? ""),
                    location: String(n.location ?? ""),
                };
                const existing = worldState.npcs.find((x) => x.name === npc.name);
                if (existing) Object.assign(existing, npc);
                else worldState.npcs.push(npc);
            }
        }
        if (Array.isArray(parsed.events)) {
            for (const ev of parsed.events) {
                if (typeof ev === "string") {
                    const s = ev.trim();
                    if (s) events.push({ text: s, known: false }); // 旧格式默认角色不知道
                } else if (ev && typeof ev.text === "string") {
                    const s = ev.text.trim();
                    if (s) events.push({ text: s, known: ev.known === true });
                }
            }
        }
        if (events.length) {
            worldState.log.push(...events);
            if (worldState.log.length > 50) worldState.log.splice(0, worldState.log.length - 50);
        }
        saveWorldState();
        // 环境感知注入（hidden，仅角色当场能感知的事件）
        const knownEvents = events.filter((e) => e.known);
        if (knownEvents.length) {
            pushMessage(
                {
                    role: "user",
                    content: `【环境感知】${knownEvents.slice(-2).map((e) => e.text).join("\n")}`,
                    timestamp: Date.now(),
                },
                true,
            );
        }
        saveSession();
        return events.length
            ? `世界已推进至「${worldState.time}」。${events.map((e) => e.text).join("；")}`
            : `世界已推进至「${worldState.time}」，无显著事件。`;
    } catch (e) {
        return "世界推演失败：" + (e instanceof Error ? e.message : String(e));
    }
}

function queryWorld(): string {
    const npcs = worldState.npcs.length
        ? worldState.npcs.map((n) => `- ${n.name}@${n.location}：${n.action}（目标：${n.goal}）`).join("\n")
        : "（无）";
    const log = worldState.log.slice(-5).map((l) => "- " + l.text).join("\n") || "（无）";
    return `时间：${worldState.time}\nNPC：\n${npcs}\n近期事件：\n${log}`;
}

// 世界感知：每轮角色对话前注入当前时间与近期动态，让故事与后台世界同步
function buildWorldAwareness(): Message | null {
    // 只注入角色当时能感知到的事件（known=true），后台私密演化不进入角色认知
    const recent = worldState.log.filter((l) => l.known).slice(-3).map((l) => l.text);
    if (!worldState.time && recent.length === 0) return null;
    const lines = [`【世界感知】当前时间：${worldState.time}`];
    if (recent.length) {
        lines.push("近期世界动态：");
        lines.push(...recent.map((l) => "- " + l));
    }
    return { role: "user", content: lines.join("\n"), timestamp: Date.now() };
}

// ---------- 幕后 Agent 引擎（每轮角色对话后自动管理世界质量） ----------
function buildManagerPrompt(): string {
    const base = getManagerPrompt(); // 默认含完整硬性规则；用户可自定义
    const modeText =
        agentSettings.evolutionMode === "active"
            ? "主动一些：有明确变化时推进一次世界，新人物/地点可在出现后建档；但仍不得超前于剧情。"
            : agentSettings.evolutionMode === "minimal"
              ? "克制：仅在出现明显事件、新人物或剧情矛盾时才行动，其余时间回复'无需调整'。"
              : "平衡：按需行动，不放过明显事件，也不过度干预；普通日常轮次优先'无需调整'。";
    const dir = agentSettings.evolutionDirection?.trim()
        ? "\n主线方向：" + agentSettings.evolutionDirection + "。维护世界时优先服务这条主线。"
        : "";
    return base + "\n" + modeText + dir;
}

const MANAGER_PROMPT = `你是角色扮演系统的幕后管理层 Agent。用户正在与角色对话，你在后台负责维持世界的鲜活与一致，但不打断用户的体验、不代替作者推进剧情。
你收到：最新对话片段、当前设定、世界状态。先判断剧情此刻真实发生了什么，再决定是否行动。
硬性规则（违反即失败）：
1. 时间与场景必须紧跟最新对话：故事还在日常地点时，严禁把世界时间/场景改到剧情未到达的地点或阶段（如鬼界、戏台、子时）。set_world_time / set_scene / advance_world 只能推进与剧情实际经过相符的少量时间。
2. 世界书禁止重复建档：已有条目（快照里的 id）不得再次 add_worldinfo；已被删除或与当前故事无关的旧设定（如柳月楼、花旦）不得擅自重建。
3. 可见性：只有角色本就知道的公开常识才 public:true；角色尚未得知的秘密、反派、地点一律 public:false。不确定就设 false。
4. 普通日常轮次：没有明显事件时，不调用任何工具，直接回复"无需调整"。
5. 工具调用要少而准：每轮最多 2-3 次，只做最必要的一件事；先考虑已有条目，再考虑新建。
6. update_worldinfo 只能追加关键词/补充内容：不得移除原有关键词，不得用更短内容重写已有条目。
7. 不要编造快照与剧情中未出现的新细节（如人名、具体物品来历）；确需记录，等剧情明确给出后再建档。
8. 若 add_worldinfo 返回"已有相似条目 id=..."，请按提示中的 id 更新该条目，不要把内容写入其他条目。
9. NPC 仅指当前角色与用户之外的居民；严禁把当前角色（如沈舟/小李）加入 NPC 列表或当作离线 NPC 演化。
允许的行动：
1. 世界推进：剧情时间明显推进/场景切换时，advance_world 让 NPC 按各自生活自然演化（可附 note）
2. 知识管理：角色在剧情中得知了隐藏条目对应的事实时，reveal_worldinfo 揭示；信息被证实为假时 conceal_worldinfo
3. 世界书维护：出现新的重要人物/地点/常驻事件时 add_worldinfo（按规则 3 设可见性）
4. 设定微调：仅当角色卡/场景与剧情明显矛盾时，update_character 或 set_scene
禁止：代替作者写正文、以角色口吻说话、对普通对话做无谓调整、修改世界观核心设定。
最终回复必须是管理侧说明（如"已更新X""无需调整"），一句话不超过 30 字；禁止输出故事正文、角色视角或对话描写。
世界书条目格式为：id=xxx [关键词] 内容。需要删除/修改/揭示世界书条目时，直接使用快照中的 id 调用工具，不要向用户索要 id。
若无需任何操作，直接回复"无需调整"（不要调用工具）。
`;

async function runAgentLoop(recentCount = 4, afterId?: string): Promise<string[]> {
    const actions: string[] = [];
    const recent = context.slice(-recentCount * 2).filter((m) => isUiVisible(context.indexOf(m)));
    if (recent.length < 2) return actions; // 对话太少，不评估
    const summary = [
        `【最新对话】`,
        ...recent.slice(-4).map((m) => textOf(m).slice(0, 400)),
        `【当前角色】${currentChar.name}。场景：${currentChar.scenario}`,
        `【世界状态】`,
        queryWorld(),
        `【世界书】${currentWorldInfo().length} 条（隐藏 ${currentWorldInfo().filter((e) => !e.public).length} 条）`,
    ].join("\n");
    const dirNote = lastDirectorNotes ? `\n【导演笔记】${lastDirectorNotes}` : "";
    lastDirectorNotes = null;
    const summaryWithDir = summary + dirNote;
    const msgs: Message[] = [{ role: "user", content: summaryWithDir, timestamp: Date.now() }];
    try {
        let advanceUsed = false;
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
                    // 完整展示工具参数（单行超长时截断到 500 字），避免"幕后调整"显示不全
                    const argLine = Object.entries(args).map(([k, v]) => k + "=" + String(v)).join(", ");
                    actions.push(`🔧 ${name}(${argLine.length > 500 ? argLine.slice(0, 500) + "…" : argLine})`);
                    return result;
                },
                onThinkingDelta: () => {},
                onTextDelta: () => {},
                onThinkingEnd: () => {},
            },
            AbortSignal.timeout(180000),
            TOOLS,
            buildManagerPrompt(),
            { timeoutMs: 150000, abortIsError: true },
        );
        const text = textOf(final);
        const mgmtRe = /^(无需|已|更新|维护|调整|记录|保持|建立|揭示|收回|世界|管理|本轮)/;
        if (text && !/无需调整|不需要调整|不需要操作|无需操作/.test(text) && mgmtRe.test(text.trim())) {
            // 保留完整管理说明（最多 600 字），避免"核心变更如下"后面内容丢失
            actions.push(text.trim().slice(0, 600));
        }
        if (actions.length) {
            // 注意：不把后台工具日志写进角色上下文（避免元信息泄漏）；
            // 世界变化通过 known 事件/世界书揭示自然流入剧情。
            // 持久化 Agent 动作，随消息历史显示（前端可一直看到"幕后调整"）
            let targetId = afterId;
            if (!targetId || !ids.includes(targetId)) {
                for (let i = ids.length - 1; i >= 0; i--) {
                    if (!hiddenIds.has(ids[i]) && context[i]?.role === "assistant") {
                        targetId = ids[i];
                        break;
                    }
                }
            }
            if (targetId) agentLog.set(targetId, actions);
            saveSession();
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 工具轮数上限不是评估失败：已执行的动作保留
        if (!/工具调用超过/.test(msg)) {
            console.error("[agent-loop] 失败:", e);
            actions.push("⚠ Agent 评估失败：" + msg);
        }
    }
    return actions;
}

function buildTrace(intermediates: Message[]): TraceEntry[] {
    const trace: TraceEntry[] = [];
    for (const m of intermediates) {
        if (m.role === "assistant") {
            const thinking = thinkingOf(m);
            const toolCalls = m.content.filter((b) => b.type === "toolCall");
            for (const tc of toolCalls) {
                trace.push({
                    round: trace.length,
                    thinking: thinking || undefined,
                    toolCall: { name: tc.name, args: tc.arguments ?? {} },
                });
            }
        } else if (m.role === "toolResult") {
            // 同一轮可能多个工具调用：结果挂到最近一个还没有结果的调用上
            for (let i = trace.length - 1; i >= 0; i--) {
                if (trace[i].toolCall && !trace[i].toolResult) {
                    trace[i].toolResult = textOf(m);
                    break;
                }
            }
        }
    }
    return trace;
}

function usageOf(msg: Message): { input: number; output: number; total: number } | undefined {
    const usage = (msg as { usage?: { input?: number; output?: number; totalTokens?: number } }).usage;
    if (!usage) return undefined;
    return {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        total: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
    };
}

function uiMessage(index: number) {
    const msg = context[index];
    const base = { id: ids[index], role: msg.role, timestamp: (msg as { timestamp?: number }).timestamp ?? Date.now() };
    if (msg.role === "user") return { ...base, content: textOf(msg) };
    return {
        ...base,
        content: textOf(msg),
        thinking: thinkingOf(msg),
        versions: versions.get(ids[index]) ?? [],
        tokens: usageOf(msg),
        trace: traceMap.get(ids[index]),
        agentActions: agentLog.get(ids[index]),
    };
}

// ---------- AnySearch 网络搜索 ----------
const ANYSEARCH_CLI = path.join(import.meta.dirname, "skills", "anysearch", "scripts", "anysearch_cli.js");

async function runAnySearch(args: string[], timeoutMs = 30000): Promise<string> {
    try {
        const { stdout } = await execFileAsync(process.execPath, [ANYSEARCH_CLI, ...args], {
            timeout: timeoutMs,
            env: { ...process.env },
            maxBuffer: 8 * 1024 * 1024,
        });
        return stdout;
    } catch (e) {
        return "搜索失败：" + (e instanceof Error ? e.message : String(e));
    }
}

function summarizeSearch(raw: string, maxItems = 6): string {
    try {
        const arr = JSON.parse(raw);
        const items = Array.isArray(arr) ? arr.slice(0, maxItems) : [];
        if (items.length === 0) return "（无搜索结果）";
        return items
            .map((it, i) => {
                const title = it.title ?? it.name ?? "";
                const url = it.url ?? it.link ?? "";
                const snippet = (it.snippet ?? it.content ?? it.description ?? "").slice(0, 250);
                return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
            })
            .join("\n");
    } catch {
        return raw.slice(0, 4000);
    }
}

// ---------- 工具定义 ----------
const TOOLS: Tool[] = [
    {
        name: "update_character",
        description:
            "更新当前角色卡的字段。field 取值：name/description/personality/scenario/world/rules。rules 用换行分隔多条规则。修改后立即生效于后续创作。",
        parameters: Type.Object({
            field: Type.String(),
            value: Type.String(),
        }),
    },
    {
        name: "set_scene",
        description: "更新当前故事场景描述。只能改为剧情此刻真实所在的场景，严禁跳到剧情未发生的地点/阶段。",
        parameters: Type.Object({
            scene: Type.String(),
        }),
    },
    {
        name: "add_worldinfo",
        description:
            "向当前角色的世界书添加一条条目。keys 为触发关键词列表，content 为条目内容。public 为可见性：true=角色本就知道的公开常识，false=角色不知道的秘密（默认）。重要秘密/反派底细必须设 false。",
        parameters: Type.Object({
            keys: Type.Array(Type.String()),
            content: Type.String(),
            public: Type.Optional(Type.Boolean()),
        }),
    },
    {
        name: "update_worldinfo",
        description: "更新当前角色的世界书条目。提供 id 和要修改的字段（keys/content/enabled/public 至少一个）。",
        parameters: Type.Object({
            id: Type.String(),
            keys: Type.Optional(Type.Array(Type.String())),
            content: Type.Optional(Type.String()),
            enabled: Type.Optional(Type.Boolean()),
            public: Type.Optional(Type.Boolean()),
        }),
    },
    {
        name: "remove_worldinfo",
        description: "删除当前角色的一条世界书条目。",
        parameters: Type.Object({
            id: Type.String(),
        }),
    },
    {
        name: "reveal_worldinfo",
        description:
            "向角色揭示一条隐藏的世界书条目（防全知机制）：揭示后该条目会注入角色设定，角色将知晓其内容。用于角色在剧情中得知秘密/真相时。",
        parameters: Type.Object({
            id: Type.String(),
        }),
    },
    {
        name: "advance_world",
        description:
            "推进模拟世界：让 NPC 按各自生活离线行动（时间前进、事件发生）。推进量必须与剧情实际经过的时间相符，严禁一次性跨越到剧情未发生的阶段。note 只能总结剧情已发生的事，不得自己编造主角或当前角色的新动作。",
        parameters: Type.Object({
            note: Type.Optional(Type.String()),
        }),
    },
    {
        name: "set_world_time",
        description: "直接设置世界时间。只能设置为与当前剧情一致的时间，严禁提前跳到剧情未到达的时间/阶段。",
        parameters: Type.Object({
            time: Type.String(),
        }),
    },
    {
        name: "add_npc",
        description: "向世界添加一个 NPC（或更新同名的现有 NPC）。name 为名字，location 位置，action 正在做的事，goal 当前目标。",
        parameters: Type.Object({
            name: Type.String(),
            location: Type.Optional(Type.String()),
            action: Type.Optional(Type.String()),
            goal: Type.Optional(Type.String()),
        }),
    },
    {
        name: "update_npc",
        description: "更新现有 NPC 的字段（action/location/goal 至少一个）。",
        parameters: Type.Object({
            name: Type.String(),
            action: Type.Optional(Type.String()),
            location: Type.Optional(Type.String()),
            goal: Type.Optional(Type.String()),
        }),
    },
    {
        name: "remove_npc",
        description: "从世界移除一个 NPC。",
        parameters: Type.Object({
            name: Type.String(),
        }),
    },
    {
        name: "query_world",
        description: "查看当前模拟世界状态：时间、各 NPC 的位置/行动/目标、近期世界事件。",
        parameters: Type.Object({}),
    },
    {
        name: "conceal_worldinfo",
        description: "收回角色的某条已揭示信息：角色将不再知晓该条目内容（如记忆被抹除/信息被证实为假）。",
        parameters: Type.Object({
            id: Type.String(),
        }),
    },
    {
        name: "web_search",
        description:
            "在互联网上搜索实时信息（新闻、百科、天气等）。query 为搜索关键词，max_results 为返回结果数（默认 5，最多 10）。返回标题、链接与摘要。",
        parameters: Type.Object({
            query: Type.String(),
            max_results: Type.Optional(Type.Number()),
        }),
    },
    {
        name: "web_extract",
        description: "提取指定网页的正文内容（Markdown 格式，自动截断）。用于获取搜索结果页面的详细内容。",
        parameters: Type.Object({
            url: Type.String(),
        }),
    },
];

// 系统级管理工具：仅 OOC Agent（Agent 对话）可用，幕后自动 Agent 不可用
const SYSTEM_TOOLS: Tool[] = [
    {
        name: "get_system_config",
        description: "查看系统级配置：当前/全部 API 配置集（不含密钥）、导演快速判断设置、当前角色的演化策略。",
        parameters: Type.Object({}),
    },
    {
        name: "update_system_config",
        description:
            "修改系统级配置（仅 OOC Agent 可用）。可选字段：api_profile_id（切换配置集）、api_base_url/api_model/api_thinking（更新当前配置集）、director_enabled/director_profile_id/director_model/director_thinking（导演设置）、evolution_mode/evolution_direction/advance_interval（当前角色演化策略）。至少提供一个字段。API Key 只能在设置界面填写，不通过对话传递。",
        parameters: Type.Object({
            api_profile_id: Type.Optional(Type.String()),
            api_base_url: Type.Optional(Type.String()),
            api_model: Type.Optional(Type.String()),
            api_thinking: Type.Optional(Type.String()),
            director_enabled: Type.Optional(Type.Boolean()),
            director_profile_id: Type.Optional(Type.String()),
            director_model: Type.Optional(Type.String()),
            director_thinking: Type.Optional(Type.String()),
            evolution_mode: Type.Optional(Type.String()),
            evolution_direction: Type.Optional(Type.String()),
            advance_interval: Type.Optional(Type.Number()),
        }),
    },
];
const OOC_TOOLS: Tool[] = [...TOOLS, ...SYSTEM_TOOLS];

// ---------- 工具执行 ----------
async function applyTool(name: string, args: Record<string, unknown>, allowSystem = false): Promise<string> {
    switch (name) {
        case "update_character": {
            const field = String(args.field ?? "");
            const value = String(args.value ?? "");
            const valid = ["name", "description", "personality", "scenario", "world", "rules"];
            if (!valid.includes(field)) return `错误：field 必须是 ${valid.join("/")}`;
            if (field === "rules") {
                currentChar.rules = value.split("\n").map((s) => s.trim()).filter(Boolean);
            } else {
                (currentChar as Record<string, unknown>)[field] = value;
            }
            saveJson(CHARACTERS_FILE, characters);
            refreshSetting();
            return `已更新角色卡字段 ${field}`;
        }
        case "set_scene": {
            currentChar.scenario = String(args.scene ?? "");
            saveJson(CHARACTERS_FILE, characters);
            refreshSetting();
            return "已更新场景描述";
        }
        case "add_worldinfo": {
            const keys = Array.isArray(args.keys) ? args.keys.map(String).filter(Boolean) : [];
            const content = String(args.content ?? "").trim();
            if (keys.length === 0 || !content) return "错误：keys 和 content 不能为空";
            // 防重复：关键词与现有条目重合时拒绝建档，改为 update_worldinfo
            const dup = worldInfo.find((e) => e.characterId === currentChar.id && e.keys.some((k) => keys.includes(k)));
            if (dup) return `已有相似条目 id=${dup.id}（关键词 ${dup.keys.join("/")}），若要补充请用 update_worldinfo 更新该 id，不要重复建档，也不要把内容写入其他条目`;
            const entry: WorldInfoEntry = {
                id: randomUUID(),
                characterId: currentChar.id,
                keys,
                content,
                enabled: true,
                public: args.public === true, // 默认隐藏，只有明确指定公开才公开
            };
            worldInfo.push(entry);
            saveJson(WORLDINFO_FILE, worldInfo);
            return `已向当前角色的世界书添加条目 ${entry.id}（${entry.public ? "公开" : "隐藏"}）`;
        }
        case "update_worldinfo": {
            const id = String(args.id ?? "");
            const entry = worldInfo.find((e) => e.id === id && e.characterId === currentChar.id);
            if (!entry) return `错误：找不到世界书条目 ${id}`;
            if (Array.isArray(args.keys)) {
                const newKeys = args.keys.map(String).filter(Boolean);
                const lost = entry.keys.filter((k) => !newKeys.includes(k));
                if (lost.length) return `错误：不能移除已有关键词（${lost.join("/")}），只能追加关键词`;
                entry.keys = newKeys;
            }
            if (typeof args.content === "string") {
                const newContent = args.content.trim();
                if (entry.content && newContent.length < entry.content.length * 0.7 && entry.content.length > 80) {
                    return `错误：新内容明显短于原条目，可能丢失已有细节（原 ${entry.content.length} 字 / 新 ${newContent.length} 字）。请基于原内容补充，不要重写`;
                }
                entry.content = newContent;
            }
            if (typeof args.enabled === "boolean") entry.enabled = args.enabled;
            if (typeof args.public === "boolean" && args.public === true && entry.public === false) {
                return "错误：隐藏条目不能直接改为公开。如需角色知道，请用 reveal_worldinfo 在会话中揭示；如需成为公开常识，请新建公开条目（add_worldinfo public:true）。";
            }
            if (typeof args.public === "boolean") entry.public = args.public;
            saveJson(WORLDINFO_FILE, worldInfo);
            return `已更新世界书条目 ${id}`;
        }
        case "remove_worldinfo": {
            const id = String(args.id ?? "");
            const before = worldInfo.length;
            worldInfo = worldInfo.filter((e) => e.id !== id);
            injectedWorldInfo.delete(id);
            saveJson(WORLDINFO_FILE, worldInfo);
            return worldInfo.length < before ? `已删除世界书条目 ${id}` : `错误：找不到世界书条目 ${id}`;
        }
        case "advance_world": {
            const note = typeof args.note === "string" ? args.note : undefined;
            return await advanceWorld(note);
        }
        case "set_world_time": {
            const time = String(args.time ?? "");
            if (!time) return "错误：time 不能为空";
            worldState.time = time;
            saveWorldState();
            return "世界时间已设为「" + time + "」";
        }
        case "add_npc": {
            const name = String(args.name ?? "").trim();
            if (!name) return "错误：name 不能为空";
            if (name === currentChar.name) return `错误：${name} 是当前角色，不是 NPC，不能加入 NPC 列表`;
            if (name === persona.name || name === "我") return `错误：${name} 是用户身份，不是 NPC`;
            const existing = worldState.npcs.find((n) => n.name === name);
            const npc = {
                name,
                location: String(args.location ?? ""),
                action: String(args.action ?? ""),
                goal: String(args.goal ?? ""),
            };
            if (existing) {
                Object.assign(existing, npc);
                return "已更新 NPC「" + name + "」";
            }
            worldState.npcs.push(npc);
            saveWorldState();
            return "已添加 NPC「" + name + "」";
        }
        case "update_npc": {
            const name = String(args.name ?? "").trim();
            if (name === currentChar.name) return `错误：${name} 是当前角色，不是 NPC，不能当作 NPC 更新`;
            if (name === persona.name || name === "我") return `错误：${name} 是用户身份，不是 NPC`;
            const npc = worldState.npcs.find((n) => n.name === name);
            if (!npc) return "错误：找不到 NPC「" + name + "」";
            if (typeof args.action === "string") npc.action = args.action;
            if (typeof args.location === "string") npc.location = args.location;
            if (typeof args.goal === "string") npc.goal = args.goal;
            saveWorldState();
            return "已更新 NPC「" + name + "」";
        }
        case "remove_npc": {
            const name = String(args.name ?? "").trim();
            const before = worldState.npcs.length;
            worldState.npcs = worldState.npcs.filter((n) => n.name !== name);
            saveWorldState();
            return worldState.npcs.length < before ? "已移除 NPC「" + name + "」" : "错误：找不到 NPC「" + name + "」";
        }
        case "query_world": {
            return queryWorld();
        }
        case "reveal_worldinfo": {
            const id = String(args.id ?? "");
            const entry = worldInfo.find((e) => e.id === id && e.characterId === currentChar.id);
            if (!entry) return `错误：找不到世界书条目 ${id}`;
            revealedWorldInfo.add(id);
            // 揭示即刻写入角色认知（隐藏消息），下一轮角色自然知道
            pushMessage({ role: "user", content: `【知识揭示】${entry.keys.join("/")}：${entry.content}`, timestamp: Date.now() }, true);
            saveSession();
            return `已向角色揭示「${entry.keys.join("/")}」——角色现在知道这条信息了`;
        }
        case "conceal_worldinfo": {
            const id = String(args.id ?? "");
            const entry = worldInfo.find((e) => e.id === id && e.characterId === currentChar.id);
            if (!entry) return `错误：找不到世界书条目 ${id}`;
            revealedWorldInfo.delete(id);
            pushMessage({ role: "user", content: `【知识收回】角色不再知晓：${entry.keys.join("/")}`, timestamp: Date.now() }, true);
            saveSession();
            return `已收回「${entry.keys.join("/")}」——角色不再知晓该信息`;
        }
        case "web_search": {
            const query = String(args.query ?? "");
            if (!query) return "错误：query 不能为空";
            const maxResults = Math.min(10, Math.max(1, Number(args.max_results ?? 5) || 5));
            const raw = await runAnySearch(["search", query, "--max_results", String(maxResults)]);
            return summarizeSearch(raw);
        }
        case "web_extract": {
            const url = String(args.url ?? "");
            if (!url.startsWith("http")) return "错误：url 必须是 http(s) 链接";
            const raw = await runAnySearch(["extract", url]);
            return raw.slice(0, 8000);
        }
        case "get_system_config": {
            if (!allowSystem) return "错误：该系统工具仅 OOC Agent（Agent 对话）可用";
            const profiles = apiProfiles.map((p) => `${p.name}${p.id === activeProfileId ? "（当前）" : ""}：${p.baseUrl} | model=${p.modelId} | thinking=${p.thinking} | key=${p.key ? "已配置" : "未配置"}`);
            return [
                `【API 配置集】${profiles.length ? "" : "（无）"}`,
                profiles.join("\n"),
                `【导演设置】启用=${directorConfig.enabled} | 配置集=${directorConfig.profileId || "跟随当前"} | 模型=${directorConfig.modelId || "跟随配置"} | 推理=${directorConfig.thinking}`,
                `【演化策略】模式=${agentSettings.evolutionMode} | 方向=${agentSettings.evolutionDirection || "（空）"} | 间隔=${agentSettings.advanceInterval}`,
            ].join("\n");
        }
        case "update_system_config": {
            if (!allowSystem) return "错误：该系统工具仅 OOC Agent（Agent 对话）可用";
            const changed: string[] = [];
            if (typeof args.api_profile_id === "string" && args.api_profile_id) {
                if (!apiProfiles.some((x) => x.id === args.api_profile_id)) return `错误：配置集 ${args.api_profile_id} 不存在`;
                activeProfileId = args.api_profile_id;
                saveApiProfiles();
                await applyActiveProfile();
                changed.push(`切换到配置集「${args.api_profile_id}」`);
            }
            const ap = apiProfiles.find((x) => x.id === activeProfileId);
            if (ap) {
                let apiChanged = false;
                if (typeof args.api_base_url === "string" && args.api_base_url.trim()) {
                    ap.baseUrl = args.api_base_url.trim();
                    apiChanged = true;
                }
                if (typeof args.api_model === "string" && args.api_model.trim()) {
                    ap.modelId = args.api_model.trim();
                    apiChanged = true;
                }
                if (typeof args.api_thinking === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(args.api_thinking)) {
                    ap.thinking = args.api_thinking;
                    apiChanged = true;
                }
                if (apiChanged) {
                    saveApiProfiles();
                    changed.push("更新当前 API 配置");
                }
            }
            if (typeof args.director_enabled === "boolean") {
                directorConfig.enabled = args.director_enabled;
                changed.push(`导演${args.director_enabled ? "启用" : "关闭"}`);
            }
            if (typeof args.director_profile_id === "string") {
                if (args.director_profile_id && !apiProfiles.some((x) => x.id === args.director_profile_id)) {
                    return `错误：导演配置集 ${args.director_profile_id} 不存在`;
                }
                directorConfig.profileId = args.director_profile_id;
                changed.push("更新导演配置集");
            }
            if (typeof args.director_model === "string") {
                directorConfig.modelId = args.director_model.trim();
                changed.push("更新导演模型");
            }
            if (typeof args.director_thinking === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(args.director_thinking)) {
                directorConfig.thinking = args.director_thinking;
                changed.push("更新导演推理强度");
            }
            if (typeof args.evolution_mode === "string" && ["active", "balanced", "minimal"].includes(args.evolution_mode)) {
                agentSettings.evolutionMode = args.evolution_mode;
                changed.push("更新演化模式");
            }
            if (typeof args.evolution_direction === "string") {
                agentSettings.evolutionDirection = args.evolution_direction;
                changed.push("更新演化方向");
            }
            if (typeof args.advance_interval === "number" && args.advance_interval >= 1 && args.advance_interval <= 10) {
                agentSettings.advanceInterval = Math.floor(args.advance_interval);
                changed.push("更新推演间隔");
            }
            saveDirectorConfig();
            saveSettings();
            await applyActiveProfile();
            return changed.length ? "已更新：" + changed.join("；") : "没有可更新的字段";
        }
        default:
            return `未知工具 ${name}`;
    }
}

// ---------- ST 角色卡导入 ----------
function parseSTCardPNG(buf: Buffer): Record<string, unknown> | null {
    let offset = 8;
    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString("latin1", offset + 4, offset + 8);
        if (type === "tEXt") {
            const data = buf.subarray(offset + 8, offset + 8 + length);
            const nul = data.indexOf(0);
            if (nul >= 0) {
                const keyword = data.toString("latin1", 0, nul);
                if (keyword === "chara" || keyword === "ccv3") {
                    const text = data.toString("latin1", nul + 1);
                    try {
                        return JSON.parse(Buffer.from(text, "base64").toString("utf-8")) as Record<string, unknown>;
                    } catch {
                        // 继续找下一个 chunk
                    }
                }
            }
        }
        offset += 12 + length;
    }
    return null;
}

function importSTCard(raw: Record<string, unknown>): { char: StoredCharacter; wiEntries: { keys: string[]; content: string }[] } {
    // chara_card_v3：字段在 data 下；v2：字段在顶层
    const card = (raw.spec === "chara_card_v3" && typeof raw.data === "object" && raw.data
        ? (raw.data as Record<string, unknown>)
        : raw) as Record<string, unknown>;

    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

    // 世界书条目
    const book = card.character_book as Record<string, unknown> | undefined;
    const entries = Array.isArray(book?.entries) ? (book.entries as Record<string, unknown>[]) : [];
    const wiEntries = entries
        .map((e) => ({
            keys: arr(e.keys),
            content: str(e.content),
        }))
        .filter((e) => e.keys.length > 0 && e.content.length > 0);

    const char: StoredCharacter = {
        id: randomUUID(),
        name: str(card.name) || "导入角色",
        description: str(card.description),
        personality: str(card.personality),
        scenario: str(card.scenario),
        initialScenario: str(card.scenario),
        world: str(card.creator_notes) || str(card.creatorcomment),
        rules: [],
        example_dialogue: str(card.mes_example),
        first_mes: str(card.first_mes),
        alternate_greetings: arr(card.alternate_greetings),
        system_prompt: str(card.system_prompt),
        post_history_instructions: str(card.post_history_instructions),
        creator_notes: str(card.creator_notes),
        tags: arr(card.tags),
        imported: true,
    };
    return { char, wiEntries };
}

// ---------- Agent（OOC）提示词 ----------
const AGENT_PROMPT = `你是角色扮演系统的控制层 Agent（OOC 管理对话），权限层级高于故事层，也高于幕后自动 Agent。用户通过你管理整个系统；你不是故事角色，始终以管理员视角回应。
你收到：最近剧情、当前角色卡、世界书（含隐藏秘密与揭示状态）、世界状态、系统配置。
工具分类：
1. 角色与场景：update_character(field,value)、set_scene(scene)
2. 世界书：add_worldinfo(keys,content,public?)、update_worldinfo(id,...)、remove_worldinfo(id)、reveal_worldinfo(id)、conceal_worldinfo(id)
3. 世界演化：advance_world(note?)、query_world()、set_world_time(time)、add_npc/update_npc/remove_npc
4. 网络：web_search(query,max_results?)、web_extract(url)
5. 系统管理（最高权限）：get_system_config()、update_system_config(...)
硬性规则：
- 修改必须真正调用对应工具执行；禁止只声称"已更新/已修改"而不调用工具。工具返回结果后再按结果汇报。
- 世界书条目格式：id=xxx [关键词] 内容。修改/删除/揭示直接用快照中的 id，不要向用户索要 id。
- 防全知：只有角色本就知道的常识才 public:true；秘密/反派/未发生地点一律 public:false；隐藏条目不能直接改公开，角色知道信息用 reveal_worldinfo，收回用 conceal_worldinfo。
- update_worldinfo 只能追加关键词/补充内容：不得移除原有关键词，不得用更短内容重写已有条目。若 add_worldinfo 返回"已有相似条目 id=..."，按该 id 更新，不要重复建档或写入其他条目。
- advance_world 只推进与剧情实际经过相符的少量时间，严禁跳到未发生的阶段；NPC 仅指当前角色与用户之外的居民，当前角色/用户不得加入 NPC。
- 不要编造快照与剧情中未出现的人名/细节；不确定就如实说明。
- 系统配置可用 get_system_config 查看、update_system_config 调整（API 配置集/导演设置/演化策略）；API Key 不通过对话传递，提示用户在设置界面填写。
- 禁止代替作者写正文、以角色口吻说话、修改世界观核心设定。
- 工具调用要少而准（每轮最多 2-3 次）；回答简洁、直接、使用中文。
当用户问"你能做什么"时，以管理员视角分类列出你的能力。`;

// ---------- 提示词自定义（留空=使用内置默认） ----------
let customPrompts: { oocAgent?: string; manager?: string; director?: string } = {};
function getAgentPrompt() {
    return customPrompts.oocAgent?.trim() ? customPrompts.oocAgent : AGENT_PROMPT;
}
function getManagerPrompt() {
    return customPrompts.manager?.trim() ? customPrompts.manager : MANAGER_PROMPT;
}
function getDirectorPrompt() {
    return customPrompts.director?.trim() ? customPrompts.director : DIRECTOR_PROMPT;
}

const oocMessages: Message[] = [];
const OOC_MAX = 20;

function buildAgentSnapshot(): Message {
    const snapshot = [
        ...(context.length
            ? [
                  "【最近剧情】",
                  ...context
                      .map((m, i) => ({ m, i }))
                      .filter(({ i }) => isUiVisible(i))
                      .slice(-6)
                      .map(({ m }) => `${m.role === "user" ? "用户" : currentChar.name}：${textOf(m).slice(0, 300)}`),
              ]
            : []),
        `【角色卡】`,
        `名称：${currentChar.name}`,
        `描述：${currentChar.description}`,
        `性格：${currentChar.personality}`,
        `场景：${currentChar.scenario}`,
        `世界：${currentChar.world}`,
        `规则：${currentChar.rules.join("；")}`,
        `【世界书】`,
        currentWorldInfo().length
            ? currentWorldInfo().map((e) => {
                  const vis = e.public ? "" : revealedWorldInfo.has(e.id) ? "(已揭示) " : "(隐藏) ";
                  return `- id=${e.id} [${e.keys.join("/")}] ${e.enabled ? "" : "(已禁用) "}${vis}${e.content}`;
              }).join("\n")
            : "（空）",
        "【世界状态】",
        queryWorld(),
        "【系统配置】",
        `API 配置：${apiProfiles.map((p) => `${p.name}${p.id === activeProfileId ? "(当前)" : ""}(${p.baseUrl}, ${p.modelId}, ${p.thinking}, key:${p.key ? "已配" : "未配"})`).join(" | ") || "（无）"}`,
        `导演：${directorConfig.enabled ? "开" : "关"}${directorConfig.modelId ? "，模型 " + directorConfig.modelId : ""}，推理 ${directorConfig.thinking}`,
        `演化：${agentSettings.evolutionMode} / 间隔 ${agentSettings.advanceInterval}`,
    ].join("\n");
    return { role: "user", content: snapshot, timestamp: Date.now() };
}

// OOC 消息增删后重排 trace 键（"ooc-索引"），避免工具过程挂到错误消息
function remapOocTraces() {
    const aligned = oocMessages.map((_, i) => traceMap.get("ooc-" + i));
    for (const k of [...traceMap.keys()]) {
        if (k.startsWith("ooc-")) traceMap.delete(k);
    }
    aligned.forEach((t, i) => {
        if (t) traceMap.set("ooc-" + i, t);
    });
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
    const startTime = Date.now();
    try {
        const { final, intermediates } = await generate(
            ctx,
            {
                onThinkingDelta: (d) => sse(res, { type: "thinking", delta: d }),
                onTextDelta: (d) => sse(res, { type: "text", delta: d }),
                onThinkingEnd: () => sse(res, { type: "thinking_end" }),
                onToolCall: async (name, args) => {
                    console.log("[tool:ooc] " + name, JSON.stringify(args));
                    sse(res, { type: "tool", name, args });
                    const result = await applyTool(name, args, true); // OOC 拥有系统级权限
                    saveSession();
                    return result;
                },
            },
            ac.signal,
            OOC_TOOLS,
            getAgentPrompt(), // Agent 独立提示词（层级高于角色，可自定义）
        );
        if (userContent) {
            oocMessages.push({ role: "user", content: userContent, timestamp: Date.now() });
        }
        oocMessages.push(final);
        if (oocMessages.length > OOC_MAX * 2) oocMessages.splice(0, oocMessages.length - OOC_MAX * 2);
        const trace = buildTrace(intermediates ?? []);
        if (trace.length) traceMap.set("ooc-" + (oocMessages.length - 1), trace);
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
                tokens: usageOf(final),
                trace,
            },
            durationMs: Date.now() - startTime,
        });
    } catch (err) {
        sse(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
        if (currentAbort === ac) currentAbort = null;
        saveSession();
        res.end();
    }
}

// ---------- SSE 工具 ----------
function sse(res: http.ServerResponse, data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------- 生成（IC：流式转发，带工具） ----------
async function generateToSSE(res: http.ServerResponse, onDone?: (newId: string) => void): Promise<void> {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const ac = new AbortController();
    currentAbort = ac;
    const startTime = Date.now();
    try {
        const { final, intermediates } = await generate(
            context,
            {
                onThinkingDelta: (d) => sse(res, { type: "thinking", delta: d }),
                onTextDelta: (d) => sse(res, { type: "text", delta: d }),
                onThinkingEnd: () => sse(res, { type: "thinking_end" }),
                // IC 模式不带工具（保持角色沉浸；工具仅在 OOC Agent 模式可用）
            },
            ac.signal,
        );
        for (const m of intermediates) pushMessage(m, true);
        const id = pushMessage(final);
        const trace = buildTrace(intermediates);
        if (trace.length) traceMap.set(id, trace);
        if (onDone) onDone(id);
        sse(res, {
            type: "done",
            message: uiMessage(context.length - 1),
            durationMs: Date.now() - startTime,
        });
    } catch (err) {
        sse(res, { type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
        if (currentAbort === ac) currentAbort = null;
        saveSession(); // 生成结束（成功/停止/失败）都落盘
        res.end();
    }
}

// ---------- API Key 安全存储 ----------
// Windows 下用 DPAPI（当前用户级）加密落盘；失败时退回明文（仅内存策略可选，见 PUT 处理）
async function dpapiProtect(text: string): Promise<string | null> {
    const script =
        "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:RPA_KEY); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($e)";
    try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...process.env, RPA_KEY: text },
            timeout: 10000,
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}
async function dpapiUnprotect(b64: string): Promise<string | null> {
    const script =
        "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:RPA_ENC); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($d)";
    try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...process.env, RPA_ENC: b64 },
            timeout: 10000,
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}
// ---------- 多 API 配置集管理（每套配置独立加密 Key） ----------
interface ApiProfile {
    id: string;
    name: string;
    baseUrl: string;
    modelId: string;
    thinking: string;
    key?: { scheme: "dpapi" | "plain"; encrypted?: string; plain?: string };
}
let apiProfiles: ApiProfile[] = [];
let activeProfileId = "";

function saveApiProfiles() {
    saveJson(API_PROFILES_FILE, { active: activeProfileId, profiles: apiProfiles });
}
async function decryptProfileKey(p: ApiProfile): Promise<string | undefined> {
    if (!p.key) return undefined;
    if (p.key.scheme === "dpapi" && p.key.encrypted) return (await dpapiUnprotect(p.key.encrypted)) ?? undefined;
    if (p.key.scheme === "plain" && typeof p.key.plain === "string") return p.key.plain;
    return undefined;
}
async function encryptProfileKey(apiKey: string): Promise<{ scheme: "dpapi"; encrypted: string } | { scheme: "plain"; plain: string }> {
    const enc = await dpapiProtect(apiKey);
    return enc ? { scheme: "dpapi", encrypted: enc } : { scheme: "plain", plain: apiKey };
}
async function applyActiveProfile() {
    const p = apiProfiles.find((x) => x.id === activeProfileId);
    if (!p) return;
    const apiKey = await decryptProfileKey(p);
    // 无 Key/解密失败时显式清空，避免沿用上一套配置的 Key
    setApiConfig({ baseUrl: p.baseUrl, apiKey: apiKey ?? "", modelId: p.modelId, thinking: p.thinking });
}
function loadApiProfiles() {
    const data = loadJson<{ active?: string; profiles?: ApiProfile[] }>(API_PROFILES_FILE, {});
    apiProfiles = data.profiles ?? [];
    activeProfileId = data.active && apiProfiles.some((x) => x.id === data.active) ? data.active : apiProfiles[0]?.id ?? "";
    if (apiProfiles.length === 0) {
        // 迁移旧的 model-config/credentials 为默认配置集
        const legacy = loadJson<{ baseUrl?: string; apiKey?: string; modelId?: string; thinking?: string }>(MODEL_CONFIG_FILE, {});
        const cred = loadJson<{ scheme?: string; apiKeyEncrypted?: string; apiKeyPlain?: string }>(CREDENTIALS_FILE, {});
        let key: ApiProfile["key"];
        if (cred.scheme === "dpapi" && cred.apiKeyEncrypted) key = { scheme: "dpapi", encrypted: cred.apiKeyEncrypted };
        else if (typeof cred.apiKeyPlain === "string") key = { scheme: "plain", plain: cred.apiKeyPlain };
        else if (typeof legacy.apiKey === "string" && legacy.apiKey) key = { scheme: "plain", plain: legacy.apiKey };
        apiProfiles = [
            {
                id: "default",
                name: "默认",
                baseUrl: legacy.baseUrl ?? getApiConfig().baseUrl,
                modelId: legacy.modelId ?? getModelConfig().modelId,
                thinking: legacy.thinking ?? getModelConfig().thinking,
                key,
            },
        ];
        activeProfileId = "default";
        saveApiProfiles();
    }
}

// ---------- 导演快速判断（每轮对话前的剧情规划） ----------
interface DirectorConfig {
    enabled: boolean;
    profileId: string; // 留空=跟随当前激活配置
    modelId: string;   // 留空=跟随 profile/当前配置
    thinking: string;  // 默认 off，保证这一步快
}
let directorConfig: DirectorConfig = { enabled: true, profileId: "", modelId: "", thinking: "off" };
let lastDirectorNotes: string | null = null;
function loadDirectorConfig() {
    directorConfig = { ...directorConfig, ...loadJson<Partial<DirectorConfig>>(DIRECTOR_CONFIG_FILE, {}) };
}
function saveDirectorConfig() {
    saveJson(DIRECTOR_CONFIG_FILE, directorConfig);
}

const DIRECTOR_PROMPT = `你是角色扮演系统的快速导演。你只负责判断本轮剧情如何推进、角色该知道什么，不写正文。
输入：用户最新消息、当前场景/时间、世界状态、世界书（含隐藏秘密）。
输出要求（最高优先级）：只输出一个 JSON 对象，禁止任何其他文字。格式严格如下：
{"time":"推进后的时间（未变则保持原样）","scene":"本轮场景（未变则保持原样）","character_knows":["角色此刻能感知/得知的信息"],"stage_direction":"给角色模型的一句舞台指示（1-2 句）","director_notes":"仅后台可见：伏笔、NPC 意图、建议落库动作"}
硬性规则：
1. character_knows 与 stage_direction 严禁包含角色不该知道的秘密（隐藏世界书内容、后台意图、未发生的事）。
2. 时间/场景只能跟随剧情实际进展，严禁跳到未发生的地点/阶段。
3. director_notes 可以包含秘密与推演建议，但不得在 character_knows/stage_direction 中泄漏。
`;

async function runDirector(userContent: string) {
    if (!directorConfig.enabled) return null;
    const base = getApiConfig();
    let cfg = { ...base };
    if (directorConfig.profileId) {
        const p = apiProfiles.find((x) => x.id === directorConfig.profileId);
        if (p) cfg = { baseUrl: p.baseUrl, apiKey: (await decryptProfileKey(p)) ?? "", modelId: p.modelId, thinking: p.thinking };
    }
    if (directorConfig.modelId) cfg.modelId = directorConfig.modelId;
    cfg.thinking = directorConfig.thinking || "off";
    const snapshot = [
        `【用户最新消息】${userContent}`,
        `【当前角色】${currentChar.name}`,
        `【场景】${currentChar.scenario}`,
        `【世界时间】${worldState.time}`,
        `【世界书】${currentWorldInfo().length ? currentWorldInfo().map((e) => `- ${e.public ? "公开" : "隐藏"} [${e.keys.join("/")}] ${e.content.slice(0, 160)}`).join("\n") : "（空）"}`,
        `【世界状态】${queryWorld()}`,
    ].join("\n");
    const msgs: Message[] = [{ role: "user", content: snapshot, timestamp: Date.now() }];
    const t0 = Date.now();
    try {
        const { final } = await generate(
            msgs,
            { onThinkingDelta: () => {}, onTextDelta: () => {}, onThinkingEnd: () => {} },
            AbortSignal.timeout(60000),
            undefined,
            getDirectorPrompt(),
            {
                timeoutMs: 45000,
                abortIsError: true,
                maxTokens: 500,
                model: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, modelId: cfg.modelId, thinking: cfg.thinking as ThinkingLevel },
            },
        );
        const jsonText = extractJsonText(textOf(final));
        if (!jsonText) return null;
        const parsed = JSON.parse(jsonText) as {
            time?: unknown;
            scene?: unknown;
            character_knows?: unknown;
            stage_direction?: unknown;
            director_notes?: unknown;
        };
        console.log(`[director] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return {
            time: typeof parsed.time === "string" ? parsed.time : undefined,
            scene: typeof parsed.scene === "string" ? parsed.scene : undefined,
            characterKnows: Array.isArray(parsed.character_knows) ? parsed.character_knows.map(String).filter(Boolean) : [],
            stageDirection: typeof parsed.stage_direction === "string" ? parsed.stage_direction : undefined,
            directorNotes: typeof parsed.director_notes === "string" ? parsed.director_notes : undefined,
        };
    } catch {
        return null; // 导演失败不阻塞对话，降级为现有流程
    }
}

// 从当前 OpenAI 兼容渠道拉取模型列表（失败返回空，前端允许手输自定义模型）
let modelsCache = { at: 0, list: [] as string[] };
async function listModels(): Promise<string[]> {
    if (Date.now() - modelsCache.at < 60000) return modelsCache.list;
    const { baseUrl, apiKey } = getApiConfig();
    const base = baseUrl.replace(/\/+$/, "");
    try {
        const res = await fetch(`${base}/models`, {
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return modelsCache.list;
        const data = (await res.json()) as { data?: { id?: string }[] };
        const list = [...new Set((data.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string" && !!x))];
        modelsCache = { at: Date.now(), list };
        return list;
    } catch {
        return modelsCache.list;
    }
}

// ---------- HTTP 服务器 ----------
// 简单互斥：串行化所有会改动全局上下文/世界状态的请求（GET 与 /api/stop 除外）
let lockChain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockChain.then(() => fn());
    lockChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    const readBody = async (): Promise<Record<string, unknown>> => {
        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 5 * 1024 * 1024) {
                const err = new Error("请求体过大") as Error & { status?: number };
                err.status = 413;
                throw err;
            }
        }
        if (!body) return {};
        try {
            return JSON.parse(body) as Record<string, unknown>;
        } catch {
            const err = new Error("请求体不是合法 JSON") as Error & { status?: number };
            err.status = 400;
            throw err;
        }
    };
    const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
    };

    const route = async () => {
    try {
        // 静态文件
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
            const file = path.join(PUBLIC_DIR, "index.html");
            if (existsSync(file)) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
                res.end(readFileSync(file));
            } else {
                res.writeHead(404).end("index.html not found");
            }
            return;
        }

        // ---------- 状态 ----------
        if (req.method === "GET" && pathname === "/api/state") {
            json(200, {
                character: currentChar,
                characters,
                worldInfo: currentWorldInfo(),
                persona,
                settings: agentSettings,
                meta: { model: getModelConfig().modelId, thinking: getModelConfig().thinking },
            });
            return;
        }

        // ---------- 用户角色（全局 persona） ----------
        if (req.method === "GET" && pathname === "/api/persona") {
            json(200, { persona });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/persona") {
            const body = await readBody();
            if (typeof body.name === "string") persona.name = body.name;
            if (typeof body.description === "string") persona.description = body.description;
            if (typeof body.personality === "string") persona.personality = body.personality;
            if (typeof body.notes === "string") persona.notes = body.notes;
            saveJson(PERSONA_FILE, persona);
            refreshSetting(); // 更新当前会话的设定消息（对话保留）
            saveSession();
            json(200, { ok: true, persona });
            return;
        }

        // ---------- 角色卡 CRUD ----------
        if (req.method === "GET" && pathname === "/api/characters") {
            json(200, { characters, currentId: currentChar.id });
            return;
        }
        if (req.method === "POST" && pathname === "/api/characters") {
            const body = await readBody();
            const card: StoredCharacter = {
                id: randomUUID(),
                name: String(body.name ?? "新角色"),
                description: String(body.description ?? ""),
                personality: String(body.personality ?? ""),
                scenario: String(body.scenario ?? ""),
                world: String(body.world ?? ""),
                rules: Array.isArray(body.rules) ? body.rules.map(String) : [],
                example_dialogue: String(body.example_dialogue ?? ""),
                initialScenario: String(body.scenario ?? ""),
            };
            characters.push(card);
            saveJson(CHARACTERS_FILE, characters);
            json(200, { ok: true, id: card.id, characters });
            return;
        }
        const charPut = pathname.match(/^\/api\/characters\/([^/]+)$/);
        if (req.method === "PUT" && charPut) {
            const id = charPut[1];
            const card = characters.find((c) => c.id === id);
            if (!card) {
                json(404, { error: "character not found" });
                return;
            }
            const body = await readBody();
            if (typeof body.name === "string") card.name = body.name;
            if (typeof body.description === "string") card.description = body.description;
            if (typeof body.personality === "string") card.personality = body.personality;
            if (typeof body.scenario === "string") {
                card.scenario = body.scenario;
                card.initialScenario = body.scenario;
            }
            if (typeof body.world === "string") card.world = body.world;
            if (Array.isArray(body.rules)) card.rules = body.rules.map(String);
            if (typeof body.example_dialogue === "string") card.example_dialogue = body.example_dialogue;
            saveJson(CHARACTERS_FILE, characters);
            if (id === currentChar.id) refreshSetting();
            json(200, { ok: true, characters });
            return;
        }
        const charDel = pathname.match(/^\/api\/characters\/([^/]+)\/delete$/);
        if (req.method === "POST" && charDel) {
            const id = charDel[1];
            characters = characters.filter((c) => c.id !== id);
            // 删除该角色的世界书条目（角色隔离）
            const before = worldInfo.length;
            worldInfo = worldInfo.filter((e) => e.characterId !== id);
            if (worldInfo.length < before) saveJson(WORLDINFO_FILE, worldInfo);
            saveJson(CHARACTERS_FILE, characters);
            // 删除该角色的会话文件
            try {
                if (existsSync(path.join(SESSIONS_DIR, id + ".json"))) {
                    writeFileSync(path.join(SESSIONS_DIR, id + ".json"), "{}", "utf-8"); // 标记空会话
                }
            } catch { /* 忽略 */ }
            try {
                writeFileSync(worldStateFile(id), "{}", "utf-8"); // 标记空世界状态
                writeFileSync(settingsFile(id), "{}", "utf-8"); // 标记空设置
            } catch { /* 忽略 */ }
            if (characters.length === 0) characters = [DEFAULT_CHARACTER];
            if (currentChar.id === id) {
                currentChar = characters[0];
                if (!loadSession(currentChar.id)) resetContext();
                loadWorldStateFor(currentChar.id);
                loadSettingsFor(currentChar.id);
            }
            json(200, { ok: true, characters });
            return;
        }
        const charLoad = pathname.match(/^\/api\/characters\/([^/]+)\/load$/);
        if (req.method === "POST" && charLoad) {
            const id = charLoad[1];
            const card = characters.find((c) => c.id === id);
            if (!card) {
                json(404, { error: "character not found" });
                return;
            }
            saveSession(); // 保存当前角色的会话
            currentChar = card;
            loadWorldStateFor(card.id);
            loadSettingsFor(card.id);
            saveWorldState();
            saveSettings();
            if (!loadSession(card.id)) resetContext(); // 加载新角色会话（无则新开）
            json(200, { ok: true });
            return;
        }

        // ---------- ST 角色卡导入 ----------
        if (req.method === "POST" && pathname === "/api/import/stcard") {
            const body = await readBody();
            const base64 = String(body.base64 ?? "");
            const doLoad = body.load === true;
            if (!base64) {
                json(400, { error: "base64 required" });
                return;
            }
            const buf = Buffer.from(base64, "base64");
            const raw = parseSTCardPNG(buf);
            if (!raw) {
                json(400, { error: "无法解析 PNG 角色卡（未找到 chara/ccv3 元数据）" });
                return;
            }
            const { char, wiEntries } = importSTCard(raw);
            characters.push(char);
            saveJson(CHARACTERS_FILE, characters);
            // 世界书条目归属该角色
            for (const w of wiEntries) {
                worldInfo.push({
                    id: randomUUID(),
                    characterId: char.id,
                    keys: w.keys,
                    content: w.content,
                    enabled: true,
                });
            }
            saveJson(WORLDINFO_FILE, worldInfo);
            if (doLoad) {
                currentChar = char;
                loadWorldStateFor(char.id);
                loadSettingsFor(char.id);
                saveWorldState();
                saveSettings();
                resetContext();
            }
            json(200, {
                ok: true,
                id: char.id,
                name: char.name,
                importedWorldInfo: wiEntries.length,
                loaded: doLoad,
            });
            return;
        }

        // ---------- 模拟世界 ----------
        if (req.method === "GET" && pathname === "/api/worldstate") {
            json(200, { worldState });
            return;
        }
        if (req.method === "POST" && pathname === "/api/advance") {
            const body = await readBody();
            const result = await advanceWorld(typeof body.note === "string" ? body.note : undefined);
            json(200, { ok: true, result, worldState });
            return;
        }

        // ---------- 设置与世界状态编辑 ----------
        if (req.method === "GET" && pathname === "/api/settings") {
            json(200, { settings: agentSettings });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/settings") {
            const body = await readBody();
            if (body.evolutionMode === "active" || body.evolutionMode === "balanced" || body.evolutionMode === "minimal") {
                agentSettings.evolutionMode = body.evolutionMode;
            }
            if (typeof body.evolutionDirection === "string") agentSettings.evolutionDirection = body.evolutionDirection;
            if (typeof body.advanceInterval === "number" && body.advanceInterval >= 1 && body.advanceInterval <= 10) {
                agentSettings.advanceInterval = Math.floor(body.advanceInterval);
            }
            saveSettings();
            json(200, { ok: true, settings: agentSettings });
            return;
        }
        if (req.method === "GET" && pathname === "/api/model-config") {
            const p = apiProfiles.find((x) => x.id === activeProfileId);
            const apiKey = p ? (await decryptProfileKey(p)) ?? "" : "";
            json(200, {
                config: {
                    baseUrl: p?.baseUrl ?? getApiConfig().baseUrl,
                    apiKey,
                    modelId: p?.modelId ?? getModelConfig().modelId,
                    thinking: p?.thinking ?? getModelConfig().thinking,
                },
            });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/model-config") {
            const p = apiProfiles.find((x) => x.id === activeProfileId);
            if (!p) {
                json(404, { error: "没有可用的 API 配置，请先新建" });
                return;
            }
            const body = await readBody();
            if (typeof body.name === "string" && body.name.trim()) p.name = body.name.trim();
            if (typeof body.baseUrl === "string" && body.baseUrl.trim()) p.baseUrl = body.baseUrl.trim();
            if (typeof body.modelId === "string" && body.modelId.trim()) p.modelId = body.modelId.trim();
            if (typeof body.thinking === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(body.thinking)) {
                p.thinking = body.thinking;
            }
            if (typeof body.apiKey === "string") {
                if (body.apiKey === "") p.key = undefined;
                else p.key = await encryptProfileKey(body.apiKey);
            }
            saveApiProfiles();
            await applyActiveProfile();
            json(200, { ok: true, config: { baseUrl: p.baseUrl, apiKey: (await decryptProfileKey(p)) ?? "", modelId: p.modelId, thinking: p.thinking } });
            return;
        }
        if (req.method === "GET" && pathname === "/api/api-profiles") {
            const profiles = [];
            for (const p of apiProfiles) {
                profiles.push({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    modelId: p.modelId,
                    thinking: p.thinking,
                    apiKey: (await decryptProfileKey(p)) ?? "",
                });
            }
            json(200, { active: activeProfileId, profiles });
            return;
        }
        if (req.method === "POST" && pathname === "/api/api-profiles") {
            const body = await readBody();
            const baseUrl = String(body.baseUrl ?? "").trim();
            if (!baseUrl) {
                json(400, { error: "baseUrl 不能为空" });
                return;
            }
            const profile: ApiProfile = {
                id: randomUUID(),
                name: String(body.name ?? "新配置").trim() || "新配置",
                baseUrl,
                modelId: String(body.modelId ?? getModelConfig().modelId).trim() || getModelConfig().modelId,
                thinking: ["off", "low", "medium", "high", "xhigh", "max"].includes(String(body.thinking)) ? String(body.thinking) : getModelConfig().thinking,
            };
            if (typeof body.apiKey === "string" && body.apiKey) profile.key = await encryptProfileKey(body.apiKey);
            apiProfiles.push(profile);
            activeProfileId = profile.id;
            saveApiProfiles();
            await applyActiveProfile();
            json(200, { ok: true, id: profile.id });
            return;
        }
        const apiProfilePut = pathname.match(/^\/api\/api-profiles\/([^/]+)$/);
        if (req.method === "PUT" && apiProfilePut) {
            const id = apiProfilePut[1];
            const p = apiProfiles.find((x) => x.id === id);
            if (!p) {
                json(404, { error: "profile not found" });
                return;
            }
            const body = await readBody();
            if (typeof body.name === "string" && body.name.trim()) p.name = body.name.trim();
            if (typeof body.baseUrl === "string" && body.baseUrl.trim()) p.baseUrl = body.baseUrl.trim();
            if (typeof body.modelId === "string" && body.modelId.trim()) p.modelId = body.modelId.trim();
            if (typeof body.thinking === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(body.thinking)) {
                p.thinking = body.thinking;
            }
            if (typeof body.apiKey === "string") {
                if (body.apiKey === "") p.key = undefined;
                else p.key = await encryptProfileKey(body.apiKey);
            }
            saveApiProfiles();
            if (id === activeProfileId) await applyActiveProfile();
            json(200, { ok: true });
            return;
        }
        const apiProfileDel = pathname.match(/^\/api\/api-profiles\/([^/]+)\/delete$/);
        if (req.method === "POST" && apiProfileDel) {
            const id = apiProfileDel[1];
            const before = apiProfiles.length;
            apiProfiles = apiProfiles.filter((x) => x.id !== id);
            if (apiProfiles.length === before) {
                json(404, { error: "profile not found" });
                return;
            }
            if (activeProfileId === id) activeProfileId = apiProfiles[0]?.id ?? "";
            saveApiProfiles();
            await applyActiveProfile();
            json(200, { ok: true });
            return;
        }
        const apiProfileAct = pathname.match(/^\/api\/api-profiles\/([^/]+)\/activate$/);
        if (req.method === "POST" && apiProfileAct) {
            const id = apiProfileAct[1];
            if (!apiProfiles.some((x) => x.id === id)) {
                json(404, { error: "profile not found" });
                return;
            }
            activeProfileId = id;
            saveApiProfiles();
            await applyActiveProfile();
            json(200, { ok: true, config: getApiConfig() });
            return;
        }
        if (req.method === "GET" && pathname === "/api/director-config") {
            json(200, { config: directorConfig });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/director-config") {
            const body = await readBody();
            if (typeof body.enabled === "boolean") directorConfig.enabled = body.enabled;
            if (typeof body.profileId === "string") {
                if (body.profileId && !apiProfiles.some((x) => x.id === body.profileId)) {
                    json(400, { error: "配置集不存在" });
                    return;
                }
                directorConfig.profileId = body.profileId;
            }
            if (typeof body.modelId === "string") directorConfig.modelId = body.modelId.trim();
            if (typeof body.thinking === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(body.thinking)) {
                directorConfig.thinking = body.thinking;
            }
            saveDirectorConfig();
            json(200, { ok: true, config: directorConfig });
            return;
        }
        if (req.method === "GET" && pathname === "/api/prompts") {
            json(200, {
                prompts: {
                    oocAgent: customPrompts.oocAgent ?? "",
                    manager: customPrompts.manager ?? "",
                    director: customPrompts.director ?? "",
                },
                defaults: { oocAgent: AGENT_PROMPT, manager: MANAGER_PROMPT, director: DIRECTOR_PROMPT },
            });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/prompts") {
            const body = await readBody();
            if (typeof body.oocAgent === "string") customPrompts.oocAgent = body.oocAgent;
            if (typeof body.manager === "string") customPrompts.manager = body.manager;
            if (typeof body.director === "string") customPrompts.director = body.director;
            saveJson(PROMPTS_FILE, customPrompts);
            json(200, {
                ok: true,
                prompts: {
                    oocAgent: customPrompts.oocAgent ?? "",
                    manager: customPrompts.manager ?? "",
                    director: customPrompts.director ?? "",
                },
            });
            return;
        }
        if (req.method === "GET" && pathname === "/api/models") {
            const models = await listModels();
            json(200, { models, current: getModelConfig().modelId });
            return;
        }
        if (req.method === "PUT" && pathname === "/api/worldstate") {
            const body = await readBody();
            const ws = body.worldState as WorldState | undefined;
            if (!ws || typeof ws !== "object") {
                json(400, { error: "worldState required" });
                return;
            }
            worldState = {
                time: typeof ws.time === "string" ? ws.time : worldState.time,
                npcs: Array.isArray(ws.npcs)
                    ? ws.npcs
                          .filter((n) => n && typeof n.name === "string")
                          .map((n) => ({
                              name: String(n.name),
                              goal: String(n.goal ?? ""),
                              action: String(n.action ?? ""),
                              location: String(n.location ?? ""),
                          }))
                    : worldState.npcs,
                log: Array.isArray(ws.log)
                    ? ws.log.map((l) =>
                          typeof l === "string"
                              ? { text: l, known: false }
                              : { text: String(l?.text ?? ""), known: l?.known === true },
                      )
                    : worldState.log,
            };
            saveWorldState();
            json(200, { ok: true, worldState });
            return;
        }

        // POST /api/agent/run — 手动触发幕后 Agent 管理评估
        if (req.method === "POST" && pathname === "/api/agent/run") {
            const body = await readBody();
            const actions = await runAgentLoop(4, typeof body.messageId === "string" ? body.messageId : undefined);
            json(200, { ok: true, actions });
            return;
        }

        // ---------- 世界书 CRUD（按当前角色隔离） ----------
        if (req.method === "GET" && pathname === "/api/worldinfo") {
            json(200, { worldInfo: currentWorldInfo() });
            return;
        }
        if (req.method === "POST" && pathname === "/api/worldinfo") {
            const body = await readBody();
            const entry: WorldInfoEntry = {
                id: randomUUID(),
                characterId: currentChar.id,
                keys: Array.isArray(body.keys) ? body.keys.map(String) : [],
                content: String(body.content ?? ""),
                enabled: body.enabled !== false,
                public: body.public !== false,
            };
            worldInfo.push(entry);
            saveJson(WORLDINFO_FILE, worldInfo);
            json(200, { ok: true, id: entry.id, worldInfo: currentWorldInfo() });
            return;
        }
        const wiPut = pathname.match(/^\/api\/worldinfo\/([^/]+)$/);
        if (req.method === "PUT" && wiPut) {
            const id = wiPut[1];
            const entry = worldInfo.find((e) => e.id === id && e.characterId === currentChar.id);
            if (!entry) {
                json(404, { error: "worldinfo not found" });
                return;
            }
            const body = await readBody();
            if (Array.isArray(body.keys)) entry.keys = body.keys.map(String);
            if (typeof body.content === "string") entry.content = body.content;
            if (typeof body.enabled === "boolean") entry.enabled = body.enabled;
            if (typeof body.public === "boolean") entry.public = body.public;
            saveJson(WORLDINFO_FILE, worldInfo);
            json(200, { ok: true, worldInfo: currentWorldInfo() });
            return;
        }
        const wiDel = pathname.match(/^\/api\/worldinfo\/([^/]+)\/delete$/);
        if (req.method === "POST" && wiDel) {
            const id = wiDel[1];
            worldInfo = worldInfo.filter((e) => e.id !== id);
            injectedWorldInfo.delete(id);
            saveJson(WORLDINFO_FILE, worldInfo);
            json(200, { ok: true, worldInfo: currentWorldInfo() });
            return;
        }

        // ---------- 聊天 ----------
        if (req.method === "GET" && pathname === "/api/history") {
            const mode = url.searchParams.get("mode") ?? "all"; // ic | ooc | all
            const messages = [];
            if (mode !== "ooc") {
                // 用户与角色的对话记录
                for (let i = 0; i < context.length; i++) if (isUiVisible(i)) messages.push(uiMessage(i));
            }
            if (mode !== "ic") {
                // 用户与 agent 的对话记录
                for (let i = 0; i < oocMessages.length; i += 2) {
                    const u = oocMessages[i];
                    const a = oocMessages[i + 1];
                    if (u) messages.push({ id: "ooc-" + i, role: "user", content: textOf(u), ooc: true, timestamp: (u as { timestamp?: number }).timestamp ?? Date.now() });
                    if (a) messages.push({ id: "ooc-" + (i + 1), role: "assistant", content: textOf(a), thinking: thinkingOf(a), ooc: true, versions: [], timestamp: (a as { timestamp?: number }).timestamp ?? Date.now(), tokens: usageOf(a), trace: traceMap.get("ooc-" + (i + 1)) });
                }
            }
            json(200, {
                messages,
                meta: { character: currentChar.name, model: getModelConfig().modelId, thinking: getModelConfig().thinking },
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/chat") {
            const { content } = await readBody();
            if (typeof content !== "string" || !content.trim()) {
                json(400, { error: "content required" });
                return;
            }
            // 导演快速判断：先决定剧情/时间/场景/角色可知信息，再进入角色对话
            const dir = await runDirector(content.trim());
            if (dir) {
                if (dir.time && dir.time !== worldState.time) {
                    worldState.time = dir.time;
                    saveWorldState();
                }
                if (dir.scene && dir.scene !== currentChar.scenario) {
                    currentChar.scenario = dir.scene;
                    saveJson(CHARACTERS_FILE, characters);
                    refreshSetting();
                }
                const parts: string[] = [];
                if (dir.time) parts.push(`时间：${dir.time}`);
                if (dir.scene) parts.push(`场景：${dir.scene}`);
                if (dir.characterKnows?.length) parts.push(`角色此刻知道/感知：${dir.characterKnows.join("；")}`);
                if (dir.stageDirection) parts.push(`舞台指示：${dir.stageDirection}`);
                if (parts.length) pushMessage({ role: "user", content: `【导演提示】${parts.join("\n")}`, timestamp: Date.now() }, true);
                lastDirectorNotes = dir.directorNotes ?? null;
            }
            const awareness = buildWorldAwareness();
            if (awareness) pushMessage(awareness, true);
            pushMessage({ role: "user", content: content.trim(), timestamp: Date.now() });
            injectWorldInfo(content.trim());
            await generateToSSE(res);
            return;
        }

        // ---------- OOC（Agent 对话） ----------
        if (req.method === "POST" && pathname === "/api/ooc") {
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
        const oocDelMatch = pathname.match(/^\/api\/ooc\/messages\/(\d+)\/delete$/);
        if (req.method === "POST" && oocDelMatch) {
            const idx = Number(oocDelMatch[1]);
            if (idx < 0 || idx >= oocMessages.length) {
                json(404, { error: "ooc message not found" });
                return;
            }
            oocMessages.splice(idx);
            remapOocTraces();
            saveSession();
            json(200, { ok: true });
            return;
        }

        // POST /api/ooc/messages/:index/edit {content} — 编辑 OOC user 消息并删除后续
        const oocEditMatch = pathname.match(/^\/api\/ooc\/messages\/(\d+)\/edit$/);
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
            remapOocTraces();
            saveSession();
            json(200, { ok: true });
            return;
        }

        // POST /api/ooc/messages/:index/regenerate — 重生成该条 OOC assistant 消息（SSE）
        const oocRegenMatch = pathname.match(/^\/api\/ooc\/messages\/(\d+)\/regenerate$/);
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
            remapOocTraces();
            saveSession();
            const ctx = [buildAgentSnapshot(), ...oocMessages];
            await generateOocToSSE(res, ctx, null);
            return;
        }

        // ---------- 消息操作 ----------
        const editMatch = pathname.match(/^\/api\/messages\/([^/]+)\/edit$/);
        if (req.method === "POST" && editMatch) {
            const idx = ids.indexOf(editMatch[1]);
            if (idx < 0) {
                json(404, { error: "message not found" });
                return;
            }
            const msg = context[idx];
            if (msg.role !== "user") {
                json(400, { error: "only user messages can be edited" });
                return;
            }
            const { content } = await readBody();
            if (typeof content !== "string" || !content.trim()) {
                json(400, { error: "content required" });
                return;
            }
            context[idx] = { role: "user", content: content.trim(), timestamp: msg.timestamp };
            deleteFromContext(idx + 1);
            saveSession();
            json(200, { ok: true });
            return;
        }
        const delMatch = pathname.match(/^\/api\/messages\/([^/]+)\/delete$/);
        if (req.method === "POST" && delMatch) {
            const idx = ids.indexOf(delMatch[1]);
            if (idx < 0) {
                json(404, { error: "message not found" });
                return;
            }
            deleteFromContext(idx);
            saveSession();
            json(200, { ok: true });
            return;
        }
        const regenMatch = pathname.match(/^\/api\/messages\/([^/]+)\/regenerate$/);
        if (req.method === "POST" && regenMatch) {
            const idx = ids.indexOf(regenMatch[1]);
            if (idx < 0) {
                json(404, { error: "message not found" });
                return;
            }
            if (context[idx].role !== "assistant") {
                json(400, { error: "only assistant messages can be regenerated" });
                return;
            }
            const old = uiMessage(idx);
            const oldList = [...(versions.get(old.id) ?? []), { content: old.content, thinking: old.thinking, ts: old.timestamp }];
            versions.delete(old.id);
            deleteFromContext(idx);
            await generateToSSE(res, (newId) => versions.set(newId, oldList));
            return;
        }

        // ---------- 停止 / 重置 / OOC 重置 ----------
        if (req.method === "POST" && pathname === "/api/stop") {
            currentAbort?.abort();
            json(200, { ok: true });
            return;
        }
        if (req.method === "POST" && pathname === "/api/ooc/reset") {
            const body = await readBody();
            if (body.characterId && body.characterId !== currentChar.id) {
                json(409, { error: "服务端当前角色已切换，请刷新界面后重试" });
                return;
            }
            oocMessages.length = 0;
            lastDirectorNotes = null;
            saveSession();
            json(200, { ok: true });
            return;
        }
        if (req.method === "POST" && pathname === "/api/reset") {
            const body = await readBody();
            if (body.characterId && body.characterId !== currentChar.id) {
                json(409, { error: "服务端当前角色已切换，请刷新界面后重试" });
                return;
            }
            // 恢复开场场景，并重置该角色的世界状态，避免新对话续写旧剧情
            if (currentChar.initialScenario) {
                currentChar.scenario = currentChar.initialScenario;
                saveJson(CHARACTERS_FILE, characters);
            }
            worldState = { time: "第一天 傍晚", npcs: [], log: [] };
            saveWorldState();
            resetContext();
            saveSession();
            json(200, { ok: true });
            return;
        }

        json(404, { error: "not found" });
    } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        json(status, { error: err instanceof Error ? err.message : String(err) });
    }
    };
    if (req.method !== "GET" && pathname !== "/api/stop") {
        await withLock(route);
    } else {
        await route();
    }
});

server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
        console.error("\x1b[31m端口 " + PORT + " 已被占用\x1b[0m");
        console.error("可能已有 rp-server 在后台运行。释放端口：");
        console.error('  Get-NetTCPConnection -LocalPort ' + PORT + " -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }");
        console.error("或换端口：$env:PORT=3201; npm run web");
    } else {
        console.error(err);
    }
    process.exit(1);
});

// ---------- 初始化（先加载加密凭据，再恢复会话，最后监听） ----------
async function init() {
    loadApiProfiles();
    loadDirectorConfig();
    customPrompts = loadJson<{ oocAgent?: string; manager?: string; director?: string }>(PROMPTS_FILE, {});
    await applyActiveProfile();
    if (process.env.RPA_MOCK === "1") {
        // Mock 模式：忽略已保存的 API 配置集，强制指向本地假模型
        setApiConfig({ baseUrl: "http://127.0.0.1:18080/v1", apiKey: "test", modelId: getModelConfig().modelId, thinking: getModelConfig().thinking });
        directorConfig.profileId = "";
        directorConfig.modelId = "";
        console.log("\x1b[36m[mock]\x1b[0m 已启用假模型模式（忽略 API 配置集）");
    }
    if (!loadSession(currentChar.id)) resetContext();
    if (!getApiConfig().apiKey) {
        console.warn("\x1b[33m[提示] 未检测到 API Key：请在网页「设置 → API 与模型」中配置，或运行 mock.bat 用假模型试玩。\x1b[0m");
    }
    server.listen(PORT, "127.0.0.1", () => {
        console.log(`\x1b[36m[rp-server]\x1b[0m http://localhost:${PORT}`);
        console.log(`角色：${currentChar.name} | 模型：${getModelConfig().modelId} | 思考：${getModelConfig().thinking}`);
        console.log(`角色卡：${characters.length} 个 | 世界书：${worldInfo.length} 条（当前角色 ${currentWorldInfo().length} 条）`);
        console.log(`用户角色：${persona.name}`);
    });
}
init().catch((err) => {
    console.error("初始化失败:", err);
    process.exit(1);
});
