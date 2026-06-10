---
title: M2 会话 HUD 与 daemon
milestone: M2
status: ready-for-agent
depends_on:
  - 00-m0-scaffold.md
  - 01-m1-core-farm-loop.md
design_refs:
  - hud-sessions.md 全文（范围 §1；信息架构 §2；视觉 §3；布局 §4；多会话 §5；克制提示 §6；状态机 §7；客户端状态机 §8；设置 §9；协议 §10；边界 §11；依赖 §12；验收 §13；开放问题 §14）
  - tech-stack.md §1（会话检测/WS/共享协议/CI 裁决行）、§3（monorepo 与 daemon 模块划分）、§4.1（会话状态数据流与安装器三条硬约束）、§5（WS 协议草案与演进规则）、§6 风险 #2/#3/#6/#7/#13、§9-3（M2 开工第一件事）
  - game-design.md §0.4（M2 边界）、§0.5 红线 4、§6.6（左上预留区 A-9）、§6.8（H 键）、§7（会话 HUD 合稿）、§11.1/§11.2/§11.3（CODE-28 / Fusion Pixel / 许可白名单）、§12（协议契约行）、附录 A-8/A-9/A-21
---

# 03 — M2 会话 HUD 与 daemon

## Problem Statement

Codestead 的核心承诺是「等 AI 干活时，你在一个连贯的游戏世界里劳作，同时不失去对工作的感知」。M1 交付后，游戏本身成立了，但它还是一个纯单机农场：玩家一旦进入游戏，就彻底看不见自己那几个 Claude Code 会话的死活——哪个还在跑、哪个已经停下来等输入、哪个早就干完了没人看。结果只能反复切屏去翻终端，注意力被来回切换撕碎，这恰恰是本项目要消灭的状态。

对玩家（等待 AI 的程序员）来说，问题是三件事：

1. **看不见**：游戏里没有任何会话状态信息，「到点就能回去」无从谈起；
2. **不可信**：即使做了展示，若状态来源不可靠（Esc 中断不触发 Stop、kill -9 留幽灵会话、卡在 working 不降级），一块会骗人的面板比没有更糟；
3. **怕被打扰**：玩家最怕的是监控功能反客为主——弹窗、强制暂停、绑奖励。HUD 一旦越界，游戏第一的原则就破产了。

对开源使用者来说，还有第四件事：**怕被动手脚**。一个会往 `~/.claude/settings.json` 写 hooks、在本机开 WebSocket 端口的守护进程，必须把「写了什么、怎么卸载、谁能连上、数据去哪了」全部交代清楚，否则没人敢装。

## Solution

交付一条完整的「会话状态感知链路」，三个部分：

1. **本地守护进程（daemon）**：常驻 Node 进程，只绑 `127.0.0.1`，通过三类信号源感知本机 Claude Code 会话——hooks HTTP 事件（语义主路）、transcript 文件监视（Esc 中断盲区兜底）、ps 进程轮询（发现与收尸，M2 末）——经一个纯函数 reducer 状态机仲裁出每个会话的四态（working / blocked / done / idle，外加 unknown 展示态），再经 WebSocket 推送给游戏。daemon 对 Claude Code「只听不说」：收到 hook 永远回空 2xx，绝不返回任何决策字段。
2. **hooks 安装器**：`codestead install` 一条命令幂等接入，先备份 `settings.json`、自身条目带命名空间标记、与用户已有 hooks 追加并存；`codestead uninstall` 只删带标记条目。零配置可用、可干净退出。
3. **游戏左上角 HUD 面板**：一块「安静的告示牌」——每行 `[状态图标] [显示名] [已持续时长]`，blocked 永远排最上、用全游戏唯一的持续呼吸动效表达「等你」；支持折叠/展开/隐藏（H 键）、悬停详情、断连/过期/版本不匹配等连接态；6 项首版设置（含隐私 streamerMode 与标签页 tabBadge）。HUD 只读不写：任何会话状态都不驱动任何游戏状态，没装 daemon 的玩家在画面上找不到它的任何痕迹。

按 hud-sessions §7 分期注记实施：**M2 首版收敛为两源**（hooks + transcript），ps 轮询、unknown 态展示、kill -9 收尸与 4 个推迟设置项放在 **M2 末**补齐；**M2 开工第一件事是 hook 事件录制器**，真实事件流落盘为 fixture，成为状态机回放测试的资产（tech-stack §9-3、风险 #2）。

## User Stories

### A. 会话感知（玩家：等待 AI 的程序员）

