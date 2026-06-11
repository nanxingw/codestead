# Hook 事件 fixture（状态机回放测试资产）

本目录存放 Claude Code hook 事件流的 JSONL fixture，是 daemon 会话状态机的回放测试资产
（tech-stack §9-3、风险 #2；PRD 03 US56 / 测试决策 1）。**升级 Claude Code 后重录一份并回放——
回放失败即 hooks 语义漂移告警。**

## 行格式（`RecordedHookEvent`，见 `src/install/recorder.ts`）

每行一个 JSON 对象：

```jsonc
{ "at": "2026-06-10T09:00:00.000Z",   // ISO 8601 接收时间，回放时重建事件时钟
  "body": { ... },                     // hook POST body（脱敏后仅含白名单字段）
  "scrubbed": true }                   // 隐私门：提交进仓库的行必须为 true
```

`test/fixtures.test.ts` 对本目录每个 `*.jsonl` 的每一行做机器校验：
`scrubbed === true`、body 仅含白名单字段（= `HookWireEventSchema` 的字段名：
`session_id / hook_event_name / cwd / transcript_path / source / notification_type / error_type / reason`）
且全为字符串值。**`scrubbed: false` 的行永远不允许提交**——这是隐私红线
（prompt / tool_input / tool_output / message 等内容字段一律被白名单剔除）。

该门禁只管隐私，不要求每行都能被 `HookWireEventSchema` 解析：合成 fixture 允许故意构造
畸形行（如缺 `session_id`）来钉死「归一化失败 → 忽略不抛」的容错语义，只要字段仍在白名单内。

## 现有 fixture

| 文件                       | 来源     | 说明                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks-synthetic.jsonl`    | 手写合成 | 按官方 hooks 文档 schema（docs/design/research/hooks.md §3，基于 v2.1.170 实测）手写的全事件集：双会话交错，覆盖安装事件集全部 10 种事件（SessionStart 含 startup/compact/clear 三种 source、Notification 含 permission_prompt/idle_prompt、StopFailure rate_limit、SessionEnd 两种 reason），另含 2 条应被忽略的事件（`Notification(auth_success)`、`SubagentStop`）用于钉死「未识别 → 忽略不抛」 |
| `synthetic-hooks-m2.jsonl` | 手写合成 | 状态机回放测试（state-reducer 契约）消费的事件序列，含故意畸形行（缺 `session_id`）钉死容错语义                                                                                                                                                                                                                                                                                                    |

合成 fixture 只是占位基线：**真实事件流必须由用户在本机真实跑一次 Claude Code 才能采集**
（开发与测试绝不读写真实 `~/.claude`，安装器的真实执行只能由用户显式触发）。采集到的真实
fixture 按 `hooks-recorded-v<Claude Code 版本>.jsonl` 命名加入本目录。

## 真实事件采集手工流程（需要用户本人执行）

1. **停掉本机 daemon**（如在跑）：录制器与 daemon 共用 43110–43119 端口窗，必须让录制器
   拿到 hooks 实际指向的端口（通常 43110）。
2. **起录制器**（只监听 127.0.0.1，向指定文件追加原始事件，终端只打印端口与计数、绝不打印
   body）：

   ```sh
   pnpm --filter @codestead/daemon exec tsx src/install/record-main.ts /tmp/hooks-raw.jsonl
   ```

3. **确认 hooks 已安装**：`~/.claude/settings.json` 中需有指向
   `http://127.0.0.1:43110/hooks` 的 codestead 条目（由用户本人显式执行
   `codestead install` 写入；安装器会先备份 `settings.json.codestead-bak`）。
4. **正常使用 Claude Code**：开 2 个以上会话，覆盖——提交 prompt、工具调用、权限确认
   （permission_prompt）、一轮完成（Stop / idle_prompt）、`/clear`、退出会话；有条件时再
   覆盖 StopFailure（限流等）。
5. **Ctrl-C 停录**，录制器打印收到的事件总数。
6. **脱敏**（字段白名单化 + 用户名替换为 `user`，并丢弃不可回放的行）：

   ```sh
   pnpm --filter @codestead/daemon exec tsx src/install/scrub-main.ts \
     /tmp/hooks-raw.jsonl test/fixtures/hooks-recorded-v2.1.170.jsonl
   ```

7. **人工逐行复查**输出文件确无 prompt/工具内容与个人路径后，再提交。`test/fixtures.test.ts`
   的机器校验是兜底，不是替代人工复查。

## 隐私红线（CLAUDE.md / PRD 03）

- 会话数据不出本机：原始录制文件（`scrubbed: false`）只能留在本机临时目录，用完即删；
- 仓库中只允许 `scrubbed: true` 且通过白名单校验的行；
- 录制器与脱敏脚本的终端输出只含端口/计数/文件路径，永不包含事件内容。
