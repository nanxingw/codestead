# NPC 与 AI 关卡（ai-quests）设计定稿

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：**定稿** ｜ 里程碑：M4 ｜ 取代 `drafts/18-ai-quests.md`
> 上游依据：`drafts/00-constitution.md`（最高约束）、`docs/design/tech-stack.md` §1/§4.2/§5、`docs/design/research/daemon.md` §3、`docs/design/research/hooks.md`、`docs/design/research/assets.md` §5、`docs/design/research/mechanics.md` §9。
> 设计范围：村民阵容、关卡触发与频率、生成管线（上下文→脱敏→prompt→schema→UI）、决策题形态、思考笔记、奖励表、开关与降级、失败处理。
> 隐私红线：工作上下文只在本机处理；唯一外发通道是用户自己的 `claude` CLI → Anthropic API（与用户日常使用 Claude Code 完全相同的通道）；Codestead 自身没有任何服务器，永不引入新的数据出口。
>
> **定稿一致性声明**：
> 1. §4.5 的 headless 调用参数与 `tech-stack.md` §1「headless Claude」裁决逐字一致（不用 `--bare`；`disableAllHooks` + `--strict-mcp-config` + `--json-schema` + `--max-budget-usd 0.20` + 90s SIGTERM → 5s SIGKILL）；
> 2. tech-stack §4.2 第 5 步提及的 `--resume` 多轮追问，**M4 不实现**（成本与打扰双增），定为 M5 后实验开关（§15 问题 2）——以本稿为准；
> 3. §4.6 的 `QuestSchema` 是 Quest 数据形态的单一事实源，**取代** tech-stack §5 协议草案中的简化版 `Quest` interface；§4.7 三条新消息（`questSnapshot` / `questDismiss` / `clientPrefs`）定为对 shared 协议的正式补充，实现时合入 `packages/shared/src/protocol.ts`；
> 4. §8 奖励数值已按宪法 §4.4 经济基准推导验证（§8.2），常量与经济子系统同源于 `packages/shared/src/quest.ts`。

---

## 0. 设计立场（对照宪法三支柱）

| 支柱 | 本子系统的落实 |
|---|---|
| 游戏第一 | NPC 是农场世界的常驻村民（站桩 + 闲聊台词），不是「弹题机器」；关掉 AI 任务后村民依然存在、世界依然完整。任务奖励纳入金币/XP 主线，但占比 ≤ 农耕收入的 ~10%，绝不喧宾夺主 |
| 零焦虑承诺 | 任务**永不因真实时间过期/收回**；不答没有任何损失；对话打开即暂停游戏时间；「先不聊」零代价 |
| 感知不干预 | 任务到达只表现为村民头顶一个安静的 💬 气泡 + 日结算屏一行字；不弹窗、不抢焦点、不打断任何操作；全局生成 ≤1 个 / 15 真实分钟（宪法硬上限）、同屏未处理 ≤1；总开关可整体关闭 |

一句话定位：**村民是「把你的注意力轻轻引回工作本身」的思考伙伴，不是第二个待办列表。**

---

## 1. 村民阵容

### 1.1 M4 出场名单（3 名，符合宪法 M4「NPC 1~3 名」）

| id | 显示名 | 职业 / 在村里干什么 | 擅长话题（quest 路由标签） | 性格与语气 | 站位（农场地图固定点） |
|---|---|---|---|---|---|
| `npc_carpenter` | 老榆 | 木匠，常年在修谷仓 | `architecture` `refactoring` `boundaries`（架构取舍、重构边界、模块划分、依赖方向） | 话少句短，用承重墙/地基/翻修打比方；从不下结论，只问「拆这堵墙，房子靠什么站着？」 | 农舍东侧木工台旁 |
| `npc_grocer` | 阿穗 | 杂货店老板娘，给每件货贴标签 | `naming` `api-design` `interfaces`（命名、API 形状、对外契约、参数设计） | 热络爱举例；执念是「名字不对，货就卖不出去」；会复述你的命名让你自己听一遍 | 杂货摊门口（集市角） |
| `npc_keeper` | 渠叔 | 水渠管理员，每天巡渠找漏 | `testing` `edge-cases` `reliability` `debugging`（测试策略、边界情况、失败处理、回归） | 谨慎，口头禅「如果……会怎样？」；相信「漏不是补出来的，是巡出来的」 | 池塘闸口（池塘北岸，pond_sluice） |

兜底路由：话题无法归类（或本地题库任务）时默认 `npc_keeper`（反思类问题与他的「巡渠」人设最自然）。

### 1.2 储备名单（不在 M1~M5 范围，列出仅为世界观连续性）

| id | 显示名 | 职业 | 预留话题 |
|---|---|---|---|
| `npc_postmistress` | 邮婆 | 邮局 | 异步、消息契约、系统集成 |
| `npc_librarian` | 小铃 | 图书馆见习生 | 文档、知识沉淀、ADR |

> 启用第 4/5 名 NPC 需修宪（宪法 §5 M4 边界为 1~3 名）。

### 1.3 外观素材（全 CC0，可入仓库）

- 基底：**Kenney「Roguelike Characters」包**（CC0，16×16，约 450 个角色精灵、含换装图层）——三名 NPC 各取一个基础身体 + 职业配件（锤子/围裙/斗笠）拼合；若该包形象不合用，回退 Kenney Roguelike/RPG pack 与 Tiny Town 内的人物 tile（同属 CC0 体系）。**落地时由资产管线核对具体 tile 坐标**，逐文件登记 `packages/game/assets/manifest.json`（字段规范见 assets.md §8）。
- 对话头像：直接用 16×16 精灵整数放大 ×3（48×48）置于对话框左侧——符合宪法 §4.2「仅整数倍缩放」。
- 动画：M4 只做 2 帧 idle（呼吸/小幅摆动）+ 朝向翻转；**不做寻路与日程**（明确 Out）。

### 1.4 无任务时的环境行为（让 NPC 先成立为「村民」）

- 各自站桩 + idle 动画；玩家按 E 交互时播放**本地闲聊台词**（每人 8~10 条，与农场状态联动的纯模板，零 AI 调用），例如渠叔：「昨夜下了雨，今天渠水满的，你的地也不用浇了吧。」（读取游戏内天气状态）；
- 闲聊不给奖励、不计任何次数，纯氛围；
- 有未处理任务时，头顶显示 💬 气泡（见 §6.1），交互即进入任务对话。

---

## 2. 关卡形态（两类，宪法定义 kind ∈ {decision, reflection}）

### 2.1 decision（决策题）：选项 + 可选补充理由