1. 作为玩家，我想要在游戏左上角看到本机所有 Claude Code 会话的实时列表，以便不切屏、不翻终端就知道每个 agent 在干嘛。
2. 作为玩家，我想要每个会话以「状态图标 + 显示名 + 已持续时长」一行展示，并用颜色与形状双编码区分五态（核心四态 + unknown），以便扫一眼（包括色盲模式下）就能分辨谁在工作、谁在等我。
3. 作为玩家，我想要会话显示名按 `title → cwd basename → tty → sessionId 前 8 位` 回退链取值、超宽截断、同名时追加父目录名消歧，以便多会话并行时每行都能认得出来（hud-sessions §2.1）。
4. 作为玩家，我想要时长用粗粒度格式（刚刚 / 12m / 1h23m / 12h / 2d）每 5 秒才刷新一次，以便知道「等了多久」而不被秒针制造焦虑（hud-sessions §2.3）。
5. 作为玩家，我想要 blocked（等待输入）的会话永远排在最上、且等我最久的排第一，以便回工作时第一眼就是最该处理的那个（hud-sessions §5.1）。
6. 作为玩家，我想要 blocked 行的图标以 2000ms 周期、4 档阶梯做慢呼吸——全面板唯一的持续动效，以便余光能感知「有会话在等我」而不被闪烁骚扰（hud-sessions §3.1）。
7. 作为玩家，我想要会话进入 blocked 或 done 时该行背景做一次 600ms 微高亮（同一会话 8 秒冷却），以便状态变化「可见但不打扰」（hud-sessions §6.1）。
8. 作为玩家，我想要 API 出错的会话（StopFailure）显示 ⚠ 图标和平静的中文文案（如「API 错误：限流（rate_limit），稍后会自动恢复」），以便知道发生了什么而不被吓到（hud-sessions §2.4）。
9. 作为玩家，我想要悬停某行 250ms 后看到 tooltip：完整标题、工作目录、最近输入、状态行（「等待输入 · 14:32 起（12 分钟）」）、信号源，以便需要时获得细节、不需要时保持安静（hud-sessions §2.2）。
10. 作为玩家，我想要 working 行用 4 帧 spinner（约 3fps）低调转动、done 显示 ✓、idle 显示 ○ 全静态，以便注意力梯度严格是 blocked > done > working > idle（hud-sessions §3.1）。
11. 作为玩家（M2 末），我想要没装 hooks、仅被进程发现的会话显示为灰色 `?` 的 unknown 态、时长为 `—`、tooltip 给出安装指引，以便知道「我们看见它，但不确定它在干嘛」而非假装精确。
12. 作为玩家（M2 末），我想要 `source = process` 的低置信会话用描边（hollow）图标修饰，以便分清「确证的状态」与「推测的状态」。

### B. 状态语义正确（玩家）

13. 作为玩家，我想要在终端提交 prompt 后 1 秒内（p95，含 daemon 转发）看到该会话变为 working，以便相信这块面板是实时的（hud-sessions §13-1）。
14. 作为玩家，我想要会话请求权限或等待我输入时变为 blocked，以便「该回去了」这个信号绝不漏报（hud-sessions §7.3）。
15. 作为玩家，我想要会话一轮工作完成（Stop / idle 提示）后变为 done，且我回到该对话提交新输入时 done 自动消解，以便「已完成未查看」语义准确——看过的不再提醒。
16. 作为玩家，我想要在终端按 Esc 中断 AI 后，HUD 不把该会话永远卡在 working——transcript 静默 90 秒且无 blocked 信号即降为 done，以便面板不骗人（hud-sessions §7.2-③，Esc 不触发 Stop 的盲区兜底）。
17. 作为玩家，我想要 done 持续 30 分钟没人理后自动降级为 idle（daemon 侧定时降级，HUD 只跟随），以便面板长期挂机后仍然反映真实的注意力优先级（hud-sessions §7.2-⑦）。
18. 作为玩家，我想要正常退出的会话（SessionEnd）立即从面板摘行，以便列表不积累尸体。
19. 作为玩家（M2 末），我想要被 kill -9 的会话由 ps 轮询收尸摘牌；在此之前的过渡期，幽灵会话按「idle 持续 ≥12 小时」近似摘牌，以便任何阶段都不会有永久幽灵行（hud-sessions §7 分期注记）。
20. 作为玩家，我想要会话自动压缩（SessionStart(compact)）期间保持 working 而不闪成 idle，以便长任务执行中状态不抖动。
21. 作为玩家，我想要工具调用心跳（Pre/PostToolUse 等）只刷新信号时间、不重置「进入当前状态的时刻」，以便「已工作 47m」不会被心跳清零（hud-sessions §7.4-2 迁移幂等）。
22. 作为玩家，我想要 working↔done 秒级抖动在显示层做 10 秒合并窗口取稳定值、时长文本刷新绝不触发行重排，以便面板不上蹿下跳（hud-sessions §5.3）。

### C. 面板操控与设置（玩家）

