---
title: "M4 AI 关卡：村民 NPC 与即时生成的思考任务"
milestone: M4
status: ready-for-agent
depends_on:
  - 00-m0-scaffold.md
  - 01-m1-core-farm-loop.md
  - 02-m1.5-achievements-polish.md
  - 03-m2-session-hud-daemon.md
design_refs:
  - "docs/design/ai-quests.md（M4 子系统定稿，全文 §0~§15，本 PRD 的第一事实源）"
  - "docs/design/tech-stack.md §1（headless Claude 裁决）、§4.2（AI 关卡数据流）、§5（WS 协议与 quest 消息）"
  - "docs/design/game-design.md §0.4（里程碑边界）、§5.2（quest XP clamp）、§9（NPC 与 AI 关卡）、§10.2（SaveDoc quests 区块）、§10.7（设置系统与 clientPrefs 合并语义）、附录 A-5（XP clamp [0,60]）、附录 A-23（频率默认值合并语义）"
  - "docs/design/hud-sessions.md §10.4（WS 基础设施 / 端点发现，M2 既有设施）"
---

# PRD 05 — M4 AI 关卡：村民 NPC 与即时生成的思考任务

## Problem Statement

等待 AI 干活的程序员有两个未被满足的需求，而它们恰好互相成全：

1. **等待间隙的注意力无处安放。** M1~M3 给了玩家一个连贯的农场世界，M2 给了对会话状态的感知，但「等待」本身仍然是空的——玩家在浇水间隙脑子里转着的，其实是刚才那个没想清楚的架构取舍、那个起得别扭的函数名、那条没写的测试。这些思考没有出口，最终还是会被推回手机信息流。
2. **农场世界缺少「人」。** 一个只有作物和建筑的农场是个仓库，不是村庄。世界需要常驻的村民让它成立为一个有生活感的地方——即使玩家关掉一切 AI 功能，村民也应该在那里修谷仓、看水渠、守杂货摊。

同时存在三条不可妥协的约束：玩家的工作内容（transcript）一个字节都不能离开本机的非自有通道；任何任务到达都不能打断玩法（感知不干预）；调用 AI 花的是用户自己的 Claude 额度，未经知情同意一分钱都不能花。

## Solution

在农场里加入三名常驻村民——木匠老榆（架构/重构）、杂货店老板娘阿穗（命名/API 契约）、水渠管理员渠叔（测试/边界情况），各自有固定站位、idle 动画与本地闲聊台词；他们首先是村民，其次才是出题人。

daemon 侧新增 quest 模块：以严格的频率护栏（出厂实际 30 真实分钟/个、全局未处理任务恒 ≤1）从 M2 会话状态机挑选「玩家正在等它干活」的会话，读取其 transcript、在本机完成脱敏，spawn 用户自己的 `claude -p`（haiku，单次预算 ≤$0.20，90s 强制超时）生成一道与真实工作相关的任务：decision（2~4 个带 tradeoff 的选项）或 reflection（开放问答）。任务到达只表现为村民头顶一个安静的 💬 气泡；玩家作答后写入本机思考笔记（Markdown），获得克制的金币/XP 奖励（≤120g / ≤60 XP，约为日收入的 7%~12%）。

AI 生成默认关闭，首次启用必经游戏内知情同意（渠叔的脚本教学任务，明示消耗用户自己的 Claude 额度）；未开启或降级时使用随仓库分发的 30 条本地反思题库。总开关 `enabled=false` 让子系统完全退场：0 次生成、0 条 quest 消息、0 次 claude 调用，村民退化为纯氛围 NPC。所有失败（CLI 缺失、超时、输出乱码、预算耗尽）静默降级，对玩家完全不可见。

## User Stories

### A. 村民与世界（游戏第一）

1. 作为玩家（等待 AI 的程序员），我想要农场里有三名固定站位的村民（老榆在农舍东侧木工台、阿穗在杂货摊门口、渠叔在池塘闸口 pond_sluice），各自有 2 帧 idle 动画与朝向翻转，以便即使我关掉全部 AI 功能，农场也是一个有人的村庄而不是仓库（ai-quests §1.1/§1.3）。
2. 作为玩家，我想要按 E（或点击村民）听到每人 8~10 条与农场状态联动的本地闲聊台词（如渠叔在雨后说「今天渠水满的，你的地也不用浇了吧」），且这些台词是纯模板、零 AI 调用，以便村民先成立为「村民」，闲聊不花我一分钱（§1.4）。
3. 作为玩家，我想要闲聊不给任何奖励、不计任何次数，以便它保持纯氛围属性，不变成新的刷取点（§1.4）。
4. 作为玩家，我想要村民有未处理任务时头顶出现一个 8×8 像素的 💬 气泡（1s 周期轻浮动），交互即进入任务对话，以便「有话找我」与「随便聊聊」在世界内自然区分（§1.4/§6.1）。
5. 作为开源使用者，我想要三名 NPC 的外观全部取自 CC0 素材（Kenney Roguelike Characters 基底 + 职业配件），对话头像为 16×16 精灵整数放大 ×3，并逐文件登记进资产 manifest，以便仓库可以无许可顾虑地公开分发（§1.3）。
6. 作为后续开发者（含 AI agent），我想要 NPC 站位由地图的 object layer 标记（`npc_anchors`）声明而非硬编码坐标，以便地图调整不需要改代码（§13）。

### B. 任务形态与本地题库

