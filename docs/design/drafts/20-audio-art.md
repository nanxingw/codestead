# 美术与音频子系统设计（audio-art）

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：草案
> 上位约束：`docs/design/drafts/00-constitution.md`（冲突以宪法为准）
> 依据：`docs/design/research/assets.md`、`docs/design/research/mechanics.md`、`docs/design/tech-stack.md`
> 范围：资产映射表（系统→具体文件，含缺口与补齐）、全局调色板与 UI 像素风格规范、音效清单与 BGM 方案、assets 目录组织与命名规范、许可合规（ATTRIBUTION.md）。
> 不在范围：玩法数值（farming 稿）、HUD 状态机逻辑（daemon/HUD 稿）、地图布局设计（map 稿）——本稿只供给它们的视觉/听觉资产与规范。

---

## 0. 三支柱对照（自检）

| 支柱 | 本稿的落实 |
|---|---|
| 游戏第一 | 资产覆盖以 M1 闭环（锄→种→浇→收→卖→结算）的「每一步都有动画+音效反馈」为第一优先级；占位美术也必须风格统一、反馈完整 |
| 零焦虑承诺 | 音频随模拟暂停而暂停（tab 隐藏 → AudioContext suspend）；BGM 选曲标准排除紧张/催促感曲风；无任何倒计时类音效 |
| 感知不干预 | **HUD 会话状态变化默认完全无声**（可选超轻提示音，默认关）；HUD 用低饱和静态图形，禁闪烁/抖动/弹跳动画；quest 出现仅一声 ≤0.5s 的柔和铃音 |

---

## 1. 资产来源总决策

按宪法 §4.6，主方案 Kenney CC0；本稿落实到包级清单，并补一个 CC0 第二素材包填角色动画缺口。

| # | 来源包 | 许可 | 用途 | 入仓库 |
|---|---|---|---|---|
| S1 | Kenney **Roguelike/RPG pack**（16×16，1700+ tiles，`roguelikeSheet_transparent.png`） | CC0-1.0 | 地形、树木、栅栏、水面、房屋构件、家具、部分物品图标 | ✅ 切片后入库 |
| S2 | Kenney **Tiny Town**（16×16，130+ tiles，`tilemap_packed.png`） | CC0-1.0 | 建筑外观备选（M3）、装饰；**与 S1 不同图层混用需过风格审查（§5.8）** | ✅ |
| S3 | Kenney **Input Prompts Pixel 16×** | CC0-1.0 | 键位提示图标（E / WASD / 1~9 / Esc） | ✅ |
| S4 | **Ninja Adventure Asset Pack**（pixel-boy & AAA，itch.io，16×16） | CC0（**入库前需在页面重核许可原文**，见 §11.4） | 玩家角色与 NPC 的四向行走动画基底 | ✅（核验后） |
| S5 | **自绘**（Aseprite，本项目产出，随仓库以 CC0 献出） | CC0-1.0 | 作物全生长阶段、农具、种子袋、UI 9-slice、HUD 状态图标、雨滴粒子等所有缺口 | ✅ |
| A1 | Kenney **UI Audio** / **Interface Sounds** | CC0-1.0 | UI 点击/翻页/确认/错误 | ✅ |
| A2 | Kenney **RPG Audio** | CC0-1.0 | 金币、布料、门、脚步备选 | ✅ |
| A3 | Kenney **Impact Sounds** | CC0-1.0 | 锄地、收割、脚步（草/土） | ✅ |
| A4 | Kenney **Music Jingles** | CC0-1.0 | 日结算、升级、quest 完成的短旋律 | ✅ |
| A5 | **FreePD GitHub 镜像**（github.com/0lhi/FreePD） | CC0-1.0 | BGM（白天 2 首 + 雨天 1 首） | ✅ |
| A6 | **freesound.org（CC0 过滤）** | CC0-1.0（逐条核） | 浇水、雨环境声等 Kenney 缺口 | ✅（逐文件核 CC0） |
| F1 | **Fusion Pixel Font 12px（缝合像素字体，TakWolf）** | OFL-1.1（**唯一非 CC0 资产**，须附许可全文） | 全游戏唯一字体（CJK 全覆盖） | ✅ |

**红线重申**：Sprout Lands / Sunnyside / Cozy Farm 仅风格参考，任何文件不得入仓库；星露谷本体素材绝对禁止。manifest（§10.3）的 license 白名单只有 `CC0-1.0` 与 `OFL-1.1`，CI 强制。

---

## 2. 全局调色板 CODE-28

自绘资产**只允许使用下表 28 色**（外加透明）；UI 颜色一律引用 token，禁止裸 hex 出现在代码里（收敛到 `game/src/ui/palette.ts` 单文件导出）。Kenney 切片资产保持原色不重涂；自绘资产通过共享描边色 `ink` 与邻近主色与之统一。

> 校准规则：导入 S1/S2 后用脚本采样草地/泥土/水面主色，若与本表对应色差 ΔE>10，以采样值回填本表并升版（v1.1），保证自绘作物「长在」Kenney 地形上不跳色。

### 2.1 世界色（自绘作物/道具用）