23. 作为玩家，我想要按 H 键在 展开 → 折叠 → 隐藏 三态间循环，且隐藏态零逐帧逻辑零绘制，以便随时把面板收起来、不付任何性能代价（hud-sessions §9）。
24. 作为玩家，我想要折叠态只显示一行计数 chips（如 `!2 ✓1 ◐3`，仅非零状态组、顺序固定），以便用 14px 高度保留最低限度的感知（hud-sessions §4.2）。
25. 作为玩家，我想要超过 maxRows（默认 5，可调 3/5/7/9）的会话折进 `+N 个会话` 溢出行，悬停可看被折叠清单（最多 12 条），以便十几个会话也不会把屏幕占满（hud-sessions §5.2）。
26. 作为玩家，我想要 blocked 会话永不被折进溢出行（必要时面板临时扩行，硬上限 9 行 / 146px），以便「在等我的」一个都不会被藏起来。
27. 作为玩家，我想要调节面板不透明度（0.6/0.8/1.0），以便按自己的视觉偏好平衡面板与游戏世界。
28. 作为玩家，我想要角色走到面板下方时面板自动淡到 alpha 0.25、离开后恢复，且面板区域吞掉鼠标点击，以便面板不挡操作、也不会隔着面板误锄地（hud-sessions §3.2、§11-16；首版行为固定开启，开关 M2 末暴露）。
29. 作为玩家，我想要提示音默认关闭，开启后也只对 →blocked / →done 触发、音量 40%、单声 ≤200ms、全局 20 秒冷却，以便声音永远是我主动要的（hud-sessions §3.4）。
30. 作为玩家，我想要切到别的标签页干活时，存在 blocked 会话则浏览器标签标题加 `● ` 前缀（tabBadge，默认开、一键可关、纯文本、不用 Notification API），以便不盯着游戏也知道「有会话在等我」（hud-sessions §6.1）。
31. 作为玩家，我想要开启 streamerMode 后 tooltip 不再显示工作目录与最近输入，以便直播或共享屏幕时不泄露工作内容（hud-sessions §2.2 隐私注意）。
32. 作为玩家，我想要 HUD 的 6 项首版设置（displayMode / maxRows / opacity / sound / tabBadge / streamerMode）在 Esc 菜单 → 设置 → 会话面板中修改并持久化到 localStorage，损坏即静默重置默认，且永不进入农场存档与 JSON 导出，以便机器偏好与游戏进度互不污染（hud-sessions §9）。
33. 作为玩家，我想要日结算屏中看到平静的「会话一行」（`会话 · ◐ 工作中 2 ｜ ! 等待输入 1 ｜ ✓ 已完成 1`），断连或 0 会话时整行省略、期间左上面板隐藏，以便睡前结算时顺带瞥一眼工作，而不被重复信息打扰（hud-sessions §4.6）。
34. 作为玩家，我想要 0 个会话时只显示一条安静的「○ 暂无会话」小条，以便面板有明确的空态而不是诡异地消失。

### D. 连接与健壮性（玩家）

35. 作为玩家，我想要 daemon 被 kill 后 5 秒内面板变成「会话服务已断开 · 重试中」小条、会话列表清空（绝不展示陈旧的 working 骗人），且游戏帧率、输入、存档完全不受影响，以便 HUD 的故障永远不传染给游戏（hud-sessions §8.1、§13-3）。
36. 作为玩家，我想要客户端按指数退避（1s 起、cap 30s、±20% 抖动、连败 10 次后 60s）自动重连，daemon 重启后 10 秒内恢复并全量同步，以便我从不需要手动「重连」（hud-sessions §8.1）。
37. 作为玩家，我想要重连成功后用新 snapshot 整体替换本地表、但保留各会话的高亮/声音冷却时间戳，以便 daemon 重启不会触发满屏高亮风暴（hud-sessions §8.1 补充规则）。
38. 作为玩家，我想要 75 秒（3 个心跳周期）收不到任何消息时面板进入 STALE：保留数据、降 60% alpha、追加「数据可能过期」小字，以便 daemon 僵死（进程在、不发消息）时我不被过期数据误导（hud-sessions §8.1、§10.3-P1）。
39. 作为玩家，我想要协议版本不匹配时显示「守护进程需要更新」小条并 5 分钟慢重试，设置页能看到双方版本号，以便升级不同步时有明确出路而非静默坏掉。
40. 作为玩家，我想要从未成功连接过 daemon 时画面上找不到 HUD 的任何痕迹（everConnected 门控，设置页除外——那里始终有连接状态与安装指引），以便纯单机玩家看不到一块「坏掉的」面板（hud-sessions §8.2）。
41. 作为玩家，我想要装好并启动 daemon 后无需刷新页面、面板经探测重试自动出现，以便接入是零仪式的（hud-sessions §13-8）。
42. 作为玩家，我想要游戏端按 43110–43119 顺序探测 `GET /handshake` 来发现 daemon 的端口与 token，以便 43110 被其他程序占用时一切照常工作（hud-sessions §10.3-P2；tech-stack 风险 #13）。
43. 作为玩家，我想要 tab 隐藏期间 HUD store 照常接收更新、动效渲染暂停、恢复可见时重算时长并对当前 blocked 行只补一次高亮，以便后台不浪费资源、回来时信息是新的（hud-sessions §8.3、§11-15）。
44. 作为玩家，我想要 12 个并发会话、状态每秒翻转的极端流量下 HUD 每帧耗时 ≤2ms、面板高度不超 146px、行序不违反防跳动纪律，以便重度多会话场景下游戏依旧丝滑（hud-sessions §13-4）。