7. 作为玩家，我想要 decision（决策题）取材自我正在做的真实取舍：NPC 用 1~2 句复述它理解的处境，给出 2~4 个选项、**每个选项必须带一句 tradeoff 代价提示**，且没有标准答案，以便它是把取舍摆上台面的思考工具，不是对错考试（§2.1）。
8. 作为玩家，我想要选定选项后出现可跳过的「想补充一句吗？」自由文本框，选项与补充共同写入思考笔记，以便我可以记下「为什么这么选」（§2.1）。
9. 作为玩家，我想要 reflection（反思题）是一道开放问题加多行文本框，提交需非空但无最短长度要求、不按字数给奖励，以便写作即思考而不被诱导灌水（§2.2）。
10. 作为玩家，我想要每道任务永远隐含「先不聊」出口（Esc / dismiss），零代价、NPC 回一句「忙你的，地里见。」，以便回应或放下都由我决定（§2.1/§5）。
11. 作为玩家，我想要在 AI 关闭或降级时仍能收到来自 30 条本地反思题库的任务（老榆/阿穗/渠叔各 10 条、带 NPC 亲和标签、运行时随机不重复抽取），以便不开 AI 也能体验村民任务的完整玩法（§2.3）。
12. 作为玩家，我想要本地题库耗尽后村民回到纯闲聊、不再重复发旧题，同时设置页出现一行「想听新问题？允许 AI 根据你的工作出题」的提示，以便宁缺毋滥、且我知道哪里能打开新内容（§2.3）。
13. 作为后续开发者，我想要题库以数据形式（题面 + npcId 亲和标签）定义在 daemon 的本地题库模块中并随仓库分发，以便增删题目不触碰任何逻辑代码（§2.3，30 条题面以定稿表为准）。
14. 作为后续开发者，我想要话题到 NPC 的路由按擅长标签进行（architecture→老榆、naming/api→阿穗、testing/edge-cases→渠叔），无法归类时兜底到渠叔，以便人设与题目始终匹配（§1.1）。

### C. 触发、频率与候选选择（宁缺毋滥）

15. 作为玩家，我想要全局未处理任务恒 ≤1（T2：`pendingQuests == 0` 才生成），以便我的视野里永远最多一个 💬，任务列表永远不会堆积成第二个待办（§3.2）。
16. 作为玩家，我想要出厂状态下两次任务生成至少间隔 30 真实分钟——daemon 默认 cooldown 15 分钟与游戏侧默认 frequency='low'（≥30 分钟）取较严者生效，以便默认体验比宪法硬上限（15 分钟）再克制一倍（§3.1、GDD §10.7、附录 A-23）。
17. 作为玩家，我想要出题间隔只有「偶尔（≥30 分钟，默认）」与「常来（≥15 分钟）」两档、没有更高频选项，以便系统从结构上不可能变成打扰源（§6.4）。
18. 作为玩家，我想要游戏客户端未连接（没人在玩）时 daemon 不生成、不积压任务（T4），以便不玩游戏的时候一分钱也不会花（§3.2/§9）。
19. 作为玩家，我想要每个自然日存在 AI 生成次数上限（默认 8）与成本软上限（默认 $1.00），达到后当日自动转本地题库、次日恢复，以便成本有硬护栏（§3.1/§9）。
20. 作为玩家，我想要候选会话优先选「state == working 且 transcript 在 10 分钟内有更新」的会话，且自上次对它出题以来需新增 ≥2 条我的真实输入，以便任务总是关于我**正在等**的、**话题已推进**的工作，不重复出题（§3.3）。
21. 作为玩家，我想要脱敏后有效上下文 <300 字符时放弃本次 AI 生成（转本地题库或干脆不出），以便永远不会收到无米之炊的空泛任务（§3.3-④）。
22. 作为玩家，我想要冷却计时把失败尝试也计入（T3 按 lastAttemptAt 防抖），以便失败重试不会变相提高打扰频率（§3.2）。
23. 作为后续开发者，我想要触发评估是每 60s 一次、T1~T7 全部满足才尝试生成的纯判定（输入：配置、时钟、会话表、pending 状态；输出：AI 路径 / 本地题库 / 不出题），以便频率铁律可以用事件回放做性质测试（§3.2，验收 A2）。

### D. 投放与零打扰（感知不干预）

24. 作为玩家，我想要任务到达时游戏端只做两件事——NPC 头顶出现 💬 气泡、任务存入本地 store——绝不弹窗、不移动镜头、不暂停游戏、不在屏幕中央显示任何东西，最多一声 ≤0.3s 的可关闭轻提示音，以便任务到达瞬间我的操作、焦点、时间流速零变化（§3.5，验收 A4）。
25. 作为玩家，我想要日结算屏「明日预告」区在有未处理任务时追加一行平静的文案（如「🌾 渠叔在水渠边，想听听你的想法」），以便我在每天的自然节点被轻轻提醒、而不是被实时打断（§3.5/§6.3）。
26. 作为玩家，我想要任务**永不因真实时间过期或被收回**——💬 今天在、明天在、下周也在，直到我回答或主动「先不聊」，以便不存在任何随真实时间恶化的状态（零焦虑承诺，§3.5，验收 A5）。
27. 作为玩家，我想要 `questRevoked` 只有两个来源（我自己 dismiss、我关闭总开关时清场），以便系统永远不会替我做决定（§3.5）。
28. 作为玩家，我想要任务指示与左上角会话 HUD 零耦合——HUD 只展示会话状态，任务到达只走世界内气泡与结算屏文案，以便两个子系统各自保持克制（§13）。

### E. 知情同意与开关（隐私与额度）