| token | hex | 用途 |
|---|---|---|
| `ink` | `#14100d` | 全局描边（所有自绘 sprite 1px 外描边统一用它） |
| `soil.dark` | `#3d2c23` | 湿耕地、阴影 |
| `soil.mid` | `#5a4030` | 干耕地基色 |
| `soil.light` | `#7a563a` | 耕地高光、木柄 |
| `wood.mid` | `#a97a50` | 木制工具、栅栏 |
| `wood.light` | `#d2a36b` | 木高光、UI 边框亮面 |
| `sand` | `#ecd3a5` | 路面、纸张 |
| `green.dark` | `#2c5230` | 叶片暗部 |
| `green.mid` | `#3f7a3c` | 叶片基色 |
| `green.light` | `#62a64f` | 叶片亮部、done 态 |
| `green.pale` | `#8ed06f` | 新芽、生长进度 |
| `water.deep` | `#1f3a5f` | 深水、夜幕 tint |
| `water.mid` | `#2e6f9e` | 水面、雨幕 tint |
| `water.light` | `#4fa4e8` | 水花、working 态 |
| `water.pale` | `#9ad1f5` | 水高光、雨滴 |
| `gold.deep` | `#b97e2c` | 金币暗部 |
| `gold.mid` | `#f0b541` | 金币、金喷壶、XP 星 |
| `gold.light` | `#f8d878` | 金币高光、选中描边 |
| `amber` | `#e8a33d` | blocked 态、警示（非报错） |
| `red.dark` | `#a93b3b` | 浆果暗部、错误 |
| `red.mid` | `#d96a6a` | 番茄/萝卜红、error 态 |
| `berry` | `#c0455e` | 浆果、芜菁紫红 |
| `purple.mid` | `#6b4a8a` | 茄紫、稀有度（M3+） |
| `purple.light` | `#9a7bd0` | 高光紫 |

### 2.2 UI 色

| token | hex | 用途 |
|---|---|---|
| `ui.panel` | `#2b211b` | 面板底（90% 不透明度上屏） |
| `ui.panelLight` | `#4a3a30` | 槽位底、按钮面 |
| `ui.text` | `#f4e3c2` | 正文（对 `ui.panel` 对比度 ≈9.4:1，达 WCAG AA） |
| `ui.textDim` | `#9aa0a6` | 次要文字、idle 态 |

### 2.3 HUD 五态颜色 + 形状双编码

颜色不可作为唯一区分（色弱可达性）：每个状态绑定**专属 8×8 图形**，HUD 同时显示图形+颜色+文字。

| 状态 | token/hex | 图形（8×8 自绘帧名） | 动效 |
|---|---|---|---|
| working | `water.light #4fa4e8` | 实心圆+缺口（`hud_state_working_0/1`，2 帧） | 呼吸交替，周期 2s（≤0.5Hz，禁闪烁） |
| blocked | `amber #e8a33d` | 实心圆内 `!`（`hud_state_blocked`） | 静态 |
| done | `green.light #62a64f` | 实心圆内 `✓`（`hud_state_done`） | 静态 |
| idle | `ui.textDim #9aa0a6` | 空心圆（`hud_state_idle`） | 静态 |
| unknown | `#8a8198` | 虚线空心圆内 `?`（`hud_state_unknown`） | 静态 |
| （error 修饰） | `red.mid #d96a6a` | blocked 图形换红（`hud_state_error`） | 静态（对应 `SessionInfo.error`） |

---

## 3. UI 像素风格规范

### 3.1 硬规则

1. 逻辑分辨率 640×360，UI 与世界共用同一整数 zoom（宪法 §4.2），**UI 不做独立高分辨率层**；
2. 所有 UI 元素坐标、尺寸、内边距为 **4 的倍数**（最小间距单元 4 逻辑 px）；图标网格 16×16；
3. 描边：1px `ink`，**硬边、无模糊、无半透明渐变**；投影只允许「右下偏移 1px 的 `ink` 35% 实色」一种；
4. 圆角：9-slice 视觉圆角 2px（像素阶梯实现），不用 CSS/几何圆角；
5. 禁止：非整数缩放、旋转文字、抗锯齿字体、超过 3 阶的渐变。

### 3.2 9-slice 面板与按钮（自绘，`ui.png` 图集）

- `ui_panel`：源图 24×24，slice 边距 8px（四角 8×8 不拉伸）。面色 `ui.panel`，外描边 `ink`，内侧 1px 高光 `wood.light`（仅上、左）；
- `ui_panel_light`：同构，面色 `ui.panelLight`，用于物品槽；
- `ui_button`：源图 24×16，slice 8px。三态三帧：`_normal`（面 `ui.panelLight`）/ `_hover`（面提亮一阶 + 外描边换 `gold.light`）/ `_pressed`（整体内容下移 1px，顶部高光移除）；
- `ui_slot`：20×20 槽位框；选中态 `ui_slot_active` 外加 2px `gold.light` 描边；
- 进度条 `ui_bar_bg` / `ui_bar_fill`：高 6px，填充色按用途（生长 `green.pale`、XP `gold.mid`、时间 `water.light`）。

### 3.3 字体

| 项 | 规格 |
|---|---|
| 字体 | Fusion Pixel 12px **proportional**（单一字体走天下；CJK+Latin 全覆盖） |
| 字号 | 正文 12px、标题 24px（=12×2 整数倍）、金额大数字 12px 加 `gold.mid` 色；**禁止非 12 倍数字号** |
| 行高 | 16px（正文）/ 28px（标题） |
| 渲染 | Phaser `Text` + `@font-face` 预载（`document.fonts.load` 完成后才进 BootScene 下一步）；`resolution=1`，靠整数 zoom 放大保持锐利；CSS `font-smooth: never` 不可靠，以 12px 原生像素字形为准 |
| 缺字回退 | AI 生成文本（M4）可能含生僻字：回退链 `Fusion Pixel → system-ui`，生僻字允许带 AA（可接受的妥协，记录于 §12） |
| 体积 | woff2 全量预计 2~4MB；**不做子集化**（quest 文本不可预知）；BootScene 进度条覆盖加载等待 |

### 3.4 屏幕布局总草图（640×360 逻辑px）

