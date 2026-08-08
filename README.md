# rp-agent

基于 `@earendil-works/pi-ai` 的角色扮演 AI 原型：**导演规划 → 角色沉浸 → 幕后世界演化**，由AI生成。

> ⚠ 概念原型，纯 Node 无框架，适合本地自用与二次开发。

## ✨ 特性

- 🎭 **角色对话**：流式输出、思考过程可展开、用户消息靠右带背景区分
- 🎬 **导演快速判断**：每轮对话前先由导演决定时间/场景/角色可知信息，可独立模型与推理强度，失败自动降级
- 🤖 **幕后 Agent**：自动推演世界、管理世界书、知识揭示（防全知）、NPC 演化，动作记录持久可见
- ⚙ **Agent 对话（最高权限）**：通过对话修改角色卡/世界书/世界，以及 API 配置集、导演设置、演化策略
- 🔌 **多 API 配置**：保存多套「Base URL + Key + 模型 + 推理强度」随时切换；Key 用 Windows DPAPI 加密
- 🛡️ **防全知**：隐藏世界书、角色未知信息、后台秘密不会泄漏给角色
- 🗂 **按角色隔离**：角色卡、世界书、世界状态、演化设置、会话各自独立
- 📝 **提示词可自定义**：OOC / 幕后 / 导演三套提示词可在设置里改写或一键还原默认
- 🖥 **ST 风格界面**：居中可拖宽聊天栏、设置折叠分区、子窗口可调宽、世界书/世界状态可视化管理

## 🚀 快速开始

需要 **Node.js 22+**。

### Windows 一键启动

```powershell
start.bat   # 正式模式：自动装依赖 → 启动服务 → 打开浏览器
mock.bat    # 试玩模式：假模型 + Web，无需任何 API Key
stop.bat    # 停止服务（只停 3200/18080 端口的 node）
```

### 手动启动

```powershell
npm install
npm run web      # http://127.0.0.1:3200（仅本机访问）
```

没有 API Key 时：启动后在网页「⚙ 设置 → 🔌 API 与模型」里填写 Base URL / Key / 模型即可，无需任何配置文件。

## ⚙️ 配置说明

### API 与模型（网页设置，推荐）

- 支持任意 OpenAI 兼容渠道：DeepSeek / OpenAI / OpenRouter / 本地 Ollama / vLLM 等
- 可保存多套配置集并随时切换；模型列表从当前渠道自动拉取，也可手输
- API Key 用 Windows DPAPI（当前用户级）加密存于 `data/api-profiles.json`，配置文件中无明文
- 环境变量（`API_BASE_URL` / `API_KEY` / `MODEL` / `THINKING`）仅作可选兜底，非必需

### 导演快速判断（设置 → 🎬）

- 每轮角色对话前先由导演快速决定：时间、场景、角色此刻知道什么、舞台指示
- 可独立选择 API 配置集 / 模型 / 推理强度（建议关闭或低，保证速度）
- 导演笔记只传给幕后 Agent，不进入角色上下文

### 提示词自定义（设置 → 📝）

- OOC Agent（管理对话）/ 幕后 Agent（自动评估）/ 导演（剧情判断）三套提示词可改写
- 默认显示当前生效内容，支持一键还原内置默认

## 🎮 使用指南

### 角色对话（🎭 模式）

输入故事指令开始创作。每轮流程：

```
用户消息 → 导演快速判断 → 角色生成 → 幕后 Agent 评估 → 世界推演（每 N 轮）
```

### Agent 对话（⚙ 模式）

管理员视角，拥有最高权限：

- 修改角色卡 / 场景 / 世界书 / 世界状态 / NPC
- 网络搜索与网页提取
- `get_system_config` / `update_system_config`：查看和调整 API 配置集、导演设置、演化策略
- 注意：API Key 不在对话中传递，请在设置界面填写

### 清理对话

- 顶部「清理对话」或输入“清理对话历史”
- 会回到该角色的开场场景并重置其世界状态（角色卡保留）
- 只影响当前角色，带角色校验，不会误清其他角色

## 📁 项目结构

```
rp-agent.ts        生成核心（模型/推理/超时/工具循环）
rp-server.ts       Web 服务（导演、Agent、世界、配置、API）
public/index.html  单文件前端
data/              运行时数据（见下）
scripts/           测试/验证脚本与假模型
skills/anysearch/  网络搜索 CLI
start.bat / mock.bat / stop.bat
```

### data/ 数据文件

| 文件 | 说明 |
|---|---|
| `characters.json` | 角色卡 |
| `persona.json` | 用户身份（全局） |
| `worldinfo.json` | 世界书（按角色隔离） |
| `worldstates/<角色id>.json` | 世界状态（时间/NPC/日志） |
| `settings/<角色id>.json` | 演化策略（按角色） |
| `sessions/<角色id>.json` | 会话记录 |
| `api-profiles.json` | 多套 API 配置（Key 加密） |
| `director-config.json` | 导演设置 |
| `prompts.json` | 自定义提示词 |

## 🧪 测试与验证

```powershell
node scripts/mock-llm.ts                          # 假模型
node scripts/verify-director.mjs                  # 导演链路验证
node scripts/verify-ooc-admin.mjs                 # OOC 系统权限验证
node scripts/test-newchar.mjs                     # 新角色整体测试
```

## ❓ 常见问题

**端口被占用？**

```powershell
Get-NetTCPConnection -LocalPort 3200 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
```

**界面看不到最新改动？** 按 Ctrl+F5 强刷（页面已启用 no-cache，一般刷新即可）。

**想用网络搜索完整功能？** 到 https://anysearch.com/console/api-keys 注册，设置环境变量 `ANYSEARCH_API_KEY`（不填也能搜，仅限流低）。

## 📄 许可

ISC（见 [LICENSE](LICENSE)）。