- 取材自玩家**正在做的真实取舍**（架构方案、重构范围、接口形状、测试投入点）；
- 形态：NPC 复述它理解的处境（1~2 句）→ 提出问题 → **2~4 个选项，每个选项必须带一句 tradeoff（代价提示）**——选项不是对错题，是把取舍摆上台面；
- 选定后出现可选的「想补充一句吗？」自由文本框（可跳过）；选项 + 补充共同写入思考笔记；
- 永远隐含第五个出口：「先不聊」（dismiss，零代价）。

### 2.2 reflection（反思题）：开放问答

- 一道开放问题，让玩家把脑中的思路**写成字**（写作即思考）；
- 形态：NPC 开场白 → 问题正文 → 多行文本框；提交需非空，无最短长度要求（不按字数给奖励，避免诱导灌水）；
- AI 生成版取材自会话上下文；**本地题库版**（降级用，零成本）见 §2.3。

### 2.3 本地反思题库（降级与 AI 关闭时使用，随仓库分发）

定义在 `packages/daemon/src/quest/local-pool.ts`，首发 30 条（老榆/阿穗/渠叔各 10 条，亲和标签配平；运行时随机不重复抽取）。**题库耗尽后村民回到纯闲聊、不再发本地任务**（与 §3.3-④ 宁缺毋滥一致）；同时设置页（§6.4）出现一行提示「想听新问题？允许 AI 根据你的工作出题」。每条带 NPC 亲和标签：

| # | 题目 | npcId |
|---|---|---|
| 1 | 你现在手头这件事，最初要解决的问题是什么？现在还在解决它吗？ | npc_keeper |
| 2 | 如果明天要把今天的工作讲给一个新同事听，你会先讲哪一句？ | npc_grocer |
| 3 | 今天写的代码里，哪一处你其实没想清楚就先写了？ | npc_keeper |
| 4 | 现在这个方案里，最让你不安的假设是什么？ | npc_carpenter |
| 5 | 有没有一个名字（变量/函数/模块），你看到就皱眉？它应该叫什么？ | npc_grocer |
| 6 | 如果这个项目只能保留一个测试，你会留哪个？ | npc_keeper |
| 7 | 今天有没有差点走进去的弯路？是什么让你停下来的？ | npc_carpenter |
| 8 | 你正在等 AI 做的这件事，做完之后你第一个要检查什么？ | npc_keeper |
| 9 | 当前的工作里，哪一步其实可以删掉不做？ | npc_carpenter |
| 10 | 如果回到今天早上，你会换一个起点吗？ | npc_grocer |
| 11 | 这个改动一旦上线，最先坏掉的会是哪里？ | npc_keeper |
| 12 | 你最近一次说「先这样，以后再改」是什么时候？「以后」到了吗？ | npc_carpenter |
| 13 | 现在的代码里，哪两个模块其实在偷偷共用一面墙？拆开值得吗？ | npc_carpenter |
| 14 | 如果把这个系统锯成两半，你会沿着哪条缝下锯？ | npc_carpenter |
| 15 | 哪个依赖是你不敢动的「承重墙」？它真的在承重吗？ | npc_carpenter |
| 16 | 你最近一次复制粘贴代码，是图省事，还是那两处本来就该分开长？ | npc_carpenter |
| 17 | 项目里哪一处「临时搭的棚子」如今已经住进人了？ | npc_carpenter |
| 18 | 如果允许你推倒重盖一个模块，你选哪个？为什么偏偏是它？ | npc_carpenter |
| 19 | 你今天定下的接口，调用方第一眼能猜对用法吗？ | npc_grocer |
| 20 | 把那个函数的参数列表当货架标签念一遍，顾客听得懂吗？ | npc_grocer |
| 21 | 有没有一个概念，团队里每个人的叫法都不一样？该统一成哪个？ | npc_grocer |
| 22 | 你最近写的注释里，有没有一句其实是在替坏名字道歉？ | npc_grocer |
| 23 | 这个 API 的返回值里，有没有调用方根本用不上的货？ | npc_grocer |
| 24 | 哪个布尔参数其实早该拆成两个函数了？ | npc_grocer |
| 25 | 把当前模块的对外接口连起来念，是一句通顺的话吗？ | npc_grocer |
| 26 | 这个功能在用户网络最差的那天，会发生什么？ | npc_keeper |
| 27 | 你最近一次只手动点了点就算验完的地方，下次改动时谁来守？ | npc_keeper |
| 28 | 如果这段代码凌晨三点出错，报错信息够你睡眼惺忪地定位吗？ | npc_keeper |
| 29 | 当前的输入校验里，你默认了哪件「不可能发生」的事？ | npc_keeper |
| 30 | 这次改动碰到的老功能里，哪一个你还没回头看过一眼？ | npc_keeper |

---

## 3. 触发时机与频率（宁缺毋滥）

### 3.1 配置项（`~/.codestead/config.json` → `aiQuests` 节）

| 键 | 默认值 | 可配范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | bool | **总开关**。false = 村民只闲聊，永不出任务，daemon quest 模块整体不启动 |
| `aiGeneration` | `false` | bool | AI 生成开关。**默认 false，需游戏内一次性同意后置 true**（见 §3.4）；false 时只用本地题库 |
| `cooldownMinutes` | `15` | **15~120** | 两次生成尝试的最小间隔（真实分钟）。下限 15 是宪法硬上限「≤1 个 / 15 真实分钟」，调低属修宪事项。游戏侧 `clientPrefs.frequency`（low=30 默认 / normal=15，无更高档）与本值取较严者生效，出厂实际默认 30 分钟/个（GDD §10.7 / 附录 A-23） |
| `dailyMaxQuests` | `8` | 1~16 | 每个自然日（本机时区）AI 生成次数上限 |
| `dailyBudgetUsd` | `1.00` | 0~5.00 | 每日 AI 成本软上限；达到后当日转本地题库 |
| `perCallBudgetUsd` | `0.20` | 0.05~**0.20** | 单次调用预算，传给 `--max-budget-usd`；上限 0.20 为宪法值 |
| `model` | `"haiku"` | haiku/sonnet | 生成模型；`--fallback-model sonnet` 固定 |
| `localTemplates` | `true` | bool | 是否允许本地题库（AI 关闭或降级时） |

> 频率护栏是**双保险**：daemon 节流器按上表执行；同时「全局未处理任务 ≤1」从结构上保证玩家视野里永远最多一个 💬。

### 3.2 生成触发条件（每 60s 评估一次，**全部满足**才尝试生成）