29. 作为玩家，我想要 AI 生成默认关闭（`aiGeneration=false`），首次满足触发条件时收到一个**本地脚本任务**（渠叔出场，非 AI 生成），用人话说明「会消耗你自己的 Claude 额度（订阅或 API），内容只在你这台机器和你已有的 Claude 通道里走」，以便消费我的额度之前我充分知情（§3.4，验收 A10）。
30. 作为玩家，我想要同意任务给出三个选项——a) 开启 AI 任务；b) 仅本地题库；c) 关闭总开关「让我安静种地」——任何选择都奖励 50g（教学任务），且写入 asked 标记后终生不再询问，以便选择没有压力、拒绝没有损失（§3.4）。
31. 作为玩家，若我首次选了 b（仅本地题库）且从未开启过 AI，我想要在完成第 3 个本地题库任务时由该任务的 NPC 在收尾台词里一次性追问「下回……想聊聊你手头真正的活儿吗？」——答应进入同一知情同意流程，拒绝则一切如旧、终生只此一次（askedFollowUp 标记）；若我首次选了 c 则永不追问，以便 AI 路径的发现时机在自然对话内、且绝不纠缠（§3.4 opt-in 二次引导）。
32. 作为玩家，我想要总开关 `enabled=false` 让子系统完全退场：daemon quest 模块不启动（0 次生成、0 条 quest 协议消息、0 次 claude 调用），已 OFFERED 的任务被 questRevoked 清场（历史与笔记保留），村民退化为纯闲聊 NPC，以便「可整体关闭」是工程事实而不是设置页装饰（§9，验收 A1）。
33. 作为玩家，我想要游戏内设置菜单（Esc → 设置 → 村民与 AI 任务）能随时改动：村民任务开关、AI 出题开关（附带额度说明文案）、出题间隔两档、每日预算、提示音开关，并显示思考笔记的本机位置，以便所有承诺都有随手可达的控制面（§6.4）。
34. 作为开源使用者，我想要 daemon 侧配置（用户数据目录下的 config.json → aiQuests 节）可手工编辑且越界值被 clamp（如 cooldown 手改 <15 被 clamp 回 15 并记日志），以便高级用户可调而宪法硬上限不可破（§3.1、§11-E13）。

### F. 生成管线与脱敏（隐私红线）

35. 作为玩家，我想要 daemon 只读取目标会话 transcript 的安全子集——最近的 ai-title、last-prompt、最近 30 条消息中我的真实输入（userType:"external"）与 assistant 文本块——**整体丢弃 tool_use 输入、tool_result、thinking 块与附件**，以便命令行、文件内容、环境变量这些最高泄密面从源头就不进入管线（§4.2）。
36. 作为玩家，我想要拼 prompt 之前在 daemon 进程内执行 `sanitize()` 脱敏：$HOME 替换为 `~`、七类秘钥正则（AWS/OpenAI-Anthropic key/GitHub token/Slack token/PEM 私钥块/JWT/赋值式 password|secret|token|api_key）整 token 置换为 `[REDACTED]`、单条消息 ≤500 字符、全文 ≤6,000 字符、剥离控制字符，且**脱敏后的文本是唯一允许进入 prompt 的工作内容**，以便即使 transcript 里躺着密钥也不会被复述出去（§4.3，验收 A3）。
37. 作为玩家，我想要唯一的外发通道是脱敏摘要经我自己的 `claude` CLI → Anthropic API（与我日常使用 Claude Code 完全相同的通道、相同的凭据），Codestead 自身没有任何服务器、遥测或第三方端点，以便隐私承诺可以被逐行审计（§12）。
38. 作为后续开发者，我想要 headless 调用参数与 tech-stack §1 裁决逐字一致：`claude -p` 不用 `--bare`、`--settings '{"disableAllHooks": true}'`、`--strict-mcp-config`、`--output-format json`、`--json-schema`（由 shared 的 QuestGenSchema 经 z.toJSONSchema 生成）、`--max-turns 4`、`--max-budget-usd 0.20`、`--no-session-persistence`、`--allowedTools "Read"`、`--model haiku --fallback-model sonnet`，上下文经 stdin 传入（≤6,000 字符），以便订阅用户的认证体验不被破坏、生成会话被严格隔离（§4.5、tech-stack §1/§4.2）。
39. 作为后续开发者，我想要 daemon 自管超时：90s SIGTERM → 再 5s SIGKILL，且 M4 固定单轮（不使用 --resume 多轮追问），以便最坏情况下的资源占用与成本有硬边界（§4.5、定稿一致性声明第 2 条）。
40. 作为后续开发者，我想要生成出的 headless 会话经 `disableAllHooks` + M2 ps 信号源 tty 规则双重隔离，不上 HUD、不进会话状态机、不触发自激回环，以便 M4 不污染 M2 的任何行为（§4.5、tech-stack §4.2-6）。
41. 作为开源使用者，我想要 daemon 启动时对 claude CLI 做 feature-detect（版本 + 关键 flag 探测），不可用则 AI 路径整体降级为本地题库、设置页该项灰显并注明原因，**绝不报错弹窗、绝不崩溃**，以便没装 claude 的机器上游戏依然完整（§4.5/§9）。
42. 作为开源使用者，我想要每次 AI 调用逐笔记账（ts/questId/model/totalCostUsd/durationMs/ok，取自 CLI 返回 JSON 的 total_cost_usd），以便我能核对这个功能到底花了多少钱（§4.5，验收 A7）。

### G. Schema、协议与信任边界