### E. 不被打扰的承诺（玩家）

45. 作为玩家，我想要 HUD 在任何情况下都不弹模态、不弹 toast、不全屏变色、不震屏、不动相机、不抢键盘焦点、不强制暂停，以便玩的时候永远是我决定何时抬眼（hud-sessions §6.2 反模式清单，违者打回）。
46. 作为玩家，我想要会话状态与游戏经济/XP/解锁零绑定（包括「切回工作给奖励」这种反向绑定），也没有任何 NPC 播报会话状态，以便世界与工作之间只有左上角这一扇窗。
47. 作为玩家，我想要所有文案是平静陈述（「等待输入」而非「快去看看！」），时长只陈述不评价，以便 HUD 是告示牌而不是闹钟。

### F. 安装、隐私与信任（开源使用者）

48. 作为开源使用者，我想要 `codestead install` 一条命令完成 hooks 接入：写入前先把 `~/.claude/settings.json` 备份为 `settings.json.codestead-bak`，重复执行幂等，以便我的配置永远有回退路径（tech-stack §4.1-1 硬约束①）。
49. 作为开源使用者，我想要 codestead 写入的每条 hook 都带唯一命名空间标记，`codestead uninstall` 只删带标记条目、绝不动我其它 hook，以便卸载是干净且无副作用的（硬约束②）。
50. 作为开源使用者，我想要同一事件上已有我自己的 hook 时 codestead 追加并存而非替换，以便我的工作流不被覆盖（硬约束③）。
51. 作为开源使用者，我想要 README 明示「会向 settings.json 添加哪些事件、如何卸载」，以便装之前就知道它对我的环境做了什么。
52. 作为开源使用者，我想要 daemon 只绑 `127.0.0.1`、校验 Origin、WebSocket 首条消息验本地 token，以便本机其他网页无法连上来读我的会话信息（tech-stack §4.1-5、风险 #7）。
53. 作为开源使用者，我想要 transcript 内容永不通过 WebSocket 传输、永不出本机、永不上传任何服务器，HUD 展示的标题级信息也永不落日志，以便工作内容的隐私有硬边界（tech-stack §4.1-4「载荷最小化」；hud-sessions §2.2）。
54. 作为开源使用者，我想要 daemon 收到 hook 永远回空 2xx、不返回任何决策字段（只听不说），以便确信这套监控绝不会改变 Claude Code 的任何行为（tech-stack §4.1-1）。
55. 作为开源使用者，我想要不装 daemon 时游戏是 100% 完整的单机农场，装与不装、何时卸载完全自由，以便监控永远是可选增强而非依赖。

### G. 工程与可维护性（后续开发者，含 AI agent）

56. 作为后续开发者，我想要 M2 开工第一件事是 hook 事件录制器——把真实多会话的 hook 事件流原样落盘为 fixture，以便状态机映射表被「真实数据回放测试」守护，hooks 语义随 Claude Code 版本漂移时第一时间被测试捕获（tech-stack §9-3、风险 #2）。
57. 作为后续开发者，我想要会话状态机是手写纯函数 reducer `(state, signal) => state`、配合每会话 `lastSignalAt` 过期校验，以便用表驱动测试逐条覆盖 hud-sessions §7.3 的 14 行转移总表，不需要起任何进程。
58. 作为后续开发者，我想要 WS 协议的全部消息、四态枚举、SessionInfo 在 shared 包用 zod 定义为单一事实源，TS 类型经 `z.infer` 导出，双端入站一律 `safeParse`，以便协议契约同时是类型、校验与测试资产（tech-stack §1 共享协议行、§5）。
59. 作为后续开发者，我想要协议演进遵守「加字段向后兼容不升版本、破坏性变更才升 PROTOCOL_VERSION」，HUD 对未识别 state 按 unknown 渲染，以便 daemon 与游戏可以不同步升级（tech-stack §5 演进规则；hud-sessions §10.2）。
60. 作为后续开发者，我想要五态状态色 token 落 shared 包（CODE-28 色值），HUD 与游戏 UI 同源引用、禁裸 hex，以便换色只动一处（game-design §7.3、附录 A-8）。
61. 作为后续开发者，我想要 HUD store 对 sim store 零 import 且由 ESLint `no-restricted-imports` 静态看护，以便「HUD 与经济零绑定」是被工具保证的架构事实而非口头纪律（hud-sessions §13-5）。
62. 作为后续开发者，我想要客户端连接状态机（CONNECTING/HANDSHAKING/LIVE/STALE/BACKOFF/INCOMPATIBLE）也是纯 reducer、可表驱动测试，以便重连/降级/版本不匹配逻辑无需真实网络即可验证（hud-sessions §8.1）。
63. 作为后续开发者，我想要 ps 信号源（M2 末）自带 tty 规则过滤 headless 进程、并与启动参数标记构成双重过滤，以便 M4 的关卡生成会话从架构上就不可能混入 HUD（hud-sessions §12-D2-A4；tech-stack §4.2-6）。
64. 作为后续开发者，我想要 CI 矩阵自 daemon 代码落地起加入 macOS 与 Node 24（与事件录制器同步），以便 ps/tty/路径这些平台敏感行为在两个平台上都被持续验证（tech-stack §1 CI 行、风险 #12）。
65. 作为后续开发者（含 AI agent），我想要 M2 首版与 M2 末的边界在代码与验收中显式标注（首版两源 + 6 项设置；ps/unknown/收尸/4 项设置在 M2 末），以便接手任何一段都知道哪些行为是「暂按默认值固定」而非缺陷（hud-sessions §7 分期注记、§9 实施分期、§13 验收拆分）。
66. 作为后续开发者，我想要 daemon 重启后扫 transcript 目录 mtime 重建会话表并全量推送 snapshot，以便 daemon 升级/崩溃重启对玩家近似无感（hud-sessions §7.4-4）。

