# 引擎选型调研：星露谷风格 2D 像素农场网页游戏（TypeScript）

> 调研日期：2026-06-10。版本号与下载量均为当日实查（npm registry / GitHub API / 官方公告）。
> 候选：Phaser 3 / Phaser 4、Excalibur.js、KAPLAY、PixiJS 自研。
> 结论先行：**选 Phaser 4（v4.1.0）**，理由见文末；CLAUDE.md 中「Phaser 3」的表述建议更新为「Phaser 4」。

---

## 1. 版本与社区活跃度速览（2026-06-10 实查）

| 引擎 | 最新稳定版 | 发布时间 | GitHub stars | npm 周下载（2026-05-27 ~ 06-02） | 许可证 |
|---|---|---|---|---|---|
| Phaser | **v4.1.0 "Salusa"**（npm `latest`） | 2026-04-30 | 39,753（repo 最后 push：2026-06-10） | 254,385 | MIT |
| Phaser 3（终版） | v3.90.0 "Tsugumi" | 2025-05-23 | （同上仓库） | （同上包） | MIT |
| Excalibur.js | v0.32.0（pre-1.0） | 约 2026-01（npm「5 个月前」） | 2,291（最后 push：2026-06-09） | 11,809 | BSD-2 |
| KAPLAY | v3001.0.19 | 持续滚动发布 | 1,562（最后 push：2026-06-09） | 6,321 | MIT |
| PixiJS | v8.19.0 | 持续发布（WebGL + WebGPU） | 47,359（最后 push：2026-06-09） | 666,776 | MIT |

数据来源：
- npm 下载量：`https://api.npmjs.org/downloads/point/last-week/phaser,excalibur,kaplay,pixi.js`（实查 JSON）
- npm dist-tags：`phaser@latest = 4.1.0`，`4.0.0` 发布于 2026-04-10，`4.1.0` 发布于 2026-04-30（registry.npmjs.org 实查）
- GitHub stars：GitHub API `repos/<owner>/<repo>` 实查

## 2. Phaser：3 的终结与 4 的发布（关键时间线）

