---
title: "M0 工程脚手架：pnpm 三包 monorepo 与全链路工具链"
milestone: M0
status: ready-for-agent
depends_on: []
design_refs:
  - "docs/design/tech-stack.md §1 决策总表（全部版本与选型的唯一事实源）"
  - "docs/design/tech-stack.md §3 Monorepo 目录结构"
  - "docs/design/tech-stack.md §5 WebSocket 协议消息草案（envelope / SessionState / SessionInfo）"
  - "docs/design/tech-stack.md §6 风险清单（#10 sim 分层、#11 corepack、#12 CI 矩阵分期）"
  - "docs/design/tech-stack.md §7 升级触发器"
  - "docs/design/tech-stack.md §9 立即行动项"
  - "docs/design/game-design.md §0.3 全局硬规格（逻辑分辨率 / 像素规则）"
  - "docs/design/game-design.md §0.4 里程碑边界"
  - "docs/design/game-design.md §7.3 五态视觉（theme token 事实源）"
  - "docs/design/game-design.md §10.1 存储方案（idb-keyval 限 storage/** 的 lint 规则出处）"
  - "docs/design/game-design.md §11.1/§11.2 许可白名单与 CODE-28 调色板"
  - "docs/design/game-design.md §12 跨系统契约速查"
  - "docs/design/hud-sessions.md §10.4 与 tech-stack 的一致性裁决（SessionInfo 字段全集）"
  - "docs/design/ai-quests.md §4.6 Quest schema（M0 仅占位，事实源指向）"
---

# PRD 00 — M0 工程脚手架

> 本 PRD 是全部后续 PRD（01～06）的公共前置：01（M1-core 农场核心循环）、02（M1.5）、03（M2 会话 HUD）、04（M3 建造与升级）、05（M4 AI 关卡）、06（M5 开源发布）的 `depends_on` 均应包含本文件。M0 本身不依赖任何 PRD。

## Problem Statement

Codestead 目前只有设计文档，没有一行代码。三类人都被卡住：

- **后续开发者（含 AI agent）**无处落笔：没有仓库骨架，M1 的 sim 层、M2 的 daemon、shared 协议都不知道写在哪、用什么版本、被什么规则约束。更危险的是，如果第一批代码先落地、纪律后补，「sim 层零 Phaser 依赖」「shared 单一事实源」这类 load-bearing 架构边界几乎必然被侵蚀（tech-stack §6 风险 #10），事后矫正成本远高于事前立规。
- **开源使用者**无法判断项目可信度：clone 下来装不起来、跑不起来、没有 CI 徽章背书的仓库，不符合 CLAUDE.md「开源产品标准」的设计原则。
- **玩家（等待 AI 的程序员）**还看不到任何东西：连一块能渲染的画布都没有，无法验证「Phaser 3 + Vite 的游戏壳在本机浏览器里跑得起来」这一最基本的技术假设。

同时，tech-stack.md 的逐项裁决（精确锁定 Phaser 3.90.0、pnpm 10.34.1、zod v4 等）如果不在第一个里程碑被固化进 `package.json` / lockfile / CI，就只是纸面决定——任何一次随手 `pnpm add` 都可能引入裁决明确否决过的版本线。

## Solution

交付一个**可安装、可运行、可验证、被规则守护**的空壳 monorepo，把 tech-stack.md 的全部裁决固化为代码与配置：

