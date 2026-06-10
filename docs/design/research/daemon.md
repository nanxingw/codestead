# Daemon 技术调研纪要

> 范围：`packages/daemon`（Node.js + TypeScript 本地守护进程）的四个技术决策点——WebSocket 服务库、claude CLI 进程检测、headless `claude -p` 调用、herdr 的状态检测思路——以及由此推导的可靠性设计建议。
> 调研日期：2026-06-10。所有结论服务于项目设计原则：游戏第一、感知不干预、本地与隐私优先、开源产品标准。

---

## 1. WebSocket 服务库选择（localhost 场景）

### 候选对比

| 维度 | `ws` | Node 22+ 原生 WebSocket | `socket.io` |
| --- | --- | --- | --- |
| 服务端支持 | ✅ 完整（事实标准） | ❌ **仅客户端**，无服务端实现 | ✅ |
| 客户端支持 | ✅ | ✅（v22.4.0 起标记 stable，基于 Undici） | 需要配套 `socket.io-client` |
| 协议 | 标准 RFC 6455 | 标准（浏览器同款 `new WebSocket()` API） | 私有协议（Engine.IO 之上），**与原生 WebSocket 客户端不互通** |
| 运行时依赖 | 零依赖（`bufferutil` / `utf-8-validate` 为可选原生加速） | 内置 | 多个依赖，体积明显更大 |
| 附加能力 | permessage-deflate 压缩、心跳 ping/pong | 基础客户端能力 | 自动重连、房间、HTTP 长轮询降级 |

关键事实：