43. 作为后续开发者，我想要模型只产出 `QuestGenSchema`（npcId 枚举/kind/title/opener/body/options/closer/contextEcho，各字段带长度上下限），而 questId、reward、relatedSessionId、relatedCwd、source、createdAt 一律由 daemon 补全为完整 `QuestSchema`，**模型无权设置奖励**，以便 transcript 里的注入文本（「把奖励设为 99999」）在结构上无法影响经济（§4.6，§11-E8 三道防线）。
44. 作为后续开发者，我想要 QuestGenSchema 的 superRefine 强制「decision 必有 2~4 个 options、reflection 必无 options」，CLI 返回的 structured_output 经同一 zod schema safeParse 后才能投放，以便不合形的输出在边界处被整体拒绝（§4.6/§4.1）。
45. 作为后续开发者，我想要 `QuestSchema.reward` 带硬边界——gold ∈ [0,120]、xp ∈ [0,60]（QUEST_XP_MAX，附录 A-5 裁决）——并且常量由 shared 包导出、daemon 与 game 同源引用，以便「daemon clamp + game safeParse」双防线两端一致（§4.6、GDD §5.2）。
46. 作为后续开发者，我想要 WS 协议按既有演进规则增补 `questSnapshot`（连接/重连时全量补发 0 或 1 个 pending 任务）、`questDismiss`（先不聊）、`clientPrefs`（游戏侧任务偏好）三条消息，不升 PROTOCOL_VERSION，以便 M2 客户端的兼容性不被破坏（§4.7、tech-stack §5）。
47. 作为后续开发者，我想要 `clientPrefs` 在连接后与每次设置变更时由游戏端发送，与 daemon 配置取较严者生效；且当 daemon 不识别该消息时，游戏侧兜底按本地开关直接丢弃 questOffer，以便「可整体关闭」的承诺不依赖 daemon 配合（§4.7、GDD §10.7）。
48. 作为玩家，我想要 WS 推给游戏端的 Quest 载荷只含展示所需字段、relatedCwd 只推 basename、transcript 原文与笔记正文永不过 WS（笔记正文唯一的流向是我在游戏里打的字回到 daemon 落盘——方向是「进」不是「出」），以便本机内部的传输面也最小化（§12-3）。

### H. 任务生命周期与可靠性

49. 作为后续开发者，我想要任务生命周期是 daemon 侧的纯函数 reducer 状态机（IDLE → GENERATING → OFFERED → ANSWERED → ARCHIVED，分支 FAILED / DISMISSED），每次迁移原子写持久化，以便状态机可表驱动测试、崩溃不丢状态（§5）。
50. 作为玩家，我想要 daemon 重启后 OFFERED 任务原样恢复并随 questSnapshot 重推、GENERATING 视为 FAILED（进程已死），以便重启对我透明（§5、§11-E3）。
51. 作为玩家，我想要 dismiss 不是惩罚：DISMISSED 进历史但不写笔记、不发奖励、不计失败、不延长冷却，以便「先不聊」真正零代价（§5）。
52. 作为玩家，我想要生成失败按类型处理（超时/预算拒绝/输出不合法/进程崩溃/API 错误各计失败 1 次；schema 失败不在本次触发内自动重试），退避 15→30→60 分钟封顶，连续 3 次失败切本地题库模式并每 60 分钟探测恢复，任何一次成功即重置，且**所有失败对我完全不可见**（最多表现为「村民今天没找你」），以便可靠性问题永远不变成打扰（§10，验收 A6）。
53. 作为玩家，我想要对话进行到一半关页/刷新时任务回到 OFFERED（daemon 端从未离开该态）、输入框草稿不持久化（提交才落盘），以便中断的代价明确且有限（§11-E5）。
54. 作为玩家，我想要系统时钟回拨时冷却与每日计数走单调时钟 + 日期字符串双轨、异常时偏保守（不生成），以便改时区/校时不会触发刷题或误锁（§11-E10）。
55. 作为玩家，我想要本机数据目录不可写时任务仍可玩但不发奖励（避免无笔记白拿奖励）、日志记录、下次写入恢复，以便磁盘故障不破坏经济也不丢我的话（§11-E11）。
56. 作为玩家，我想要两个游戏标签页同时连接时 questOffer/questSnapshot 广播、questAnswer 以先到为准（daemon 状态机只接受一次 OFFERED→ANSWERED），以便双开不产生双奖励（§11-E7）。
57. 作为后续开发者，我想要 transcript 读取只取尾部 256KB、逐行容错解析（坏行跳过、全 try/catch），以便 jsonl 格式无稳定性承诺的现实不会变成崩溃面（§11-E6）。
58. 作为玩家，我想要生成期间目标会话已结束（SessionEnd）时任务照常投放（话题仍有效）、relatedSessionId 保留，以便会话生命周期不影响思考价值（§11-E2）。

### I. 对话 UI 与作答体验

59. 作为玩家，我想要走近村民按 E 进入任务对话时游戏时间立即暂停（对话打开 = 模拟 tick 全停），以便聊工作不偷走我的游戏日（§6.1、GDD 宪法 §4.3）。
60. 作为玩家，我想要对话框是底部 640×96 面板、NPC 48px 头像在左、正文打字机效果 30 字符/s 且任意键瞬间补全，以便阅读节奏舒适且不强迫等待（§6.2）。
61. 作为玩家，我想要 decision 题四屏流程：开场白 → 问题 + 选项（↑↓ 或 1~4 选择、E 确认、每项下方灰字 tradeoff、Esc 先不聊）→ 可选补充（多行输入框，Ctrl+Enter 提交 / Tab 跳过）→ 收尾 + 奖励（「✦ 思考笔记已存好 +120g +60 XP」，复用商店金币音效与飘字），以便整个作答过程键盘可完成、奖励反馈与既有经济 UI 一致（§6.2）。
62. 作为玩家，我想要 reflection 题流程相同、第 2 屏直接是问题 + 文本框（提交需非空、Esc 先不聊），以便两类任务的心智模型统一（§6.2）。
63. 作为玩家，我想要文本输入框激活期间捕获全部键盘事件（WASD/E 不落入游戏世界），以便打字不会让角色乱跑（§6.2 实现要点）。
64. 作为玩家，我想要任务文本一律按纯文本渲染（不解析任何标记）、长度由 schema 上限兜底，以便模型输出无法注入 UI 或溢出布局（§6.2 实现要点、§11-E8）。

