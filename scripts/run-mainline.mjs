// run-mainline.mjs — 10 轮主线测试（支持断点续跑）
const base = "http://localhost:3200";
const LOG = "E:/rp-demo/logs/test-mainline-log.json";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROUNDS = [
    "傍晚六点，我和小李坐在公园长椅上聊天。天突然暗得不对劲，路灯一盏接一盏地闪，空气冷得像进了冰窖。我看见远处花坛边的影子在动——那影子没有主人。",
    "小李抓住我的袖子，声音发抖：'你也看到了？那个影子……它朝我们这边来了。'我攥紧她的手，盯着那个影子——它停在三米外，慢慢变成了人形。",
    "影子人形开口了，声音像从水底传来：'活人……能看到我？'它突然扑过来，穿过我身体的一瞬间，我看见无数模糊的画面——都是这条街过去的样子。我回头，小李脸色煞白：'它穿过去的时候，我看到了——鬼界。'",
    "我们决定查清楚。小李想起老城区的传说：'柳树巷的井，通往另一个世界。'我们往柳树巷走，路上经过陈伯的月季花坛——他正弯着腰浇水，好像完全不知道今晚发生了什么。",
    "柳树巷的井边，井水是黑色的，水面倒映的不是我们——是两个穿寿衣的老人，正抬头对着我们笑。小李哆嗦着说：'这口井通向鬼界。人间和鬼界，隔着一层水。'",
    "我们回到公园找线索。小李的书包掉出那张旧照片——照片里的女人，和井边倒影里的一个老人长得一模一样。她说：'这是我奶奶。她三年前就去世了……但她一直在保护我。'",
    "深夜，井边传来敲击声。我们赶到时，一个浑身青灰、穿着民国长衫的鬼影从井里爬出来，它的眼睛是两团绿火：'终于……找到能看见我的活人了。吃掉你们，我就能留在人间。'——这就是井祟。",
    "井祟扑过来，普通的东西打不到它。我想起奶奶照片的事——小李说：'我奶奶的遗物里有道符！'我们跑回她家，从抽屉里翻出一张发黄的黄纸符。小李举着符：'井祟怕这个！'",
    "柳树巷，决战。符纸在井祟胸口烧起来，它尖啸着往井里缩。小李死死按住符纸，我抓住她的手腕——我们同时把井祟压回了井底。井水轰然合拢，恢复成黑色。",
    "第二天清晨，公园一切如常。陈伯在浇花，林小满摘薄荷，张阿姨推着孙子。只有我和小李知道，井里睡着的东西没有死——它在等下一次月圆。我们相视一笑，决定把这事记下来。",
];

async function readSSE(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
    }
    // 提取文本
    const texts = [...buf.matchAll(/"type":"text","delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    const doneEvt = buf.includes('"type":"done"');
    return { text: texts, done: doneEvt };
}

// fetch 带超时
async function fetchWithTimeout(url, opts, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
        return await fetch(url, { ...opts, signal: ac.signal });
    } finally {
        clearTimeout(timer);
    }
}

// 加载进度
let log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf-8")) : { rounds: [], startedAt: Date.now() };
const startFrom = log.rounds.length;
console.log(`共 ${ROUNDS.length} 轮，从第 ${startFrom + 1} 轮开始`);

for (let i = startFrom; i < ROUNDS.length; i++) {
    const input = ROUNDS[i];
    const t0 = Date.now();
    const entry = { round: i + 1, input, time: new Date().toLocaleTimeString() };
    console.log(`\n===== 第 ${i + 1} 轮 =====`);
    try {
        // 1. 角色对话
        const res = await fetchWithTimeout(base + "/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: input }),
        }, 300000);
        const { text, done } = await readSSE(res);
        entry.reply = text.slice(0, 1200);
        entry.replyLen = text.length;
        entry.done = done;
        console.log(`  角色回复 ${text.length} 字 | done=${done} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);

        // 2. Agent 评估
        const t1 = Date.now();
        const ar = await fetchWithTimeout(base + "/api/agent/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        }, 240000);
        const ad = await ar.json();
        entry.agentActions = ad.actions || [];
        console.log(`  Agent: ${(ad.actions || []).length} 个动作 | ${((Date.now() - t1) / 1000).toFixed(0)}s`);
        (ad.actions || []).slice(0, 4).forEach((a) => console.log("    -", a.slice(0, 100)));

        // 3. 手动推演（确保世界在动，每轮都推）
        const t2 = Date.now();
        const av = await fetchWithTimeout(base + "/api/advance", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: `主线进展：${input.slice(0, 60)}` }),
        }, 150000);
        const avd = await av.json();
        entry.advance = avd.result ? avd.result.slice(0, 400) : "（失败）";
        entry.world = { time: avd.worldState?.time, npcs: avd.worldState?.npcs?.length };
        console.log(`  推演: ${(avd.result || "失败").slice(0, 80)} | ${((Date.now() - t2) / 1000).toFixed(0)}s`);
    } catch (e) {
        entry.error = e.message;
        console.log("  错误:", e.message, e.name === "AbortError" ? "（超时）" : "");
    }
    log.rounds.push(entry);
    writeFileSync(LOG, JSON.stringify(log, null, 2), "utf-8");
    console.log(`  进度已保存 (${i + 1}/${ROUNDS.length})`);
}

// 汇总
const doneCount = log.rounds.filter((r) => !r.error).length;
console.log(`\n===== 完成: ${doneCount}/${ROUNDS.length} 轮 =====`);
console.log(`日志: ${LOG}`);