1. **pnpm workspaces 三包 monorepo**（shared / game / daemon），目录结构、依赖方向、版本锁定与 tech-stack §1/§3 逐字一致；
2. **游戏壳跑通**：Phaser 3.90.0 + Vite 7 + TS 5.9，浏览器里渲染一个符合像素硬规格（640×360 逻辑分辨率、整数倍缩放、pixelArt + roundPixels，game-design §0.3）的空场景——这是玩家在本项目里看到的第一块画布；
3. **daemon 开发链路打通**：tsx watch 直跑、tsc 编译 ESM 产物，入口仅为可启动、可干净退出的占位（不实现任何 M2 功能）；
4. **shared 包协议骨架**：zod v4 单一事实源，落地 envelope、`PROTOCOL_VERSION`、五态 `SessionState`、`SessionInfo` 与 theme 五态色 token；quest / save 模块仅占位；
5. **质量工具链全链路**：Vitest 根级 projects 统一三包、ESLint 10 flat config + typescript-eslint 类型感知规则 + Prettier，其中 **sim 层 `no-restricted-imports` 边界规则从第一天生效**；
6. **GitHub Actions CI**：M1 阶段收敛为 ubuntu × Node 22 单 job，流水线 frozen-lockfile → typecheck → lint+format check → test → build；
7. **README 与开发文档骨架**：安装（不依赖 corepack）、运行、支持矩阵、许可白名单与素材红线、贡献入口。

M0 的验收对象是**工具链行为**而非游戏功能：clone → install → dev → test → lint → build 全链路一次通过，且每条架构纪律都有自动化守护。

## User Stories

### A. Monorepo 与依赖管理

1. 作为后续开发者，我想 clone 仓库后用一条 `pnpm install` 装齐三个包的全部依赖（CI 上 `--frozen-lockfile` 可复现同一棵依赖树），so that 我不需要任何额外的环境调试就能开始干活。
2. 作为后续开发者，我想让根 `package.json` 的 `packageManager` 字段精确锁定 pnpm 版本（tech-stack §1 裁决值），so that 不同协作者/CI 之间不会因 pnpm 大版本差异产生 lockfile 漂移。
3. 作为开源使用者，我想在 README 里看到不依赖 corepack 的两种 pnpm 安装方式（npm 全局安装与 standalone，tech-stack §6 风险 #11），so that 在 corepack 被新版 Node 剥离后我仍能零摩擦装起项目。
4. 作为后续开发者，我想让 `engines` 字段声明 Node 下限（tech-stack §1 裁决值 `>=22.13.0`）并在不满足时安装即报错，so that 我不会在过老的 Node 上浪费时间排查 Vite 7 / ESLint 10 的兼容性怪病。
5. 作为后续开发者（含 AI agent），我想让仓库目录结构与 tech-stack §3 的蓝图逐目录对应（三包、各自的 src 子目录占位、根级配置文件），so that 我读完设计文档就能按图索骥，不需要猜测任何文件该放在哪。
6. 作为后续开发者，我想让三包依赖方向固定为单向（shared ← game / daemon，game 与 daemon 互不依赖），并由 TypeScript project references 表达，so that shared 改动后 `tsc -b` 增量重建下游类型，且循环依赖在编译期就不可能出现。
7. 作为后续开发者，我想用一条 `pnpm dev` 并行拉起 Vite dev server 与 daemon 的 tsx watch（tech-stack §3 根脚本约定），so that 我的日常开发只需记一个命令。
8. 作为后续开发者，我想让 `pnpm -r build / test / typecheck` 与 `pnpm lint` 作为全仓统一入口存在且全部通过，so that 任何人（包括 CI 和 AI agent）用同一组命令验证仓库健康度。
9. 作为后续开发者，我想让仓库不引入任何任务编排器（无 Turborepo/Nx，tech-stack §1 裁决），so that 依赖面与心智负担保持在三包一条直线的最小规模。

### B. 游戏壳（packages/game）