## Implementation Decisions

以下决策均已在设计定稿中裁定，此处汇总并给出事实源；实现期任何偏差须先修订对应设计文档。

### 1. 模块划分与职责边界

- **daemon 包**（计划发布 npm，CLI 名 `codestead`）：HTTP + WS 服务（单端口：POST hooks 接收 + WS upgrade）、会话状态机（纯函数 reducer + 三源仲裁 + staleness）、信号源（hooks 接收 / transcript fs.watch / ps 轮询）、hooks 安装器、CLI（start / install / uninstall）、回放 fixture 测试资产。模块划分按 tech-stack §3。
- **shared 包**：WS 协议 envelope 与消息 schema、会话状态枚举与 SessionInfo、五态色 token（CODE-28）。zod v4 单一事实源（tech-stack §1）。
- **game 包**：HUD 独立 store（与农场经济完全隔离）+ WS 客户端（浏览器原生 WebSocket + 自写指数退避重连，约 30 行）。HUD 渲染贴 UIScene；store 不依赖 Phaser，可单独测试。
- **分层纪律**：HUD store 禁 import sim；sim 禁 import phaser——均由 ESLint `no-restricted-imports` 强制（tech-stack §1 状态管理行、§6 风险 #10）。

### 2. 会话四态状态机（语义定稿 = hud-sessions §7，内联其 load-bearing 骨架）

- 状态集合：核心四态 `working / blocked / done / idle`（仅 hooks / transcript 驱动迁移）+ 展示态 `unknown`（仅 ps 发现、不参与四态转移）+ 生命周期伪态（未注册 / 注销，不上面板）。
- 转移总表共 **14 行**（事件为行的权威定义，hud-sessions §7.3，daemon 实现与 HUD 文案共同遵守），骨架：`SessionStart(startup/resume/clear)→idle`、`SessionStart(compact)→working`、`UserPromptSubmit→working（消解 done）`、`Pre/PostToolUse(Failure)→working（心跳）`、`PermissionRequest ∪ Notification(permission_prompt)→blocked`、`Stop ∪ Notification(idle_prompt)→done`、`StopFailure→blocked(+error.kind)`、`SessionEnd→注销`、`transcript 追加→working（仅 hooks 缺失/过期时）`、`transcript 静默 ≥90s 且无 blocked→done`、`done 持续 30min→idle`、`ps 发现无 hook 进程→unknown`、`unknown 首个 hook→按其语义并入四态`、`进程消失→注销`。
- 仲裁与过期四规则（hud-sessions §7.4）：信号源优先级 hooks > transcript > ps，低优先级仅在高优先级缺失/过期时修正；迁移幂等（同态重复事件只刷新 `lastSignalAt`、不重置 `since`）；全状态过期纪律（working 静默降 done、done 超时降 idle、blocked 合法长寿）；daemon 重启扫 transcript mtime 重建 + snapshot 全量推送。
- HUD 完全信任服务端状态，客户端不做任何语义迁移，只做显示层抖动合并（hud-sessions §8.3）。

### 3. WS 协议契约（定稿 = tech-stack §5 与 hud-sessions §10，完全一致；以下形状内联自设计定稿）