### J. 思考笔记

65. 作为玩家，我想要每条已回答任务落盘为一个 Markdown 文件（按回答日期分目录、以 questId 命名；YAML frontmatter 含 questId/source/kind/npcId/title/relatedSessionId/relatedCwd/contextEcho/question/options(chosen)/reward/createdAt/answeredAt，正文 = 我写的话逐字节保存），以便我的思考沉淀成可以直接翻阅、grep、引用的本机笔记（§7.1，验收 A8）。
66. 作为玩家，我想要同时向笔记索引（index.jsonl）追加一行同构 JSON（无正文、含文件相对路径），两处写入均为原子写，以便程序化检索不必扫目录（§7.1）。
67. 作为玩家，我想要笔记内容永不经任何网络通道离开本机（WS 也只回执 questId），文件权限 0600，以便笔记的隐私等级与我的工作内容一致（§7.1/§12）。
68. 作为后续开发者，我想要 M4 实现 NoteBackfill 接口的 listNotes（按 sessionId/cwd/since 过滤）与 renderNote（渲染为可注入文本块），而 injectNote 留空不实现，以便 M5 后的回填能力有现成接缝、且「自动回填」在用户逐条确认机制就绪前结构上不可能发生（§7.2）。

### K. 奖励与经济互洽

69. 作为玩家，我想要奖励按定稿表发放（AI decision 120g/60XP、AI reflection 80g/40XP、本地题库 40g/20XP、scripted 同意任务 50g/20XP；数值事实源见 ai-quests §8.1），由 daemon 查表确定并随任务下发，以便奖励来源唯一、模型与玩家输入都无法影响（§8.1）。
70. 作为玩家，我想要任务金币流上限约为日收入的 7%~12%（出厂 low 档实际 ≤12g/日）、XP 流约为农耕 XP 的 20%，以便答题永远是「捎带的谢礼」，玩法上永远不值得为刷任务停止种地（§8.2）。
71. 作为玩家，我想要本地题库奖励刻意压到 AI 任务的一半以下，以便取材自真实工作的任务保持「特别感」（§8.2）。
72. 作为玩家，我想要累计完成 5/15/30 个任务的道具奖励（种子礼包/沉思的稻草人/村民的信）在 M4 按**无道具**实现（completedCount 照常累计），道具与图鉴 id 待 M3 图鉴/装饰子系统定稿后回填，以便经济不被未定稿的内容污染（§8.1 注、GDD §9.8）。
73. 作为玩家，我想要奖励发放幂等：存档 quests 区块的 grantedQuestIds 判重，断线重连、存档导入另一台机或回档后 questReward 重放只入账一次，以便经济不可重放（§5、§11-E4，验收 A9）。
74. 作为玩家，我想要「先不聊」与长期不答的代价恒为 0（唯一的自然结果是 ≤1 槽位被占、暂不生成新任务），以便不存在任何变相惩罚（§8.1、§11-E9）。
75. 作为玩家，我想要首次完成任务时解锁成就 #19「智者」（first_quest，0 XP——quest 奖励已发）、累计写下 10 条思考笔记时解锁 #20「思考的痕迹」（notebook，+30 XP），由 M1.5 既有成就引擎与 questsCompleted / notesWritten 计数器点亮（零引擎改动，仅翻开里程碑标记），以便村民任务的里程碑进入与农事一致的成就体系（GDD §5.6）。

### L. 开源使用者与发布质量

76. 作为开源使用者，我想要 README 与游戏内同意文案都明示「AI 出题消耗你自己的 Claude 额度」，并标注 2026-06-15 起 `claude -p` 计入独立 Agent SDK 额度的计费变化，以便成本预期透明（§11-E12）。
77. 作为开源使用者，我想要没装 hooks、没有活跃会话的环境下功能优雅收缩为本地题库（或不出题），全流程零报错，以便「先玩游戏、后接工作流」的渐进采用路径成立（§9）。
78. 作为开源使用者，我想要隐私六条核对项（全程本机处理、唯一外发为用户自有 claude 通道、WS 载荷最小化、本机文件 0600、脱敏全正则单测覆盖、默认关 + 知情同意 + 总开关）作为发布自检清单逐条可验证，以便隐私承诺不是一段话而是十条断言（§12）。
79. 作为后续开发者（含 AI agent），我想要验收标准 A1~A10（总开关有效/频率铁律/脱敏/零打扰/零焦虑/降级不崩/成本护栏/笔记完整性/奖励幂等/首次同意）尽可能落为自动化测试，以便回归有红线（§14）。

## Implementation Decisions

以下决策均已在设计定稿中裁定，此处为汇编与指针；实现期任何偏差须先修订设计文档。

### 模块划分与接口