10. 作为玩家（等待 AI 的程序员），我想在浏览器里打开 dev server 地址就看到一块能渲染的游戏画布（空场景即可），so that 我能确认这个未来会承接我等待间隙的游戏世界在我的机器上真实跑得起来。
11. 作为后续开发者，我想让游戏壳从第一天就满足像素硬规格——逻辑分辨率 640×360、仅整数倍缩放、`pixelArt + roundPixels`、禁抗锯齿（内联自 game-design §0.3，宪法级规格），so that M1 落第一张像素资产时不会出现灰边、渗色与非整数位移的返工。
12. 作为后续开发者，我想让 Phaser 被**精确锁定**在 3.90.0（无 `^`，tech-stack §1 裁决），并在开发文档中指向 tech-stack §7 的升级触发器，so that 我既不会被 v4 生态漂移误伤，也清楚何时该重新评估升级。
13. 作为后续开发者，我想让 `vite build` 产出可被任意静态服务器托管的产物，so that M5「daemon 同端口静态托管游戏」（tech-stack §1 产品形态裁决）的路从 M0 起就是通的。
14. 作为后续开发者，我想让 game 包内预留 sim 层目录位（tech-stack §3：纯 TS 模拟层，零 Phaser 依赖），且该目录从存在的第一天起就被 lint 边界规则守护，so that 「sim 禁 import phaser」是先于任何游戏逻辑的既成事实，而不是事后补救。
15. 作为玩家，我想让游戏壳此刻**不**包含任何玩法、HUD 或网络代码，so that 我看到的空场景就是真实进度，项目不会用半成品功能制造虚假预期。

### C. daemon 开发链路（packages/daemon）

16. 作为后续开发者，我想让 daemon 在开发态用 tsx watch 直跑、保存即重启（tech-stack §1 裁决），so that 我改一行代码的反馈循环在秒级。
17. 作为后续开发者，我想让 daemon 的发布产物由 tsc 编译为 ESM、不经任何打包器（tech-stack §1 裁决），`node dist` 可直接运行，so that 调试栈帧干净、产物可审计，符合开源产品标准。
18. 作为后续开发者，我想让 M0 的 daemon 入口仅是「可启动、打印版本信息、可干净退出」的占位——**不开端口、不装 hooks、不碰 `~/.claude`**，so that M2 的会话监控功能不被半实现地提前泄漏进脚手架，范围边界清晰可审。
19. 作为玩家，我想确认 M0 的任何代码都不会读取我的 Claude Code 配置或 transcript，so that 在隐私机制（M2 的本地 token、只绑 127.0.0.1）就位之前，仓库不存在任何触碰我工作内容的代码路径。

### D. shared 协议骨架（packages/shared）

20. 作为后续开发者，我想让 shared 包以 zod v4 为唯一运行时依赖、所有跨边界数据形状用 zod schema 定义、TS 类型一律 `z.infer` 导出（tech-stack §1 裁决），so that daemon 与 game 两个运行时共享同一份「schema = 类型 = 校验」三位一体的事实源。
21. 作为后续开发者，我想让 M0 落地协议骨架的最小集：envelope `{ v: 1, type, payload }`、`PROTOCOL_VERSION = 1`、五态 `SessionState`（`working | blocked | done | idle | unknown`）与 `SessionInfo` 字段全集（含 `source` 与可选 `error`，按 hud-sessions §10.4 裁决对齐后的 tech-stack §5 为准），so that M2 开工时协议地基已在，且形状不会与设计定稿出现第二个版本。
22. 作为后续开发者，我想让 theme 模块（设计指认 `shared/src/theme.ts`，game-design §7.3 / §11.2 CODE-28）导出五态状态色 token——working `#4fa4e8` / blocked `#e8a33d` / done `#62a64f` / idle `#9aa0a6` / unknown `#8a8198` / error 修饰 `#d96a6a`（色值内联自设计定稿，事实源为 game-design §7.3），so that M2 的 HUD 与游戏 UI 从同一处取色、永不出现裸 hex 漂移。
23. 作为后续开发者，我想让 shared 包在全仓 `strict` 之上额外开启 `exactOptionalPropertyTypes`（tech-stack §1 裁决），so that 协议中「可选字段」与「值为 undefined」的区别在类型层就被钉死。
24. 作为后续开发者（含 AI agent），我想让 quest 与 save 两个模块位仅以占位形式存在、不含实质 schema，并在占位处注释指向各自的事实源（save → game-design §10.2/§10.3，归 PRD 01；quest → ai-quests §4.6，归 PRD 05），so that 我不会在错误的里程碑实现它们，也不会找不到它们将来该长成什么样。
25. 作为后续开发者，我想让 shared 的非 quest 消息骨架（`auth / hello / snapshot / sessionUpsert / sessionRemoved / heartbeat`）以 tech-stack §5 的形状落 zod 定义，但其语义验证与演进归 M2（PRD 03），so that M0 交付的是「形状正确的骨架」而非「未经集成验证的协议实现」。

