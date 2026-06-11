# Codestead 🌾

一款星露谷风格的像素农场游戏，也是你所有 Claude Code 会话的「候车室」。

当 AI 在写代码时，与其刷手机把注意力撕成碎片，不如来 Codestead 种一垄菜：

- 🚜 **真正好玩的农场游戏** — 开垦、种植、收割、出售、建造房屋、升级农场；
- 👀 **会话状态 HUD** — 左上角实时显示每个 Claude Code 会话是在工作、还是在等你输入；
- 🧙 **AI 生成的村民任务** — 后端 Claude Code 根据你正在做的工作即时生成 NPC 对话，陪你把架构和决策想清楚，还有游戏内奖励。

完整的初衷、理想形态与路线图见 [CLAUDE.md](CLAUDE.md)；技术裁决见 [docs/design/tech-stack.md](docs/design/tech-stack.md)。

> **当前状态：M1（农场核心循环 + 成就与打磨）。** 游戏已可玩：64×48 的农场地图、
> 角色移动、开垦/种植/浇水/收割 6 种春季作物、出货箱过夜结算、商店买种与工具升级
> （铜/金档范围工具）、金币与农场等级（Lv1~5）、游戏内时间与天气、22 条成就数据表
> （#1~#14 可解锁）、背包拖拽/撤销槽/一键整理、IndexedDB 存档 + JSON 导入导出。
> **尚无会话 HUD 与 AI 关卡**——后续里程碑（M2 会话 HUD → M3 建造 → M4 AI 关卡 →
> M5 开源发布）见 CLAUDE.md；M1 已知限制见下文「支持矩阵与已知限制」。

## 环境要求

- **Node.js ≥ 22.13.0**（`engines` 强制，过老版本安装即报错）；
- **pnpm 10**（精确锁定 `pnpm@10.34.1`，见根 `package.json` 的 `packageManager` 字段）。

安装 pnpm 的两种方式（**不依赖 corepack**，corepack 已从新版 Node 剥离）：

```bash
# 方式一：npm 全局安装
npm install -g pnpm@10

# 方式二：standalone 脚本（无需已有 Node 包管理器）
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

> 也可以用 corepack（若你的 Node 仍带它）：`corepack prepare pnpm@10.34.1 --activate`。

## 快速开始

```bash
git clone https://github.com/nanxingw/codestead.git
cd codestead
pnpm install          # 装齐三个包的全部依赖
pnpm -r typecheck     # 首次需要：编译 shared 的类型产物（lint/test 依赖它）
pnpm dev              # 并行拉起 game 的 Vite dev server + daemon 的 tsx watch
```

打开终端里 Vite 打印的地址（默认 `http://localhost:5173`），主菜单点「新游戏」即可
开始种田（WASD 移动、E 交互、Tab 背包、Esc 菜单，键位说明在暂停菜单里）。

## 常用命令

