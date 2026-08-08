// test-live.mjs — 从零开始的真实 API 主线测试
// 主线：主角与小李一起发现人间与鬼界的存在，并合力击败小boss「井祟」
// 流程模拟前端：IC 生成 → Agent 评估 → 每 3 轮世界演化
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";

const base = "http://localhost:3200";
const LOG = "E:/rp-demo/logs/live-test.log";
const PROG = "E:/rp-demo/logs/live-test-log.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const text = [...buf.matchAll(/"type":"text","delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    const done = buf.includes('"type":"done"');
    return { text, done, timeout, ms: Date.now() - t0 };
}

async function agentRun() {
    const t0 = Date.now();
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 260000);
        const res = await fetch(base + "/api/agent/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
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

// ---------- 主线（12 轮，用户输入只给动作/观察，不预设 AI 回答） ----------
const steps = [
    { u: "傍晚的公园长椅上，我刚坐下，你背着书包从对面走过来，看见我愣了一下，然后抿着嘴笑了笑，在我旁边坐下。今天放学怎么这么晚？", n: "开场日常" },
    { u: "天突然暗得不对劲，明明才七点多，路灯却一盏接一盏地闪。喷泉的水面没有风，却一圈一圈地泛起细纹，倒影里的天空好像不是我们这个天空。我盯着水面看了几秒，心里有点发毛，你呢？", n: "异象初现" },
    { u: "我拉着你绕到喷泉另一边，想看看是不是灯的问题。结果滑梯底下蹲着一团灰蒙蒙的影子——没有主人的那种，它没有脸，却好像正朝着我们这个方向。你还记得外婆说过的话吗？", n: "灰影" },
    { u: "你翻书包想找手机照明，却带出一本旧相册。你愣了一下，翻到其中一页——一张泛黄的老照片，一个穿碎花衬衫的女人蹲在井沿边。照片背面好像有字，你看了看，念给我听？", n: "照片线索" },
    { u: "你犹豫了一会儿，说外婆生前讲过，柳树巷那口老井「通着别处」。我们决定去看看。老街上路灯忽明忽暗，巷口有个大叔站在小卖部门口抽烟，好像没注意到我们。井在巷子深处吗？", n: "前往柳树巷" },
    { u: "井找到了。井沿的青苔绿得发黑，井水映不出天，只映着一片灰蒙蒙的天色，水面安安静静的，却好像有什么东西在井底动。我们蹲在井边，谁也没先开口。水里……是不是有什么在看着我们？", n: "古井异象" },
    { u: "井水忽然自己满上来，漫过井沿，在月光下铺开一片亮亮的水面。水面里不是我们的倒影，而是一条灰暗的街道，街上站着几个模糊的人影，全都面朝一个方向。外婆说过「莫照镜、莫碰水」，可我觉得，要是不进去看一眼，就再也没机会弄清楚这些事了。你愿意跟我一起进去吗？", n: "水镜与通道" },
    { u: "我们牵着手，一起踏进那片水面。一步过去，声音全没了，空气冷得像冰窖。我们站在一条灰蒙蒙的街上，两边的房子都像褪了色的老照片，看不见一个人。你冷吗？我们往哪边走？", n: "进入鬼界" },
    { u: "街尽头的井边，一团湿漉漉的黑影从地底下慢慢浮上来，越聚越高，最后变成一个没有五官的人形，身上往下滴水。它开口了，声音像从井底传上来的：「活人……借你们的影子用用。」我挡在你前面，它朝我们扑过来了！", n: "遭遇井祟" },
    { u: "我忽然想起外婆的话——水面能照出它的样子，怕响亮的金属声，还怕被人叫破真名。我一边后退一边喊：「井祟！你就是井祟！」你从书包里摸出那半块石敢当碎片——它真的僵住了。现在怎么办？", n: "对峙与弱点" },
    { u: "我们趁它僵住，把石敢当碎片按进它胸口，把它往井底推。它尖叫着缩回水里，井水轰然合拢，恢复成普通的水面。我们瘫坐在井边，过了好半天才听见巷口传来大叔的脚步声和打火机的声音——世界好像又正常了。接下来怎么办？", n: "击败井祟" },
    { u: "第二天傍晚，我们又坐在公园长椅上。陈伯照例擦长椅，林小满拎着奶茶路过，张阿姨遛着柯基。一切好像什么都没发生过，只有你书包里那本旧相册沉甸甸的。你说，井底那东西，真的睡着了吗？", n: "回归日常" },
];

// ---------- 执行 ----------
let prog = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf-8")) : { rounds: [], startedAt: Date.now() };
const startFrom = prog.rounds.length;

log("========== 真实主线测试开始（12 轮） ==========");
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
    log("角色回复: " + (r.text.slice(0, 260).replace(/\n/g, " ") || "(空)"));

    const a = await agentRun();
    log(`Agent 评估: ${(a.ms / 1000).toFixed(1)}s | actions=${a.actions.length}`);
    a.actions.forEach((x) => log("  🤖 " + x.slice(0, 140)));

    if ((i + 1) % 3 === 0) {
        const av = await advance();
        log("世界演化: " + av.slice(0, 140));
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