- envelope：`{ v: 1, type, payload }`，JSON 文本帧；`PROTOCOL_VERSION = 1` 随 `hello` 握手。
- M2 消息集（quest* 归 M4）：game→daemon `auth { token }`（连接后首条）；daemon→game `hello { protocol, daemonVersion }`、`snapshot { sessions }`、`sessionUpsert { session }`、`sessionRemoved { sessionId }`、`heartbeat { at }`（每 25s 一条；客户端 75s 未收任何消息 → STALE）。
- `SessionInfo`（来自 tech-stack §5）：`{ sessionId; title: string|null; subtitle: string|null; cwd; state: 'working'|'blocked'|'done'|'idle'|'unknown'; since: ISO8601; lastSignalAt: ISO8601; source: 'hooks'|'transcript'|'process'; error?: { kind } }`。字段→UI 映射逐项按 hud-sessions §10.2。
- 端点发现（WS 之外唯一 HTTP 契约）：`GET http://127.0.0.1:43110/handshake → { port, wsPath, token, daemonVersion }`，游戏端按 **43110–43119** 顺序探测；`~/.codestead/daemon.json` 仅供 CLI 与本机工具（浏览器读不到本机文件，裁决记录 hud-sessions §10.4-2）。CORS 仅放行开发期 Vite origin。
- 安全三件套：只绑 `127.0.0.1` + Origin 校验 + 首条 `auth` 本地 token（tech-stack §4.1-5）。
- 演进规则：加字段向后兼容不升版本（heartbeat 即按此增补转正）；未识别 state 按 unknown 渲染（向前兼容）。
- 渐进回退（daemon 心跳/握手未落地前的过渡行为）：无 heartbeat = 不进 STALE；握手不可用 = 按 43110 固定口直连（hud-sessions §10.3）。

### 4. hooks 安装器（tech-stack §4.1-1）

- 安装事件集（最小集）：`SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd`，全部 HTTP 型指向 daemon hooks 端点，timeout 3s。
- 三条硬约束：① 首次写入前备份 `settings.json.codestead-bak`；② 自身条目带 codestead 命名空间标记，卸载只删带标记条目；③ 同事件已有用户 hook 时追加并存。
- daemon 对 hook 请求永远回空 2xx、不返回任何决策字段——「感知不干预」的工程化。

### 5. 游戏端 HUD

- 面板与视觉规格（锚点 (4,4)、宽 152px、行高 14px、高度公式与 146px 硬上限、背景/边框/高亮/自动淡出参数）：事实源 hud-sessions §3.2 / game-design §7.4；预留矩形 (4,4)–(156,150) 为对布局子系统的既定契约（附录 A-9）。
- 五态视觉（颜色 + 形状双编码、blocked 2000ms 4 档呼吸为唯一持续动效、working 4 帧 3fps spinner、其余静态）：事实源 hud-sessions §3.1 / game-design §7.3 / 附录 A-8；色值经 shared 包 theme token（CODE-28）引用，禁裸 hex。
- 排序（stateRank → since 升序 → sessionId）、溢出（+N 行、blocked 永不折叠）、防跳动（仅四类事件重排、10s 抖动合并）：事实源 hud-sessions §5。
- 客户端连接状态机（CONNECTING / HANDSHAKING / LIVE / STALE / BACKOFF / INCOMPATIBLE，含退避参数与各态面板表现）：事实源 hud-sessions §8.1，纯 reducer 实现。snapshot 前的 upsert 一律丢弃；重连后保留高亮/声音冷却表。
- everConnected 门控：localStorage 布尔，首次 HELLO_OK 置 true；此前连接失败全程静默（hud-sessions §8.2）。
- 设置：localStorage key `codestead.hud.v1`（zod 校验，损坏重置默认），**不进存档 schema**（附录 A-21）。M2 首版仅暴露 6 项：`displayMode / maxRows / opacity / sound / tabBadge / streamerMode`；取值与默认值表见 hud-sessions §9。H 键循环显示三态（键位入 game-design §6.8 总表）。
- 克制提示上限与反模式清单：事实源 hud-sessions §6（反模式 7 条永久禁止，作为 code review 否决项）。
- 日结算屏「会话一行」：HUD store 提供五态计数，渲染归 day-cycle 子系统；格式与省略规则按 hud-sessions §4.6。
- 字体与图标：Fusion Pixel 12px（OFL-1.1）CJK 全字库 + 8×8 状态图标 7 枚（自绘 CC0），入 manifest 许可追溯（hud-sessions §3.3、§12-D5；game-design §11.1/§11.3）。

### 6. M2 实施分期（hud-sessions §7 分期注记、§9、§13；不得私自合并）

- **第一件事**：hook 事件录制器——fixture 即测试资产（tech-stack §9-3）。
- **M2 首版**：两源收敛（hooks 语义主路 + transcript fs.watch 兜底）；核心四态全语义；6 项设置；过渡期幽灵会话按「idle ≥12 小时摘牌」近似收尸；验收按 hud-sessions §13「M2 首版」9 条。
- **M2 末**：ps 轮询（2s，自行 spawn `ps -axo`，含 tty 过滤 headless；不用 ps-list，tech-stack §1 会话检测行）；unknown 态展示与安装指引；kill -9 收尸（替换 idle≥12h 近似）；4 项推迟设置（showIdle / showUnknown / autoFade / soundInBackground）暴露；验收按 §13「M2 末补验」3 条。
- **CI**：daemon 代码落地起，矩阵加入 macOS 与 Node 24（tech-stack §1 CI 行）。

### 7. 关键数值出处索引（不复制全表）