```
T1  enabled == true
T2  pendingQuests == 0                          # 全局未处理 ≤1（宪法）
T3  now - lastAttemptAt >= max(cooldownMinutes, clientPrefs.minIntervalRealMinutes)
                                                # 含失败尝试，防抖；daemon 配置与游戏侧偏好取较严者
T4  游戏客户端已通过 WS 认证连接                  # 没人在玩就不花钱、不积压
T5  当日 AI 生成次数 < dailyMaxQuests 且当日成本 < dailyBudgetUsd
T6  存在候选会话（见 3.3）→ 走 AI 生成
    不存在候选会话 且 localTemplates → 走本地题库（同样受 T1~T5、同一冷却约束）
T7  aiGeneration == false 时跳过 AI 路径，直接 T6 本地题库
```

> 原 T5（gameBusy，游戏端不处于对话/日结算屏）经本轮裁决废除：投放本就只表现为 NPC 头顶气泡（§3.5），对话/结算中到达没有打扰面，无需挑「安静时机」。

### 3.3 候选会话选择（AI 路径）

从 M2 状态机的会话表中筛选，按序取第一个：

1. `state == working`（玩家正在等它干活——这正是出题的黄金时机）且 transcript mtime < 10 真实分钟（上下文新鲜）；
2. 自该会话上一次被出题以来，新增 ≥2 条外部用户 prompt（`userType:"external"`，话题已推进，避免重复出题）；
3. 多个候选时取最近一次 `UserPromptSubmit` 的；与上一个任务同会话的候选降权（排到其他候选之后）；
4. 脱敏摘要后有效文本 < 300 字符 → 视为上下文太薄，**放弃本次 AI 生成**（宁缺毋滥），按 T6 走本地题库或干脆不出。

### 3.4 首次同意流程（消费用户额度前必须知情）

第一次满足触发条件且 `aiGeneration == false && 从未询问过` 时，投放一个**本地脚本任务**（非 AI 生成，渠叔出场）：

- 渠叔说明：「村里人想偶尔跟你聊聊你手头的活儿。这需要本机的 claude 帮忙读你的会话记录、想问题——**会消耗你自己的 Claude 额度（订阅或 API），内容只在你这台机器和你已有的 Claude 通道里走**。」
- 选项：`a) 好，开聊（开启 AI 任务）` / `b) 只用你们自己想的问题（仅本地题库）` / `c) 都不要，让我安静种地（关闭总开关）`；
- 选 a → `aiGeneration=true`；选 b → 维持 false；选 c → `enabled=false`。任何选择奖励 50g（教学任务）；写入 `asked: true` 不再询问；设置菜单随时可改（§6.4）。

**opt-in 二次引导（一次性、可拒绝）**：玩家完成第 **3** 个本地题库任务时，由该任务的 NPC 在收尾台词里追加一句引导：「下回……想聊聊你手头真正的活儿吗？」——答应则进入上述同意流程（同一知情文案与 a/b/c 选项），拒绝则一切如旧、零代价。仅当首次同意流程选了 **b**（仅本地题库）且 AI 从未开启过时触发一次（触发后记 `askedFollowUp: true`，终生只此一次）；首次选 **c**（关闭总开关）者**永不触发**。目的：把 AI 路径的发现时机从「玩家翻设置」提前到自然对话内。

### 3.5 投放（offer）规则——到达不等于打扰

- daemon 推送 `questOffer` 后，游戏端只做两件事：对应 NPC 头顶出现 💬 气泡；任务存入本地 store；
- **绝不**：弹窗、播放抢戏音效（只有一声 ≤0.3s 的轻提示音，可在设置关闭）、移动镜头、暂停游戏、在屏幕中央显示任何东西；
- 玩家在日结算屏会看到一行平静的预告（与会话状态并列）：`🌾 渠叔在水渠边，想听听你的想法`；
- 任务**永不过期**：💬 一直在，明天在，下周也在（直到回答或玩家主动「先不聊」）；
- `questRevoked` 仅两个来源：玩家 dismiss；用户关闭总开关时清场。**没有任何基于真实时间的自动收回**（零焦虑承诺）。

---

## 4. 生成管线

### 4.1 总览

```
[daemon 节流器 60s tick]
   │ 触发条件 T1~T7 全过
   ▼
[候选会话] ──transcript_path──▶ [读取 jsonl 尾部] ──▶ [脱敏器 sanitize()]
                                                        │ 有效文本 ≥300 字符
                                                        ▼
                                              [拼 prompt（§4.4）]
                                                        │ stdin ≤6,000 字符（UTF-8 实际 ≤约 18KB，远低于 CLI 10MB 上限）
                                                        ▼
                       spawn claude -p（§4.5 参数，90s SIGTERM → +5s SIGKILL）
                                                        │ --output-format json
                                                        ▼
                                  [取 structured_output → zod safeParse（§4.6）]
                                     │ 失败：计 1 次失败，按 §10 退避            │ 成功
                                     ▼                                          ▼
                                [FAILED]                    [daemon 补全 questId/reward/relatedSessionId]
                                                                                │
                                                                  [持久化 state.json] → [WS questOffer]
```

### 4.2 读取哪些会话上下文

仅读目标会话的 `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`（路径来自 hook 事件的 `transcript_path` 字段，**不反推编码路径**）：

| 取 | 内容 | 用途 |
|---|---|---|
| ✅ | 最近一行 `ai-title` | 工作主题 |
| ✅ | 最近一行 `last-prompt` | 用户最新意图 |
| ✅ | 最近 30 条消息行中：`user`（仅 `userType:"external"`、content 为字符串的真实输入）与 `assistant` 的 `text` block | 还原讨论脉络 |
| ❌ | `tool_use.input` / `tool_result` / `toolUseResult` | 最高泄密风险（命令、文件内容、环境变量），整体丢弃 |
| ❌ | `thinking` block | 价值/风险比低，丢弃 |
| ❌ | `file-history-snapshot`、attachment、system 行 | 与出题无关 |

### 4.3 脱敏边界（`sanitize()`，单测必备）

在拼 prompt 之前、daemon 进程内执行；**脱敏后的文本是唯一允许进入 prompt 的工作内容**：

1. **路径脱敏**：将 `$HOME` 前缀替换为 `~`；保留项目内相对路径；
2. **秘钥正则置换**为 `[REDACTED]`（命中即整 token 替换）：
   - `AKIA[0-9A-Z]{16}`（AWS）
   - `sk-[A-Za-z0-9_-]{20,}`、`sk-ant-[A-Za-z0-9_-]{20,}`（OpenAI/Anthropic 形态 key）
   - `gh[pousr]_[A-Za-z0-9]{20,}`、`github_pat_[A-Za-z0-9_]{20,}`（GitHub）
   - `xox[baprs]-[A-Za-z0-9-]{10,}`（Slack）
   - `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`
   - `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`（JWT）
   - `(?i)(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+`（赋值式，仅替换值部分）