### E. 测试、lint 与格式化

26. 作为后续开发者，我想让 Vitest 以根级 projects 模式统一三包（tech-stack §1 裁决），`pnpm test` 一条命令跑全仓，so that 测试入口唯一、新增包自动纳入，不存在「某个包的测试被遗忘」的结构可能。
27. 作为后续开发者，我想让每个包至少有一个真实通过的冒烟测试（shared 为协议 schema 的编解码往返：合法样例 `safeParse` 通过、非法样例被拒；game / sim 与 daemon 为最小纯函数测试占位），so that 测试链路从第一天就是「绿色且非空」的，后来者照样画瓢即可。
28. 作为后续开发者，我想让 ESLint 采用根级单一 flat config、typescript-eslint `recommendedTypeChecked` 类型感知规则集、按包差异化（tech-stack §1 裁决），so that `no-floating-promises` 这类对 daemon 异步代码 load-bearing 的规则从 M0 起生效。
29. 作为后续开发者（含 AI agent），我想让 sim 层架构边界由 `no-restricted-imports` 强制（sim 目录禁 import phaser，tech-stack §1/§6 风险 #10），违规时 `pnpm lint` 退出码非 0，so that 「sim 可 headless 测试」这一全项目最高接缝不依赖任何人的自觉。
30. 作为后续开发者，我想让「`idb-keyval` 仅允许在 game 的 storage 模块内 import」的边界规则（game-design §10.1）随 M0 一并立好，so that M1 实现存档时该纪律已是现成约束而非新增谈判。
31. 作为后续开发者，我想让 Prettier 负责全部格式问题、ESLint 不管格式，`format:check` 进 CI，so that 格式争论被工具终结，AI agent 产出的代码风格自动归一。
32. 作为后续开发者，我想要轻量 pre-commit 钩子（husky + lint-staged，tech-stack §1），只对暂存文件跑 lint + format，so that 坏格式不进历史，且钩子耗时不至于让人想绕过它。

### F. CI

33. 作为后续开发者，我想让每次 push / PR 触发 GitHub Actions 单 job（M1 阶段仅 ubuntu-latest × Node 22，tech-stack §1/§6 风险 #12），按固定顺序执行 frozen-lockfile 安装 → typecheck → lint + format check → test → build，so that 「CI 绿」是一个含义明确、覆盖全链路的可合并信号。
34. 作为后续开发者，我想让 CI 通过 `pnpm/action-setup` 读取 `packageManager` 字段决定 pnpm 版本（tech-stack §6 风险 #11），so that pnpm 版本只在一处声明，CI 与本地永远一致。
35. 作为后续开发者（含 AI agent），我想让 CI 配置中以注释写明矩阵扩展触发器——「macOS 与 Node 24 自 M2 daemon 代码落地起加入」（tech-stack §1 裁决），so that 接手 M2 的人不会漏掉这个与功能同步的基建动作。

### G. 文档

36. 作为开源使用者，我想在 README 看到项目是什么（一段话 + 指向 CLAUDE.md / 设计文档）、当前处于什么阶段（M0 脚手架，尚无玩法）、以及从零跑起来的完整命令序列，so that 我五分钟内能判断这个项目值不值得 star 和试用。
37. 作为开源使用者，我想在 README 看到支持矩阵的诚实声明（macOS / Linux 优先，Windows 为 M5 补位项，tech-stack §6 风险 #12），so that 我不会在未支持的平台上浪费时间后失望离开。
38. 作为开源使用者，我想在文档中看到素材许可白名单（仅 CC0-1.0 与 OFL-1.1，OFL 仅限 Fusion Pixel 字体，game-design §11.1）与「星露谷本体素材绝对禁止」的红线，so that 我对这个仓库的法律干净度有明确预期，贡献素材时也有章可循。
39. 作为后续开发者（含 AI agent），我想要一份开发文档骨架，至少包含：如何新增包、根脚本约定、三包职责一句话、架构边界规则清单（及其设计出处）、版本升级触发器的指针（tech-stack §7），so that 工程决策的「为什么」永远可追溯到设计定稿，而不是口口相传。
40. 作为玩家，我想让文档明确承诺「本地与隐私优先：一切数据不出本机、永无遥测」（CLAUDE.md 设计原则 3 与 game-design §0.4 M5 永久 Out 项），并且 M0 代码与依赖中确实不存在任何上报路径，so that 我从第一天起就能信任把工作上下文交给这个工具的未来形态。

