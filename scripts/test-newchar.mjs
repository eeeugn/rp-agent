// test-newchar.mjs — 新角色「沈舟」整体系统测试（模拟用户在角色对话模式交互）
// 主线：雨夜老街 → 古井异象 → 字条线索 → 井水成镜 → 灰街遭遇 → 解决 → 回归日常
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";

const base = "http://localhost:3200";
const LOG = "E:/rp-demo/logs/test-newchar.log";
const PROG = "E:/rp-demo/logs/test-newchar-log.json";
const log = (s) => {
    const line = `[${new Date().toLocaleTimeString()}] ${s}`;
    console.log(line);
    appendFileSync(LOG, line + "\n", "utf-8");
};

async function readSSE(res, timeoutMs = 300000) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    while (true) {
        if (Date.now() - t0 > timeoutMs) return { buf, timeout: true };
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
    }
    return { buf, timeout: false };
}

async function chat(content) {
    const t0 = Date.now();
    const res = await fetch(base + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
    });
    const { buf, timeout } = await readSSE(res);
    const evs = buf.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    const text = evs.filter((e) => e.type === "text").map((e) => e.delta).join("");
    const doneEv = evs.find((e) => e.type === "done");
    return { text, done: !!doneEv, messageId: doneEv?.message?.id, timeout, ms: Date.now() - t0 };
}

async function agentRun(messageId) {
    const t0 = Date.now();
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 260000);
        const res = await fetch(base + "/api/agent/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId }),
            signal: ac.signal,
        });
        const d = await res.json();
        clearTimeout(timer);
        return { actions: d.actions || [], ms: Date.now() - t0 };
    } catch (e) {
        return { actions: ["请求失败: " + e.message], ms: Date.now() - t0 };
    }
}

async function advance() {
    try {
        const res = await fetch(base + "/api/advance", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        const d = await res.json();
        return d.result || "";
    } catch (e) {
        return "推演失败: " + e.message;
    }
}

async function worldState() {
    try {
        const d = await (await fetch(base + "/api/worldstate")).json();
        return `时间=${d.worldState.time} NPC=${d.worldState.npcs.length}(${d.worldState.npcs.map((n) => n.name).join("/")}) 日志=${d.worldState.log.length}`;
    } catch {
        return "世界状态读取失败";
    }
}

const steps = [
    { u: "雨突然下大了，我一路跑到这家旧书店门口，在屋檐下躲雨。门开着，我看见你在搬门口的书架。能借个地方躲雨吗？", n: "躲雨进店" },
    { u: "我帮你把书架往屋里挪，雨声敲着瓦片，屋里一股旧纸的味道。你递了条毛巾给我，又转身去泡茶。我随口问：老街这边最近有没有什么新鲜事？", n: "雨夜闲谈" },
    { u: "你说巷尾那口井最近夜里老有咕噜声，路灯也闪得厉害。雨小了点，我想去看看那口井，你陪我走一趟？", n: "去看古井" },
    { u: "井找到了，在巷子尽头，青苔长得发黑。我探头往里看——井水居然映不出天空，水面上像蒙着一层灰，看不清底。你以前见过这样的井吗？", n: "古井异象" },
    { u: "回店里你翻一本旧书时，书里掉出一张泛黄的字条，上面写着几行字，好像和井水、影子有关。你念给我听听？", n: "字条线索" },
    { u: "半夜我睡不着，又溜到巷尾。井水真的漫上来了，漫过井沿，水面里映着一条灰蒙蒙的街道，街上站着模糊的人影。我回头看见你打着手电跟过来——你也看见了？", n: "井水成镜" },
    { u: "我们踏进那片水面，来到灰街上。街尽头井边，一团湿漉漉的黑影慢慢站起来，没有脸，朝我们这边转过来。它开口了，声音闷闷的：「活人……」", n: "灰街遭遇" },
    { u: "我想起字条上的那句话，冲着它喊出那个名字。它真的僵住了，像被什么钉在原地。你拉住我：「趁现在！」——然后呢？", n: "解决与回归" },
];

let prog = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf-8")) : { rounds: [], startedAt: Date.now() };
const startFrom = prog.rounds.length;

log("========== 沈舟整体系统测试开始（8 轮） ==========");
// 确保当前角色是沈舟（服务重启后默认回到列表第一个角色）
{
    const st = await (await fetch(base + "/api/state")).json();
    const sz = st.characters.find((c) => c.name === "沈舟");
    if (!sz) throw new Error("找不到角色 沈舟");
    if (st.character.id !== sz.id) {
        await fetch(base + `/api/characters/${sz.id}/load`, { method: "POST" });
        log("已切换到沈舟");
    }
}
log("起始世界状态: " + (await worldState()));
if (startFrom === 0) {
    await fetch(base + "/api/reset", { method: "POST" });
    log("会话已重置");
}

for (let i = startFrom; i < steps.length; i++) {
    const step = steps[i];
    log(`\n--- 第 ${i + 1} 轮 [${step.n}] ---`);
    log("输入: " + step.u.slice(0, 70) + (step.u.length > 70 ? "…" : ""));

    const r = await chat(step.u);
    log(`角色生成: ${(r.ms / 1000).toFixed(1)}s | done=${r.done}${r.timeout ? " | ⚠超时" : ""}`);
    log("沈舟回复: " + (r.text.slice(0, 260).replace(/\n/g, " ") || "(空)"));

    const a = await agentRun(r.messageId);
    log(`Agent 评估: ${(a.ms / 1000).toFixed(1)}s | actions=${a.actions.length}`);
    a.actions.forEach((x) => log("  🤖 " + x.slice(0, 130)));

    if ((i + 1) % 3 === 0) {
        const av = await advance();
        log("世界演化: " + av.slice(0, 130));
    }
    log("世界状态: " + (await worldState()));

    prog.rounds.push({
        round: i + 1,
        note: step.n,
        input: step.u,
        reply: r.text,
        replyLen: r.text.length,
        done: r.done,
        timeout: r.timeout,
        icMs: r.ms,
        agentMs: a.ms,
        agentActions: a.actions,
        at: new Date().toISOString(),
    });
    writeFileSync(PROG, JSON.stringify(prog, null, 2), "utf-8");
}

log("\n========== 测试结束 ==========");
log("汇总: " + JSON.stringify(prog.rounds.map((r) => ({ r: r.round, ok: r.done, len: r.replyLen, agent: r.agentActions.length, ic: Math.round(r.icMs / 1000), agentMs: Math.round(r.agentMs / 1000) }))));
log("最终世界状态: " + (await worldState()));
