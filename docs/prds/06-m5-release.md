---
title: "M5 开源发布：npx codestead 单进程产品、存档加固、许可审计与中英文档"
milestone: M5
status: ready-for-agent
depends_on:
  - 00-m0-scaffold.md
  - 01-m1-core-farm-loop.md
  - 02-m1.5-achievements-polish.md
  - 03-m2-session-hud-daemon.md
  - 04-m3-building-audio.md
  - 05-m4-ai-quests.md
design_refs:
  - "tech-stack.md §1（决策总表：产品形态 M5 行 / 构建 daemon 行 / CI 行 / 测试行 / 美术白名单行 / Node 基线行）"
  - "tech-stack.md §3（monorepo 结构与 codestead bin、install 模块职责）"
  - "tech-stack.md §4.1（hooks 安装/卸载三条硬约束与 README 透明义务）"
  - "tech-stack.md §5（/handshake 端点契约、M5 托管后同源无 CORS 面）"
  - "tech-stack.md §6（风险 #4 #7 #8 #11 #12 #13 #14）"
  - "tech-stack.md §7（升级触发器：tsdown/tsup 单文件、Vite 8、TS 6、pnpm 11）"
  - "game-design.md §0.4（里程碑边界：M5 In/Out 与 M1 移出至 M5 的清单）"
  - "game-design.md §0.5（验收红线 5：资产 manifest 逐文件可追溯）"
  - "game-design.md §2.9（同档双 tab：M5 前行为未定义 → M5 落地互斥）"
  - "game-design.md §10.1 / §10.4 / §10.5 / §10.6 / §10.9（存档 M5 项：backup/corrupt 恢复链、降级链、触发器 C/D/F、Web Locks 互斥、导入预览屏与 migrateSaveDoc）"
  - "game-design.md §10.7（general.language 'en' 文案 M5）"
  - "game-design.md §11.1 / §11.7（许可白名单 CC0-1.0 + OFL-1.1、assets:import 管线、check:assets 五项门禁、ATTRIBUTION.md、体积预算）"
  - "game-design.md 附录 B-12（多存档槽、改键、favicon 角标、NPC 多轮追问、英文 i18n 的 M5 评估裁决）"
  - "hud-sessions.md §10.3（P2 握手发现端点；CORS 收敛说明）、§14-2（字体许可审计入 CREDITS）"
  - "ai-quests.md §7.2（notes CLI 三条子命令与 NoteBackfill 接口）、§12（隐私红线工程化核对）、§14-A4（Playwright 零打扰冒烟）、§15 问题 2（--resume 多轮追问实验项）与问题 3（任务语言 i18n）、E12（README 额度声明）"
---

# 06 — M5 开源发布

## Problem Statement

M1~M4 之后，Codestead 功能上已经完整：农场循环好玩、会话 HUD 可靠、AI 关卡克制。但它仍然是一个「开发者形态」的项目——想用它的人必须 clone 仓库、装 pnpm、起两个进程（Vite dev server + daemon）；这对目标用户（想在等 AI 时有个候车室的程序员）是不可接受的安装摩擦。

同时还有四块「能用但不敢发布」的欠账：

1. **存档防丢不完整**：M1 只有 JSON 导出兜底，没有备份轮换、没有损坏恢复链、没有存储降级链；同档双 tab 行为未定义。开源用户的浏览器环境千奇百怪，丢档 = 丢信任；
2. **许可合规靠人肉**：manifest.json 是手维护的，没有 CI 自动审计、没有可重现的资产管线、没有面向再分发的署名文档（ATTRIBUTION）。「仓库内全部资产可追溯」是验收红线 5，发布前必须机器看护；
3. **文档与发布管线缺位**：没有英文文档、没有 npm 发包流程、没有端到端冒烟测试、Windows 行为未知；
4. **思考笔记没有出口**：M4 把笔记落在了 `~/.codestead/notes/`，但没有任何 CLI 工具帮用户检索查看。

## Solution

把 Codestead 从「仓库」变成「产品」：

