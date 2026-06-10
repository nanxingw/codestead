# 调研纪要：Claude Code Hooks 能力与会话四态推断

> 调研日期：2026-06-10
> 来源：
> - 官方 Hooks 参考：https://code.claude.com/docs/en/hooks
> - 官方 Hooks 指南：https://code.claude.com/docs/en/hooks-guide
> - 本机实测：`~/.claude/projects/`（Claude Code v2.1.170，macOS）
>
> 服务目标：Codestead M2「会话 HUD」——daemon 通过 hooks 获取语义状态，推断 working / blocked / done / idle 四态。遵循「感知不干预」：我们的 hooks 永远不阻塞、不修改 Claude 行为。

---

## 1. Hook 事件全景

官方文档（2026-06 版）列出约 30 个事件。下表是全集；与四态推断**直接相关**的已加粗。

| 事件 | 触发时机 | Matcher 取值 | 可阻塞 |
|---|---|---|---|
| **SessionStart** | 新建/恢复会话（startup、resume、/clear、compact 后重启上下文） | `startup` / `resume` / `clear` / `compact` | 否 |
| Setup | `claude --init-only` 或 `-p --init/--maintenance` | `init` / `maintenance` | 否 |
| **UserPromptSubmit** | 用户提交 prompt、Claude 处理之前 | 无（总是触发） | 是 |
| UserPromptExpansion | 斜杠命令展开为 prompt 时 | 命令名 | 是 |
| **PreToolUse** | 工具执行前 | 工具名（`Bash`、`Edit\|Write`、`mcp__.*`） | 是 |
| **PermissionRequest** | 权限对话框出现时（注意：`-p` 非交互模式下不触发） | 工具名 | 是 |
| PermissionDenied | 工具被 auto-mode 分类器拒绝 | 工具名 | 否 |
| **PostToolUse** | 工具成功后 | 工具名 | 是 |
| **PostToolUseFailure** | 工具失败后 | 工具名 | 是 |
| PostToolBatch | 一批并行工具调用全部完成 | 无 | 是 |
| **Stop** | Claude 完成本轮响应（每轮都触发，不只是任务完成；用户 Esc 中断时**不**触发） | 无 | 是 |
| **StopFailure** | 因 API 错误（限流/认证/计费等）结束本轮 | 错误类型（`rate_limit`、`overloaded`、`authentication_failed`、`billing_error` 等） | 否 |
| SubagentStart / SubagentStop | 子代理创建/结束 | agent 类型（`general-purpose`、`Explore`、`Plan`、自定义名） | 否 / 是 |
| TeammateIdle | agent team 成员即将空闲 | 无 | 是 |
| TaskCreated / TaskCompleted | 任务创建/完成 | 无 | 是 |
| **PreCompact / PostCompact** | 上下文压缩前/后 | `manual` / `auto` | 是 / 否 |
| **Notification** | Claude Code 发送通知时 | 通知类型（见下） | 否 |
| MessageDisplay | 助手消息文本流式显示时 | 无 | 否 |
| ConfigChange | 会话期间配置文件变化 | `user_settings` / `project_settings` / `local_settings` / `policy_settings` / `skills` | 是 |
| CwdChanged | 工作目录变化（如 `cd`） | 无 | 否 |
| FileChanged | 被监视的文件变化 | 字面文件名（`.envrc\|.env`） | 否 |
| InstructionsLoaded | CLAUDE.md / rules 加载时 | `session_start` 等 | 否 |
| Elicitation / ElicitationResult | MCP 服务器请求用户输入 / 用户响应 | MCP 服务器名 | 是 |
| WorktreeCreate / WorktreeRemove | worktree 创建/移除 | 无 | 是 / 否 |
| **SessionEnd** | 会话终止 | `clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other` | 否 |

**Notification 的 matcher 取值**（对四态最关键）：

| Matcher | 含义 |
|---|---|
| `permission_prompt` | Claude 需要你批准一次工具调用 → **blocked 信号** |
| `idle_prompt` | Claude 已完成、正在等待你的下一条 prompt → **done 信号** |
| `auth_success` | 认证完成 |
| `elicitation_dialog` / `elicitation_complete` / `elicitation_response` | MCP elicitation 表单相关 |

---

## 2. settings.json 配置方式

### 2.1 配置位置与作用域