## Implementation Decisions

以下决策均已由设计定稿裁决，本 PRD 只做汇编与指认，不重新论证。

1. **包划分与依赖方向**：`packages/shared`（协议与类型，仅依赖 zod）、`packages/game`（private，游戏客户端）、`packages/daemon`（计划 M5 发布 npm，bin 名 `codestead`）；依赖严格单向 shared ← game / daemon，由 pnpm workspace 协议 + TypeScript project references 双重表达。出处：tech-stack §3。
2. **版本与选型**：全部以 tech-stack §1 决策总表为唯一事实源——Phaser **3.90.0 精确锁定**、TS `~5.9.3`（全仓 `strict`）、Vite `^7.3.5`、tsx `^4.22.4`、pnpm `10.34.1`（`packageManager` 精确锁定）、Node engines `>=22.13.0`、zod `^4.4.3`、ws（M2 才装）、Vitest `^4.1.8` + coverage-v8、ESLint `^10.4.1` flat config + typescript-eslint `^8.61.0` + Prettier `^3.8.4`。本 PRD 不复述各项落选理由；升级一律走 tech-stack §7 触发器，M0 不留任何「顺手升级」空间。
3. **构建策略**：game 用 Vite；daemon / shared 开发态 tsx、产物 tsc 编译 ESM，不引打包器（tech-stack §1）。根脚本契约：`pnpm dev`（并行 Vite dev + daemon tsx watch）、`pnpm -r build / test / typecheck`、`pnpm lint`（tech-stack §3）。
4. **游戏壳硬规格**（内联自 game-design §0.3，宪法级）：逻辑分辨率 640×360（16:9），仅整数倍缩放（×2/×3），`pixelArt + roundPixels` 开启，禁抗锯齿与非整数位移。M0 交付满足该规格的空场景；场景的三场景划分（Boot/Farm/UI）属 M1 实现细节，M0 只需一个可渲染场景。
5. **shared 协议骨架**（形状内联，事实源 tech-stack §5 + hud-sessions §10.4 裁决）：
   - envelope：`{ v: 1, type, payload }`，`PROTOCOL_VERSION = 1`；
   - `SessionState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'`；
   - `SessionInfo`：`sessionId / title(string|null) / subtitle(string|null) / cwd / state / since(ISO 8601) / lastSignalAt / source('hooks'|'transcript'|'process') / error?({ kind })`——字段全集含 `source` 与 `error`，这是 hud-sessions §10.4 对 tech-stack 原文的修正结果，M0 必须落修正后的版本；
   - 非 quest 消息骨架：`auth / hello / snapshot / sessionUpsert / sessionRemoved / heartbeat` 按 tech-stack §5 形状定义；演进规则（加字段不升版、破坏性变更升 `PROTOCOL_VERSION`）写入模块注释；
   - quest / save 模块仅占位：内容分别归 PRD 05（事实源 ai-quests §4.6）与 PRD 01（事实源 game-design §10.2/§10.3）。