- **一条命令即产品**：daemon 在同一端口（127.0.0.1:43110）静态托管游戏构建产物，`npx codestead` 启动单进程 = 完整产品（游戏 + HUD + AI 关卡），浏览器打开本地地址即玩；Origin 校验收敛为同源；
- **npm 打包**：daemon 包以 `codestead` 名发布 npm，bin 提供 `start / install / uninstall / notes` 子命令，游戏构建产物随包分发；
- **存档加固到发布级**：backup 轮换 + corrupt 留证 + 三选一恢复对话框、IDB→localStorage→内存的存储降级链、关键事件存档 / 30s 脏轮存 / pagehide 三个补充触发器、导入预览确认屏（含 migrateSaveDoc）、Web Locks 多标签互斥与接管流程；
- **notes CLI**：`codestead notes list / show / open`，让思考笔记可检索、可直达；
- **资产管线与许可审计**：`assets:import` 自动化管线（可重现切片）、`check:assets` 五项 CI 门禁（manifest 全覆盖、白名单许可、sha256 重现、体积预算、帧名正则）、ATTRIBUTION.md 逐来源署名；
- **CI 与发布**：ubuntu+macos × Node 22/24 矩阵上叠加 Playwright 冒烟与许可门禁，引入 changesets 管理版本与发包；Windows 行为评估与补位，README 标注支持矩阵；
- **中英文档**：安装、卸载、hooks 透明说明、隐私声明、Claude 额度声明，中文优先、发布前补英文；游戏内 `language: 'en'` 文案落地；
- **实验项评估**：`--resume` NPC 多轮追问、多存档槽、改键、favicon 角标等 B-12 待裁决项，本里程碑只做评估与裁决记录，不默认实现。

发布永久不包含：云服务、账号、遥测（game-design §0.4 M5 Out，宪法级）。

## User Stories

### A. 单进程产品形态（npx codestead）

1. 作为玩家（等待 AI 的程序员），我想在终端里只敲 `npx codestead` 一条命令就启动完整产品，so that 我不需要 clone 仓库、装 pnpm、读构建文档就能开始玩。
2. 作为玩家，我想在 `codestead start` 启动后看到终端清晰打印出游戏地址（如 `http://127.0.0.1:43110`）与 daemon 状态，so that 我知道下一步去浏览器打开哪里。
3. 作为玩家，我想让游戏页面和 WebSocket 由同一个进程、同一个端口提供，so that 我的机器上不再有「游戏服务器」与「守护进程」两个概念，关掉一个进程就是全部关掉。
4. 作为玩家，当 43110 端口被占用时，我想让 daemon 自动递增换口（43110–43119）并在终端打印实际地址，so that 端口冲突不需要我手工排查。
5. 作为玩家，我想让单进程形态下的 `/handshake` 与 WS 连接都是同源请求，so that 不存在跨域配置，也没有任何其他网页能借 CORS 面碰我的本机数据（仍保留 127.0.0.1 绑定 + token 鉴权）。
6. 作为开源使用者，我想让 `npx codestead` 在未安装 hooks 时也能完整玩农场（HUD 显示安装指引），so that 我可以先玩起来、再决定是否运行 `codestead install` 接入会话感知。
7. 作为后续开发者（含 AI agent），我想让开发模式（Vite dev server + daemon watch）与产品模式（daemon 静态托管构建产物）并存且行为一致，so that 开发期的跨域白名单逻辑不会泄漏到发布形态里。

### B. npm 打包与 bin

8. 作为开源使用者，我想从 npm 安装到的 `codestead` 包自带游戏构建产物与全部 CC0/OFL 资产，so that 安装后无需任何额外下载或构建步骤。
9. 作为开源使用者，我想让 `codestead` bin 提供 `start`（默认）、`install`、`uninstall`、`notes` 子命令和 `--help`/`--version`，so that 一个入口覆盖产品全部命令面。
10. 作为开源使用者，我想让 `codestead install` 严格遵守三条硬约束（先备份 `~/.claude/settings.json`、自身条目带 codestead 命名空间标记、与我已有的同事件 hook 追加并存），so that 接入会话感知绝不破坏我现有的 Claude Code 配置（tech-stack §4.1）。
11. 作为开源使用者，我想让 `codestead uninstall` 只删除带 codestead 标记的 hook 条目并告知备份位置，so that 卸载是干净、可验证、可回滚的。
12. 作为开源使用者，我想让 npm 包在 Node `>=22.13.0` 之外的版本上启动时给出明确的版本要求报错，so that 我不会在老 Node 上看到莫名其妙的语法错误。
13. 作为后续开发者，我想让发包产物保持 tsc 编译的透明 ESM（不打包、不混淆），so that 用户可以审计安装到本机的每一行代码（tech-stack §1 构建 daemon 行）；只有当包体积或启动摩擦实测不达标时，才按 tech-stack §7 触发器评估 tsdown/tsup 单文件方案。
14. 作为后续开发者，我想用 changesets 管理版本号、changelog 与 npm 发布流程，so that 每次发版有可追溯的变更记录，发布动作可以在 CI 里重放（tech-stack §1 CI 行：changesets 留到 M5 发包时引入）。