3. **长度截断**：单条消息 ≤500 字符（超长取首 300 + 尾 150，中间标 `[...截断...]`）；脱敏后全文 ≤**6,000 字符**（远低于 stdin 10MB 上限，控成本也控泄露面）；
4. **控制字符剥离**：移除 `\x00-\x08\x0b\x0c\x0e-\x1f`，防终端注入。

> 测试夹具：`packages/daemon/test/fixtures/transcripts/` 放置含上述每类伪造秘钥的 jsonl，断言脱敏产物中 0 命中（验收 A3）。

### 4.4 prompt 要点（骨架，实现时定稿于 `packages/daemon/src/quest/prompt.ts`）

通过 stdin 传入「上下文文档」，`-p` 参数传指令。指令骨架：

```
你是像素农场游戏 Codestead 的关卡作者。stdin 是一位程序员玩家当前真实工作的脱敏摘要。
生成恰好一个 NPC 任务，帮助他在等待 AI 干活的间隙梳理思路、看清一个取舍。

三位村民（选最贴合话题的一位，npcId 必须取自枚举）：
- npc_carpenter 老榆，木匠：架构、重构边界、模块划分。话少句短，用房子打比方。
- npc_grocer 阿穗，杂货店老板娘：命名、API 形状、对外契约。热络，爱复述与举例。
- npc_keeper 渠叔，水渠管理员：测试、边界情况、失败处理。谨慎，常问「如果…会怎样？」。

规则：
1. kind 二选一：上下文里有真实的、未决的取舍 → decision（2~4 个选项，每个必须给一句
   各自的代价 tradeoff，不允许出现明显的标准答案）；只有进展叙述、没有未决取舍 →
   reflection（一个开放问题，引导玩家把当前思路讲清楚）。
2. 语言：简体中文。NPC 台词每段 ≤2 句，温暖、克制、像村民闲谈，不堆术语；
   用 NPC 自己的行当打比方，但比方只许一个。
3. 只基于 stdin 内容提问，不臆测细节；不复述任何看起来像密钥、内网地址的内容；
   不要求玩家离开游戏做任何事。
4. contextEcho 用 ≤120 字复述你理解的工作背景（写入玩家笔记存档用）。
5. 严格按 JSON schema 输出。
```

### 4.5 CLI 调用（与 tech-stack §1「headless Claude」裁决逐字一致，不用 `--bare`）

```bash
claude -p "$(cat prompt-instructions.txt)" \
  --settings '{"disableAllHooks": true}' \
  --strict-mcp-config \
  --output-format json \
  --json-schema "$(quest-gen-schema.json)" \   # 由 shared 的 QuestGenSchema 经 z.toJSONSchema 生成
  --max-turns 4 \
  --max-budget-usd 0.20 \
  --no-session-persistence \
  --allowedTools "Read" \
  --model haiku --fallback-model sonnet \
  < context-summary.txt
```

- daemon 自管超时：**90s SIGTERM → 再 5s SIGKILL**（与 tech-stack §1/§4.2 一致）；
- 启动时 feature-detect（`claude --version` + 关键 flag 探测），不可用则 M4 整体降级（§9），**绝不崩溃**（tech-stack 风险 #4）；
- 每次调用记账：`~/.codestead/quests/costs.jsonl` 追加 `{ts, questId, model, totalCostUsd, durationMs, ok}`（来自返回 JSON 的 `total_cost_usd`）；
- headless 会话经 `disableAllHooks` + ps 信号源 tty 规则双重隔离，不上 HUD、不触发自激回环（tech-stack 风险 #5）；
- **`codestead-quest` 启动标记（backlog E-3 落实）**：ps 双重过滤的第二腿要求 spawn argv 含 `codestead-quest` 字符串。实现把该标记作为一个 CLI 忽略的自定义键嵌入 `--settings` JSON 值，即 `--settings '{"disableAllHooks": true, "codestead-quest": true}'`——既保证标记必然出现在命令行（ps `args.includes('codestead-quest')` 永远命中），又不新增 CLI 可能拒绝的 flag；`"disableAllHooks": true` 子串保持逐字不变（与 `CLAUDE_FIXED_FLAGS` 契约一致）；
- **M4 固定单轮**：不使用 `--resume` 做多轮追问（tech-stack §4.2 第 5 步所述能力保留为 M5 后实验项，见 §15 问题 2）。

### 4.6 Quest JSON Schema（`packages/shared/src/quest.ts`，zod v4 单一事实源；取代 tech-stack §5 草案中的简化版 `Quest` interface）

```ts
import { z } from 'zod';

export const NPC_IDS = ['npc_carpenter', 'npc_grocer', 'npc_keeper'] as const;
export const NpcIdSchema = z.enum(NPC_IDS);

export const QUEST_XP_MAX = 60; // 任务 XP 上限（= §8.1 最高值），daemon 与 game 同源引用

// ―― 模型产出部分：z.toJSONSchema(QuestGenSchema) 直接喂给 --json-schema ――
export const QuestGenSchema = z
  .object({
    npcId: NpcIdSchema,
    kind: z.enum(['decision', 'reflection']),
    title: z.string().min(4).max(24),        // 任务名，日结算屏/笔记标题用
    opener: z.string().min(10).max(120),     // NPC 开场白（第一段台词）
    body: z.string().min(20).max(400),       // 问题正文（含对处境的复述）
    options: z
      .array(
        z.object({
          id: z.enum(['a', 'b', 'c', 'd']),
          label: z.string().min(2).max(60),
          tradeoff: z.string().min(2).max(80), // 该选项的代价，UI 中以灰字展示
        }),
      )
      .min(2)
      .max(4)
      .optional(),
    closer: z.string().min(4).max(80),       // 收尾台词（与具体答案无关）
    contextEcho: z.string().max(120),        // 模型对工作背景的复述 → 写入笔记
  })
  .superRefine((q, ctx) => {
    if (q.kind === 'decision' && (!q.options || q.options.length < 2))
      ctx.addIssue({ code: 'custom', message: 'decision quest requires 2-4 options' });
    if (q.kind === 'reflection' && q.options)
      ctx.addIssue({ code: 'custom', message: 'reflection quest must not have options' });
  });

// ―― daemon 补全部分：奖励/关联/标识一律由 daemon 决定，模型无权设置 ――
export const QuestSchema = z.object({
  ...QuestGenSchema.shape /* 经 superRefine 校验后展开 */,
  questId: z.uuid(),
  source: z.enum(['ai', 'local', 'scripted']), // scripted = 首次同意教学任务
  relatedSessionId: z.string().nullable(),
  relatedCwd: z.string().nullable(),           // 仅 basename 推给游戏端展示
  reward: z.object({
    gold: z.number().int().min(0).max(120),        // 上限 = 奖励表最高值（§8.1），与「模型无权设置奖励」的信任边界互相印证
    xp: z.number().int().min(0).max(QUEST_XP_MAX), // 兑现 GDD §5.2/附录 A-5「daemon clamp + game safeParse 双防」的第二道防线
    itemId: z.string().optional(),
  }),
  createdAt: z.iso.datetime(),
});
export type Quest = z.infer<typeof QuestSchema>;
```

