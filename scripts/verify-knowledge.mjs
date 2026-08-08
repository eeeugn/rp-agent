// verify-knowledge.mjs — 验证角色是否还会知道不该知道的事
const base = "http://localhost:3200";
const content = process.argv[2] ?? "你觉得井底那东西真的解决了吗？";

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
console.log(text);
