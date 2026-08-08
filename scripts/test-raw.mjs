// test-raw.mjs — 查看原始 SSE 输出
const base = "http://localhost:3200";

const ic = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "原始输出测试" }),
});
const reader = ic.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
}
console.log("=== IC 原始 SSE（最后 600 字符） ===");
console.log(buf.slice(-600));
