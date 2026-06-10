# Codestead PRD 索引

7 份 PRD 覆盖 M0~M5 全部路线图（M1 拆为 M1-core 与 M1.5 两份）。每份 PRD 均含完整 frontmatter（title / milestone / status / depends_on / design_refs）与七个固定章节：Problem Statement、Solution、User Stories、Implementation Decisions、Testing Decisions、Out of Scope、Further Notes。

| PRD | 里程碑 | 一句话范围 | 依赖 | 状态 |
|---|---|---|---|---|
| [00-m0-scaffold.md](00-m0-scaffold.md) | M0 | pnpm 三包 monorepo 脚手架：工具链、CI、shared 协议骨架与 lint 架构边界规则 | — | ready-for-agent |
| [01-m1-core-farm-loop.md](01-m1-core-farm-loop.md) | M1-core | 完整农场核心循环：地图/移动/6 作物/时间与夜结算/经济/进度/背包/存档 v1/8 SFX | 00 | ready-for-agent |
| [02-m1.5-achievements-polish.md](02-m1.5-achievements-polish.md) | M1.5 | 成就 #1~#14 与成就页、铜/金档范围交互、背包拖拽/撤销/整理、重型验收（与 01 合并为 M1 发布） | 00, 01 | ready-for-agent |
| [03-m2-session-hud-daemon.md](03-m2-session-hud-daemon.md) | M2 | daemon 三源会话状态机、hooks 幂等安装器、WS 推送、左上角会话 HUD（首版 6 项设置） | 00, 01 | ready-for-agent |
| [04-m3-building-audio.md](04-m3-building-audio.md) | M3 | 建造 12 种设施与农舍升级链、Lv6~10/职业/品质、存档 v2 迁移链、BGM 与完整音频管线 | 00, 01, 02, 03 | ready-for-agent |
| [05-m4-ai-quests.md](05-m4-ai-quests.md) | M4 | 村民 3 名、headless claude 任务生成（脱敏/频率护栏/知情同意）、思考笔记、成就 #19/#20 | 00, 01, 02, 03 | ready-for-agent |
| [06-m5-release.md](06-m5-release.md) | M5 | `npx codestead` 单进程产品、存档加固（备份/降级/多标签互斥）、许可审计、中英文档与发布管线 | 00~05 | ready-for-agent |

依赖说明：02（M1.5）与 03（M2）互不依赖、可并行；05（M4）不依赖 04（M3）——道具奖励已裁决推迟，若 M3 延期，M4 可在 M1.5 与 M2 完成后独立实施。依赖图无环。

## 如何使用这些 PRD（面向实现 agent）

1. **先读对应设计文档章节，再读 PRD。** 每份 PRD 的 `design_refs` 列出了它所依据的设计文档章节——`docs/design/tech-stack.md`（技术选型）、`docs/design/game-design.md`（完整 GDD）、`docs/design/hud-sessions.md`（会话 HUD）、`docs/design/ai-quests.md`（AI 关卡）。这四份定稿是**数值与机制的唯一事实源**：作物数据、XP 阈值、状态机转移表、协议字段、面板几何等全表一律以设计文档为准，PRD 只内联 load-bearing 的状态机与数据形状。
2. **PRD 是范围与验收的合同。** In/Out 边界以 PRD 的 User Stories 与 Out of Scope 为准（其权威出处是 game-design §0.4 里程碑表）；不得「顺手多做」Out 清单里的内容，也不得借分期之名裁剪 In 清单。Testing Decisions 章节即验收口径。
3. **实现与设计文档出现任何偏差，必须先修订设计文档再落码**（game-design 文末纪律）；PRD 与设计文档冲突时以设计文档定稿为准，并回修 PRD。

## 测试接缝总策略

全项目六类测试接缝由 tech-stack §1 裁决，各 PRD 的 Testing Decisions 按里程碑取用并注明理由：

- **a — sim 纯函数层 headless 测试**（零 Phaser、零墙钟、确定性 rng，「快进 N 天」毫秒级推演）：M1-core 起的最高接缝，承载经济带宽、红线回归、确定性回放等重型验收（M1.5 放大样本）；
- **b — shared 包 zod schema 编解码测试**（schema = 类型 = 校验 = 契约）：M0 即建立，存档/协议/quest 的 round-trip 与拒绝非法样例贯穿全程；
- **c — daemon 纯函数 reducer + 真实事件 fixture 回放**：M2 会话状态机与 M4 任务生命周期/触发评估的主接缝；
- **d — daemon WS 集成测试**（本地真实起进程，断言协议帧与安全外部行为）：M2 起，M4/M5 增量扩展；
- **e — stub claude 可执行注入**：M4 生成管线的主接缝（不触网、零成本、可注入故障）；
- **f — Playwright 游戏壳冒烟**：按裁决整体推迟 M5，只做冒烟级、跑构建产物。

横切纪律：只测外部行为、不测实现细节；渲染层不写单测（人工验收清单替代）；sim 禁 import phaser 与 HUD store 禁 import sim 等架构边界由 ESLint `no-restricted-imports` 静态看护，不写运行时测试。