```
┌────────────────────────────────────────────────────────────── 640 ──┐
│ ┌HUD 会话面板(M2)──────┐                    ┌─时间/日期/金币────────┐ │
│ │ ◔ api-refactor  工作中│                    │ 春 7日 10:40  ⛅      │ │
│ │ ! daemon-fix    待输入│                    │ ◉ 1,240g   Lv3 ▓▓▓░ │ │
│ │ ✓ docs-pass     已完成│                    └───────────(右上,内缩8)┘ │
│ └──(左上,内缩8,宽≤200)──┘                                            │
│                                                                      │
│                          【 游 戏 世 界 视 口 】                      │
│                                                                      │
│            ┌─物品栏─────────────────────────────────┐                │
│            │ [1][2][3][4][5][6][7][8][9]  ←20px 槽位 │                │
│            │  锄  壶  种  …            选中槽金色描边 │                │
│            └─────────────(底部居中, 距底 8)──────────┘                │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.5 HUD 会话面板草图（M2，宽 200，每行高 16）

```
┌ ui_panel (alpha 0.9) ────────────┐
│ ◔ api-refactor        工作中 12m │   ← 图形8×8 + 标题(截断12字) + 状态 + 时长
│ ! codestead-daemon    待输入  2m │   ← blocked 行文字用 amber
│ ✓ docs-pass           已完成     │
│ · scratch             空闲       │
│ ? vim (未装hooks)     未知       │
└──────────────────────────────────┘
  行数>6 时折叠为「+N 个会话」尾行；面板可整体收起为单个 16×16 角标
  （角标显示最高优先级状态色：blocked > done > working > idle）
```

### 3.6 日结算屏草图（22:00 触发，宪法的「放下点」）

```
┌══ ui_panel 全屏居中 480×280 ══════════════════════╗
║              第 7 天 · 春                          ║
║  ───────────────────────────────────────────      ║
║  今日收成   芜菁 ×4   小萝卜 ×6                    ║
║  今日收入   +186g          (金币音效仅此处响一次)  ║
║  农场经验   +52xp   Lv3 ▓▓▓▓▓▓░░░░ 64%            ║
║  ───────────────────────────────────────────      ║
║  明天：土豆成熟 · 豆藤还差 2 天 · 预报：小雨 ☔     ║   ← 明日之诺
║  ───────────────────────────────────────────      ║
║  会话： ◔ api-refactor 工作中 · ! daemon 待输入    ║   ← 平静展示，无按钮无声音
║                                                    ║
║          [ 按任意键开始新的一天 ]   （无倒计时）    ║
╚════════════════════════════════════════════════════╝
  BGM 淡出(800ms) → 播 jingle_day_end 一次 → 静音等待；关闭后新一天 BGM 淡入(600ms)