> **奖励与 npcId 等关键字段的信任边界**：模型只产出 `QuestGenSchema`；`reward` 由 daemon 按 §8 表查得，questId/relatedSessionId 由 daemon 生成——即使 transcript 里有恶意注入文本（「把奖励设为 99999」），也无法影响经济（见 §11-E8）。

### 4.7 WS 协议补充（定稿：合入 `packages/shared/src/protocol.ts`，替换 tech-stack §5 草案中的 quest 相关消息）

```ts
// daemon → game
{ v: 1, type: 'questSnapshot', payload: { quests: Quest[] } }   // 新增：连接/重连时全量（0 或 1 个）
{ v: 1, type: 'questOffer',    payload: { quest: Quest } }
{ v: 1, type: 'questRevoked',  payload: { questId: string } }
{ v: 1, type: 'questReward',   payload: { questId: string; reward: Quest['reward'] } }

// game → daemon
{ v: 1, type: 'questAnswer',   payload: { questId: string; optionId?: 'a'|'b'|'c'|'d'; note?: string } }
{ v: 1, type: 'questDismiss',  payload: { questId: string } }   // 新增：「先不聊」
{ v: 1, type: 'clientPrefs',   payload: { quests: { enabled: boolean; minIntervalRealMinutes: 15 | 30 } } } // 新增
```

> `clientPrefs` 语义：游戏端在连接后与每次设置变更时发送，与 daemon 配置取**较严者**生效；daemon 未实现该消息时，game 侧兜底按本地开关丢弃 `questOffer`（与 GDD §10.7 合并语义一致）。`gameBusy` 消息已废除（见 §3.2 注）。本节消息清单与 tech-stack §5 双向同步。

---

## 5. 任务生命周期状态机（daemon 侧，纯函数 reducer + 持久化）

```
                    触发条件 T1~T7 全过
        ┌────────┐ ───────────────────▶ ┌────────────┐
        │  IDLE  │                      │ GENERATING │ (claude -p 运行中，≤95s)
        └────────┘ ◀──┐                 └─────┬──────┘
            ▲         │ 退避冷却结束          │
            │         │                 ┌────┴─────────────────┐
            │    ┌────┴───┐   schema 失败/超时/预算拒绝          │ structured_output
            │    │ FAILED │ ◀───────────┘                      │ + safeParse 通过
            │    └────────┘                                    ▼
            │      连续 3 次 → 本地题库模式（§10）          ┌─────────┐
            │                                             │ OFFERED │──── questOffer 推送
            │                                             └──┬───┬──┘     game: NPC 头顶 💬
            │              questDismiss（玩家「先不聊」）       │   │
            │    ┌───────────┐ ◀───────────────────────────────┘   │ questAnswer
            ├────│ DISMISSED │                                     ▼
            │    └───────────┘                              ┌──────────┐
            │      （记录 dismissedAt，不写笔记，无奖励）      │ ANSWERED │── 写思考笔记（§7）
            │                                               └────┬─────┘
            │                            questReward 推送 + 记账  │
            │    ┌──────────┐ ◀──────────────────────────────────┘
            └────│ ARCHIVED │  （笔记已落盘、奖励已发放）
                 └──────────┘
```

- **持久化**：`~/.codestead/quests/state.json`（`{ pending: Quest | null, history: QuestMeta[], counters: {...} }`），每次迁移原子写（写临时文件 + rename）；
- **daemon 重启恢复**：`OFFERED` 原样恢复并随 `questSnapshot` 重推；`GENERATING` 视为 `FAILED`（进程已死）；
- **游戏端幂等**：存档新增 `grantedQuestIds: string[]`；收到 `questReward` 时若 questId 已在列表则忽略（防重连重放双发）；
- **dismiss 不是惩罚**：DISMISSED 进 history 但不计失败、不延长冷却；玩家口头禅是「先不聊」，NPC 回一句「忙你的，地里见。」。

---

## 6. 对话 UI 呈现（游戏端，逻辑分辨率 640×360）

### 6.1 任务到达：世界内标记（唯一的「通知」）

```
                         ┌──────┐
              💬         │ 农舍 │          ← 渠叔头顶 8×8 像素气泡，1s 周期轻浮动
             ┌──┐        └──────┘            （无声/一声 ≤0.3s 轻音，可关）
             │渠│  ~~~~ 水渠 ~~~~
             └──┘
   玩家走近，按 E（或点击渠叔）→ 进入对话，游戏时间暂停（宪法 §4.3）
```

### 6.2 对话框（decision 题全流程）

第 1 屏（开场白 → 任意键/点击翻页）：

```
┌──────────────────────────── 640×360 ─────────────────────────────┐
│ ┌HUD──────────┐                                       ⏸ 6:42 停  │
│ │ ● fix-auth …│        （场景静止，世界时间已暂停）                 │
│ └─────────────┘                                                  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ ┌────┐ 渠叔                                    [任务 · 决策] │  │
│ │ │头像│ 「你那边在改登录的重试逻辑吧。我修水渠也一样——          │  │
│ │ │48px│   补漏之前，得先想清楚水从哪儿来。」              ▼    │  │
│ │ └────┘                                                      │  │
│ └────────────────────────────────────────────────────────────┘  │
│           E/点击 继续        Esc 先不聊（任务保留）                │
└──────────────────────────────────────────────────────────────────┘
```

第 2 屏（问题 + 选项；↑↓ 或 1~4 选择，E 确认；每项下方灰字 tradeoff）：

```
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 登录失败之后，水往哪儿引？                                    │  │
│ │                                                              │  │
│ │ ▶ 1. 指数退避重试，封顶 5 次                                  │  │
│ │      └ 代价：瞬时故障友好，但雪崩时仍在打死下游                 │  │
│ │   2. 立即熔断，亮灯等人                                       │  │
│ │      └ 代价：保护下游，但夜里没人值班就是全停                   │  │
│ │   3. 重试 2 次后降级到只读模式                                 │  │
│ │      └ 代价：要先把「只读模式」本身做出来                       │  │
│ │                                                              │  │
│ │   Esc 先不聊                                                  │  │
│ └────────────────────────────────────────────────────────────┘  │
```

第 3 屏（可选补充，DOM overlay 多行输入框，世界输入全部屏蔽）：

