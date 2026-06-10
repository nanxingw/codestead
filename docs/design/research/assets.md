# 美术与音频素材调研纪要

> 调研日期：2026-06-10 ｜ 范围：适合星露谷风格 2D 像素农场游戏（Codestead M1）的免费可商用素材
> 红线：绝不使用星露谷（Stardew Valley）本体素材或仿冒/提取素材，只做「风格」致敬。

## 0. 筛选标准

按 CLAUDE.md 的设计原则（开源产品标准、本地优先）制定：

1. **可商用**：许可证明确允许 commercial use；
2. **可入开源仓库**：Codestead 是公开 GitHub 仓库，素材文件 commit 进 repo 等同于「再分发（redistribution）」。这是本次调研最关键的区分点——itch.io 上大量「免费可商用」素材包**禁止再分发原始文件**，这类素材不能直接进仓库；
3. **tile 尺寸**：优先 16×16（星露谷同款尺寸，Phaser 3 tilemap 直接支持）；
4. **署名要求**：CC0 无需署名最省心；CC-BY / CC-BY-SA 需在 CREDITS 文件中署名。

### 许可证速查

| 许可证 | 商用 | 入开源仓库（再分发） | 署名 | 备注 |
|---|---|---|---|---|
| CC0 1.0 | ✅ | ✅ | 不需要 | 最安全，无任何义务 |
| CC-BY 3.0/4.0 | ✅ | ✅ | 必须 | 写明作者+链接即可 |
| CC-BY-SA 3.0 / GPL 3.0（LPC 双许可） | ✅ | ✅ | 必须 | 对素材的修改稿须以同许可发布（仅传染美术衍生物，不传染游戏代码） |
| itch.io 常见自定义许可（“可商用但不可 resell/redistribute”） | ✅ | ❌（风险） | 视作者而定 | 不能把原始文件 commit 进公开仓库；需用户自行下载或取得作者书面许可 |

---

## 1. Sprout Lands（Cup Nooble）——风格最贴合，但许可受限

- 页面：<https://cupnooble.itch.io/sprout-lands-asset-pack>（另有 [UI Pack](https://cupnooble.itch.io/sprout-lands-ui-pack)）
- **tile 尺寸**：16×16，柔和马卡龙色系顶视角，是 itch.io 上最接近星露谷氛围的免费包之一。
- **内容**：草地/水面 tile、角色 6 类动画（idle / walk / run / 耕地 / 砍树 / 浇水，共 24 个方向变体）、农场动物（鸡、牛）、作物与植物、装饰 tile；Premium 版额外含更多动物变体与扩展 tileset。
- **许可（原文摘录）**：
  - 免费版：*“This asset pack can be used in any non-commercial project … can't be used in any commercial project, resold/redistributed, even if modified”*，且要求署名 “Cup Nooble”。
  - Premium 版（$3.99 起，pay-what-you-want）：*“can be used in any commercial or non-commercial project … can't be resold or redistributed even if modified”*。
- **结论**：免费版**禁商用**，直接排除；Premium 版可商用但**禁再分发**——不能 commit 进公开仓库。若坚持要用，只能走「构建脚本引导用户自行购买/下载」路线，对开源产品安装体验不友好。**建议仅作风格参考（reference），不作为实际资产来源。**

## 2. Sunnyside World（Daniel Diggle）——免费可商用、内容最全，但禁再分发

- 页面：<https://danieldiggle.itch.io/sunnyside>（作者站：<https://danieldiggle.com/sunnysideworld.php>）
- **tile 尺寸**：16×16 tileset；角色 sprite 为左右朝向（类似 Forager / Atomicrops），支持调色板换色生成发色/肤色变体（自带 7 种发型）。
- **内容**：明确面向农场游戏——种地、建造、钓鱼、探索、战斗；角色动画极全：Idle / Walk / Run / Roll / Jump / Hurt / Death / Carry / Attack / Swim / 砍树 / 挖矿 / 建造 / 钓鱼；tileset 含建筑、室内、地形、自然物。
- **许可（页面表述）**：可用于免费与商业项目，**署名非必须**（appreciated）；但 *“may not repackage and resell the assets, no matter how much they are modified”*——禁止再打包分发。
- **结论**：单机商用没问题，但与 Sprout Lands 同样**不能直接入开源仓库**。备选：联系作者取得「随开源游戏仓库分发」的书面许可（itch.io 上有作者活跃回复记录，可尝试）。