### C. 存档加固（game-design §10 的 M5 完整版）

15. 作为玩家，我想让每次日结算存档前自动把上一份好档轮换进 backup 键（深度 1），so that 即使新写入是「逻辑性坏档」，我也始终有上一晚的可用备份（§10.4 写入原子性）。
16. 作为玩家，当启动时主存档损坏，我想让游戏先把原始数据移入 corrupt 键留证、再读 backup，可用时给我低压文案的三选一对话框（从备份继续 / 导入 JSON / 开新农场），so that 坏档不等于丢档，而且没有吓人的报错（§10.4 RECOVERY 完整版）。
17. 作为玩家，当 backup 也不可用时，我想看到二选一对话框（导入 JSON / 开新农场）且损坏数据不被删除，so that 我仍有机会事后用工具抢救留证数据。
18. 作为玩家，当 IndexedDB 不可用时，我想让存档自动降级到 localStorage 适配器（>4MB 拒写并提示导出，顶部安静提示「存储受限」），so that 在受限浏览器环境里我还能继续玩并知道风险（§10.1 降级链）。
19. 作为玩家，当 localStorage 也不可用时，我想进入内存模式（可玩但刷新即丢），且结算屏高亮导出按钮，so that 最坏情况下我仍可手动带走存档。
20. 作为玩家，我想让工具升级、背包扩容、职业选择、农场升级、quest 奖励、导入完成这些不可逆事件在 5 秒合并窗口内触发自动存档，so that 关键进度永远不会因为意外关页而丢失（§10.4 触发器 C）。
21. 作为玩家，我想要每 30 真实秒的脏数据轮存，so that 任意时刻硬关窗口的进度损失上界被压到 30 秒（§10.4 触发器 D；§10.9 验收）。
22. 作为玩家，我想要 pagehide 时的 best-effort 存档作为最后一道兜底，so that 多数「直接关标签页」的场景也能落盘（§10.4 触发器 F）。
23. 作为玩家，导入存档 JSON 时我想先看到预览确认屏（双方存档摘要对比 + 「当前存档将被替换并自动备份」），低版本档先经 migrateSaveDoc 迁到当前版本，任一步失败现有存档纹丝不动，so that 导入永远是知情且无损的操作（§10.6）。
24. 作为玩家，当同一存档被第二个标签页打开时，我想看到「接管」屏而不是两个标签页互相覆写，点击「在这里继续玩」后旧页保存、停 sim、释放锁，新页 3 秒内接管，so that 同档双 tab 从「行为未定义」变成明确安全的流程（§10.5、§2.9）。
25. 作为玩家，在不支持 Web Locks 的浏览器里，我想让互斥自动退化为 BroadcastChannel claim/held 握手（250ms 无回应视为独占），so that 互斥保护不依赖单一浏览器 API（§10.5）。
26. 作为后续开发者，我想让全部加固逻辑收敛在 SaveStorage 接口之后（idb-keyval 仍被 ESLint 限制在存储模块内），so that 降级链与备份链可以用注入的 fake 适配器做确定性测试，未来桌面化只动一个模块（tech-stack 风险 #8、§10.1）。

### D. notes CLI（ai-quests §7.2）

27. 作为玩家，我想用 `codestead notes list [--session <id>]` 列出我的思考笔记（标题、日期、关联会话/目录），so that 我能快速回顾「等 AI 时想清楚了哪些决策」。
28. 作为玩家，我想用 `codestead notes show <questId>` 在终端直接阅读某条笔记全文（frontmatter + 我的回答），so that 不必去文件管理器翻目录。
29. 作为玩家，我想用 `codestead notes open` 一键用系统文件管理器打开 `~/.codestead/notes/` 目录，so that 笔记保持「就是本机 Markdown 文件」的可触达性。
30. 作为后续开发者，我想让 notes CLI 复用 M4 已落地的 NoteBackfill `listNotes` / `renderNote` 接口与 index.jsonl，so that CLI 是薄壳，检索逻辑只有一份且已被 M4 测试覆盖。
31. 作为玩家，我想让 notes CLI 在 notes 目录不存在或为空时输出友好的空态提示（而非报错），so that 还没玩过 AI 关卡的用户不会被吓到。

### E. 资产管线与许可审计