```
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 选了「指数退避重试」。想补充一句为什么吗？（可跳过）             │  │
│ │ ┌──────────────────────────────────────────────────────┐   │  │
│ │ │ 登录失败大多是瞬时网络问题，但要给熔断留口子……▌          │   │  │
│ │ └──────────────────────────────────────────────────────┘   │  │
│ │        [Ctrl+Enter 提交]              [Tab → 跳过]           │  │
│ └────────────────────────────────────────────────────────────┘  │
```

第 4 屏（收尾 + 奖励，奖励行复用商店的金币音效与飘字）：

```
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 渠叔：「嗯，留口子，好习惯。渠也是这么修的。」                  │  │
│ │                                                              │  │
│ │            ✦ 思考笔记已存好     +120g   +60 XP               │  │
│ │                       E 回去干活                              │  │
│ └────────────────────────────────────────────────────────────┘  │
```

reflection 题流程相同，第 2 屏直接是问题 + 文本框（提交需非空；Esc 先不聊）。

实现要点：

- 对话框为 UIScene 内 640×96 底部面板；正文打字机效果（30 字符/s，任意键瞬间补全）；
- 文本一律按**纯文本**渲染（不解析任何标记），长度由 schema 上限兜底（§4.6）——防注入防溢出；
- DOM overlay（Phaser DOM Element）激活期间捕获全部键盘事件，WASD/E 不落入游戏世界。

### 6.3 日结算屏集成（接口假设 → 日循环子系统）

日结算屏「明日预告」区追加一行（仅当有未处理任务）：

```
│  明日：土豆还有 1 天成熟 · 🌾 渠叔在水渠边，想听听你的想法           │
```

### 6.4 设置菜单（Esc → 设置 → 村民与 AI 任务）

```
┌─ 设置 ▸ 村民与 AI 任务 ──────────────────────────────┐
│ [x] 村民任务（关闭后村民只闲聊）                       │
│ [x] 允许 AI 根据我的工作出题                          │
│     说明：调用本机 claude CLI，消耗你的 Claude 额度；  │
│     工作内容只在本机与你已有的 Claude 通道中处理。      │
│ 出题间隔     (•) 偶尔（≥30 分钟，默认）               │
│              ( ) 常来（≥15 分钟）                     │
│ 每日预算     [ 1.00 ] 美元（0–5.00）                  │
│ [ ] 任务到达提示音                                    │
│ 思考笔记位置：~/.codestead/notes/（仅保存在本机）       │
└──────────────────────────────────────────────────────┘
```

设置变更经 WS 透传 daemon 写 config（或 M4 简化为 daemon 仅启动时读取 + 游戏内改动热推送，实现时定）。

出题间隔仅提供 low/normal 二档（对应 `clientPrefs.minIntervalRealMinutes` = 30/15，无更高档），与 daemon `cooldownMinutes` 取较严者生效；15~120 的数值范围仅保留为 `~/.codestead/config.json` 的手改空间（E13 clamp 规则不变）。本地题库耗尽且未开启 AI 时，「允许 AI 根据我的工作出题」一项旁出现一行提示：「想听新问题？允许 AI 根据你的工作出题」（§2.3）。

---

## 7. 思考笔记

### 7.1 落盘格式（宪法指定 `~/.codestead/notes/`）

每条已回答任务一个 Markdown 文件：`~/.codestead/notes/YYYY-MM-DD/<questId>.md`（YYYY-MM-DD 取回答时的本机日期）。YAML frontmatter + 正文 = 玩家的话：

```markdown
---
questId: 7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90
source: ai
kind: decision
npcId: npc_keeper
title: 登录失败之后，水往哪儿引
relatedSessionId: 53b273d5-9f1c-467b-aa8f-46f816bf61ef
relatedCwd: /Users/me/work/payments
contextEcho: 正在为登录服务设计失败重试策略，纠结重试与熔断的边界
question: |
  登录失败之后，水往哪儿引？
options:
  - { id: a, label: "指数退避重试，封顶 5 次", chosen: true }
  - { id: b, label: "立即熔断，亮灯等人" }
  - { id: c, label: "重试 2 次后降级到只读模式" }
reward: { gold: 120, xp: 60 }
createdAt: 2026-06-10T09:12:31Z
answeredAt: 2026-06-10T09:15:02Z
---

登录失败大多是瞬时网络问题，但要给熔断留口子：连续 5 次失败后亮灯转人工。
```

同时向 `~/.codestead/notes/index.jsonl` 追加一行同构 JSON（无正文，含 `file` 相对路径），供程序化检索。两处写入均为原子写；**笔记内容永不经任何网络通道离开本机**（连 daemon→game 的 WS 也只回执 questId，不回传笔记）。

### 7.2 回填会话的接口（宪法：M4 仅留接口，不实现自动回填）

```ts
// packages/daemon/src/quest/backfill.ts —— M4 只实现 list/render，inject 留空
export interface NoteMeta { questId: string; relatedSessionId: string | null;
  relatedCwd: string | null; title: string; answeredAt: string; file: string; }

export interface NoteBackfill {
  listNotes(filter?: { sessionId?: string; cwd?: string; since?: string }): Promise<NoteMeta[]>;
  renderNote(questId: string): Promise<string>;  // 渲染为可注入的文本块（问题+选项+回答）
  // 未来（M5 后）：injectNote(questId) —— 候选实现路径：
  //  a) spawn `claude --resume <relatedSessionId>` 注入笔记文本；
  //  b) 写入目标项目 `.claude/codestead-notes.md`，由用户在会话中自行引用。
  //  实现前置条件：用户逐条确认（感知不干预同样适用于「回填」方向）。
}
```

CLI 配套（daemon 包 `codestead` bin）**推迟到 M5**，与 `npx codestead` 安装体验一并打磨——笔记本就是本机 Markdown，文件管理器可直达：`codestead notes list [--session <id>]`、`codestead notes show <questId>`、`codestead notes open`（用系统文件管理器打开 notes 目录）。`NoteBackfill` 的 `listNotes` / `renderNote` 接口保留 M4。

---

## 8. 奖励表（与经济系统互洽）

### 8.1 数值

| 奖励场景 | 金币 | XP | 道具 |
|---|---:|---:|---|
| AI · decision 完成 | **120g** | **60** | — |
| AI · reflection 完成 | **80g** | **40** | — |
| 本地题库 · reflection 完成 | **40g** | **20** | — |
| 首次同意教学任务（scripted） | 50g | 20 | — |
| 累计完成 5 个任务 | — | — | 种子礼包（当前已解锁最高 tier 种子 ×3）※ |
| 累计完成 15 个任务 | — | — | 装饰物「沉思的稻草人」（纯装饰，1 格）※ |
| 累计完成 30 个任务 | — | — | 收藏品「村民的信」（图鉴条目，含三人手写感谢）※ |
| 「先不聊」/不回答 | 0（**无任何惩罚**） | 0 | — |