| 位置 | 作用域 | 可共享 |
|---|---|---|
| `~/.claude/settings.json` | 本机所有项目 | 否 |
| `.claude/settings.json` | 单项目 | 是（可提交进仓库） |
| `.claude/settings.local.json` | 单项目 | 否（自动 gitignore） |
| 托管策略设置（managed policy） | 组织级 | 管理员控制 |
| 插件 `hooks/hooks.json` | 插件启用时 | 是 |
| Skill / agent frontmatter | 该组件激活期间 | 是 |

> Codestead 结论：daemon 安装器应把状态上报 hooks 写入 **`~/.claude/settings.json`**（用户级，覆盖本机所有项目，零项目配置）。

### 2.2 配置结构

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "timeout": 30
          }
        ]
      }
    ]
  },
  "disableAllHooks": false
}
```

- 每个事件名是 `hooks` 对象下的一个 key，值为「matcher 组」数组；每组含 `matcher`（可省略=全部触发）和 `hooks` 数组。
- hook 的 `type` 有五种：
  - `"command"`：执行 shell 命令（最常用；事件 JSON 从 stdin 传入）；
  - `"http"`：把事件 JSON POST 到一个 URL，响应体即 hook 输出（**对 Codestead daemon 最优**：无需每次事件 spawn 进程）；
  - `"mcp_tool"`：调用已连接 MCP 服务器上的工具；
  - `"prompt"`：单轮 LLM 判断（默认 Haiku）；
  - `"agent"`：多轮带工具的子代理验证（实验性）。
- 其他字段：`timeout`（秒；command/http/mcp_tool 默认 600s，UserPromptSubmit 上限 30s，MessageDisplay 上限 10s）、`if`（按权限规则语法过滤，如 `"Bash(git *)"`，仅工具类事件，需 v2.1.85+）、`statusMessage`、`once`、`args`（exec form，绕过 shell）。
- HTTP hook 示例（daemon 接收端形态）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "http", "url": "http://127.0.0.1:43110/hooks", "timeout": 3 }
        ]
      }
    ]
  }
}
```

- 通过 `/hooks` 菜单可查看（只读）所有已注册 hooks；编辑需直接改 settings 文件，文件监视器会自动热加载。
- `"disableAllHooks": true` 可整体禁用。

### 2.3 退出码与输出语义（command hook）

| 退出码 | 含义 |
|---|---|
| 0 | 成功；stdout 若是 JSON 则被解析（UserPromptSubmit / SessionStart 等事件中 stdout 文本会注入 Claude 上下文） |
| 2 | 阻塞该动作，stderr 反馈给 Claude（不可阻塞的事件如 Notification / SessionStart 则仅展示给用户） |
| 其他 | 非阻塞错误，动作继续 |

> Codestead 结论：**永远 exit 0、不输出任何 stdout**（HTTP hook 则返回空 2xx），保证「感知不干预」——hooks 只读取事件，绝不改变 Claude 行为。

---

## 3. Hook stdin JSON 字段

### 3.1 所有事件的公共字段

```json
{
  "session_id": "53b273d5-9f1c-467b-aa8f-46f816bf61ef",
  "transcript_path": "/Users/<me>/.claude/projects/<encoded-cwd>/<session_id>.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "EventName",
  "agent_id": "（仅子代理内）",
  "agent_type": "（仅子代理或 --agent 启动时）"
}
```

`session_id` + `cwd` 是 daemon 区分多会话、把会话映射到项目的主键；`transcript_path` 直接给出该会话 transcript 的绝对路径（M4 关卡生成读取上下文用）。

### 3.2 关键事件的专有字段

```jsonc
// SessionStart —— source 标识启动方式
{ "hook_event_name": "SessionStart", "source": "startup",
  "model": "claude-sonnet-4-6", "agent_type": "Plan", "session_title": "my-session" }

// UserPromptSubmit —— 拿到用户原始 prompt
{ "hook_event_name": "UserPromptSubmit", "prompt": "Write a function to calculate factorial" }

// PreToolUse / PostToolUse —— 工具名与参数（PostToolUse 多一个 tool_output）
{ "hook_event_name": "PreToolUse", "tool_name": "Bash",
  "tool_input": { "command": "npm test" } }

// PostToolUseFailure
{ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
  "tool_input": { "command": "npm test" }, "tool_output": "Error: test failed", "is_error": true }

// Notification —— notification_type 即 matcher 值
{ "hook_event_name": "Notification", "notification_type": "permission_prompt",
  "message": "Allow database write?" }

// Stop —— 输入里另有 stop_hook_active（hook 已触发过续跑时为 true）
{ "hook_event_name": "Stop" }

// StopFailure
{ "hook_event_name": "StopFailure", "error_type": "rate_limit", "error_message": "Rate limit exceeded" }

// SessionEnd —— reason 标识结束原因
{ "hook_event_name": "SessionEnd", "reason": "prompt_input_exit" }

// PreCompact / PostCompact
{ "hook_event_name": "PreCompact", "trigger": "auto" }
```

