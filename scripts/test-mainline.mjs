// test-mainline.mjs — 12 轮真实主线测试：人间与鬼界 + 小boss
// 模拟前端完整机制：IC 生成 → Agent 评估 → 每 3 轮世界演化
import { writeFileSync, appendFileSync } from "node:fs";

const base = "http://localhost:3200";
const LOG = "E:/rp-demo/logs/mainline-test.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => {
    const line = `[${new Date().toLocaleTimeString()}] ${s}`;
    console.log(line);
    appendFileSync(LOG, line + "\n", "utf-8");
};

async function readSSE(res, timeoutMs = 240000) {
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
        const res = await fetch(base + "/api/agent/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        const d = await res.json();
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
    const d = await (await fetch(base + "/api/worldstate")).json();
    return `时间=${d.worldState.time} NPC=${d.worldState.npcs.length} 日志=${d.worldState.log.length}`;
}

// ---------- 主线（12 轮） ----------
const steps = [
    { u: "傍晚的公园长椅上，我坐下来，身边是刚放学的你。夕阳把影子拉得很长，风里有栀子花的味道。今天过得怎么样？", n: "开场日常" },
    { u: "天快黑了，你收拾书包准备回家。突然我注意到，公园喷泉的水面平静得异常——明明没有风，水面却像镜子一样，倒映着一片漆黑，看不到任何东西。", n: "异象萌芽" },
    { u: "我拉住你的手，指着喷泉。水里倒映的不是我们头顶的天空，而是一条灰暗的街道，街上站着模糊的人影，像另一个世界。", n: "发现鬼界入口" },
    { u: "我们试着靠近喷泉，一股凉意从脚底窜上来。你书包里那张旧照片——照片里的女人，居然在倒影里动了一下，转过头看了我们一眼。", n: "照片呼应" },
    { u: "你沉默了一会儿，说你从小就能看到一些奇怪的东西，一直不敢告诉别人。现在喷泉里的世界在召唤我们，你问我敢不敢一起进去看看。", n: "角色背景揭示" },
    { u: "我点头。我们并肩跨进喷泉的倒影——一步过去，空气骤然变冷，所有声音消失了。我们站在一条灰暗的街道上，街道尽头立着一座破旧的戏楼。", n: "进入鬼界" },
    { u: "戏楼门口挂着一盏白灯笼，上面写着「子时开锣」。里面传来咿咿呀呀的唱戏声，还有鼓掌喝彩——可这空荡荡的街上，明明只有我们两个人。", n: "探索鬼界" },
    { u: "我们推开戏楼的门。台上一个穿红嫁衣的身影正在唱戏，唱到一半突然转过头——她的脸白得像纸，眼睛全是黑的。她笑了：'来了两个活人，正好。'", n: "遭遇 boss" },
    { u: "红嫁衣女人从台上飘下来，指甲变得又长又黑。她说她要吃掉我们的命，好让她能走出鬼界。我挡在你前面，问她怎么样才肯放过我们。", n: "boss 对峙" },
    { u: "她大笑：'想活命？拿你们最珍贵的东西来换。' 你咬咬牙，从书包里掏出那张旧照片——'这是我妈，我最珍贵的东西。但我会自己找到她。' 照片在你手里燃烧起来，发出刺目的白光。", n: "boss 战高潮" },
    { u: "白光炸开，红嫁衣女人发出凄厉的尖叫，身影在白光里碎成一片片纸屑。戏楼轰然倒塌，一股力量把我们推回喷泉边——水面恢复平静，倒映着正常的黄昏。你手里的照片只剩一片焦黑的纸灰。", n: "boss 战胜利" },
    { u: "我们瘫坐在公园长椅上，久久说不出话。你看着手里的纸灰，轻声说：'那张照片里，是我妈。' 我握住你的手：'那我们就一起找她。' 夕阳完全沉了下去，路灯亮了起来。", n: "结局铺垫" },
];

// ---------- 执行 ----------
log("========== 主线测试开始（12 轮） ==========");
await fetch(base + "/api/reset", { method: "POST" });
log("会话已重置，起始世界状态: " + (await worldState()));

const results = [];
for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log(`\n--- 第 ${i + 1} 轮 [${step.n}] ---`);
    log("输入: " + step.u.slice(0, 60) + "...");

    // 1. 角色生成
    const r = await chat(step.u);
    log(`角色生成: ${(r.ms / 1000).toFixed(1)}s | done=${r.done}${r.timeout ? " | ⚠超时" : ""}`);
    log("角色回复: " + (r.text.slice(0, 120).replace(/\n/g, " ") || "(空)"));

    // 2. Agent 评估（模拟前端自动触发）
    const a = await agentRun();
    log(`Agent 评估: ${(a.ms / 1000).toFixed(1)}s | actions=${a.actions.length}`);
    a.actions.forEach((x) => log("  🤖 " + x.slice(0, 110)));

    // 3. 世界演化（每 3 轮，模拟前端间隔）
    if ((i + 1) % 3 === 0) {
        const adv = await advance();
        log(`世界演化: ${adv.slice(0, 110)}`);
        log("世界状态: " + (await worldState()));
    }

    results.push({ round: i + 1, note: step.n, textLen: r.text.length, done: r.done, agentActions: a.actions, ms: r.ms });

    // 如果角色生成失败（审计拒绝等），重试一次（换措辞）
    if (!r.done || !r.text.trim()) {
        log("⚠ 本轮异常，重试一次...");
        const r2 = await chat(step.u + "（继续）");
        log(`重试: ${(r2.ms / 1000).toFixed(1)}s | done=${r2.done} | ${r2.text.slice(0, 100)}`);
        results[results.length - 1].retried = true;
        results[results.length - 1].textLen = r2.text.length;
    }
}

log("\n========== 测试结束 ==========");
log("汇总: " + JSON.stringify(results.map((r) => ({ r: r.round, ok: r.done, len: r.textLen, agent: r.agentActions.length, ms: Math.round(r.ms / 1000) })), null, 0));
log("最终世界状态: " + (await worldState()));