6. **theme token**：五态色 token 落 shared 的 theme 模块（设计指认位置见 tech-stack §3 注释行与 game-design §11.2），色值即 game-design §7.3 表（working `#4fa4e8` / blocked `#e8a33d` / done `#62a64f` / idle `#9aa0a6` / unknown `#8a8198` / error `#d96a6a`）。CODE-28 全调色板与游戏侧 palette 归 M1，M0 只落五态 token。
7. **TS 配置**：全仓 `strict: true`；shared 额外 `exactOptionalPropertyTypes`（tech-stack §1）；项目结构保持对 tsgo 友好（project references、无 paths 魔法，tech-stack §1 语言行）。
8. **lint 边界规则**（load-bearing，M0 全部立好）：
   - sim 目录 `no-restricted-imports` 禁 phaser（tech-stack §1/§6 风险 #10）——全项目最高测试接缝的守护规则；
   - `idb-keyval` 仅限 game 的 storage 模块（game-design §10.1）——规则先行，M1 用到时已生效；
   - daemon 启用 `no-floating-promises` 等 `recommendedTypeChecked` 类型感知规则（tech-stack §1）；
   - HUD store 对 sim 零 import 的规则（game-design §7.8）随 M2 的 HUD 目录出现时再加，M0 在开发文档中预告。
9. **CI**：GitHub Actions 单 workflow，M1 阶段仅 `ubuntu-latest × Node 22` 单 job，步骤顺序固定：`pnpm install --frozen-lockfile` → typecheck → lint + format check → test → build（tech-stack §1）。pnpm 版本由 `pnpm/action-setup` 读 `packageManager`（风险 #11）。矩阵扩展（macOS + Node 24）的触发器是「M2 daemon 代码落地」，以注释固化在 workflow 内（风险 #12）。
10. **daemon 占位边界**：M0 的 daemon 不监听任何端口、不读写 `~/.claude` 与 `~/.codestead`、不 spawn 任何进程；入口行为限定为「启动 → 输出版本 → 退出」。这是对「感知不干预」「隐私优先」原则在脚手架阶段的工程化表达，也防止 M2 范围以半成品形式提前泄漏。
11. **文档动作**：随 M0 完成 tech-stack §9 立即行动项第 1 条——在 CLAUDE.md 补注「Phaser 锁 3.90.0，升级触发条件见 tech-stack §7」「使用 zod v4 API」「M5 起 daemon 同端口静态托管游戏产物」。
12. **M0 不引入的依赖**：状态库（裁决：无）、ws / idb-keyval（分别随 M2 / M1 进入）、Playwright（M5）、changesets（M5）、grid-engine 等 Phaser 插件（M1 按需且必须核对 peer 锁 v3）。

## Testing Decisions

原则：只测外部行为，不测实现细节；M0 的「外部行为」就是工具链对各角色的承诺（装得上、跑得起、违规会红、CI 能拦）。全项目六类接缝（tech-stack §1 测试裁决）在 M0 的处置如下：

1. **接缝 b（shared zod schema 编解码）——M0 即建立**。这是 M0 唯一有实质被测对象的接缝：对 envelope、`SessionState`、`SessionInfo` 与非 quest 消息写「合法样例 `safeParse` 通过 / 非法样例（缺字段、错枚举、错版本号）被拒」的往返测试。理由：协议骨架是 M0 的实质交付物，schema 测试只断言输入输出形状，不触碰任何实现内部。
2. **接缝 a（sim 纯函数 headless）——M0 只预留，不建测试**。M0 没有 sim 逻辑可测；该接缝的可行性由两件事保障：sim 目录的 lint 边界规则（违规 lint 即红），以及 Vitest projects 已覆盖 game 包（M1 的「快进 N 天」测试落地时零配置成本）。在 game / daemon 各放一个最小纯函数冒烟测试，目的仅是证明「该包的测试链路是通的」。
3. **接缝 c / d / e（daemon reducer、WS 集成、quest stub claude）——全部推迟**至 PRD 03 / 05，M0 不为不存在的功能写测试骨架，避免空壳测试制造虚假覆盖感。
4. **接缝 f（Playwright 游戏壳冒烟）——按裁决推迟 M5**（tech-stack §1 测试行）。M0 对游戏壳的自动化验证收敛为「`vite build` 在 CI 通过」；「浏览器中空场景实际渲染」在 M0 验收时人工冒烟一次并在 PR 中附截图。理由：为一个空场景引入浏览器自动化与其维护成本不成比例，且设计已裁决其归属。
5. **lint 边界规则的有效性验证**：验收时以一次临时违规改动（sim 内 import phaser）演示 `pnpm lint` 退出码非 0，记录于 PR；**不**为 lint 配置编写常驻测试——测工具配置属于测实现细节，规则回归由日常 lint 自然覆盖。
6. **CI 本身即 M0 的最大集成测试**：流水线五步的顺序与全绿是验收标准的一部分；frozen-lockfile 步骤同时充当「依赖树可复现」的回归测试。

