// parse-st-card.mjs — 解析 ST PNG 角色卡（tEXt chunk 中的 chara/ccv3）
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2] ?? "D:/EFiles/5.png");

// PNG 结构：8 字节签名 + chunks（length 4 + type 4 + data + crc 4）
let offset = 8;
const chunks = [];
while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, length });
    if (type === "tEXt") {
        // data: keyword\0text
        const nul = data.indexOf(0);
        const keyword = data.toString("latin1", 0, nul);
        const text = data.toString("latin1", nul + 1);
        if (keyword === "chara" || keyword === "ccv3") {
            console.log(`[tEXt] ${keyword} 长度 ${text.length} 字符`);
            const json = Buffer.from(text, "base64").toString("utf-8");
            console.log("===== JSON 内容 =====");
            console.log(json.slice(0, 3000));
            console.log("===== 截断显示（总长 " + json.length + "）=====");
            // 保存解析结果
            const { writeFileSync } = await import("node:fs");
            writeFileSync("E:/rp-demo/parsed-st-card.json", json, "utf-8");
            console.log("已保存到 E:/rp-demo/parsed-st-card.json");
        }
    }
    offset += 12 + length;
}
console.log("chunk 列表:", chunks.map(c => c.type).join(", "));