32. 作为后续开发者，我想用 `pnpm assets:import` 从 assets-src 源（aseprite 导出 + recipes 切片配方）可重现地生成图集、tileset（含 1px extrude）与最终产物，so that 资产更新不再依赖手工导出的不可复现操作（§11.7 管线，M1 移出清单转正）。
33. 作为后续开发者，我想让 manifest.json 由管线生成/校验而非纯手维护，每个条目含 author / source / sourceSha256 / license / licenseVerifiedAt / derivedFrom / processing，so that 逐文件许可追溯（验收红线 5）从约定变成机器事实（§11.7）。
34. 作为开源使用者，我想让 CI 的 `check:assets` 门禁强制五项检查——① 每文件有 manifest 条目；② license ∈ 白名单（CC0-1.0 + OFL-1.1，OFL 仅限 Fusion Pixel 字体）且 redistributable；③ recipes 重切 sha256 一致；④ 体积预算（atlases ≤1.5MB、tileset ≤256KB、字体 ≤4MB、SFX+jingle ≤2.5MB、BGM+ambience ≤12MB、总计 ≤20MB、首批 ≤8MB）；⑤ 帧名正则——so that 任何许可踩线或体积超支的 PR 无法合入（§11.1、§11.7、tech-stack 风险 #14）。
35. 作为开源使用者，我想在仓库根看到 ATTRIBUTION.md 按来源逐项列出署名（Kenney 各包、FreePD 逐曲、freesound 逐条、Fusion Pixel 字体含 OFL-1.1 全文链接），并由根 CREDITS 链接，so that 我 fork / 再分发时能直接满足上游许可与社区礼仪（§11.7、hud-sessions §14-2）。
36. 作为开源使用者，我想确认 npm 包内同样带有 OFL 许可全文与 manifest，so that 不只是 git 仓库、连分发产物也合规。
37. 作为后续开发者（含 AI agent），我想让许可门禁按「白名单 = CC0-1.0 + OFL-1.1」实现而非「仅 CC0」字面，so that 字体例外不被误拦，同时 Sprout Lands 等「可商用禁再分发」素材永远进不了仓库（§11.1 红线、tech-stack §1 美术行）。

### F. CI 扩展与发布管线

38. 作为后续开发者，我想让 CI 在 ubuntu-latest + macos-latest × Node 22/24 四 job 矩阵（M2 起已有）上全绿，并叠加 M5 新增门禁：Playwright 冒烟、check:assets 完整五项、npm 打包冒烟，so that 发布门槛是机器判定的（tech-stack §1 CI 行）。
39. 作为后续开发者，我想让 CI 用 pnpm/action-setup 读取根 package.json 的 packageManager 字段、不依赖 corepack，so that Node 新版剥离 corepack 不影响流水线（tech-stack 风险 #11）。
40. 作为后续开发者，我想要一条基于 changesets 的发布工作流：合并 changeset → 版本 PR → 打 tag → npm publish，so that 发版是一键且可审计的。
41. 作为开源使用者，我想看到 Windows 上的行为评估结论落档：`npx codestead` 启动、静态托管、hooks 安装路径、ps 轮询正则逐项实测，阻断性问题修复（补位），README 支持矩阵如实标注支持级别，so that 我在 Windows 上知道能用到什么程度（game-design §0.4「Windows 补位」；tech-stack §1 CI 行）。
42. 作为后续开发者，我想让「CI 是否加入 windows-latest job」依据上述评估结果裁决并记录理由，so that 矩阵成本与支持承诺相匹配，而不是拍脑袋加 job。
43. 作为后续开发者，我想让 Playwright 冒烟作为独立 CI job 只跑构建产物（非 dev server），so that 冒烟测的是用户真正拿到的形态。

### G. 中英文档与安装体验