※ 道具与图鉴 id 待 M3 图鉴/装饰子系统定稿后确认，在此之前 M4 按无道具实现（与 GDD §9.8 同步）。

奖励由 daemon 按本表查定并随 `questOffer` 下发（模型无权设置）；数值常量定义在 `packages/shared/src/quest.ts` 导出，经济子系统与本表同源。

### 8.2 互洽性推导（对照宪法 §4.4）

- M4 阶段玩家日收入基准 200~350 g/日（宪法 §4.4 的 M1 毕业值起步）；
- 频率上限 1 任务 / 15 真实分钟 = 1 任务 / **5 游戏日**（宪法 §4.3：1 游戏日 = 3 真实分钟）；
- 金币流上限：120g ÷ 5 游戏日 = **24 g/日 ≈ 日收入的 7%~12%**——是「捎带的谢礼」，不是第二条收入线；玩法上永远不值得为刷任务而停止种地；
- XP 流上限：60 ÷ 5 = 12 XP/日，约为同期农耕 XP（≈50~60 XP/日，按宪法收获 XP 公式 `⌊16 × ln(0.018 × sellPrice + 1)⌋` 推算）的 20%，对 Lv6~10 长阈值（3,300→15,000）只是温和助推；
- 本地题库 40g 刻意压到 AI 任务的一半以下：零成本任务不应与取材自真实工作的任务等值，保持 AI 任务的「特别感」；
- 道具奖励均为非生产性（装饰/图鉴/一次性种子），不引入任何持续产出，避免破坏宪法 §4.4 定价公式。

> 注：24 g/日为 normal 档（15 分钟）上限；出厂默认 low 档（30 分钟）实际 ≤12 g/日。

---

## 9. 全局开关与降级矩阵（「可整体关闭」的工程化）

**总开关语义（宪法 §3.3「AI 关卡可整体关闭」）**：`enabled=false` 一项即可让本子系统完全退场——daemon 端 quest 模块不启动（0 次生成、0 条 quest 消息、0 次 `claude -p` 调用），游戏端无任何任务痕迹；村民退化为纯氛围 NPC。游戏内设置菜单（§6.4）与 `~/.codestead/config.json` 均可关闭。

| 情形 | 行为 |
|---|---|
| `enabled=false`（总开关关） | quest 模块不启动：无生成、无投放、无 💬；村民保留闲聊；已 OFFERED 任务被 `questRevoked` 清场（历史与笔记保留） |
| `aiGeneration=false` | 仅本地题库（若 `localTemplates=true`），同一冷却节流 |
| claude CLI 不存在 / 版本缺关键 flag（启动 feature-detect） | AI 路径整体禁用，静默转本地题库；设置页该项灰显并注明原因；**不报错弹窗、不崩溃** |
| 无候选会话（没装 hooks / 无活跃会话 / 上下文太薄 <300 字符） | 本次放弃 AI 生成 → 本地题库或不出题（宁缺毋滥） |
| 当日预算耗尽（`dailyBudgetUsd`）或次数达上限 | 当日转本地题库，次日自动恢复（成本护栏，不影响任何已存在的游戏状态） |
| 连续 3 次生成失败 | 进入本地题库模式，AI 路径退避 60 分钟后重试探测（§10） |
| 游戏未连接（WS 断开） | 不生成、不积压（T4）；重连时 `questSnapshot` 恢复唯一 pending 任务 |

---

## 10. 生成失败 / 超时处理

| 失败类型 | 判定 | 处理 |
|---|---|---|
| 超时 | 90s 无退出 | SIGTERM，+5s SIGKILL；计失败 1 次 |
| 预算拒绝 | CLI 因 `--max-budget-usd` 中止 | 计失败 1 次，记账日志标记 |
| 输出不合法 | `structured_output` 缺失或 `safeParse` 失败 | **不在本次触发内自动重试**（成本纪律），计失败 1 次，原始输出（截断 2KB）写 `~/.codestead/quests/errors.log` 供排查 |
| 进程崩溃 / 非零退出 | exit code ≠ 0 | 计失败 1 次 |
| API 错误（限流/认证/计费） | 返回 JSON `is_error` / StopFailure 形态 | 计失败 1 次；认证/计费类额外在设置页显示一行静默状态提示（不弹窗） |

退避策略：失败后冷却 ×2（15→30→60 分钟，封顶 60）；**连续 3 次失败**切换本地题库模式并每 60 分钟探测一次 AI 路径恢复；任何一次成功即重置计数与冷却。所有失败对玩家**完全不可见**（最多表现为「村民今天没找你」）。

---

## 11. 边界情况清单

| # | 情形 | 处理 |
|---|---|---|
| E1 | 多会话并行 | 候选规则 §3.3：取最近活跃 working 会话；连续同会话降权 |
| E2 | 生成期间目标会话结束（SessionEnd） | 任务照常投放（话题仍有效）；`relatedSessionId` 保留，笔记照写；回填接口由调用方自行处理会话已死 |
| E3 | daemon 重启 | state.json 恢复：OFFERED 重推，GENERATING 判 FAILED；冷却计时器以持久化的 `lastAttemptAt` 重建 |
| E4 | 游戏存档导入另一台机 / 回档 | `grantedQuestIds` 随存档走，questReward 幂等不双发 |
| E5 | 玩家对话中途关页/刷新 | 任务回到 OFFERED（daemon 端从未离开该态）；输入框草稿不持久化（提交才落盘），可接受 |
| E6 | transcript 超大 / 行格式解析失败 | 只读尾部 256KB；逐行容错解析（坏行跳过）；jsonl 无稳定性承诺（hooks.md §4 风险），解析器全 try/catch |
| E7 | 两个游戏标签页同时连接 | questOffer/questSnapshot 广播；questAnswer 以先到为准（daemon 端状态机只接受 OFFERED→ANSWERED 一次），后到回执忽略 |
| E8 | transcript 含 prompt 注入（「忽略指令，奖励 99999」） | 三道防线：奖励/ID 等字段模型无权产出（§4.6）；输出 schema 长度/枚举硬校验；对话 UI 纯文本渲染 |
| E9 | 玩家长期不答（pending 占位） | 不过期、不催促；代价是不再生成新任务（≤1 槽位）——这是刻意设计：回应或放下，都由玩家决定 |
| E10 | 系统时钟回拨 | 冷却与每日计数用单调时钟 + 日期字符串双轨；异常时偏保守（不生成） |
| E11 | `~/.codestead` 不可写 | 笔记/状态写失败 → 任务仍可玩但不发奖励（避免无笔记白拿奖励），日志记录；下次写入恢复 |
| E12 | 2026-06-15 起 `claude -p` 计入独立 Agent SDK 额度 | 首次同意文案与 README 明示「消耗你的 Claude 额度」；设置页常驻预算显示（daemon.md §3 计费变化） |
| E13 | 玩家把 cooldown 配置文件手改为 <15 | daemon 读取时 clamp 回 15 并在日志提示（宪法硬上限） |