| 命令                                | 作用                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`                          | 并行启动 Vite dev server 与 daemon tsx watch                                       |
| `pnpm -r build`                     | 全仓构建（shared/daemon → tsc ESM；game → vite build，产物可被任意静态服务器托管） |
| `pnpm test` / `pnpm -r test`        | Vitest 根级 projects 跑全仓 / 按包跑                                               |
| `pnpm -r typecheck`                 | 全仓类型检查（`tsc -b` project references，增量）                                  |
| `pnpm lint`                         | ESLint（type-aware + 架构边界规则；违规退出码非 0）                                |
| `pnpm format` / `pnpm format:check` | Prettier 写入 / 校验（格式问题全归 Prettier，ESLint 不管格式）                     |

> 注意顺序：`lint` / `test` 依赖 `@codestead/shared` 的 `dist` 类型产物，fresh clone 后
> 先跑一次 `pnpm -r typecheck` 或 `pnpm -r build`。CI 流水线即按此顺序执行。

## 仓库结构与三包职责

```
packages/
├── shared/   # 协议与类型：zod v4 单一事实源（envelope、SessionState、SessionInfo、theme 色 token）
├── game/     # 游戏客户端：Phaser 3.90.0 + Vite 7，跑在浏览器里；src/sim/ 为纯 TS 模拟层（M1）
└── daemon/   # 本地守护进程：Node + tsx 开发 / tsc ESM 产物；M0 仅占位（启动→打印版本→退出）
```

依赖方向严格单向：**shared ← game / daemon**（game 与 daemon 互不依赖），由 pnpm
workspace + TypeScript project references 双重表达。不引任务编排器（无 Turborepo/Nx）。

### 如何新增一个包

1. 在 `packages/<name>/` 建 `package.json`（`@codestead/<name>`，`"type": "module"`）；
2. 建 `tsconfig.json`（宽配置，IDE/lint 用）与 `tsconfig.build.json`（composite，挂进根
   `tsconfig.json` 的 `references`）；
3. 建 `vitest.config.ts`（`defineProject`），根级 `projects: ['packages/*']` 会自动纳入；
4. 依赖只允许指向 `shared`（`workspace:*`）；新增任何外部依赖前核对其无网络上报行为。

## 架构边界规则（自动化守护，违规 lint 即红）

| 规则                                                                       | 守护方式                                   | 设计出处                    |
| -------------------------------------------------------------------------- | ------------------------------------------ | --------------------------- |
| `game/src/sim/**` 禁止 import `phaser`（sim 必须可 headless 测试）         | ESLint `no-restricted-imports`             | tech-stack §1 / §6 风险 #10 |
| `idb-keyval` 仅允许在 `game/src/storage/**` 内 import（M1 生效，规则已立） | ESLint `no-restricted-imports`             | game-design §10.1           |
| shared 在全仓 `strict` 之上加开 `exactOptionalPropertyTypes`               | tsconfig                                   | tech-stack §1               |
| daemon 异步代码 `no-floating-promises` 等类型感知规则                      | typescript-eslint `recommendedTypeChecked` | tech-stack §1               |
| HUD store 对 sim 零 import（M2 HUD 目录出现时再加规则，此处预告）          | （M2 起）ESLint                            | game-design §7.8            |

## 版本锁定与升级纪律

Phaser **3.90.0**、pnpm **10.34.1** 为精确锁定，TS/Vite/zod 等版本以
[tech-stack.md §1 决策总表](docs/design/tech-stack.md) 为唯一事实源；任何升级须对照
[§7 升级触发器](docs/design/tech-stack.md)，在里程碑间隙评估，不留「顺手升级」空间。
`pnpm-lock.yaml` 进 git 并被 CI `--frozen-lockfile` 守护，与 `packageManager`、`engines`
共同构成可复现性的三道锁。

## 支持矩阵与已知限制（诚实声明）

| 平台          | 状态                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| macOS / Linux | 优先支持；CI 当前为 ubuntu × Node 22 单 job，M2 daemon 落地起加入 macOS 与 Node 24 |
| Windows       | M5 前的补位项，当前未验证                                                          |

M1 已知限制（US109，修复计划见各里程碑 PRD）：

- **同一存档开双标签页的行为未定义**——两个 tab 会写同一份存档，可能互相覆盖。
  Web Locks 多标签互斥与「接管」流程随 M5 落地（game-design §2.9/§10.5）；
- **存档仅依赖 IndexedDB，无降级链**——隐私模式/禁用 IDB 的浏览器无法持久化
  （会得到温和提示，建议用设置里的「导出存档 JSON」做备份）；backup/corrupt
  恢复链与存储降级链归 M5；
- **Windows 未验证**（见上表，M5 补位）。

## 素材许可白名单与红线

- 白名单：**CC0-1.0** 与 **OFL-1.1**（OFL 仅限 Fusion Pixel 字体，仓库须附 OFL 全文）；
  除该字体外，进仓库的一切美术/音频资产仅限 CC0（Kenney / FreePD 体系），
  `assets/manifest.json` 逐文件追溯（M1 起）；
- 红线：做的是星露谷「风格」——**星露谷本体素材绝对禁止**；Sprout Lands / Sunnyside /
  Cozy Farm 等「可商用禁再分发」素材不得进仓库，仅作风格参考。
  出处：game-design §11.1。

## 本地与隐私优先

**一切数据不出本机，永无遥测、永无云服务与账号体系。** M0 的代码与依赖中不存在任何
上报路径；daemon 占位入口不开端口、不读写 `~/.claude` 与 `~/.codestead`、不 spawn 进程。
M2 实现会话监控时将采用本地 token + 仅绑定 `127.0.0.1` 的隐私机制，并在 README 明示
hooks 安装/卸载行为。

## 贡献

- 提交前会触发 husky pre-commit（lint-staged：仅对暂存文件跑 ESLint + Prettier）；
- 代码标识符与注释用英文，面向用户的文档中文优先；
- 工程决策不在 PR 里重新辩论——先读 `docs/design/`，要改先改设计文档。