## 3. Cozy Farm（shubibubi）——同类许可

- 页面：<https://shubibubi.itch.io/cozy-farm>
- 免费（pay-what-you-want）；许可：*“can be used in any commercial or non commercial project … can't be resold or redistributed even if modified”*。
- 内容为农场主题 tile/动物/作物；页面未明确标注 tile 尺寸（需下载核实，社区普遍按 16×16 使用）。
- **结论**：与 Sunnyside 同类——可商用、**禁再分发**，不适合直接入仓库。

## 4. Cute Fantasy RPG（Kenmi）——同类许可

- 页面：<https://kenmi-art.itch.io/cute-fantasy-rpg>
- 16×16 顶视角，Premium（约 $3.99）可商用；明确说明 *“Assets can't be redistributed even if modified … letting people download them for free would be a violation”*。
- **结论**：风格可爱、扩展包多（Dungeon / Desert / UI），但**禁再分发**条款对开源仓库是硬伤。

## 5. Kenney（kenney.nl）——全部 CC0，开源仓库首选 ✅

全站素材 CC0 1.0（公有领域），可商用、可修改、可再分发、无署名义务，是唯一能无顾虑 commit 进公开仓库的大型来源。农场相关包：

| 包 | 链接 | 规格 | 内容 |
|---|---|---|---|
| Roguelike/RPG pack | <https://kenney.nl/assets/roguelike-rpg-pack> | 16×16，1700+ tiles | 顶视角：地板/墙/屋顶、树木灌木、门窗、家具、矿物、旗帜、UI 面板按钮；含 spritesheet 与示例地图 |
| Tiny Town | <https://kenney.nl/assets/tiny-town> | 16×16，130 assets | 顶视角城镇/overworld，与 Tiny Dungeon 等 “Tiny” 系列同风格可混用 |
| Pixel Platformer Farm Expansion | <https://kenney.nl/assets/pixel-platformer-farm-expansion> | 110 assets | 作物、秋季树木、模块化温室——注意是**侧视角平台**风格，顶视角农场需改造后用 |
| Audio 系列 | <https://kenney.nl/assets/category:Audio> | WAV/OGG | UI Audio（50）、Impact Sounds（130）、Interface/RPG 音效等，全 CC0 |

- **结论**：许可最干净，但美术风格偏「简洁卡通」，氛围感不如 Sprout Lands/Sunnyside；适合做**占位资产与 UI/音效底座**，正式美术可后续替换或委托定制。

## 6. LPC（Liberated Pixel Cup）——可入仓库的完整 RPG 资产体系 ✅（有署名与 SA 义务）