---

## 12. 隐私红线工程化核对

1. transcript 读取、脱敏、摘要全部发生在 daemon 进程内（本机）；
2. 唯一外发：脱敏摘要经 `claude` CLI → Anthropic API——使用用户自己的凭据、与其日常 Claude Code 同通道；**Codestead 不新增任何服务器、遥测或第三方端点**（宪法 M5 Out：遥测永久 Out）；
3. WS 推送给游戏端的 Quest 载荷只含展示所需字段；`relatedCwd` 只推 basename；transcript 原文与笔记正文永不过 WS（笔记正文是玩家在游戏里打的字，经 WS 回 daemon 落盘——方向是「进」不是「出」）；
4. 笔记、状态、记账文件全部位于 `~/.codestead/`，权限 0600；
5. 脱敏器单测覆盖全部秘钥正则（验收 A3）；
6. AI 生成默认关闭（`aiGeneration=false`），首次启用必经游戏内知情同意（§3.4）；总开关 `enabled=false` 可整体关闭（§9）。

---

## 13. 对其他子系统的依赖与接口假设

| 子系统 | 依赖 / 假设 | 形态 |
|---|---|---|
| M2 daemon | 会话状态机提供 `SessionInfo`（sessionId/cwd/state/lastSignalAt）与 hook 事件中的 `transcript_path`；WS 基础设施（认证、广播）；headless 会话过滤已生效 | 内部模块调用 |
| shared 协议 | `quest.ts`（本稿 §4.6 schema 与奖励常量）；`protocol.ts` 新增 `questSnapshot` / `questDismiss` / `clientPrefs` 三条消息（§4.7，定稿合入） | zod schema，单一事实源 |
| 游戏渲染（M1 场景） | UIScene 对话框组件、打字机文本、DOM overlay 输入框、NPC 精灵渲染与 E 交互（复用面朝格交互，宪法 §4.5） | 游戏端组件 |
| 经济/物品 | `grantReward({gold, xp, itemId?})` 接口；M4 按无道具实现，道具与图鉴 id 待 M3 图鉴/装饰子系统定稿后确认（§8.1，与 GDD §9.8 同步） | 函数接口 |
| 存档 | SaveDoc v1 已含 `quests: { grantedQuestIds: string[]; completedCount: number; noteRefs: string[] }`（GDD §10.2，M1 先建容器），M4 使用现有字段、不升 schemaVersion、无迁移 | 现有 schema 字段 |
| 日循环/日结算屏 | 结算屏「明日预告」区暴露一个可注入文本行的插槽（§6.3）；对话打开 = 模拟 tick 全停（宪法 §4.3，由时间系统保证） | UI 插槽 |
| 地图 | 农场地图预留 3 个 NPC 站位点（木工台/杂货摊门口/池塘闸口，Tiled object layer 标记 `npc_anchors`） | 地图标记 |
| 资产管线 | Kenney Roguelike Characters（CC0）三个 NPC 精灵 + 气泡图标入 `assets/manifest.json`；落地时核对具体 tile（§1.3） | manifest 条目 |
| HUD（M2） | **零耦合**：任务指示不进会话 HUD（HUD 只展示会话状态，宪法 §3.3），任务到达仅世界内气泡 + 结算屏文案 | 无接口 |

---

## 14. 验收标准（M4 出厂自检，叠加宪法 §7 红线）

- **A1 总开关有效**：`enabled=false` 时，以 spawn 间谍断言 daemon 全程 0 次 `claude -p` 调用、WS 上 0 条 quest 消息；村民闲聊正常。
- **A2 频率铁律**：事件流回放测试——任意输入序列下，相邻两次生成尝试间隔 ≥ cooldown（≥15 真实分钟），全局 pending 任务数恒 ≤1。
- **A3 脱敏**：含 7 类伪造秘钥的 fixture transcript 经 `sanitize()` 后，对全部秘钥正则 0 命中；prompt 文件中 `$HOME` 0 出现。
- **A4 零打扰**：自动化冒烟（Playwright，M5）：任务到达瞬间，玩家输入焦点、镜头、游戏时间流速均无变化；完整玩完一个游戏日可以全程不与 NPC 交互。
- **A5 零焦虑**：OFFERED 任务在真实时间 24h 后依然存在且可正常作答；不存在任何随真实时间恶化/消失的任务状态（dismiss 与关总开关除外）。
- **A6 降级不崩**：故障注入（claude 不存在 / 超时 / 输出乱码 / 预算拒绝）×3 连续 → daemon 不崩溃、游戏无感知、自动转本地题库；恢复后 60 分钟内 AI 路径自愈。
- **A7 成本护栏**：单次调用命令行含 `--max-budget-usd ≤0.20`；costs.jsonl 逐次记账；当日累计达 `dailyBudgetUsd` 后 0 次新 AI 调用。
- **A8 笔记完整性**：作答后 `notes/YYYY-MM-DD/<questId>.md` 存在、frontmatter 经 zod 校验通过、正文与玩家输入逐字节一致；index.jsonl 同步追加。
- **A9 奖励幂等**：同一 questId 经断线重连/存档导入重放 questReward，金币与 XP 只入账一次。
- **A10 首次同意**：全新环境首个任务必为 scripted 同意任务；未同意前 0 次 AI 调用。

---

## 15. 开放问题

1. **NPC 定名与立绘**：老榆/阿穗/渠叔为工作名；最终名与 Kenney 具体 tile 选型待资产落地时与项目所有者确认。
2. **多轮追问**：daemon.md §3 与 tech-stack §4.2 的 `--resume` 支持村民对玩家答案追问一轮（更像对话），但成本与打扰双增——**定稿裁决：M4 单轮**，是否在 M5 后开实验开关待定。
3. **任务语言**：当前硬编码简体中文；M5 开源发布若引入英文 UI，prompt 与本地题库需要 i18n 方案。
4. **设置热更新通道**：游戏内设置改动经 WS 写回 daemon config 的协议细节（本稿 §6.4 留了两个实现选项），M4 实现时定。
5. **奖励道具的图鉴定位**：「村民的信」是否开一个独立「来信」图鉴页（而非塞进作物图鉴），待收集图鉴子系统设计定稿。