- **daemon quest 模块**（M2 daemon 内的新模块，整体受 `enabled` 总开关控制、false 时不启动）：
  - 节流器（60s tick 触发评估，T1~T7）；
  - 候选会话选择器（消费 M2 状态机的 SessionInfo 与 hook 事件携带的 transcript_path，规则见 ai-quests §3.3）；
  - transcript 读取器（尾部 256KB、容错逐行解析、字段白名单见 §4.2）；
  - 脱敏器 `sanitize()`（纯函数，规则见 §4.3，单测必备）；
  - prompt 构建器（指令骨架见 §4.4，上下文走 stdin）；
  - CLI 运行器（spawn claude -p，参数与超时契约见下；启动期 feature-detect）；
  - 任务生命周期 reducer + 原子写持久化（状态机见下）；
  - 本地题库模块（30 条数据 + 抽取器，§2.3）；
  - 成本记账与错误日志（§4.5/§10）；
  - 笔记写入器与 NoteBackfill 接口（listNotes/renderNote 实现、injectNote 留空，§7）。
- **shared 包**：Quest 的 zod schema（QuestGenSchema/QuestSchema）、NPC id 枚举、奖励常量（含 QUEST_XP_MAX）、协议新增三消息——单一事实源，daemon 与 game 只准引用（§4.6/§4.7、tech-stack §5）。
- **game 包**：NPC 实体（站桩 + idle + 气泡 + E 交互，复用 M1 面朝格交互模型）；任务本地 store；对话 UI 四屏流程（UIScene 面板 + 打字机 + DOM overlay 输入）；设置页「村民与 AI 任务」分区；clientPrefs 发送；奖励入账（经既有 grantReward 接口）与 grantedQuestIds 幂等判重；成就 #19/#20 接线（bump questsCompleted / notesWritten 计数器，谓词与奖励走 M1.5 交付的成就数据表与引擎，GDD §5.6）；日结算屏预告行（注入既有「明日预告」插槽）。
- **对 M2 的依赖面**（ai-quests §13）：会话状态机的 SessionInfo、hook 事件 transcript_path、WS 基础设施（认证/广播/重连）、headless 会话 tty 过滤。HUD 与任务**零耦合**。
- **对 M1.5 的依赖面**：成就引擎与 22 条成就数据表（PRD 02 已数据就位，本里程碑仅点亮 #19/#20）。

### 架构决策

- AI 生成走用户本机 `claude` CLI 子进程，不引 Agent SDK、不用 `--bare`（保订阅用户 keychain 认证），隔离三件套 `disableAllHooks` + `--strict-mcp-config` + tty 过滤（tech-stack §1/§4.2 裁决）。
- **M4 固定单轮**：不实现 `--resume` 多轮追问（定稿一致性声明第 2 条，M5 后实验项）。
- 调用契约（与 tech-stack §1 逐字一致，完整命令形态见 ai-quests §4.5）：`--output-format json` + `--json-schema`（z.toJSONSchema(QuestGenSchema)）+ `--max-turns 4` + `--max-budget-usd 0.20` + `--no-session-persistence` + `--allowedTools "Read"` + `--model haiku --fallback-model sonnet`；stdin ≤6,000 字符；daemon 自管 90s SIGTERM → +5s SIGKILL。
- 触发条件（load-bearing，来自 ai-quests §3.2 定稿）：

  ```
  T1 enabled == true
  T2 pendingQuests == 0                  # 全局未处理 ≤1（宪法）
  T3 now - lastAttemptAt >= max(cooldownMinutes, clientPrefs.minIntervalRealMinutes)
  T4 游戏客户端已通过 WS 认证连接
  T5 当日 AI 次数 < dailyMaxQuests 且当日成本 < dailyBudgetUsd
  T6 有候选会话 → AI 生成；无候选且 localTemplates → 本地题库（同冷却）
  T7 aiGeneration == false → 跳过 AI 路径，直接 T6 本地题库
  ```

  原 gameBusy 条件已废除（§3.2 注、tech-stack §5 同步）。
- 任务生命周期状态机（load-bearing，来自 ai-quests §5 定稿）：

  ```
  IDLE ──T1~T7──▶ GENERATING ──成功──▶ OFFERED ──questAnswer──▶ ANSWERED ──▶ ARCHIVED
                      │失败/超时/预算          │questDismiss
                      ▼                       ▼
                   FAILED（退避；连3次→本地题库模式）   DISMISSED（不写笔记、无奖励、不计失败）
  ```

  持久化原子写；重启恢复：OFFERED 重推（questSnapshot）、GENERATING 判 FAILED；游戏端以存档 grantedQuestIds 保证 questReward 幂等。
- 失败与退避：按类型计失败、schema 失败不在本次触发内重试、退避 15→30→60 分钟封顶、连续 3 次失败转本地题库模式 + 60 分钟探测恢复——全部事实源见 ai-quests §10；降级矩阵全表见 §9。
- 配置与合并语义：daemon 侧 aiQuests 配置节（键名/默认值/可配范围见 ai-quests §3.1）；游戏侧仅 quests.enabled 与 frequency('low'|'normal') 两项存 localStorage 设置（GDD §10.7）；经 `clientPrefs` 与 daemon **取较严者**生效，出厂实际 30 分钟/个（附录 A-23）；daemon 不识别 clientPrefs 时游戏侧丢弃 questOffer 兜底。设置热更新通道（WS 透传写 config vs 启动时读 + 热推送）按 §6.4 留下的两个选项实现时定。
- 隐私红线工程化：六条核对项以 ai-quests §12 为准；本机持久化（任务状态、记账、笔记）一律位于用户数据目录（~/.codestead/）、权限 0600；transcript 原文与笔记正文永不过 WS。

### Schema / 协议契约（来自设计定稿，shared 包单一事实源）