- 基础资产：<https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles>；资产仓库：<https://github.com/OpenGameArt/LiberatedPixelCup>；精选合集：<https://github.com/ElizaWy/LPC>
- **许可**：CC-BY-SA 3.0 与 GPL 3.0 **双许可**（二选一遵守）。允许商用与再分发 → **可以 commit 进开源仓库**；义务：附许可证全文 + 逐作者署名（资产 tarball 内 README.txt 提供完整作者信息）；ShareAlike 仅传染「由 LPC 美术直接衍生的美术」，不传染游戏代码与其他来源素材（官方说明：<https://lpc.opengameart.org/content/properly-licensing-your-liberated-pixel-cup-game-entry>）。
- **tile 尺寸**：32×32（角色帧 64×64），与 16×16 体系**不混搭**，选 LPC 意味着整体走 32×32。
- **农场内容**：Daniel Eddeland 的 [LPC Farming Tilesets](https://opengameart.org/content/lpc-farming-tilesets-magic-animations-and-ui-elements)（LPC 美术赛大奖作品）：小麦、玉米、番茄等作物、栅栏、沙地/草地、农具道具、UI 元素；另有 [LPC Crops](https://opengameart.org/content/lpc-crops)、[LPC Farm](https://opengameart.org/content/lpc-farm) 等社区扩展。
- **角色生成器**：[Universal LPC Spritesheet Character Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/)（[源码](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator)）——在线组合身体/发型/服装/工具，导出带逐部件署名信息的 spritesheet，对「玩家自定义形象 + NPC 量产」极有价值。
- **结论**：唯一「内容全 + 可再分发」的体系；代价是 32×32 风格偏写实欧美像素、署名管理成本、SA 传染美术衍生物。

## 7. 音频来源（CC0）

1. **Kenney Audio**（<https://kenney.nl/assets/category:Audio>）：CC0 音效——UI Audio（50 个）、Impact Sounds（130 个）、Interface/RPG 系列，覆盖 M1 所需的点击/收割/金币等反馈音。
2. **FreePD**（Kevin MacLeod 创办）：全站音乐 CC0 1.0。⚠️ 官网 freepd.com 已于 2025 年关站，但 CC0 授权不可撤销，GitHub 镜像可正常使用：<https://github.com/0lhi/FreePD>（286 首主目录曲目）。轻快田园曲目适合做 BGM。
3. 补充：OpenGameArt（<https://opengameart.org>）音乐区可按许可证筛选 CC0，作为 BGM 第二来源。

## 8. 推荐方案

**主方案（M1 起步）**：Kenney CC0（Roguelike/RPG pack + Tiny Town 做地形/建筑/UI 占位）+ Kenney Audio + FreePD 镜像 BGM。全 CC0，零署名义务，可直接 commit，安装体验零摩擦，符合「开源产品标准」。

**备选方案 A（更强 RPG 氛围）**：整体切 32×32 走 LPC 体系（基础资产 + Eddeland 农耕包 + 角色生成器），仓库内附 `CREDITS.md` 与 CC-BY-SA/GPL 许可证全文。

**备选方案 B（最佳观感）**：联系 Daniel Diggle（Sunnyside World）洽谈开源仓库分发许可；谈不下来则提供 `scripts/fetch-assets.ts` 引导用户自行从 itch.io 下载（牺牲安装体验）。

**资产清单字段规范（建议在 `packages/game/assets/manifest.json` 维护，逐文件可追溯）**：

```jsonc
{
  "id": "kenney-roguelike-rpg",
  "name": "Roguelike/RPG pack",
  "author": "Kenney",
  "source": "https://kenney.nl/assets/roguelike-rpg-pack",
  "license": "CC0-1.0",
  "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
  "attributionRequired": false,
  "redistributable": true,
  "tileSize": 16,
  "files": ["tilesets/roguelike-rpg.png"],
  "modified": false   // 若为 LPC 衍生改稿则置 true 并以 CC-BY-SA 发布该改稿
}
```

## 来源链接汇总

- Sprout Lands：<https://cupnooble.itch.io/sprout-lands-asset-pack> ｜ UI：<https://cupnooble.itch.io/sprout-lands-ui-pack>
- Sunnyside World：<https://danieldiggle.itch.io/sunnyside> ｜ <https://danieldiggle.com/sunnysideworld.php>
- Cozy Farm：<https://shubibubi.itch.io/cozy-farm>
- Cute Fantasy RPG：<https://kenmi-art.itch.io/cute-fantasy-rpg>
- Kenney：<https://kenney.nl/assets/roguelike-rpg-pack> ｜ <https://kenney.nl/assets/tiny-town> ｜ <https://kenney.nl/assets/pixel-platformer-farm-expansion> ｜ <https://kenney.nl/assets/category:Audio>
- LPC：<https://opengameart.org/content/liberated-pixel-cup-lpc-base-assets-sprites-map-tiles> ｜ <https://opengameart.org/content/lpc-farming-tilesets-magic-animations-and-ui-elements> ｜ <https://github.com/OpenGameArt/LiberatedPixelCup> ｜ <https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/> ｜ 许可指引：<https://lpc.opengameart.org/content/properly-licensing-your-liberated-pixel-cup-game-entry>
- 音频：<https://github.com/0lhi/FreePD>（FreePD CC0 镜像）｜ <https://opengameart.org>
- itch.io CC0 tileset 筛选入口：<https://itch.io/game-assets/assets-cc0/tag-tileset>