- 时长格式分段与 5s 刷新 → hud-sessions §2.3；error.kind 文案映射 → §2.4；五态色值/动效参数 → §3.1；面板几何全表 → §3.2；提示音参数 → §3.4；排序/溢出/防跳动参数 → §5；高亮 600ms 与 8s 冷却 → §6.1；90s 静默、30min 降级、2s ps 周期 → §7；退避序列与 75s 心跳超时 → §8.1 / §10.3；设置项全表与默认值 → §9；边界情况 22 条 → §11；验收阈值（p95 1s、5s/10s 断连恢复、2ms/帧、146px）→ §13。

### 8. 与前置 PRD 的依赖

- **00（工程基线）**：monorepo 三包骨架、shared 包 zod 基础、ESLint flat config（no-restricted-imports 规则位）、Vitest projects、CI 骨架——daemon 与 HUD 的全部代码以此为地基。
- **01（M1 核心农场循环）**：游戏壳与 UIScene、Esc 菜单/设置页框架（HUD 设置挂入其中）、日结算屏（「会话一行」的渲染宿主）、Fusion Pixel 字体加载链、localStorage 设置模式、左上预留区零绘制约定（game-design §6.6）。
- 与 **02（M1.5）** 无依赖关系，可并行；M2 不使用 M1.5 的任何交付物（拖拽、成就页等）。
- 下游：**05（M4 AI 关卡）** 依赖本 PRD 的 daemon 进程、WS 通道与 headless 过滤预留；**06（M5 发布）** 依赖本 PRD 的端口/握手契约（静态托管同端口）与安装器（npx codestead 体验）。

## Testing Decisions

总原则：好测试只测外部行为（事件流入 → 状态/协议帧/文件内容出），不测实现细节（不断言内部数据结构、不 mock 内部函数）。本里程碑用到的接缝与理由如下（接缝编号沿用 tech-stack 裁决的全项目接缝策略）：

1. **接缝 c：daemon 状态 reducer 纯函数 + hook 事件 fixture 回放**——本里程碑的最高接缝。reducer 是手写纯函数，输入 = 信号序列，输出 = 会话表；表驱动测试逐条覆盖 hud-sessions §7.3 转移总表（首版覆盖 hooks 与 transcript 行，M2 末补齐 unknown/ps 行），外加四条仲裁规则的专项用例：心跳不重置 since（幂等）、低优先级信号仅在高优先级过期时生效、working 静默 90s 降 done、done 30min 降 idle（用注入时钟，不真等）。fixture 来自 M2 第一件事的事件录制器——真实事件流回放是对「hooks 语义随版本漂移」（风险 #2）的长期守护：升级 Claude Code 后重录 fixture，回放失败即语义漂移告警。理由：状态机正确性是整个 HUD 可信度的根，纯函数接缝让全部 14 行转移在毫秒级测完。
2. **接缝 b：shared 包 zod schema 协议编解码测试**——六种 M2 消息（auth/hello/snapshot/sessionUpsert/sessionRemoved/heartbeat）与 SessionInfo 的序列化往返、safeParse 拒绝畸形帧、向前兼容用例（多余字段宽容、未识别 state 值仍可解析并由 HUD 按 unknown 渲染）。理由：daemon 与 game 是两个运行时，schema 即契约，编解码测试就是契约测试。
3. **接缝 d：daemon WS 集成测试**——本地真实起 daemon（随机端口），伪造 hook HTTP 事件打进 hooks 端点，断言 WS 客户端收到的帧序列：连接 → auth → hello → snapshot，随后事件触发 sessionUpsert；SessionEnd 触发 sessionRemoved；并覆盖安全外部行为：无 token / 错 token 拒绝、非白名单 Origin 拒绝、hook 响应恒为空 2xx、`GET /handshake` 返回形状、端口被占时递增。理由：reducer 之外的「接线层」（HTTP→reducer→广播）只能在进程级验证，且这是隐私红线的自动化看护。
4. **HUD 客户端纯函数测试（接缝 c 的客户端镜像）**——连接状态机 reducer 表驱动测试（hud-sessions §8.1 明示「纯 reducer，可表驱动测试」）：超时进 BACKOFF、退避序列、心跳 75s 进 STALE、PROTO_MISMATCH 进 INCOMPATIBLE、snapshot 前 upsert 丢弃、重连保留冷却表；以及展示层纯函数：排序元组、溢出折叠（blocked 永不折叠）、显示名回退链与同名消歧、时长格式分段、抖动合并窗口。零 Phaser 依赖。理由：这些是 HUD 全部「会出错的逻辑」，把它们从渲染壳里隔出来测，渲染层就只剩贴图。
5. **安装器测试（外部行为 = 文件前后状态）**——指向临时目录的 settings.json fixture：首装产生备份、重复安装幂等（字节级等价）、与已有用户 hook 并存不覆盖、卸载只删带标记条目并保留用户条目、损坏 JSON 的安全失败。理由：这是对用户环境唯一的写操作，必须用最严格的「前后对比」黑盒验证。
6. **不引入的接缝**：接缝 a（sim 快进 N 天 headless）本里程碑不新增用例——HUD 与 sim 的关系是「零关系」，由 ESLint no-restricted-imports 静态看护（hud-sessions §13-5 的自动化断言），无需运行时测试；接缝 e（quest stub claude）归 M4；接缝 f（Playwright 冒烟）按 tech-stack 裁决推迟 M5。渲染层不写单测（tech-stack §1 测试行），像素锐利度、色盲可分性、呼吸频率等走 hud-sessions §13 的手动验收清单。