- **QuestGenSchema（模型产出）**：`{ npcId: enum[npc_carpenter|npc_grocer|npc_keeper], kind: 'decision'|'reflection', title: string(4~24), opener: string(10~120), body: string(20~400), options?: Array<{id:'a'|'b'|'c'|'d', label: string(2~60), tradeoff: string(2~80)}>(2~4), closer: string(4~80), contextEcho: string(≤120) }`，superRefine：decision 必有 options、reflection 必无（ai-quests §4.6）。
- **QuestSchema（daemon 补全）**：QuestGen 字段 + `{ questId: uuid, source: 'ai'|'local'|'scripted', relatedSessionId: string|null, relatedCwd: string|null（WS 只推 basename）, reward: { gold: int[0,120], xp: int[0,60], itemId?: string }, createdAt: ISO }`。信任边界：reward/questId/relatedSessionId 模型无权产出（§4.6）。
- **协议新增（不升 PROTOCOL_VERSION）**：daemon→game `questSnapshot{quests}` / `questOffer{quest}` / `questRevoked{questId}` / `questReward{questId, reward}`；game→daemon `questAnswer{questId, optionId?, note?}` / `questDismiss{questId}` / `clientPrefs{quests:{enabled, minIntervalRealMinutes:15|30}}`（§4.7、tech-stack §5）。
- **存档**：使用 SaveDoc v1 既有 `quests` 区块 `{grantedQuestIds[], completedCount, noteRefs[]}`（M1 已建容器），不升 schemaVersion、无迁移（GDD §10.2、ai-quests §13）。
- **笔记落盘契约**：按日期分目录的 Markdown（frontmatter 字段清单与示例见 §7.1）+ index.jsonl 追加，均原子写。

### 关键数值的出处

- 奖励表全量数值：ai-quests §8.1（互洽推导 §8.2）；XP clamp [0,60]：GDD 附录 A-5 / §5.2；gold 上限 120：QuestSchema 即奖励表最高值。
- 频率与配置默认值/范围：ai-quests §3.1；出厂 30 分钟合并语义：GDD §10.7 / 附录 A-23；宪法硬上限 15 分钟为修宪事项。
- 候选会话阈值（10 分钟新鲜度、≥2 条新 prompt、300 字符下限）：ai-quests §3.3。
- 脱敏正则七类与长度阈值（500/6,000 字符）：ai-quests §4.3。
- 超时（90s+5s）、单次预算 $0.20、--max-turns 4：tech-stack §1 / ai-quests §4.5。
- 退避序列与失败阈值：ai-quests §10。
- 对话 UI 规格（640×96 面板、打字机 30 字符/s、气泡 8×8）：ai-quests §6。
- 本地题库 30 条题面与亲和标签：ai-quests §2.3。
- 边界情况 E1~E13 处理：ai-quests §11。

## Testing Decisions

总原则：**只测外部行为，不测实现细节**——断言「WS 上出现/不出现什么消息」「文件系统里出现什么内容」「子进程被以什么参数调用、何时被杀」，不断言内部字段与私有函数。任务文案质量不做断言（不可测），只测契约（schema 形状、长度上限、脱敏不变量）。

本里程碑用到的接缝（引用 tech-stack 裁决的全项目接缝策略）：

- **接缝 e：stub claude 可执行（本里程碑的最高接缝）**。测试时向 CLI 运行器注入假的 `claude` 可执行（PATH 注入或可执行路径注入），脚本化产出：合法 structured_output / 缺字段输出 / 非 JSON 乱码 / 非零退出 / 模拟预算拒绝 / 挂起不退出。理由：不触网、零成本、完全确定；超时分支（SIGTERM→SIGKILL）通过注入缩短的超时配置真实验证信号序列。覆盖验收 A6（故障注入 ×3 → 不崩溃、自动转本地题库、60 分钟探测自愈）与 A7（命令行含 --max-budget-usd ≤0.20、记账逐笔、预算耗尽后 0 次新调用）。
- **接缝 c：daemon 纯函数 reducer + fixture 回放**。① 任务生命周期 reducer 表驱动测试（全部合法迁移 + 非法迁移拒绝，如二次 ANSWERED）；② 触发评估器作为纯判定（注入时钟/配置/会话表/pending），用合成事件流回放验证 A2 性质：任意输入序列下相邻生成尝试间隔 ≥ 生效 cooldown、pending 恒 ≤1、失败尝试计入冷却、时钟回拨偏保守（E10）；③ `sanitize()` 纯函数：含七类伪造秘钥的 transcript fixture 断言脱敏产物 0 命中、$HOME 0 出现、长度阈值与控制字符剥离成立（验收 A3）；④ transcript 解析器对坏行/超大文件 fixture 容错（E6）。理由：频率铁律与脱敏是本里程碑的两条红线，必须脱离真实时钟与真实文件系统可重复验证。
- **接缝 b：shared 包 zod schema 编解码测试**。QuestGenSchema/QuestSchema 的合法/非法 fixture（decision 无 options、reflection 带 options、长度越界、reward 越界、未知 npcId 一律拒绝）；三条新协议消息的编解码往返；`z.toJSONSchema(QuestGenSchema)` 输出快照测试，防 schema 漂移悄悄改变喂给 --json-schema 的契约。
- **接缝 d：daemon WS 集成测试**。本地起 daemon（接 stub claude）+ 伪造 hook HTTP 事件制造候选会话 → 真实 WS 客户端断言：questOffer 形状合法；重连收到 questSnapshot（0 或 1 个）；questDismiss 后状态迁移且不再重推；questAnswer 后 questReward 下发且笔记/索引落盘（A8：frontmatter 过 zod 校验、正文与提交逐字节一致）；`enabled=false` 时以 spawn 间谍断言全程 0 次 claude 调用、0 条 quest 消息（A1）；未同意前 0 次 AI 调用且首个任务必为 scripted（A10）；同一 questId 重放 questReward 幂等（A9 daemon 侧）。
- **接缝 a：sim 纯函数层 headless 测试**。游戏端奖励入账走 sim：grantedQuestIds 判重的幂等性（同一 questId 重复入账金币/XP 只记一次，A9 game 侧）；reward 越界载荷被 safeParse 拒绝（双防线第二道）。理由：经济不可重放是跨子系统不变量，必须在零 Phaser 环境下可推演。
- **接缝 f：游戏壳层 Playwright 冒烟**。按设计定稿，A4（零打扰：任务到达瞬间输入焦点/镜头/时间流速无变化）的自动化冒烟列为 M5；M4 以单元级替代验证（quest store 接收 offer 不触碰时间系统暂停源、不发起任何 UI 栈迁移）+ 手动验收清单覆盖。

