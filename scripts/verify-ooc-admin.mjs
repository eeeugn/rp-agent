// verify-ooc-admin.mjs — 验证 OOC Agent 的系统级权限（get/update_system_config）
const base = "http://localhost:3200";

async function ooc(content) {
    const res = await fetch(base + "/api/ooc", {
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
    const tools = evs.filter((e) => e.type === "tool").map((e) => `${e.name}(${JSON.stringify(e.args)})`);
    return { text, tools };
}

console.log("=== 1. 查看系统配置 ===");
const r1 = await ooc("请查看当前系统配置，简要汇报：API 配置集、导演设置、演化策略。");
console.log("工具调用:", r1.tools.join(" | "));
console.log("回复:", r1.text.slice(0, 400).replace(/\n/g, " "));

console.log("\n=== 2. 修改导演推理与演化模式 ===");
const r2 = await ooc("请调用 update_system_config 工具，把 director_thinking 改为 low、evolution_mode 改为 minimal。");
console.log("工具调用:", r2.tools.join(" | "));
console.log("回复:", r2.text.slice(0, 300).replace(/\n/g, " "));
const dc = (await (await fetch(base + "/api/director-config")).json()).config;
const st = await (await fetch(base + "/api/state")).json();
console.log(`验证: directorThinking=${dc.thinking} evolutionMode=${st.settings.evolutionMode}`);

console.log("\n=== 3. 恢复默认 ===");
const r3 = await ooc("请调用 update_system_config 工具，把 director_thinking 改回 off、evolution_mode 改回 balanced。");
console.log("工具调用:", r3.tools.join(" | "));
const dc2 = (await (await fetch(base + "/api/director-config")).json()).config;
const st2 = await (await fetch(base + "/api/state")).json();
console.log(`验证: directorThinking=${dc2.thinking} evolutionMode=${st2.settings.evolutionMode}`);
