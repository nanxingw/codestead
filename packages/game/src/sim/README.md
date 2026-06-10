# sim/ — 纯 TS 模拟层（占位，M1 落地）

这里是 Codestead 的模拟核心目录位：农场玩法的全部规则与数值（time / farming / economy /
progression 等子系统）将在 M1（PRD 01）落在这里。M0 阶段本目录只有这份边界说明。

## 边界规则（load-bearing，自第一天起生效）

1. **零 Phaser 依赖**：`sim/**` 内禁止 `import 'phaser'`，由根 `eslint.config.js` 的
   `no-restricted-imports` 强制（违规则 `pnpm lint` 退出码非 0）。
   出处：docs/design/tech-stack.md §1「游戏状态管理」与 §6 风险 #10。
2. **确定性 tick**：sim 是纯 TS 模拟层，状态推进只依赖输入与当前状态，不依赖渲染帧率、
   不读 DOM、不碰网络。Phaser 场景只做渲染与输入转译。
3. **可 headless 测试**：因为 1 + 2，sim 可以在 Node 里直接跑「快进 N 天」级别的
   经济/生长测试（docs/design/mechanics.md 数值自检清单的代码化形态），这是全项目
   最高的测试接缝（tech-stack §1 测试裁决，接缝 a）。
4. **依赖方向**：sim 可以 import `@codestead/shared`（类型与 schema），不可以 import
   场景层（`../scenes` 等渲染代码）；事件向外用回调/事件发射器暴露，由场景层订阅。

> 修改或放宽以上任何一条之前，先修订 docs/design/tech-stack.md 并过 review。