## Out of Scope

依据 game-design §0.4 里程碑边界与附录裁决，下列内容明确不属于 M0，挪动须先修订设计文档：

- **一切 M1-core 玩法与内容**（→ PRD 01）：地图与 .tmj、角色移动、sim 各子系统（time/farming/economy/progression）、存档实现（idb-keyval 依赖随此进入）、save schema 实质内容、背包/UI、新手引导、Kenney 素材与自绘资产入库、`assets/manifest.json` 与 `check:assets` 门禁、SFX 与音量设置、游戏侧 CODE-28 全调色板模块。
- **M1.5 项**（→ PRD 02）：成就页、铜/金档范围交互、拖拽状态机、确定性回放 ×100 等重型验收。
- **全部 M2 功能**（→ PRD 03）：daemon 的 HTTP/WS 服务、三信号源、状态机 reducer、hooks 安装器/卸载器、事件录制器与 fixture、HUD 面板与 HUD store、协议的集成验证与演进；**CI 矩阵扩展（macOS + Node 24）同属 M2**（tech-stack §6 风险 #12）。
- **M3 项**（→ PRD 04）：建造系统、迁移链函数数组与其 CI 守护测试（game-design §10.1：待 v2 引入时再建）、BGM/AudioDirector、Vite 8 / TS 6 升级评估。
- **M4 项**（→ PRD 05）：quest schema 实质内容、headless claude 调用管线、思考笔记。
- **M5 项**（→ PRD 06）：`npx codestead` 单进程托管、tsdown/tsup 单文件评估、Playwright 冒烟、changesets、`assets:import` 自动化与 sha256 重现校验、Web Locks 多标签互斥、存储降级链、Windows 补位、英文文档。
- **永久 Out**（game-design §0.4 M5 行）：云服务、账号体系、遥测——M0 起即不存在任何此类代码与依赖。

## Further Notes

- **素材许可红线**：M0 不引入任何美术/音频/字体资产；许可白名单（仅 CC0-1.0 + OFL-1.1，OFL 仅限 Fusion Pixel 字体）与「Sprout Lands / Sunnyside / Cozy Farm 仅风格参考、星露谷本体素材绝对禁止」的红线先行入文档（game-design §11.1），使 M1 第一次资产入库就有章可循。
- **隐私红线**：M0 的依赖审计标准与功能代码同级——新增任何依赖前核对其无网络上报行为；daemon 占位不触碰用户目录（见 Implementation Decisions 10）。
- **范围纪律风险**：脚手架阶段最常见的失败模式是「顺手多做」——给 daemon 开个端口、给 shared 写全 quest schema、给 CI 加 macOS。本 PRD 已把每一项的归属里程碑写明，review 时按此打回。
- **版本漂移风险**：精确锁定策略（Phaser 3.90.0、pnpm 10.34.1）意味着 Renovate/Dependabot 类自动升级工具若引入须配置忽略清单；任何升级须对照 tech-stack §7 触发器，在里程碑间隙评估。
- **lockfile 即契约**：`pnpm-lock.yaml` 自 M0 起进 git 并被 CI frozen-lockfile 守护；它与 `packageManager` / `engines` 共同构成可复现性的三道锁。
- **对 PRD 01～06 的接口承诺**：M0 交付后，下游 PRD 可以假设——三包可 import shared、`pnpm test` 可纳入新测试文件、sim 边界规则已生效、CI 五步流水线已存在且只需增量扩展（M2 加矩阵、M1 加 `check:assets`）。