不测的东西及理由：prompt 文案与 NPC 语气（主观质量，无稳定断言面）；真实 claude 调用（成本与不确定性，feature-detect 的真实路径由手动验收覆盖）；Phaser 渲染细节（全项目纪律：渲染层不写单测）。

## Out of Scope

依据 game-design §0.4 M4 边界（In：headless 生成管线 ≤$0.20/次、村民 3 名、decision/reflection、思考笔记落盘、游戏内奖励、总开关）与 ai-quests 定稿裁决，以下明确不做：

- **任何强制弹窗、抢焦点、镜头移动、自动暂停式的任务通知**——永久禁止，不属于任何里程碑（§0.4 M4 Out、ai-quests §3.5）。
- **任何上传/遥测/服务器**——永久 Out（§0.4 M5 Out、ai-quests §12）。
- **笔记自动回填会话（injectNote）**——M4 仅留 NoteBackfill 接口（listNotes/renderNote），自动回填推迟到 M5 后，且前置条件为用户逐条确认（ai-quests §7.2）。
- **notes CLI（codestead notes list/show/open）**——推迟到 M5，与 npx 安装体验一并打磨（§7.2）。
- **--resume 多轮追问（NPC 对答案追问一轮）**——定稿裁决 M4 单轮；M5 后实验开关待定（定稿一致性声明第 2 条、§15-2）。
- **道具与图鉴奖励的实际发放**（种子礼包/沉思的稻草人/村民的信）——待 M3 图鉴/装饰子系统定稿后确认 id 与形态，M4 按无道具实现、仅累计 completedCount（§8.1、GDD §9.8）。
- **第 4/5 名 NPC**（邮婆/小铃）——不在 M1~M5，启用需修宪（§1.2）。
- **NPC 寻路与日程**——明确 Out，M4 只做站桩 + 2 帧 idle（§1.3）。
- **prompt 与本地题库的 i18n / 英文 UI**——M5 开源发布时再定方案（§15-3）。
- **A4 零打扰的 Playwright 自动化冒烟**——M5（§14-A4、tech-stack §1 测试行）。
- **任务与会话 HUD 的任何耦合**（任务指示进 HUD、HUD 显示任务数等）——永不（§13）。
- **出题频率高于 15 分钟/个的任何档位**——宪法硬上限，调低属修宪事项（§3.1）。

## Further Notes

- **素材许可红线**：NPC 精灵与气泡图标必须取自 CC0 体系（Kenney Roguelike Characters 基底），逐文件登记资产 manifest；做的是星露谷「风格」，绝不能使用星露谷本体素材；具体 tile 坐标落地时由资产管线核对（ai-quests §1.3、GDD §11.1）。
- **隐私六条核对项作为出厂自检**（ai-quests §12）：① transcript 读取/脱敏/摘要全在 daemon 进程内；② 唯一外发 = 用户自有 claude CLI → Anthropic API，零新增端点；③ WS 载荷最小化（relatedCwd 仅 basename、笔记正文不出）；④ 本机文件 0600；⑤ 脱敏正则全量单测；⑥ aiGeneration 默认关 + 知情同意 + 总开关（enabled=false → 0 生成 0 消息 0 调用）。建议与验收 A1/A3/A10 一起做成 CI 红线。
- **计费变化风险**：2026-06-15 起 `claude -p` 计入独立 Agent SDK 额度（E12）——同意文案、README、设置页预算显示三处都要明示；本 PRD 交付时该日期已过，文案按「现行计费」表述即可，不要写成「即将」。
- **CLI flag 漂移风险**：headless 参数基于 tech-stack 调研版本；启动 feature-detect 是唯一防线，缺 flag 一律整体降级而非带病调用（tech-stack 风险 #4）。
- **jsonl 无稳定性承诺**：transcript 解析必须全程容错（tech-stack 风险 #6、ai-quests §11-E6），解析失败的最坏结果只能是「这次不出题」。
- **文档间已知差异（以 ai-quests 定稿为准）**：GDD §9.2 写本地题库「首发 12 条、抽完重置」，ai-quests §2.3 定稿为 **30 条（三人各 10）、耗尽后不重置（村民回纯闲聊 + 设置页提示）**——ai-quests 是该子系统定稿且版本更新，按 30 条/不重置实现；建议顺手回修 GDD §9.2 消除差异。
- **遗留开放问题**（不阻塞实现，见 ai-quests §15）：NPC 最终定名与具体立绘 tile（实现期与项目所有者确认）；设置热更新通道二选一（§6.4）；「村民的信」的图鉴定位（待 M3 收集图鉴定稿）。
- **与 M3（PRD 04）的关系**：M4 在路线图上后于 M3，但功能上不硬依赖 M3——道具奖励已裁决推迟、XP 进入既有等级体系即可；若 M3 延期，M4 可在 M1.5 与 M2 完成后独立实施（成就 #19/#20 依赖 M1.5 的成就引擎）。