44. 作为开源使用者，我想要中文优先、发布前补齐英文版的 README 与使用文档，覆盖：是什么/为什么、`npx codestead` 快速开始、`codestead install/uninstall`、设置与数据位置（`~/.codestead/`）、支持矩阵、开发者上手（pnpm 两种安装方式：`npm i -g pnpm@10` 或 standalone），so that 中英文用户都能在五分钟内跑起来（CLAUDE.md 开发约定；tech-stack 风险 #11）。
45. 作为开源使用者，我想让 README 明示 `codestead install` 会向 `~/.claude/settings.json` 添加哪些 hook 事件、备份在哪、如何干净卸载，so that 我对这个工具碰我配置文件的每个动作都知情（tech-stack §4.1 透明义务）。
46. 作为开源使用者，我想让 README 有显著的隐私声明：工作上下文只在本机处理、唯一外发通道是我自己的 `claude` CLI、Codestead 没有服务器、永久无遥测，so that 我可以放心把它接到我的工作会话上（ai-quests §12；game-design §0.4 M5 Out）。
47. 作为玩家，我想让 README 与首次同意文案一致地标注「AI 关卡消耗你的 Claude 额度」及 2026-06-15 起 `claude -p` 计入 Agent SDK 额度的变化，so that 成本预期没有惊喜（ai-quests E12；tech-stack 风险 #4）。
48. 作为玩家，我想在游戏内把语言切到英文（`general.language: 'en'`）后看到完整的英文 UI 文案，so that 非中文玩家也能玩完整农场循环（game-design §10.7：en 文案 M5）。
49. 作为开源使用者，我想让文档明确列出已知限制（如 AI 任务语言现为简体中文、远程/多机会话不支持），so that 期望被正确管理。

### H. 端到端冒烟与发布验收

50. 作为后续开发者，我想要 Playwright 冒烟覆盖游戏壳层关键路径：页面加载、canvas 渲染出帧、新档「种→收→卖」可达、存档导出→清站点数据→导入往返一致，so that 「打包产物在真浏览器里活着」有机器证据（tech-stack §1 测试行：Playwright 推迟到 M5 做冒烟级）。
51. 作为后续开发者，我想要 Playwright 双标签页场景验证 Web Locks 接管流程（旧页保存停 sim、新页 3 秒内接管），so that 多标签互斥不是只有单测。
52. 作为玩家，我想让 ai-quests 验收 A4 的「零打扰」冒烟在 M5 自动化：任务到达瞬间输入焦点、镜头、时间流速均无变化，so that 「感知不干预」在发布门禁里被持续看护（ai-quests §14-A4）。
53. 作为后续开发者，我想要一条「干净机器」安装冒烟：从 npm tarball 安装 → `codestead start` → HTTP 探测 `/handshake` 与游戏首页 200，so that 安装体验回归有自动化兜底。
54. 作为玩家，我想让冷启动到可操作 ≤3 秒、首批资产加载 ≤8MB 在发布前被实测确认，so that 「候车室」打开的速度配得上它的定位（§11.7 体积预算）。

### I. 实验项与待裁决项评估

55. 作为玩家，我想让团队对 `--resume` NPC 多轮追问做一次正式评估（成本、打扰度、实现路径），结论与理由落档：开实验开关或明确不做，so that 这个从 M4 悬置的问题有个交代而不是默认实现（ai-quests §15 问题 2、tech-stack §4.2 第 5 步）。
56. 作为玩家，我想让笔记自动回填 `injectNote` 维持「仅留接口」，任何实现都必须以「用户逐条确认」为前置条件且不在 M5 落地，so that 「感知不干预」同样适用于回填方向（ai-quests §7.2）。
57. 作为后续开发者，我想让多存档槽、改键、favicon 角标这三个 B-12 预留项在 M5 复盘时逐项裁决（做/不做/推迟）并记录，so that 协议与键名预留是否兑现有明确去向（game-design 附录 B-12）。
58. 作为后续开发者，我想让 quest prompt 与本地题库的 i18n 方案随 en 文案落地一起评估（本里程碑可裁决为「AI 任务暂仅中文，文档明示」），so that 英文 UI 不被一个开放问题阻塞（ai-quests §15 问题 3）。

## Implementation Decisions

### 与前置 PRD 的关系

- **00（脚手架）**：monorepo、三包、CI 骨架、ESLint 边界规则是本 PRD 全部工作的地基；
- **01/02（M1-core / M1.5）**：本 PRD 的存档加固是 game-design §10 中被 §0.4 明确从 M1 移出的全部存档项的「补完」，依赖 01 落地的 SaveStorage 接口、SaveDoc v1 schema、启动加载状态机简版；资产管线自动化依赖 01/02 已入库的手工图集与手维护 manifest；
- **03（M2 HUD）**：单进程托管复用 daemon 的 HTTP 服务器与 `/handshake` 契约；`codestead install/uninstall` 在 M2 已实现，本 PRD 将其纳入 npm bin 的发布形态并补文档义务；CI 的 ubuntu+macos × Node 22/24 矩阵 M2 已就位，本 PRD 只做叠加；
- **04（M3 建造）**：体积预算与音频双格式 CI 检查依赖 M3 音频管线；存档迁移链（v1→v2）与 CI 守护测试 M3 已建，本 PRD 的导入预览屏直接复用 migrateSaveDoc；
- **05（M4 AI 关卡）**：notes CLI 是 M4 NoteBackfill 接口（listNotes/renderNote）与 index.jsonl 的薄壳；A4 零打扰冒烟自动化、README 额度声明均收尾 M4 留下的 M5 项。