- **Phaser v3.90.0 "Tsugumi"**（2025-05-23）官方明确「很可能是 v3 的最后一个版本，团队全部精力转向 v4」。来源：[Phaser v3.90 Released](https://phaser.io/news/2025/05/phaser-v390-released)、[下载页](https://phaser.io/download/stable)
- **Phaser v4.0.0 "Caladan"** 于 **2026-04-10** 正式发布——官方称「Phaser 史上最大版本」：WebGL 渲染器从零重写为 **Render Node 架构**，但保留既有 API。来源：[v4.0.0 下载页](https://phaser.io/download/release/v4.0.0)、[GameFromScratch 评测](https://gamefromscratch.com/phaser-4-released/)
- **Phaser v4.1.0 "Salusa"**（2026-04-30）：更智能的渲染、ESM 修复。来源：[官方公告](https://phaser.io/news/2026/04/phaser-4-1-0-salusa-release)
- 官方对比文章 [Phaser 3 vs Phaser 4](https://phaser.io/news/2026/05/phaser-3-vs-phaser-4)：**大多数标准项目迁移成本极小**；sprite / text / physics / scene 管理与 v3 兼容，仅自定义 WebGL pipeline 需改写为 render node。

### Phaser 4 与本项目直接相关的新能力

- **TilemapGPULayer**：单 draw call 渲染整层 tilemap，渲染成本与可见瓦片数量无关；支持最大 4096×4096 瓦片地图（约 1600 万瓦片）；`Tilemap.createLayer()` 传 `gpu` 标志启用；**仅限正交（orthogonal）地图**——农场游戏正是正交地图，完美命中。来源：[v4.0.0 CHANGELOG](https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/CHANGELOG-v4.0.0.md)
- **SpriteGPULayer**：单 draw call 渲染百万级精灵，官方称比常规渲染快至 100 倍（适合大片农作物/粒子）。
- **统一 Filter 系统**（FX + Mask 合并）、`sprite.setLighting(true)` 一行开灯光（支持自阴影）、PCT 纹理图集格式（比 JSON 图集小 90-95%）。
- 注意：**Canvas 渲染器保留但官方视为弃用**；`roundPixels` 默认值由开启改为 `false`；新增 `smoothPixelArt` 选项（锐利纹素 + 抗锯齿平滑）。

## 3. 维度对比

### 3.1 Tilemap 支持

| 引擎 | 内置 Tilemap | Tiled 编辑器支持 | 备注 |
|---|---|---|---|
| **Phaser 4** | 强（继承 v3 完整 API） | Tiled JSON / CSV / 二维数组；正交、等距、六边形、staggered 四种朝向；图层自动相机剔除 | 另有 TilemapGPULayer（正交专用，固定渲染成本）。来源：[Phaser Tilemap 文档](https://docs.phaser.io/api-documentation/class/tilemaps-tilemaplayer)、[rex notes（已更新至 Phaser 4）](https://rexrainbow.github.io/phaser3-rex-notes/docs/site/tilemap/) |
| **Excalibur** | 有 `TileMap` 类 | 官方插件 [@excaliburjs/plugin-tiled](https://www.npmjs.com/package/@excaliburjs/plugin-tiled)：解析 .tmx/.tmj/.tsx/.tsj/.tx 全量数据；正交 + 等距；支持无限地图、全部 tileset 类型、`solid` 自定义属性、瓦片自定义碰撞体；不支持六边形与 staggered 等距 | 质量很高的官方一方插件。来源：[插件文档](https://excaliburjs.com/docs/tiled-plugin/)、[GitHub](https://github.com/excaliburjs/excalibur-tiled) |
| **KAPLAY** | `addLevel()`（ASCII 字符网格）+ `tile()` 组件（含寻路 agent） | 无官方 Tiled 支持；第三方插件仅支持「有限正交 JSON、每图单 tileset」 | 最弱项。来源：[tile 文档](https://kaplayjs.com/docs/api/ctx/tile/)、[kaplay-plugin-tiled](https://remarkablegames.org/posts/kaplay-plugin-tiled/) |
| **PixiJS 自研** | 无，仅渲染库 | 需自己集成 [@pixi/tilemap](https://www.npmjs.com/package/@pixi/tilemap)（v5.0.2，周下载 3,877）+ 自写 Tiled 解析或引第三方 | 所有 gameplay 层（碰撞、剔除、图层语义）自建 |

### 3.2 像素渲染（缩放 / 抗锯齿控制）——具体字段

- **Phaser 4**：`new Phaser.Game({ pixelArt: true, roundPixels: true })`——`pixelArt` 一键 nearest 采样；v4 新增 `smoothPixelArt`（缩放非整数倍时仍保持纹素锐利）；`roundPixels` v4 默认 `false` 且仅对轴对齐未缩放对象生效（防闪烁）。
- **Excalibur**：`new ex.Engine({ pixelArt: true })`——官方"pretty pixel art"专用着色器（带抗锯齿的像素艺术混合）；另有 `antialiasing: boolean | AntialiasOptions`、`pixelRatio: number`、`snapToPixel: boolean`（默认 false）、`uvPadding`（pixelArt 模式默认 0.25，防 spritesheet 采样溢出）。来源：[EngineOptions API](https://excaliburjs.com/api/interface/EngineOptions/)
- **KAPLAY**：`kaplay({ crisp: true, scale: 2, texFilter: "nearest", pixelDensity: 1 })`。来源：[KAPLAYOpt 文档](https://kaplayjs.com/docs/api/KAPLAYOpt/)
- **PixiJS**：`TextureSource.defaultOptions.scaleMode = 'nearest'` 全局设置 + `Application` 的 `roundPixels` / `antialias: false`，控制粒度最细但全靠自己组装。

### 3.3 性能

- **Phaser 4**：本场景最优解——TilemapGPULayer（地图渲染成本恒定）+ SpriteGPULayer（百万精灵单 draw call）直接覆盖「大地图 + 海量农作物」两个农场游戏热点。
- **PixiJS v8**：底层最快（WebGPU 后端，多 batch break 场景更优），但拿到等价能力要自己写。
- **Excalibur**：对中小型 2D 游戏足够；无 GPU 级 tilemap 优化宣传。
- **KAPLAY**：面向 game jam 体量；`pixelDensity` 高时官方自述伤性能。

### 3.4 生态与文档

- **Phaser**：4,000+ 官方示例、[docs.phaser.io](https://docs.phaser.io)、Phaser Editor、活跃 Discord/论坛；周下载 25.4 万（游戏框架第一）。风险：v4 发布仅 2 个月，第三方插件（grid-engine、rex plugins 等）适配进行中（rex notes 已标注 Phaser 4）。
- **PixiJS**：周下载 66.7 万、47k stars，但定位是渲染库；游戏向生态零散。
- **Excalibur**：文档质量高、官方插件齐（tiled/aseprite/ldtk），但 pre-1.0（v0.x 官方自述"rough around the edges"，破坏性变更可期）。
- **KAPLAY**：[2026 路线图](https://github.com/kaplayjs/kaplay/wiki/KAPLAY-Roadmap-2026)中 v4000「暂无计划」；版本号体系（3001.x）独特；社区最小。

### 3.5 TypeScript 类型完备度

- **Excalibur**：唯一**用 TS 从零写成**的引擎，类型即源码，最完备。
- **KAPLAY**：TS 编写，类型好，但大量全局上下文函数的风格使类型收益打折。
- **PixiJS**：TS 编写，v8 单包单入口（`import {} from 'pixi.js'`），tree-shaking 友好，类型优秀。
- **Phaser 4**：源码仍是 JS，但官方一方 `.d.ts`（由占代码 84% 的 JSDoc 生成）随包分发（package.json `types` 字段），VSCode 开箱即用；v3 时代类型偶有边角不准，v4.0/4.1 含社区类型修复。来源：[npm phaser](https://www.npmjs.com/package/phaser)、[安装文档](https://docs.phaser.io/phaser/getting-started/installation)

### 3.6 AI 辅助开发友好度（Claude Code 实际开发视角）

- **Phaser**：训练语料量级遥遥领先（十余年教程、4,000+ 示例、海量开源游戏），AI 生成 Phaser 代码正确率最高。注意点：语料以 Phaser 3 为主，但 v4 与 v3 API 高度兼容，知识可直接迁移；需在 CLAUDE.md 注明「使用 Phaser 4，自定义渲染用 render node 而非 pipeline，roundPixels 默认已为 false」等差异。
- **PixiJS**：语料丰富，且是四者中**唯一提供 `llms.txt`**（https://pixijs.com/llms.txt，实测 HTTP 200；其余三家均 404）；但「自研引擎」意味着 AI 要在无既定框架约束下编排大量自建系统，出错面大。
- **Excalibur / KAPLAY**：语料少一到两个量级，AI 易混入 Phaser 习语或幻觉 API；Excalibur pre-1.0 的 API 漂移进一步降低 AI 输出可靠性。

## 4. 结论与建议

**推荐：Phaser 4（v4.1.0+）**。理由按项目设计原则排序：

1. **游戏第一**：tilemap（含 Tiled 工作流）、相机、动画、输入、Arcade 物理、粒子、时间事件全部内置，是四者中唯一"农场游戏所需能力全覆盖"的选择；TilemapGPULayer/SpriteGPULayer 直接解决大地图与海量作物的性能热点。
2. **AI 辅助开发**：最大训练语料 + v3/v4 API 兼容，Claude Code 产出代码可靠性最高——对本项目（以 AI 结对为主的开发方式）权重极高。
3. **开源产品标准**：MIT、25 万周下载、官方全职团队、文档与示例体系成熟。

**风险与对策**：
- v4 发布仅 2 个月 → 锁定 `phaser@^4.1.0`，遇 v4 回归 bug 时 v3.90 是 API 兼容的退路；第三方插件优先选已声明支持 v4 的（rex notes 已适配）。
- AI 语料偏 v3 → 在 CLAUDE.md 写明 v3→v4 差异清单（render node、roundPixels 默认值、Filter 替代 FX/Mask）。

**次选**：Excalibur.js——若极度看重「原生 TS + 官方 Tiled 插件」可选，但 pre-1.0 + 社区规模小，与 M5 开源发布目标冲突。**不推荐**：KAPLAY（tilemap 太弱、体量面向 jam）；PixiJS 自研（违背「游戏第一」——时间会耗在造引擎而非做玩法上）。

**起步配置示例**（packages/game）：

```ts
import Phaser from 'phaser'; // ^4.1.0

new Phaser.Game({
  type: Phaser.WEBGL,
  width: 640,
  height: 360,            // 16x16 tile 下约 40x22.5 格视野
  zoom: 2,                // 整数倍放大保证像素锐利
  pixelArt: true,         // nearest 采样
  roundPixels: true,      // v4 默认 false，像素风需显式开启
  scene: [BootScene, FarmScene],
});
```

## 5. 来源清单

- Phaser v4.0.0 发布：https://phaser.io/download/release/v4.0.0
- Phaser v4.1.0 公告：https://phaser.io/news/2026/04/phaser-4-1-0-salusa-release
- Phaser 3 vs 4 官方对比：https://phaser.io/news/2026/05/phaser-3-vs-phaser-4
- Phaser v3.90 公告（v3 终版声明）：https://phaser.io/news/2025/05/phaser-v390-released
- Phaser 4.0.0 CHANGELOG（TilemapGPULayer/roundPixels/smoothPixelArt）：https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/CHANGELOG-v4.0.0.md
- GameFromScratch Phaser 4 评测：https://gamefromscratch.com/phaser-4-released/
- Excalibur 仓库 / 文档 / Tiled 插件：https://github.com/excaliburjs/Excalibur 、https://excaliburjs.com/api/interface/EngineOptions/ 、https://excaliburjs.com/docs/tiled-plugin/
- KAPLAY 官网 / 2026 路线图 / KAPLAYOpt：https://kaplayjs.com/ 、https://github.com/kaplayjs/kaplay/wiki/KAPLAY-Roadmap-2026 、https://kaplayjs.com/docs/api/KAPLAYOpt/
- PixiJS v8 发布与更新：https://pixijs.com/blog/pixi-v8-launches 、https://pixijs.com/blog/8.16.0 、llms.txt：https://pixijs.com/llms.txt
- @pixi/tilemap：https://www.npmjs.com/package/@pixi/tilemap
- npm 下载量 API（实查 2026-06-10）：https://api.npmjs.org/downloads/point/last-week/phaser,excalibur,kaplay,pixi.js