---

## 4. transcript JSONL 结构（本机实测，v2.1.170）

### 4.1 路径规则

```
~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
```

- `<encoded-cwd>` 为会话 cwd 的编码：`/` 与 `.` 等特殊字符均替换为 `-`。实例：
  - `/Users/nanjiayan/Desktop/Nemori/Codestead` → `-Users-nanjiayan-Desktop-Nemori-Codestead`
  - `/Users/nanjiayan/.autoviral/works/…` → `-Users-nanjiayan--autoviral-works-…`（隐藏目录的 `.` 也变 `-`，出现双横线）
- 同目录下还有与 jsonl 同名的会话子目录 `<session_id>/`，内含 `subagents/`、`tool-results/`（超大工具输出落盘于此）、`workflows/`。
- **注意**：不要依赖路径编码反推 cwd（有歧义），应从 hook 的 `cwd` 字段或 jsonl 行内的 `cwd` 字段取。

### 4.2 行类型（每行一个 JSON 对象）

本机一个 145 行的真实会话中的分布：`assistant` 47、`user` 35、`file-history-snapshot` 12、`ai-title` 10、`mode` 10、`permission-mode` 10、`attachment` 7、`last-prompt` 7、`system` 7。

**消息行公共字段**（user / assistant / attachment / system）：
`uuid`、`parentUuid`（链表结构，指向上一条）、`sessionId`、`cwd`、`gitBranch`、`version`（CLI 版本）、`timestamp`（ISO 8601）、`type`、`userType`（真实用户输入为 `"external"`）、`isSidechain`、`entrypoint`、`message`。

**user 行**两种形态：

```jsonc
// 真实用户输入：message.content 是字符串
{ "type": "user", "userType": "external", "parentUuid": null,
  "cwd": "/Users/nanjiayan/Desktop/Nemori/Codestead", "gitBranch": "HEAD",
  "version": "2.1.170", "timestamp": "2026-06-10T08:20:21.381Z",
  "uuid": "055bd1e8-…", "sessionId": "53b273d5-…", "promptId": "…",
  "message": { "role": "user", "content": "我要在这个目录下创建一个新项目…" } }

// 工具结果回填：content 是 tool_result block 数组，且有 toolUseResult、sourceToolAssistantUUID 字段
{ "type": "user", "toolUseResult": { … }, "sourceToolAssistantUUID": "407c01a7-…",
  "message": { "role": "user", "content": [
    { "type": "tool_result", "tool_use_id": "toolu_016m6juy…", "content": "…" } ] } }
```

**assistant 行**：含 `requestId`；`message` 即 API 响应消息——`id`（msg_*）、`model`、`stop_reason`（`tool_use` / `end_turn`）、`content` 为 block 数组（`thinking` / `text` / `tool_use {id, name, input}`）、`usage`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 等）。

**元数据行**（无 message，对 HUD 极有用）：

```jsonc
{ "type": "ai-title", "aiTitle": "初始化 codestead GitHub 仓库", "sessionId": "…" }   // AI 生成的会话标题 → HUD 显示名
{ "type": "last-prompt", "lastPrompt": "我要在这个目录下创建…", "leafUuid": "…", "sessionId": "…" } // 最近一条用户输入
{ "type": "mode", "mode": "normal", "sessionId": "…" }
{ "type": "permission-mode", "permissionMode": "default", "sessionId": "…" }
{ "type": "system", "subtype": "stop_hook_summary" | "turn_duration" | "informational", … }
{ "type": "file-history-snapshot", "messageId": "…", "snapshot": { … }, "isSnapshotUpdate": false }
```

> Codestead 用法：HUD 的会话名取最新 `ai-title` 行；副标题取 `last-prompt`；M4 关卡生成读 user/assistant 行还原工作上下文；文件 **mtime** 可作为「会话最近活动时间」的零成本兜底信号（无 hooks 也能用，对应 herdr 式检测）。
> 风险提示：jsonl 行格式无官方稳定性承诺（版本字段 `version` 随 CLI 升级变化），解析需做容错与版本兼容。

---

## 5. 四态状态机：hook 事件 → 状态转移映射建议

四态定义（CLAUDE.md）：`working`（工作中）/ `blocked`（等待用户输入）/ `done`（已完成未查看）/ `idle`（空闲）。

### 5.1 映射表