### 决策清单

1. **产品形态（定稿，tech-stack §1 产品形态行 / §8 裁决）**：daemon 在同端口静态托管 game 构建产物；`npx codestead`（等价 `codestead start`）单进程即完整产品。静态托管挂在既有 node:http 服务上（与 `/hooks`、WS upgrade、`/handshake` 同一监听）；启动打印实际地址；端口占用按 43110–43119 递增（tech-stack 风险 #13 既有约定不变）。
2. **安全收敛（定稿，tech-stack §5 / hud-sessions §10.3）**：托管后游戏与 daemon 同源，Origin 校验收敛为同源校验、`/handshake` 无 CORS 面；开发模式保留 Vite origin 白名单。只绑 127.0.0.1、首条 WS 消息 token 鉴权、载荷最小化（transcript 内容永不过 WS）全部维持不变。
3. **npm 包与 bin**：发布物 = daemon 包（包名 `codestead`，bin 同名），游戏构建产物与 assets（含 manifest.json、OFL 全文）作为包内静态资源；game/shared 包保持 private。命令面：`start`（默认子命令）/ `install` / `uninstall` / `notes <list|show|open>` / `--version` / `--help`。engines `">=22.13.0"`，启动期校验并给可读报错。产物保持 tsc ESM 不打包；tsdown/tsup 仅在体积或启动摩擦不达标时按 tech-stack §7 触发器评估（评估结论落档）。
4. **hooks 安装/卸载契约（定稿，tech-stack §4.1，M2 已实现，M5 验收其发布形态）**：① 首次写入前备份 `~/.claude/settings.json` 为 `settings.json.codestead-bak`；② 自身条目带 codestead 命名空间标记，uninstall 只删带标记条目；③ 同事件用户 hook 追加并存。README 义务：列出全部写入事件与卸载方法。
5. **存档加固范围 = game-design §0.4 从 M1 移出至 M5 的存档清单，逐项转正**，规格全部以 game-design §10 为事实源，不在此复述：backup/corrupt 键名与轮换深度（§10.1/§10.4）、RECOVERY 完整版分支（§10.4 启动状态机，load-bearing 形状如下）、降级链与各级用户提示（§10.1）、自动存档触发器 C/D/F 及节流参数（§10.4 触发表）、导入预览确认屏 + migrateSaveDoc（§10.6）、Web Locks `'codestead-slot0'` + BroadcastChannel takeover（§10.5）。启动恢复链顺序（来自 §10.4 设计定稿，load-bearing）：

   ```
   VALIDATE/MIGRATING 失败 → RECOVERY：
     原始数据移入 corrupt 键 → 读 backup →
       可用：三选一 [从备份继续] [导入 JSON] [开新农场]
       不可用：二选一 [导入 JSON] [开新农场]
   version > CURRENT → TOO_NEW（只读 + 仅导出，绝不写盘/向下迁移）
   ```

   全部加固在 SaveStorage 接口之后实现；好档永不被截断覆盖（§10.9）。