```

---

## 4. 资产映射表：游戏系统 → 文件

图例：✅=源包直接切片可用 ｜ ⚠️=源包可用但需改造 ｜ ❌=缺口，按「补齐」列处理。
「运行时 key」是**对其他子系统的接口承诺**（farming/地图/HUD 按 key 引用，与源无关）。
源包内的精确坐标在导入时圈选并固化进 `recipes.json5`（§10.4），此处不预填以免错标。

### 4.1 地形与地图（M1，Tiled 管线）

| 资产 | 运行时 key（tileset `terrain` 内命名 tile） | 源 | 状态 | 补齐 |
|---|---|---|---|---|
| 草地（基础+4 变体） | `grass_0..4` | S1 | ✅ | — |
| 泥土/小径（含 16 邻接过渡） | `dirt_*`、`path_*` | S1 | ✅ | — |
| 水面（池塘边缘 13 块 + 2 帧水波动画） | `water_*` | S1 | ⚠️ 水波动画帧可能不足 | 自绘第 2 帧（色 `water.mid/pale`） |
| 耕地（干） | `tilled_dry` | S1 泥土改造 | ⚠️ | 自绘沟壑纹（`soil.mid/dark`） |
| 耕地（湿） | `tilled_wet` | — | ❌ | 自绘（`soil.dark` 基底，**独立贴图，不用 tint**，避免脏色） |
| 树（2 种）/树桩/岩石/草丛 | `tree_a/b`、`stump`、`rock`、`bush` | S1 | ✅ | — |
| 栅栏（木，4 向接合） | `fence_*` | S1 | ✅ | — |
| 农舍外观（M1 仅装饰不可入） | `house_*`（多 tile 组合） | S1 优先，S2 备选 | ✅ | — |
| 出售箱（shipping bin） | `sprite: ship_bin_closed/open` | S1 木箱改造 | ⚠️ | 自绘开盖第 2 帧 |
| 雨滴粒子（2 帧）+ 落地水花（2 帧） | `fx_rain_0/1`、`fx_splash_0/1` | — | ❌ | 自绘 8×8（`water.pale/light`） |

**Tiled 约定**（对 map 稿的接口）：tileset 名固定 `terrain`，图片 `assets/tilesets/terrain.png`（重打包：margin 1 / spacing 2 的 1px 外扩防渗色版，由导入脚本用 tile-extruder 生成）；`.tmj` 按宪法 §4.1（嵌入 tileset、CSV、非 infinite、正交）。图层名约定：`ground` / `ground_detail` / `obstacles`（带碰撞属性 `collides=true`）/ `above`。

### 4.2 角色（M1）

| 资产 | 运行时 key | 源 | 状态 | 补齐 |
|---|---|---|---|---|
| 玩家：4 向 idle（各 1 帧） | `player_idle_{down,up,left,right}` | S4 | ✅（核许可后） | 备选：自绘 |
| 玩家：4 向行走（各 4 帧，8fps） | `player_walk_{dir}_{0..3}` | S4 | ✅ | 同上 |
| 玩家：使用工具（4 向各 2 帧，挥臂） | `player_use_{dir}_{0,1}` | S4 动作帧 | ⚠️ S4 是「攻击」帧，观感即挥臂，直接复用 | 不足则自绘 |
| 工具叠加层：锄/喷壶挥动弧（各 3 帧，10fps，~250ms） | `tooloverlay_hoe_{0..2}`、`tooloverlay_can_{0..2}` | — | ❌ | 自绘 16×16，锚点随朝向翻转；浇水第 3 帧带水珠（`water.pale`） |
| NPC×3（M4）：4 向 idle+walk | `npc_{a,b,c}_…`（同玩家帧规范） | S4（50+ 角色可选 3 个非武装造型） | ✅ | — |

动画注册表（render 层常量，farming 稿无需关心帧数，只发动作事件）：

| anim key | 帧 | fps | repeat |
|---|---|---|---|
| `player-walk-{dir}` | 4 | 8 | loop |
| `player-use-{dir}` | 2 | 10 | 0（一次） |
| `tool-swing-{hoe\|can}` | 3 | 12 | 0 |

### 4.3 作物（M1 六作物，全自绘 → `atlases/crops.png`）

视觉阶段契约（对 farming 稿的**强接口**）：`spriteStages = stageDays.length + 1`（末位为成熟 ready 态）；再生作物另有 `picked` 态。`stage 0`=共享播种土堆 `crop_common_seeded`，`stage 1`=共享新芽 `crop_common_sprout`。成熟态额外提供 1 帧 `_ready_glint`（高光闪帧，3s 一次轻提示，非闪烁）。

| 作物 id | stageDays（mechanics §9.3） | 贴图序列（运行时 key） | 自绘帧数 |
|---|---|---|---|
| radish_quick | [1,1] | seeded → sprout → `crop_radish_quick_s2`(ready) | 1+glint |
| turnip | [1,1,1,1] | seeded → sprout → `crop_turnip_s2` → `crop_turnip_s3` → `crop_turnip_s4`(ready) | 3+glint |
| potato | [1,2,2,1] | seeded → sprout → s2 → s3 → s4(ready) | 3+glint |
| bean_vine | [2,2,2,2]，regrow 2 | seeded → sprout → s2 → s3 → s4(ready) → `crop_bean_vine_picked` | 4+glint |
| cabbage | [2,2,3,3] | seeded → sprout → s2 → s3 → s4(ready) | 3+glint |
| berry | [2,3,3]，regrow 3 | seeded → sprout → s2 → s3(ready) → `crop_berry_picked` | 3+glint |

> stageDays 的具体切分如与 farming 稿定稿不一致，**以 farming 稿为准**，本表只承诺「每阶段一张贴图 + 共享前两阶 + 再生 picked 态」的命名契约。
> 自绘量合计：约 17 帧作物 + 6 帧 glint + 2 共享 = 25 帧（16×16）。

### 4.4 物品图标（→ `atlases/items.png`）

| 资产 | 运行时 key | 源 | 状态 | 补齐 |
|---|---|---|---|---|
| 收获物图标 ×6 | `item_{cropId}` | S1 有蔬果图标可借 2~3 个 | ⚠️ | 余量自绘（与作物 ready 帧同形缩编） |
| 种子袋 ×6 | `seed_{cropId}` | — | ❌ | 自绘 1 个袋型模板 + 角标作物缩影（6 变体） |
| 锄头（木/铜/金） | `tool_hoe_t{1..3}` | S1 有农具类图标 | ⚠️ | 三档配色换皮（柄 `wood.*`，头 `soil/gold` 系） |
| 喷壶（木/铜/金） | `tool_can_t{1..3}` | — | ❌ | 自绘 ×3 |
| 金币 | `icon_gold` | S1 | ✅ | — |
| XP 星 / 等级徽章 | `icon_xp`、`icon_level` | — | ❌ | 自绘（`gold.mid/light`） |
| 天气图标（晴/雨） | `icon_sun`、`icon_rain` | — | ❌ | 自绘 ×2 |

### 4.5 UI（→ `atlases/ui.png`，全自绘，§3.2 规范）

`ui_panel`、`ui_panel_light`、`ui_button_{normal,hover,pressed}`、`ui_slot`、`ui_slot_active`、`ui_bar_bg`、`ui_bar_fill`、HUD 六枚状态图形（§2.3）、`ui_close`、`ui_arrow_{l,r}`、音量开关 `icon_sound_{on,off}`。键位提示直接用 S3 现成帧：`key_e`、`key_wasd`、`key_esc`、`key_1..9`。

### 4.6 里程碑缺口前瞻（不在 M1 制作，先占规范）

| 里程碑 | 新增资产 | 预案 |
|---|---|---|
| M3 建筑 | 鸡舍/加工棚/温室外观（多 tile）、建造中脚手架 2 态、品质星标（银/金）、洒水器 | 建筑用 S2 Tiny Town 整楼或 S1 构件拼装；品质星/洒水器自绘 |
| M4 NPC/quest | 对话框立绘（16×16 头像放大 ×4 像素完美）、quest 标记 `icon_quest`（羽毛笔造型，非感叹号——与 blocked 的 `!` 区分） | S4 角色头部裁切 + 自绘标记 |

### 4.7 风格混搭审查规则（S1 vs S2 vs 自绘）

1. 同一逻辑图层只用同一来源（地形全 S1；建筑群 M3 时整体二选一）；
2. 自绘 sprite 必须：1px `ink` 外描边、CODE-28 取色、光源统一左上；
3. 任何新切片/自绘合入前，置于 `docs/design/art-review/` 截图（放大 ×3）走一次 PR 自查：与相邻 tile 同屏不跳色、不跳描边风格。

---

## 5. 音效清单（动作 → 仓库规范名 → 来源）

仓库规范名是对其他子系统的接口；「来源候选」列的具体文件名以导入时核对为准（包内命名风格已按各包惯例标注），核定后写死进 manifest。

### 5.1 世界动作（M1）

| 触发事件（假设由 sim 发出，§14） | 规范名（`assets/audio/sfx/`） | 来源候选 | 状态 |
|---|---|---|---|
| 玩家移动（草/泥，0.3s 节流交替） | `step_grass_{0..2}.ogg`、`step_dirt_{0..2}.ogg` | A3 `footstep_grass_00x` 系列 | ✅ |
| `TileTilled` 锄地 | `hoe_till.ogg` | A3 `impactSoft_medium_00x`（闷土声） | ✅ |
| `CropPlanted` 播种 | `seed_plant.ogg` | A1/A2 轻「噗」声（cloth/drop 类） | ⚠️ 试听挑选 |
| `CropWatered` 浇水 | `water_pour.ogg` | A6 freesound CC0「watering can pour short」 | ❌ 外采 |
| `CropHarvested` 收割 | `harvest_pop.ogg` | A1 轻快确认音 | ✅ |
| 拾取入包 | `item_get.ogg` | A1/A2 短「叮」 | ✅ |
| `ItemSold` 出售入账 | `coins.ogg` | A2 `handleCoins` 系 | ✅ |
| 工具挥空（无效目标格） | `whiff.ogg` | A3 轻挥风声 | ⚠️ |
| `WeatherChanged(rain)` 雨环境循环 | `../ambience/rain_loop.ogg`（45~60s 无缝环） | A6 freesound CC0 | ❌ 外采 |

### 5.2 UI 与进度

| 触发 | 规范名 | 来源候选 |
|---|---|---|
| 悬停/切换物品栏 | `ui_tick.ogg` | A1 rollover/tick 类 |
| 确认/点击 | `ui_click.ogg` | A1 click 类 |
| 打开/关闭面板 | `ui_open.ogg` / `ui_close.ogg` | A1 |
| 无效操作（钱不够等） | `ui_error.ogg` | A1 error 类（选**柔和**变体，不刺耳） |
| `FarmLevelUp` 升级 | `jingle_levelup.ogg`（≤3s） | A4 |
| `DayEnded` 日结算入场 | `jingle_day_end.ogg`（≤4s，下行解决感=「放下」） | A4 |
| 收集图鉴点亮（M3） | `jingle_collect.ogg` | A4 |
| questOffer 出现（M4） | `quest_chime.ogg`（≤0.5s 柔和单音） | A1 |
| quest 完成（M4） | `jingle_quest.ogg` | A4 |
| NPC 对话逐字 blip（M4） | `blip_talk.ogg`（每 2 字符 1 次，音量 0.25×，设置可关） | A1 tick 最轻者 |
| **HUD 会话状态变化** | `hud_soft_tick.ogg` | A1 最轻 tick；**默认关闭**（`settings.audio.hudSoundEnabled=false`），即便开启也仅 blocked/done 两种迁移触发、10s 内去重 |

### 5.3 SFX 技术规格

- 格式：每条音效双格式 `*.ogg`（Vorbis q4）+ `*.m4a`（AAC 96k，Safari 兜底），Phaser `load.audio(key, [ogg, m4a])` 自选；
- 单文件 ≤100KB、时长 ≤2s（环境环除外）；全部经 `pnpm assets:audio` 脚本统一响度（ffmpeg loudnorm：SFX 目标 −14 LUFS、true peak −1.5dBTP）；
- 重复防机枪：同 key 50ms 去重 + 随机音高抖动 ±4%（footstep/hoe/harvest 适用）、同 key 最大并发 3；
- 音量分层基线（相对所属总线）：世界动作 1.0、UI 0.8、jingle 1.0、blip 0.25。

---

## 6. BGM 方案

### 6.1 曲目槽位（M1 共 3 首 + 静音选项）

| 槽位 | 仓库规范名 | 时长目标 | 选曲标准 | 来源 |
|---|---|---|---|---|
| 白天 A | `bgm/day_a.ogg` | 90~150s 可循环 | 70~100 BPM、大调、木吉他/钢琴/口哨类民谣质感；**无鼓点驱动、无紧张和声**；首尾可无缝接 | A5（FreePD 镜像 `Upbeat/`、`Romantic-Sentimental/` 目录试听初选 ≥6 首 → 终选 2） |
| 白天 B | `bgm/day_b.ogg` | 同上 | 与 A 同族异质（避免单曲洗脑）；按游戏日奇偶轮换 | A5 |
| 雨天 | `bgm/rain_day.ogg` | 同上 | 更慢（60~80 BPM）、柔和钢琴/弦乐，与 `rain_loop` 环境声叠放和谐 | A5 |
| 静音 | — | — | 设置项「关闭音乐」一键；mute 状态持久化 | — |

> FreePD 曲目终选需要试听，本稿不预填曲名（开放问题 §15.2）；终选后曲名、作曲者（Kevin MacLeod / Rafael Krux / Bryan Teoh 等）、镜像内路径写入 manifest 与 ATTRIBUTION.md。

技术规格：OGG Vorbis q3（≈112kbps）stereo 44.1kHz + m4a 兜底；响度 −16 LUFS；整轨循环（导出时裁静音、对齐小节）；单轨 ≤3.5MB，BGM 总预算 ≤9MB；**首屏不加载 BGM**——首次用户手势解锁音频后惰性加载（§7 边界 1）。

### 6.2 BGM 状态机（render 层 `AudioDirector` 持有）

```
                      ┌────────────────────────────────────────────┐
                      │  事件源：sim 的 DayStarted / WeatherChanged │
                      │  / DayEnded / SimPaused / SimResumed       │
                      └────────────────────────────────────────────┘

 [SILENT]──首次手势解锁&加载完──▶[DAY_CALM(A|B 按日奇偶)]
     ▲                              │            ▲
     │ 设置关闭音乐(800ms 淡出)      │WeatherChanged(rain)
     │                              ▼            │WeatherChanged(clear)
     │                          [RAIN_DAY]───────┘
     │                              │   （切换=交叉淡入淡出：出 800ms / 入 600ms）
     │                              │
     │          DayEnded（任意态）   ▼
     └──────────[SUMMARY]：BGM 淡出 800ms → 播 jingle_day_end 一次 → 保持静音
                    │ 玩家关闭结算屏（DayStarted）
                    ▼
                回到 DAY_CALM（新一天奇偶决定 A/B，淡入 600ms）

 任意态 ──SimPaused(tab 隐藏/Esc 菜单)──▶ [SUSPENDED]（AudioContext.suspend()，零 CPU）
 [SUSPENDED] ──SimResumed──▶ 恢复原状态（resume()，无重头播放）
