// verify-director.mjs — 验证导演快速判断链路
import { readFileSync } from "node:fs";

const base = "http://localhost:3200";

async function readSSE(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
    }
    const evs = buf.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    return evs;
}
async function chat(content) {
    const t0 = Date.now();
    const res = await fetch(base + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
    });
    const evs = await readSSE(res);
    const text = evs.filter((e) => e.type === "text").map((e) => e.delta).join("");
    const done = evs.find((e) => e.type === "done");
    console.log(`[chat ${((Date.now() - t0) / 1000).toFixed(1)}s] done=${!!done}`);
    console.log("回复:", text.slice(0, 200).replace(/\n/g, " "));
    return done?.message?.id;
}
async function agentRun(id) {
    const t0 = Date.now();
    const res = await fetch(base + "/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: id }),
    });
    const d = await res.json();
    console.log(`[agent ${((Date.now() - t0) / 1000).toFixed(1)}s] actions=${d.actions.length}`);
    d.actions.slice(0, 5).forEach((a) => console.log("  🤖 " + a.slice(0, 120)));
}

const steps = [
    "傍晚的公园长椅上，我刚坐下，你背着书包从对面走过来，在我旁边坐下。今天放学怎么这么晚？",
    "天突然暗得不对劲，路灯一闪一闪，喷泉水面没有风却泛起细纹，倒影里的天空好像不是我们这个天空。",
];

const st = await (await fetch(base + "/api/state")).json();
console.log("当前角色:", st.character.name);
let lastId;
for (const s of steps) {
    lastId = await chat(s);
    if (lastId) await agentRun(lastId);
}

// 检查会话隐藏消息：应有【导演提示】，不应有【导演笔记】
const session = JSON.parse(readFileSync(`E:/rp-demo/data/sessions/${st.character.id}.json`, "utf-8"));
const hidden = session.messages.filter((m) => m.hidden).map((m) => (typeof m.msg.content === "string" ? m.msg.content : ""));
console.log("\n隐藏消息含【导演提示】:", hidden.some((c) => c.includes("【导演提示】")));
console.log("隐藏消息含【导演笔记】:", hidden.some((c) => c.includes("【导演笔记】")));
console.log("隐藏消息含【世界感知】:", hidden.some((c) => c.includes("【世界感知】")));