6. **notes CLI**：三条子命令语义按 ai-quests §7.2 逐字实现（`list [--session <id>]` / `show <questId>` / `open`）；数据源 = `~/.codestead/notes/index.jsonl` 与笔记 Markdown，经 M4 的 NoteBackfill `listNotes`/`renderNote` 复用，CLI 不引入第二套检索逻辑；笔记内容仍永不经网络通道离开本机。
7. **资产管线**：`assets:import` = sharp + maxrects-packer + tile-extruder，读切片配方（recipes），输出图集/tileset 与 manifest 条目；sha256 重现校验转正为 `check:assets` 第 ③ 项。`check:assets` 五项门禁与体积预算数值以 game-design §11.7 为事实源；许可白名单 = CC0-1.0 + OFL-1.1（OFL 仅限 Fusion Pixel 字体，附许可全文），按白名单而非「仅 CC0」字面实现（§11.1、tech-stack 风险 #14）。manifest 条目字段形状（来自 §11.7 设计定稿）：`author / source / sourceSha256 / license / licenseVerifiedAt / derivedFrom / processing`。
8. **署名文档**：ATTRIBUTION.md 按来源逐项（Kenney 各包、FreePD 逐曲、freesound 逐条、Fusion Pixel/OFL），根 CREDITS 链接（§11.7、hud-sessions §14-2）；npm 包内同步分发。
9. **CI 扩展**：在 M2 既有 ubuntu+macos × Node 22/24 矩阵上叠加：Playwright 冒烟 job（跑构建产物）、`check:assets` 完整门禁（含音频双格式与体积预算，依 §11.7 随 M3/M5 启用项全开）、npm 打包冒烟；changesets 版本/发布工作流；pnpm/action-setup 读 packageManager 字段（不依赖 corepack，tech-stack 风险 #11）。Windows：实测评估 + 阻断性补位 + README 支持矩阵标注；windows-latest job 取舍依评估结论裁决并记录。
10. **文档**：中文优先、发布前补英文（CLAUDE.md 开发约定）；内容义务清单 = 快速开始（npx）、hooks 透明说明（决策 4）、隐私声明（ai-quests §12 六条的用户语言版）、Claude 额度与 2026-06-15 配额变化（ai-quests E12 / tech-stack 风险 #4）、支持矩阵、开发者上手（pnpm 双安装路径）、已知限制（AI 任务语言、远程会话等）。
11. **en 文案**：游戏内 `general.language: 'en'` 的 UI 文案落地（game-design §10.7）；quest prompt 与本地题库 i18n 不强制随行，按 ai-quests §15 问题 3 评估裁决，允许「AI 任务暂仅中文 + 文档明示」作为 M5 结论。
12. **实验项纪律**：`--resume` 多轮追问、injectNote 自动回填、多存档槽、改键、favicon 角标——M5 只产出评估与裁决记录（做/不做/推迟 + 理由），任何一项未经裁决不得进入实现（ai-quests §15 问题 2、§7.2；game-design 附录 B-12）。
13. **永久 Out 的工程化**：仓库内不存在任何遥测/上报代码路径；发布检查含「无新增网络出口」复核（唯一外发通道 = 用户自己的 claude CLI，ai-quests §12）。

## Testing Decisions

原则：只测外部行为（命令的退出码与输出、HTTP/WS 响应、浏览器内可观察状态、文件系统产物），不测实现细节。本里程碑用到的接缝与理由：

1. **接缝 f：游戏壳层 Playwright 冒烟（本里程碑的主接缝）**——M5 交付的是「形态」而非新玩法，唯一能证明形态成立的是真浏览器跑构建产物：加载、canvas 渲染、新档最小循环、存档导出→清数据→导入往返；叠加双标签页接管场景（Web Locks 互斥）与 ai-quests A4 零打扰断言。只做冒烟级，不做 E2E 全覆盖（tech-stack §1 测试行裁决）。
2. **接缝 d：daemon 集成测试扩展**——本地起 daemon（产品模式），断言：游戏首页与静态资产 200、`/handshake` 同源返回契约形状、伪造 hook HTTP 事件 → WS 推送仍然正确。理由：静态托管挂在同一 http 服务上，必须证明它没有破坏 M2 的既有契约。
3. **SaveStorage 接口接缝（接缝 a 的存储侧延伸）**——降级链、backup 轮换、corrupt 留证、恢复链状态机全部通过注入 fake 存储适配器（可编程地抛 QuotaExceeded、返回损坏 JSON、模拟 IDB 不可用）做确定性单测；启动加载状态机以「输入 = 存储内容 fixture，输出 = 终态 + 键变更」断言，不触碰真实浏览器存储。三选一对话框的可达性归 Playwright（接缝 1）。
4. **接缝 b：shared schema 编解码测试**——导入导出往返（export → parse → safeParse → 深等）、migrateSaveDoc 低版本 fixture 逐版迁移（链与 CI 守护测试 M3 已建，M5 为导入预览路径补「迁移失败现有档纹丝不动」断言）、TOO_NEW 只读分支。
5. **notes CLI 测试**——以临时 HOME 目录 + 笔记 fixture 跑 CLI，断言 stdout 形状与退出码；空目录空态、坏行容错（index.jsonl 含损坏行）各一例。复用 M4 的 NoteBackfill 测试资产，不重测检索逻辑（外部行为：命令输出；不断言内部函数调用）。
6. **check:assets 门禁自测**——用违规 fixture（缺 manifest 条目、license=CC-BY、sha256 不符、超预算文件、坏帧名）逐项断言门禁红；全合规 fixture 断言绿。理由：门禁本身是发布安全网，安全网必须有「会响」的证据。
7. **npm 打包冒烟**——CI 内 `pnpm pack` → 干净临时前缀安装 tarball → 启动 → HTTP 探测首页与 `/handshake` → `notes --help` 退出码 0。这是「npx codestead 单命令即产品」承诺的机器化版本。
8. **接缝 e（stub claude）**——M5 不新增生成功能，仅当 `--resume` 评估需要实验数据时，用 M4 既有 stub claude 接缝跑实验，不引新测试设施。
9. **接缝 c（reducer 回放）**——本里程碑无状态机变更，仅作为回归资产在矩阵全平台继续跑（Windows 评估时在本地 Windows 实测跑通与否即为评估输入之一）。