```

环境声层（`rain_loop`）独立于 BGM 总线：`WeatherChanged(rain)` 淡入 1.5s，`clear` 淡出 1.5s；与 RAIN_DAY 曲并行。

---

## 7. 音频运行时规范

### 7.1 总线与默认音量（对 save 稿的接口：`settings.audio`）

| 总线 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `master` | 0.8 | 0~1 步进 0.1 | 总闸；`muted: false` 单独布尔 |
| `bgm` | 0.35 | 同上 | 刻意偏低：候车室场景常与工作并存 |
| `sfx` | 0.7 | 同上 | 世界动作 |
| `ui` | 0.5 | 同上 | UI 与 blip |
| 设置布尔 | `hudSoundEnabled: false`、`dialogueBlip: true` | | |

### 7.2 解锁状态机（浏览器 autoplay 策略）

```
[LOCKED]（页面加载完成；不发任何 play()，不报错）
   │ 首次 pointerdown/keydown（任意输入即解锁）
   ▼
[UNLOCKING] AudioContext.resume() → 惰性加载 BGM 当前槽位
   ▼
[READY] ⇄ [SUSPENDED]（visibilitychange / Esc 菜单，§6.2）
```

边界：1）解锁前发生的 sim 音效**直接丢弃不排队**（避免解锁瞬间音浪）；2）`resume()` 失败（极旧浏览器）→ 全局静音降级，游戏不受影响，设置面板显示「音频不可用」；3）日结算屏打开时 sim 暂停但 jingle 属 UI 通道，允许播完。

---

## 8. 资产目录组织与命名规范

### 8.1 目录树（`packages/game/`）

```
packages/game/
├── assets/                      # 仅「运行时直接加载」的最终产物，全部入 git
│   ├── manifest.json            # 逐文件许可溯源（§10.3 schema）
│   ├── tilesets/
│   │   └── terrain.png          # 重打包+1px extrude（margin 1 / spacing 2）
│   ├── atlases/                 # Phaser 3 atlas（JSON hash 格式），≤2048×2048
│   │   ├── crops.{png,json}
│   │   ├── items.{png,json}
│   │   ├── ui.{png,json}
│   │   └── characters.{png,json}
│   ├── fonts/
│   │   ├── fusion-pixel-12px-proportional.woff2
│   │   └── LICENSE-OFL.txt      # OFL 全文+版权行，紧贴字体存放（合规要求）
│   └── audio/
│       ├── sfx/    *.ogg + *.m4a
│       ├── bgm/    day_a.* / day_b.* / rain_day.*
│       ├── jingles/ jingle_*.ogg|m4a
│       └── ambience/ rain_loop.*
├── assets-src/                  # 生产源，入 git、不打包进构建
│   ├── aseprite/                # 自绘 .aseprite 源文件（CC0 献出）
│   ├── recipes.json5            # 切片配方：源表→坐标→输出帧（可重现，§10.4）
│   └── vendor/                  # 原始下载包解压件，.gitignore（manifest 记录下载 URL+sha256）
└── maps/                        # Tiled .tmx 源 + .tmj 导出（map 稿管辖，引用 tilesets/terrain.png）
```

### 8.2 命名规则

1. 文件与帧名：小写 `snake_case`，ASCII；禁空格、连字符、汉字；
2. 帧 key 模式（**接口承诺**）：作物 `crop_{cropId}_s{n}` / `crop_{cropId}_picked`；物品 `item_{cropId}`；种子 `seed_{cropId}`；工具 `tool_{hoe|can}_t{1..3}`；角色 `{actor}_{anim}_{dir}_{frame}`；UI `ui_*`；图标 `icon_*`；HUD `hud_state_{state}`；特效 `fx_*`；
3. 音频 key = 文件名去扩展名；BGM/jingle 前缀按目录（`bgm/day_a` → key `bgm_day_a`）；
4. `{cropId}` 与 shared 包 `CropDef.id` **逐字相等**（farming 稿接口）；
5. 加载 key 注册收敛到 `game/src/assets/keys.ts` 一个常量文件，杜绝魔法字符串。

### 8.3 体积预算（CI 检查）

| 类别 | 预算 |
|---|---|
| atlases 合计 | ≤1.5MB |
| tileset | ≤256KB |
| 字体 | ≤4MB |
| SFX+jingle 合计 | ≤2.5MB |
| BGM+ambience 合计 | ≤12MB |
| **assets/ 总计** | **≤20MB**；BootScene 首批（tileset+atlas+font+sfx）≤8MB，BGM 惰性加载 |

---

## 9. 资产生产管线（状态机）

```
[vendor 原包] ──pnpm assets:import──▶ [切片/extrude/打包]──▶ [assets/ 产物 + manifest 条目]
      ▲              （读 recipes.json5；sharp + maxrects-packer + tile-extruder）
      │