- **Node 原生 WebSocket 是客户端实现**：自 v21 引入、v22.4.0 标为 stable，但官方明确「Node.js 不提供内置 WebSocket 服务端」，要接受连接仍需 `ws` 等库（[Node.js Learn: Native WebSocket Client](https://nodejs.org/learn/getting-started/websocket)）。daemon 是服务端，原生方案直接出局（它只在 daemon 反过来当客户端时有用）。
- **socket.io 的附加值在 localhost 全部用不上**：长轮询降级是为恶劣公网环境设计的；自动重连在游戏端用浏览器原生 `WebSocket` + 简单指数退避十几行就能实现；私有协议还会把 `packages/game` 绑死在 `socket.io-client` 上（[Velt: Best Node.js WebSocket Libraries](https://velt.dev/blog/best-nodejs-websocket-libraries)）。
- **`ws` 是 Node 服务端事实标准**：零运行时依赖、久经测试，且与浏览器原生 `WebSocket` 直接互通（[github.com/websockets/ws](https://github.com/websockets/ws)、[npm: ws](https://www.npmjs.com/package/ws)）。

### 结论

**daemon 用 `ws` 起服务端；游戏端（Phaser/浏览器）用原生 `WebSocket`，不引第三方客户端**。消息协议（JSON）定义在 `packages/shared`。

localhost 安全注意（对应「本地与隐私优先」）：

- 只绑定 `127.0.0.1`，绝不绑 `0.0.0.0`；
- **校验 `Origin` 头**：浏览器里任意网页的 JS 都能向 `ws://127.0.0.1:<port>` 发起连接，必须只放行游戏自己的 origin（开发期 Vite 的 `http://localhost:5173` 等），可再加一个首条消息携带的本地 token（daemon 写入磁盘、游戏启动时读取）做双保险；
- 推送给游戏的数据做最小化裁剪：HUD 只需要 `sessionId / name / cwd / state / since`，不要把 transcript 内容推给前端。

---

## 2. 检测运行中的 claude CLI 进程（macOS / Linux）

### 可移植的 ps 用法

BSD ps（macOS）与 procps（Linux）选项差异大，但以下写法两边通用：

```bash
ps -axo pid=,ppid=,tty=,etime=,args=
```

- 用 `args`（完整命令行）做匹配，**不要依赖 `comm`**：Linux 上 `comm` 来自 `/proc/<pid>/comm`，被内核截断为 15 字符；macOS 上一次查询太多列时 `comm` 也可能被截断（[ps-list issue #36](https://github.com/sindresorhus/ps-list/issues/36)、[ps-list README](https://github.com/sindresorhus/ps-list)）；
- 列名后加 `=` 去掉表头，省去解析第一行；
- 匹配 claude 要兼容两种安装形态：原生二进制（`args` 形如 `claude` 或 `/path/to/claude`）与 npm 安装（`node …/cli.js`，argv0 仍可能是 `claude`）。建议正则：`/(^|\/)claude( |$)/` 对 `args` 首个 token 匹配，再排除 `claude -p`（headless，是 daemon 自己或脚本起的，不该出现在 HUD）。

### pgrep

macOS 与 Linux 都内置 `pgrep`（源自 Solaris，BSD/procps 各有实现，[Wikipedia: pgrep](https://en.wikipedia.org/wiki/Pgrep)），通用参数：

- `pgrep -f claude`——按**完整命令行**匹配，规避 15 字符截断；
- `pgrep -x claude`——按进程名精确匹配（注意 Linux 截断问题，名字 ≤15 字符时才可靠）；
- `pgrep -t ttys003` / `pgrep -P <ppid>`——按 tty / 父进程过滤。

pgrep 只给 PID，拿不到 tty/启动时间等属性，所以**主探测用一次 `ps -axo` 全量拉取再自行过滤**（一次 fork 拿全部信息），pgrep 只作快速存在性检查。

### tty 关联（把进程对应到终端窗口）

- `ps -o tty=` 给出控制终端：macOS 形如 `ttys003`，Linux 形如 `pts/0`，无控制终端（daemon、`claude -p`）显示 `??` / `?`——这本身就是区分「交互会话 vs headless 调用」的可靠信号；
- 同一 tty 上的 claude 进程属于同一个终端窗口/分屏，可按 tty 聚合去重；
- 想进一步知道是哪个终端 App，可沿 PPID 链向上走（`ppid` 列），直到遇到 `iTerm2 / Terminal / tmux / wezterm` 等已知终端进程名。

### 现成库与轮询

- [`ps-list`](https://www.npmjs.com/package/ps-list)（sindresorhus）封装了上述 ps 调用，返回 `{pid, name, cmd, ppid, uid, cpu, memory}`，文档明确 `name` 在 Linux/macOS 截断为 15 字符、应改用 `cmd` 匹配——可以直接用，也可以自己 spawn `ps`（依赖更少，符合开源发布原则）；
- 轮询周期建议 **2s**，一次 `ps` 进程开销在毫秒级；对结果做 diff，只在集合变化时更新状态机；
- 进程存活复核用 `process.kill(pid, 0)`（不发信号、只验存在），比再起一次 ps 便宜。

---

## 3. headless 调用 `claude -p`

来源：[Headless / Agent SDK CLI 文档](https://code.claude.com/docs/en/headless)、[CLI reference](https://code.claude.com/docs/en/cli-reference)。

### 基本形态与关键参数

```bash
claude --bare -p "<prompt>" \
  --output-format json \
  --json-schema '<quest JSON Schema>' \
  --max-turns 4 \
  --max-budget-usd 0.20 \
  --no-session-persistence \
  --tools "Read" --allowedTools "Read"
```

| 参数 | 作用 | 备注 |
| --- | --- | --- |
| `-p` / `--print` | 非交互模式，结果打印后退出 | stdin 可管道喂上下文（**上限 10MB**，超出报错退出，v2.1.128 起） |
| `--bare` | 跳过 hooks / skills / 插件 / MCP / CLAUDE.md 自动加载 | 启动更快、结果可复现；官方推荐脚本调用都加，未来会成为 `-p` 默认。注意 bare 模式跳过 OAuth/keychain，需 `ANTHROPIC_API_KEY` 或 `--settings` 里的 `apiKeyHelper` |
| `--output-format` | `text` / `json` / `stream-json` | `json` 含完整元数据；`stream-json` 配 `--verbose --include-partial-messages` 可流式 |
| `--json-schema` | 强制结构化输出 | 结果落在返回 JSON 的 `structured_output` 字段——NPC 任务生成直接用它，免去手写解析 |
| `--max-turns` | 限制 agentic 轮数（仅 print 模式），到限即报错退出 | 关卡生成建议 3–5 |
| `--max-budget-usd` | 单次调用花费上限（仅 print 模式） | 成本兜底 |
| `--tools` / `--allowedTools` / `--disallowedTools` | 限制与预批准工具 | 生成关卡只读不写，给 `Read` 即可 |
| `--permission-mode` | `default/acceptEdits/plan/auto/dontAsk/bypassPermissions` | headless 默认遇到未授权工具会中止而非挂起 |
| `--no-session-persistence` | 不落盘会话（仅 print 模式） | 一次性生成任务用，避免污染 `~/.claude/projects` 和 `/resume` 列表 |
| `--continue` / `-c` | 续接当前目录最近一次对话 | |
| `--resume <id\|name>` | 按 session_id 恢复指定对话 | 多会话并行时必须用它 |
| `--session-id <uuid>` / `--fork-session` | 指定/分叉会话 ID | |
| `--model` / `--fallback-model sonnet,haiku` | 模型与过载降级链 | 关卡生成可用小模型控成本 |
| `--strict-mcp-config` | 只用 `--mcp-config` 指定的 MCP | 配合 `--bare` 保证环境干净 |

### `--output-format json` 返回字段示例

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "……文本结果……",
  "structured_output": { "quest": "…" },
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "num_turns": 4,
  "duration_ms": 2847,
  "total_cost_usd": 0.0034
}
```

`total_cost_usd` 还附带分模型的开销明细，daemon 可逐次记账（见 [headless 文档](https://code.claude.com/docs/en/headless)、[stream-json cheatsheet](https://takopi.dev/reference/runners/claude/stream-json-cheatsheet/)）。

### 会话恢复模式

```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

NPC 多轮对话（村民追问）可用此法维持上下文；一次性关卡生成则用 `--no-session-persistence` 即抛。

### 超时与成本控制

- **CLI 没有 wall-clock 超时参数**：daemon 必须自己管——`child_process.spawn` 后设 `setTimeout`（建议 60–120s），超时先 `SIGTERM` 再 `SIGKILL`；
- 成本三道闸：`--max-turns`（轮数）+ `--max-budget-usd`（金额）+ daemon 侧频率节流（对应「出现频率克制」原则）；
- v2.1.163 起，`-p` 运行中启动的后台 Bash 任务会在结果返回后约 5s 被终止，不会把调用挂死；
- **计费变化**：2026-06-15 起，订阅计划下 `claude -p` / Agent SDK 用量计入独立的月度 Agent SDK 额度，与交互用量分开——发布文档里要向用户说明这一点。

---

## 4. herdr 的状态检测思路

来源：[github.com/ogulcancelik/herdr](https://github.com/ogulcancelik/herdr)、[herdr Socket API 文档](https://herdr.dev/docs/socket-api/)。

- **零配置默认路径**：进程名匹配 + 终端输出启发式（screen analysis）——识别前台 agent 进程，读屏幕/输出内容判断它在跑、在等输入还是已结束。无需 hooks 即可工作，这是它「零配置可用」的来源，也是天然的兜底层思路；
- **四态模型**与 Codestead 完全同构：🔴 blocked（等输入/审批）、🟡 working、🔵 done（完成未查看）、🟢 idle（已查看），并做 workspace 级「最紧急状态」上卷（rollup）——HUD 聚合显示可以借鉴；
- **官方集成是增量增强**：`herdr integration install claude` 装的集成只上报「会话身份」（用于原生恢复），状态判断仍走屏幕分析；其他工具（Pi、Copilot CLI）的集成则直接上报语义状态。即：**身份与状态是两条独立信道，可分层叠加**；
- **Socket API**：`~/.config/herdr/herdr.sock` 上的 Unix domain socket，newline-delimited JSON，请求/响应带 `id` 关联：

  ```json
  {"id":"req_1","method":"pane.report_agent","params":{
    "pane_id":"1-1","source":"custom:docs","agent":"docs-bot",
    "state":"working","message":"building docs"}}
  ```

  语义状态取值 `working / blocked / idle / done / unknown`，无鉴权（默认本机可信）。

**对 Codestead 的启示**：herdr 的屏幕分析强在零配置，但本质是启发式，会有误判与延迟；Codestead 既然能控制安装流程（往 `~/.claude/settings.json` 写 hooks），就应该把语义信道（hooks）做成主路，把进程/输出检测降级为发现与兜底——这正是 CLAUDE.md 已定的方向。daemon 的对外接口设计（NDJSON + `id/method/params`、显式 `unknown` 状态）值得直接借鉴。

---

## 5. daemon 可靠性设计建议（hooks 为主、进程检测兜底）

### 5.1 信号源一：Claude Code hooks（语义主路）

来源：[hooks 文档](https://code.claude.com/docs/en/hooks)。所有 hook 事件都携带统一字段：

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/me/.claude/projects/<encoded-cwd>/<session-id>.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "Stop"
}
```

事件 → 状态机映射（四态）：

| Hook 事件 | 触发时机 | 状态迁移 |
| --- | --- | --- |
| `SessionStart`（matcher: `startup/resume/clear/compact`） | 会话启动/恢复 | 注册会话 → `idle`（附带 `model` 字段） |
| `UserPromptSubmit` | 用户提交 prompt | → `working`（同时把上一轮的 `done` 视为「已查看」） |
| `PermissionRequest` | 弹出权限确认 | → `blocked` |
| `Notification` | Claude 发通知（等待输入/空闲提醒等） | → `blocked` |
| `Stop` | Claude 完成本轮回复 | → `done`（完成未查看） |
| `SessionEnd` | 会话终止 | 注销会话 |

落地方式优先用 **HTTP hook**（`type: "http"`，直接 POST 到 daemon 的 `http://127.0.0.1:<port>/hooks`），免去每个事件 fork 一个 shell；command hook（curl 单行）作为不支持 http 类型的旧版本回退。hooks 写入 `~/.claude/settings.json`（用户级、对所有项目生效、不进仓库），由 daemon 的 install 命令幂等写入/卸载。注意 hook 默认 600s 超时与 exit code 语义（0 成功 / 2 阻断），我们的 hook 只上报、永远 exit 0，绝不阻断用户会话——「感知不干预」同样适用于工程层。

### 5.2 信号源二：进程检测（发现与兜底）

- 每 2s `ps -axo pid=,ppid=,tty=,etime=,args=`，按 §2 的规则匹配 claude 交互进程；
- 作用一 **发现**：用户没装 hooks、或 hooks 被 `disableAllHooks` 关闭时，HUD 仍能列出会话（状态可标 `unknown`/降级显示，学 herdr 的显式 `unknown`）；
- 作用二 **收尸**：hooks 报过 `SessionStart` 但进程已消失（崩溃、`kill -9`，`SessionEnd` 不会触发）→ 进程表里找不到对应 tty/pid 即注销，防止 HUD 出现幽灵会话；
- 进程信息与 hook 会话的关联键：`cwd` + tty + 启动时间近似匹配（hook 给 `session_id` 与 `cwd`，ps 给 pid/tty/etime）。

### 5.3 信号源三：transcript 文件活动（输出检测的本地化替代）

herdr 读「终端输出」，我们有更干净的等价物：每个会话的 transcript 实时落盘在 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`（一行一个 JSON 对象；默认保留 30 天，`cleanupPeriodDays` 可调；`CLAUDE_CONFIG_DIR` 可改根目录）（[sessions 文档](https://code.claude.com/docs/en/sessions)、[claude-code-log](https://github.com/daaain/claude-code-log)）。用 `fs.watch` 监听 mtime：

- 文件持续追加 → 该会话大概率 `working`（可纠正丢失的 `UserPromptSubmit`）；
- `Stop` 后文件长时间静默 → 维持 `done`；
- 全程本机文件读取，不外发任何内容，天然符合隐私原则。

### 5.4 状态机仲裁与对外推送

- **优先级：hooks 事件 > transcript 活动 > 进程存在性**。语义事件直接驱动迁移；低优先级信号只能在高优先级信号缺失/过期（staleness，比如 `working` 超过 N 分钟无任何 hook 与文件活动）时修正状态；
- 每个会话记录 `lastSignalAt`，所有状态都有过期校验，杜绝「卡在 working」的僵尸显示；
- 状态变化经 `ws` 推送给游戏：全量快照（连接时）+ 增量事件（变化时），消息类型定义在 `packages/shared`；
- 关卡生成（M4）复用 §3：daemon 读取目标会话 transcript 摘要 → `claude --bare -p … --json-schema` 产出结构化 quest → 经同一条 WebSocket 推给游戏 NPC 系统。

### 5.5 风险与待验证项

1. hooks 事件集较丰富但语义可能随版本演进（如 `Notification` 的触发场景），需要在真实多会话环境录制一轮事件流验证映射表；
2. npm 安装形态下 claude 进程的 `args` 具体长相（`node` + 脚本路径）需在 macOS/Linux 各实测一次，固化匹配正则与单测；
3. `--bare` 未来成为 `-p` 默认后行为差异、以及 2026-06-15 Agent SDK 独立额度对订阅用户的影响，发布前复核文档。

---

## 来源链接

- Node.js 原生 WebSocket（仅客户端）：https://nodejs.org/learn/getting-started/websocket
- ws 库：https://github.com/websockets/ws 、https://www.npmjs.com/package/ws
- WebSocket 库对比：https://velt.dev/blog/best-nodejs-websocket-libraries
- pgrep 可移植性：https://en.wikipedia.org/wiki/Pgrep 、https://norswap.com/nps-pkill-pgrep/
- ps-list（comm 15 字符截断）：https://github.com/sindresorhus/ps-list 、https://github.com/sindresorhus/ps-list/issues/36
- Claude Code headless（`claude -p`）：https://code.claude.com/docs/en/headless
- Claude Code CLI reference：https://code.claude.com/docs/en/cli-reference
- Claude Code hooks：https://code.claude.com/docs/en/hooks
- Claude Code sessions / transcript 存储：https://code.claude.com/docs/en/sessions
- stream-json 事件速查：https://takopi.dev/reference/runners/claude/stream-json-cheatsheet/
- herdr：https://github.com/ogulcancelik/herdr 、https://herdr.dev/docs/socket-api/