不做：渲染层单测（既有裁决）、Playwright 全场景回归、对 npm registry 的真实发布测试（以 dry-run / pack 替代）。

## Out of Scope

- **云服务、账号、遥测**——永久 Out（game-design §0.4 M5 Out 行；宪法级，不是推迟而是永不做）；
- **`--resume` NPC 多轮追问的实现**——M5 仅评估裁决；实现（若裁决通过）为 M5 后实验开关（ai-quests §15 问题 2）；
- **injectNote 笔记自动回填的实现**——仅保留 M4 接口；实现前置条件（用户逐条确认）与路径选型留 M5 后（ai-quests §7.2）；
- **多存档槽、改键、favicon 角标**——B-12 评估项，未裁决通过前不实现（game-design 附录 B-12；存档键名 slot0 维度与协议预留已存在，不动）；
- **quest prompt / 本地题库的完整 i18n**——允许裁决为「AI 任务暂仅中文 + 文档明示已知限制」（ai-quests §15 问题 3）；
- **多机/远程会话（ssh 上的 Claude Code）**——M2~M5 一律不在范围（hud-sessions §14-6）；
- **daemon 本机落盘存档端点**——风险 #8 的远期选项（「M3 后可加」），不是 M5 承诺，SaveStorage 接口已为其留缝；
- **Phaser 4 / Vite 8 / TS 6 / pnpm 11 升级**——按 tech-stack §7 触发器在里程碑间隙评估，非 M5 义务；tsdown/tsup 单文件同理（仅评估）；
- **Windows 一线支持承诺**——M5 做的是评估 + 阻断性补位 + 支持矩阵如实标注；与 macOS/Linux 同级的支持承诺及 windows CI job 依评估结论另行裁决；
- **浏览器系统通知（Notification API）**——M2~M5 一律不用（hud-sessions 既有裁决）。

## Further Notes

- **许可红线（验收红线 5）**：仓库与 npm 包内全部资产必须在 manifest.json 中追溯到 CC0-1.0 / OFL-1.1（OFL 仅限 Fusion Pixel 字体）；Sprout Lands / Sunnyside / Cozy Farm 任何文件不得入库，星露谷本体素材绝对禁止（game-design §11.1）。发布前人工抽查 + CI 门禁双保险。
- **隐私红线**：发布即承诺——数据不出本机、唯一外发通道是用户自己的 claude CLI、`~/.codestead/` 下文件权限 0600、WS 载荷最小化。M5 发布检查表包含 ai-quests §12 六条的逐条复核；README 隐私声明与代码事实必须一致。
- **npm 包体积风险**：assets 预算上限 20MB 意味着 tarball 不小。先发布、实测安装体验（npx 冷启动时间），不达标再触发 tech-stack §7 的单文件/体积优化评估——不要预优化。
- **配额变化时点**：2026-06-15 起 `claude -p` 计入独立 Agent SDK 额度（tech-stack 风险 #4 / ai-quests E12），与 M5 发布窗口接近，README 与首次同意文案务必在发布前核对最新口径。
- **hooks 语义漂移**：发布后用户的 Claude Code 版本不受控；M2 的 fixture 回放测试是兼容性安全网，发布文档应标注已验证的 Claude Code 版本范围（tech-stack 风险 #2）。
- **「先玩起来」原则**：未装 hooks、未装 claude CLI、甚至离线，`npx codestead` 都必须能玩完整农场（HUD/quest 各自优雅缺席）——这是 M2/M4 既有降级设计在发布形态下的总验收。
- **发布检查表建议**（出厂自检，对照 game-design §0.5 五条红线）：新档 10 分钟红线 playtest、2 分钟红线、离开无恶化、零强制打断、资产可追溯，全部在打包产物（非 dev 模式）上复验一遍。