## Out of Scope

依据 game-design §0.4 M2 行（Out：任何干预；HUD 与经济的任何绑定；公网/多机）与 hud-sessions §1.2 / §6.2 / §14：

- **任何干预形态**：模态弹窗、toast、强制暂停、抢焦点、聚焦终端、Notification API 系统通知、NPC 播报会话状态、催促文案、默认开启的声音——永久禁止（反模式清单），不属于任何里程碑。
- **HUD 与游戏经济/XP/解锁的任何绑定**（含反向绑定）——永久禁止。
- **公网、多机、远程（ssh）会话**：不在 M2~M5 范围；SessionInfo 是否预留 host 字段留给 shared 协议演进讨论（hud-sessions §14-6）。
- **quest 全系**：questOffer 等消息处理、NPC 对话、headless 生成管线 → M4（本 PRD 仅交付「headless 会话永不进状态机」的过滤预留）。
- **daemon 静态托管游戏产物与 `npx codestead` 单进程产品形态、同源 Origin 收敛** → M5（tech-stack §1 产品形态行）。
- **Windows 支持** → M5 补位（tech-stack 风险 #12 注）；M2 平台矩阵为 macOS + Linux。
- **favicon 角标**（tabBadge 增强形态）→ 开放问题，M2 明确不做（hud-sessions §14-4）。
- **折叠态点击临时展开 3 秒** → 开放问题，M2 仅 H 键切换（§14-5）。
- **done→idle 30 分钟降级的可配置化** → 当前定死在 daemon，配置化待裁决（§14-3）。
- **终端焦点检测**（done 消解的增强信号）→ M3+（tech-stack §4.1-3）。
- **多轮 NPC 追问、思考笔记、`--resume`** → M4/M5 后（tech-stack §4.2-5）。
- 注意：ps 轮询、unknown 态、kill -9 收尸、4 项推迟设置**不是 Out**——它们在本里程碑内分期至 M2 末交付（见 Implementation Decisions 第 6 条），不得借分期之名挪出 M2。

## Further Notes

- **隐私红线（设计原则 #3 的本 PRD 落点）**：transcript 内容永不过 WS、永不出本机；HUD 标题级信息（cwd、最近输入）仅本机渲染、永不落日志；streamerMode 供共享屏幕场景一键遮蔽；daemon 永不上传任何数据。任何实现便利（如把 prompt 内容塞进日志调试）都不得触碰这条线。
- **素材许可**：新增资产全部走白名单——8×8 状态图标 7 枚（!/⚠/✓/◐×4帧/○/?/⌁）与面板 9-slice 自绘并以 CC0 献出；Fusion Pixel 12px 为全仓唯一 OFL-1.1 例外（附许可全文）；提示音取 Kenney UI Audio（CC0）。全部入 manifest 逐文件追溯（game-design §11.1；红线 §0.5-5）。CJK 字体终选（Fusion Pixel vs Ark Pixel）是开放问题（hud-sessions §14-2），M5 许可审计前定。
- **主要风险与缓解**（tech-stack §6）：hooks 语义版本漂移（#2）→ 录制器 fixture 回放守护 + macOS/Linux 双平台 CI；Esc/kill -9 幽灵状态（#3）→ transcript 90s 降级 + ps 收尸 + 全状态过期校验三层兜底；jsonl 格式无稳定性承诺（#6）→ 解析全容错、title 取不到回退 cwd basename、mtime 信号不依赖行内格式；本机其他网页连 WS（#7）→ 127.0.0.1 + Origin + token；端口占用（#13）→ 递增探测 + handshake 发现。
- **待内测裁决**：提示音默认值（纯 off vs blocked 默认开）按 hud-sessions §14-1 在 M2 内测两周后用自家狗粮定夺，本 PRD 按定稿默认 off 实施；tabBadge 默认开的取舍理由与复核约定见 hud-sessions §6.1。
- **验收基准**：以 hud-sessions §13 两栏（M2 首版 9 条 + M2 末补验 3 条）为出厂自检单，对照宪法红线「HUD 全程未产生一次强制打断」（game-design §0.5-4）。
- **文档义务**：README 须随本里程碑补「daemon 会向 settings.json 写哪些事件、如何卸载、数据流向（一切不出本机）」章节——这是开源信任面的一部分，不是 M5 才做的文档润色。