| Hook 事件（matcher） | 状态转移 | 说明 |
|---|---|---|
| `SessionStart`（`startup` / `resume`） | （注册会话）→ **idle** | 会话出现在 HUD；尚未提交 prompt |
| `SessionStart`（`clear`） | 任意 → **idle** | /clear 后回到空白等待态 |
| `SessionStart`（`compact`） | 维持 **working** | 压缩重启上下文是 working 过程的一部分 |
| `UserPromptSubmit` | 任意 → **working** | 最强的「开始干活」信号，同时充当 done 的确认（用户已回来） |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` | blocked/任意 → **working**（心跳） | 工具在跑=在干活；权限批准后第一条 PreToolUse 自然把 blocked 拉回 working |
| `PermissionRequest` | working → **blocked** | 权限对话框已弹出（注意 `-p` 模式不触发） |
| `Notification`（`permission_prompt`） | working → **blocked** | 与 PermissionRequest 冗余互备，二者取并集 |
| `Notification`（`idle_prompt`） | working → **done** | 官方语义即「Claude 已完成、等你下一条 prompt」 |
| `Elicitation` | working → **blocked** | MCP 表单等用户填写 |
| `Stop` | working → **done** | 每轮响应结束都触发；HUD 标记「完成未查看」 |
| `SubagentStop` | 忽略 | 仅子代理结束，主会话仍在跑 |
| `StopFailure` | working → **blocked**（带 error 标记） | API 错误终止，需要用户处理（限流/认证/计费） |
| `PreCompact` / `PostCompact` | 维持 **working** | 可在 HUD 显示「压缩中」细分提示 |
| `SessionEnd`（任意 reason） | 任意 → 移除会话（offline） | HUD 摘牌 |

### 5.2 done → idle：hooks 的盲区与兜底

「已完成**未查看**」到「空闲」的转移需要**用户已查看**信号，hooks 无法提供（没有终端聚焦事件）。建议分层：

1. **简化路径（M2 先做）**：done 状态只被 `UserPromptSubmit`（→ working）或 `SessionEnd`（→ 移除）消解；HUD 上 done 即「有结果等你看」，玩家切回终端提交新 prompt 后自然变 working。
2. **焦点检测兜底（herdr 式，后做）**：daemon 周期检测前台进程/终端窗口，发现该会话所在终端获得焦点超过 N 秒 → done → idle（已查看）。
3. **超时降级（可选）**：done 持续超过阈值（如 30 分钟）→ idle，避免 HUD 长期挂红点。

### 5.3 其他健壮性建议

- **Esc 中断不触发 Stop**：用户中断后会话可能卡在 working。兜底：transcript 文件 mtime 超过 N 秒（如 90s）无更新且无 blocked 信号 → 降级为 done/idle；下一个任意 hook 事件再校正。
- **`-p`（headless）会话**：PermissionRequest 不触发，靠 `Notification(permission_prompt)` 与 PreToolUse 心跳兜底；Codestead 自己的关卡生成 headless 会话应被 daemon 过滤（按 `session_title` / 启动参数标记），不上 HUD。
- **事件丢失**（daemon 重启、hook 超时）：状态机做成幂等——任何事件都能从任意状态转入目标状态；daemon 启动时扫一遍 `~/.claude/projects/**/*.jsonl` 的 mtime 重建会话列表。
- **传输方式**：首选 `type: "http"` hook 直接 POST 到 daemon 的 localhost 端口（零进程开销、配置即一行）；daemon 未启动时 HTTP hook 会快速失败且不影响 Claude（设小 `timeout` 如 3s，不可阻塞事件本身也不会阻断）。备选 `type: "command"` + `curl --max-time 1`。所有 hook 一律不返回决策字段——**只听不说**。

### 5.4 需订阅的最小事件集

```
SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, Notification, Stop, StopFailure, SessionEnd
```

其中 PreToolUse/PostToolUse 仅作心跳，若担心高频事件开销，可只保留 PreToolUse 并接受秒级延迟。

---

## 6. 与 Codestead 设计原则的对齐检查

- **游戏第一**：daemon 与 hooks 完全后台化，游戏端只消费 WebSocket 状态流；
- **感知不干预**：所有 hooks exit 0 / 空响应，永不 block、永不注入上下文；
- **本地隐私**：HTTP hook 指向 127.0.0.1，transcript 只在本机读取；
- **开源标准**：安装器写 `~/.claude/settings.json` 时必须做合并（保留用户已有 hooks）、提供一键卸载，并在 README 说明每个 hook 的作用。
