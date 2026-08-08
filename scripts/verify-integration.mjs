// verify-integration.mjs — 验证"世界感知 + Agent 回流 + 历史持久化"联动
const base = "http://localhost:3200";

const content = "天完全黑了，公园里就剩我们两个。你好像一直有点心不在焉，在想什么？";
const res = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
}
const evs = buf.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
const text = evs.filter((e) => e.type === "text").map((e) => e.delta).join("");
const doneEv = evs.find((e) => e.type === "done");
console.log("=== IC 回复（前 400 字） ===");
console.log(text.slice(0, 400));
console.log("done:", !!doneEv, "| messageId:", doneEv?.message?.id);

if (doneEv?.message?.id) {
    const t0 = Date.now();
    const ar = await fetch(base + "/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: doneEv.message.id }),
    });
    const ad = await ar.json();
    console.log("\n=== Agent 评估 ===");
    console.log("耗时:", ((Date.now() - t0) / 1000).toFixed(1) + "s", "| actions:", ad.actions.length);
    ad.actions.slice(0, 4).forEach((a) => console.log("  🤖 " + a.slice(0, 110)));

    const h = await (await fetch(base + "/api/history?mode=ic")).json();
    const last = h.messages.find((m) => m.id === doneEv.message.id);
    console.log("\n=== 持久化检查 ===");
    console.log("该消息 agentActions 条数:", last?.agentActions?.length ?? 0);
}