[aseprite 源] ──aseprite CLI 批导──┘
                                        │
[音频原文件] ──pnpm assets:audio──▶ [loudnorm + 双格式转码] ──▶ audio/ 产物
                                        │
                                        ▼
                              pnpm check:assets（CI 门禁）：
                              ① assets/** 每个文件都有 manifest 条目
                              ② license ∈ {CC0-1.0, OFL-1.1} 且 redistributable=true
                              ③ 按 recipes 重切结果与提交产物 sha256 一致（可重现）
                              ④ 体积预算（§8.3）逐类校验
                              ⑤ atlas json 帧名符合 §8.2 模式（正则）
```

依赖工具均为 devDependencies：`sharp`、`maxrects-packer`、`tile-extruder`；音频走系统 `ffmpeg`（CI 装包，本地 README 注明）。

---

## 10. 许可合规

### 10.1 白名单与红线

- manifest license 字段白名单：`CC0-1.0`、`OFL-1.1`（字体唯一例外）；出现其他值 CI 直接失败；
- itch.io「可商用禁再分发」类（Sprout Lands/Sunnyside/Cozy Farm/Cute Fantasy）任何文件、任何改稿不得入库；
- 星露谷本体/提取素材：红线，发现即回滚并审计提交历史。

### 10.2 ATTRIBUTION.md 内容清单（置于 `packages/game/assets/ATTRIBUTION.md`，M5 时根 CREDITS.md 链接之）

须包含以下章节与字段（脚本可从 manifest 生成初稿）：

```markdown
# Codestead 资产致谢与许可
## 概述
- 本仓库所有资产可再分发；美术/音频为 CC0-1.0，字体为 OFL-1.1（许可全文见 fonts/LICENSE-OFL.txt）。
## 美术
- Kenney — Roguelike/RPG pack / Tiny Town / Input Prompts Pixel 16×（CC0-1.0，kenney.nl，无署名义务，自愿致谢）
- pixel-boy & AAA — Ninja Adventure Asset Pack（CC0，itch.io 链接，核验日期 + 许可原文摘录）
- Codestead 项目自绘资产（assets-src/aseprite/**，作者列表，以 CC0-1.0 献出）
## 字体
- Fusion Pixel Font 12px — TakWolf（OFL-1.1；保留版权声明行；上游字体链：方舟像素/Ark Pixel 等，逐项列出）
## 音频
- Kenney — UI Audio / Interface Sounds / RPG Audio / Impact Sounds / Music Jingles（CC0-1.0）
- FreePD（CC0-1.0）：逐曲列出《曲名》— 作曲者 — 镜像路径（github.com/0lhi/FreePD）
- freesound.org（CC0）：逐条列出 音效名 — 用户名 — 原始 URL — 下载日期
## 风格致谢（无资产引用）
- Stardew Valley（ConcernedApe）、Sprout Lands、Sunnyside World——仅风格参考，未使用任何文件。
```

### 10.3 manifest.json 条目 schema（在 research/assets.md 基础上扩展）

```jsonc
{
  "id": "kenney-roguelike-rpg",
  "name": "Roguelike/RPG pack",
  "author": "Kenney",
  "source": "https://kenney.nl/assets/roguelike-rpg-pack",
  "sourceSha256": "…",                  // vendor 原包校验，支撑可重现
  "license": "CC0-1.0",
  "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
  "licenseVerifiedAt": "2026-06-10",    // 人工核验许可原文的日期
  "attributionRequired": false,
  "redistributable": true,
  "kind": "image",                       // image | audio | font
  "tileSize": 16,
  "files": ["tilesets/terrain.png"],
  "derivedFrom": "Spritesheet/roguelikeSheet_transparent.png",
  "processing": "sliced per assets-src/recipes.json5, extruded 1px, repacked",
  "modified": true
}
```

### 10.4 recipes.json5 条目示例（坐标固化点）

```json5
{
  output: "atlases/items.png#icon_gold",
  source: "vendor/kenney-roguelike-rpg/Spritesheet/roguelikeSheet_transparent.png",
  // 16×16 网格 + 1px spacing；cell 坐标在导入时人工圈选后写死：
  cell: { col: 0, row: 0 },   // TODO(import): 圈选后固化
  ops: []
}
```

---

## 11. 边界情况汇总

| # | 情况 | 处理 |
|---|---|---|
| 1 | 浏览器 autoplay 锁 | §7.2 状态机；解锁前丢弃音效不排队 |
| 2 | Safari 不支持 OGG Vorbis | 全音频双格式 ogg+m4a，loader 数组自选 |
| 3 | tab 隐藏 | 与时间即停同源事件：AudioContext.suspend()；恢复不重播 |
| 4 | 纹理渗色（tile bleeding） | tileset 1px extrude + 整数 zoom + roundPixels 三保险 |
| 5 | 旧 GPU 纹理上限 | 单图 ≤2048×2048（CI 校验） |
| 6 | AI 文本生僻字（M4） | 字体不裁剪 + system-ui 回退（允许局部 AA） |
| 7 | 色弱玩家看 HUD | 五态=颜色+专属图形+文字三重编码（§2.3） |
| 8 | 光敏/动效敏感 | 全局无 >1Hz 闪烁；working 呼吸 0.5Hz；设置项「减少动效」关闭一切循环动效 |
| 9 | 同音效机枪化 | 50ms 去重 + ±4% 音高抖动 + 并发上限 3 |
| 10 | BGM 单曲洗脑疲劳 | 双曲按游戏日奇偶轮换 + 默认音量 0.35 |
| 11 | HUD 状态高频抖动（会话快速 working↔blocked） | 视觉上状态显示由 HUD store 节流（假设 ≥1s，§14.4）；声音侧即便开启也 10s 去重 |
| 12 | vendor 包下线/改版 | manifest 记 sourceSha256 + 下载 URL；产物已入库，构建不依赖在线下载 |
| 13 | S4 许可页面变更 | `licenseVerifiedAt` + 许可原文摘录存档于 ATTRIBUTION.md；若核验失败启用自绘备案（§4.2） |
| 14 | ffmpeg 缺失（贡献者本地） | `assets:audio` 脚本启动探测，缺失则提示安装并跳过（产物已入库不阻塞开发） |

---

## 12. 验收标准（出厂自检，可逐条执行）

1. **许可审计绿**：`pnpm check:assets` 通过——assets/** 全部文件有 manifest 条目、license 在白名单、体积预算达标、recipes 重切 sha256 一致、帧名正则合规；
2. **像素纯净**：游戏在 ×2/×3 缩放截图中，任取 UI 边框与作物 sprite 放大检查，无半透明灰边（AA）、无非整数位移导致的模糊行；
3. **反馈完整**：M1 闭环 7 个动作（锄/种/浇/收/拾/卖/升级）每个都同时有动画帧变化 + 音效（开声状态下逐一手测）；
4. **不干预承诺**：默认设置下，会话状态从 working→blocked→done 全程**无任何声音**、无任何 >0.5Hz 视觉变化；日结算屏无倒计时元素；
5. **零焦虑承诺**：tab 隐藏 5 分钟后回来，BGM 从暂停点恢复（非重播）、无任何声音积压爆发；
6. **可达性**：HUD 五态在灰度截图下仍可通过图形互相区分；正文文字对面板对比度 ≥4.5:1；
7. **加载预算**：冷启动（本地 daemon 托管、清缓存）到可操作 ≤3s；首批资产 ≤8MB、assets 总量 ≤20MB；
8. **跨浏览器声音**：Chrome 与 Safari 各手测一遍音效与 BGM（双格式兜底生效）；
9. **ATTRIBUTION 完整**：manifest 中每个 `id` 在 ATTRIBUTION.md 有对应条目；fonts/LICENSE-OFL.txt 存在且含版权行；
10. **风格统一**：§4.7 的 art-review 截图流程对 M1 全部自绘资产执行过至少一轮。

---

## 13. 工作量预估（M1 自绘缺口）

| 项 | 数量 | 估时 |
|---|---|---|
| 作物 25 帧 + 物品/种子/工具/图标 ≈25 帧 | ~50 帧 16×16 | 2~3 天（非专业像素作者，含返工） |
| UI 9-slice/按钮/槽位/HUD 图形 | ~20 帧 | 1 天 |
| 工具叠加层 + 雨滴/水花特效 | ~10 帧 | 0.5 天 |
| Kenney 切片圈选 + recipes 固化 | — | 1 天 |
| 音效试听挑选 + freesound 外采 + 响度脚本 | ~25 条 | 1 天 |
| FreePD 试听终选 3 曲 + 循环裁剪 | 3 曲 | 0.5 天 |

---

## 14. 对其他子系统的依赖与接口假设

| # | 对象 | 假设/承诺 | 风险若不成立 |
|---|---|---|---|
| 1 | **farming/sim 稿** | sim 经 EventEmitter 发出：`TileTilled, CropPlanted, CropWatered, CropHarvested, ItemPicked, ItemSold, GoldChanged, FarmLevelUp, DayStarted, DayEnded, WeatherChanged(rain|clear), SimPaused, SimResumed`——render/audio 只订阅、零反向调用 | 事件名定稿后回填 §5/§6 映射表 |
| 2 | **farming 稿（CropDef）** | `CropDef.id` 与贴图 key `{cropId}` 逐字一致；`spriteStages = stageDays.length + 1`；再生作物需 `picked` 态；6 作物表以 farming 稿定稿为准 | stageDays 切分变更 → §4.3 帧序列同步改 |
| 3 | **时间/天气** | 雨天由 `WeatherChanged` 推送；时间即停由 `SimPaused/Resumed` 统一通知（含 visibilitychange），audio 不自行监听 DOM | 否则 audio 需自挂 visibilitychange（备援已写 §7.2） |
| 4 | **HUD 稿（M2）** | HUD store 提供 `SessionInfo[]`（tech-stack §5 协议）；**状态显示节流 ≥1s** 由 store 负责；本稿供给 §2.3 色板/图形与 §3.5 版式 | 节流缺失 → 视觉抖动，违宪法三支柱 3 |
| 5 | **存档稿** | save schema 增加 `settings.audio { master, bgm, sfx, ui, muted, hudSoundEnabled, dialogueBlip, reduceMotion }`，含默认值与迁移 | 设置不持久 → 每次进游戏重置音量 |
| 6 | **地图稿** | Tiled 用 tileset 名 `terrain`、图片 `assets/tilesets/terrain.png`（margin 1/spacing 2）、图层命名 §4.1 | 改名需双向同步 |
| 7 | **quest/NPC 稿（M4）** | quest 出现频率由 daemon 节流（≤1/15min），本稿只保证表现层不打断（一声柔和 chime + 地图上静态 `icon_quest` 标记，无弹窗） | — |
| 8 | **工程** | sim 层（`game/src/sim/`）零资产引用（ESLint 边界已有）；asset keys 常量文件归 render 层 | — |

---

## 15. 开放问题

1. **S4（Ninja Adventure）双重确认**：a) 页面许可原文是否仍为 CC0；b) 忍者造型与农场氛围的违和度——若不可接受，启动自绘 farmer（4 向 ×5 帧 ≈20 帧，+1.5 天）；
2. **FreePD 终选曲目**：需一次 30 分钟试听会从镜像 `Upbeat/`、`Romantic-Sentimental/` 目录选 3 曲（候选 ≥6 进短名单），定稿后回填 §6.1 与 manifest；
3. **浇水声/雨环境声外采**：freesound CC0 候选各 3 条试听，注意环境声无缝环裁剪质量；
4. **字体首屏策略**：4MB woff2 是否值得做「Latin 子集先行、CJK 全量后台续载」两段加载——倾向不做（复杂度>收益），待 M1 实测冷启动时间后定；
5. **HUD 可选提示音的设置归属**：`hudSoundEnabled` 放游戏设置面板还是 daemon 配置——倾向游戏设置（纯表现层），待 HUD 稿确认。
