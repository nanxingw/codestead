# 星露谷核心玩法调研与 Codestead 机制子集提案

> 调研日期：2026-06-10。目标：分析星露谷物语（Stardew Valley，下称 SDV）核心循环为什么好玩，
> 提炼适合 Codestead 场景的机制子集——**网页端轻量农场，单次游玩 2~10 分钟，随时可放下，不强迫长流程**。
> 所有 SDV 数值均核对自 [Stardew Valley Wiki](https://stardewvalleywiki.com)（经 MediaWiki API 抓取原文）。

---

## 1. 星露谷为什么好玩：核心循环拆解

SDV 的可玩性来自三层嵌套循环，每层都有清晰的「投入 → 等待 → 回报」闭环：

| 层级 | 周期 | 内容 | 情绪钩子 |
|---|---|---|---|
| 操作层 | 秒级 | 锄地、播种、浇水、收割，每次点击都有即时音效/动画反馈 | 即时满足、"嚼劲"（juice） |
| 日循环 | 14 真实分钟 | 体力与时间是每日有限资源，迫使玩家做小决策（今天浇水后去钓鱼还是挖矿？） | 规划感、日结算的小结回报 |
| 季/长线 | 数小时 | 作物季节轮替、工具升级、建筑、社区中心收集 | 「明日之诺」：总有一件事明天会发生 |

关键设计要点（综合多篇分析，见文末来源）：

1. **永远有一件「待发生的事」**：作物明天长一格、工具后天升级完、新建筑三天后竣工。玩家睡觉（结束一天）不是终止，而是「快进到下一个回报」。这是留存的核心引擎。
2. **小决策密度高、惩罚轻**：体力不够、时间不够造成取舍，但失败代价小（晕倒只扣 10% 金币、上限 1000g）。压力来自「想做的事太多」而非「会失去什么」。
3. **多目标并行**：经济（金币）、技能（XP）、收集（运输列表/收集包）、关系（NPC 好感）互不阻塞，任何一次游玩总能推进至少一条线。
4. **自动化是终极进度幻想**：从手动浇 40 格地，到洒水器全自动——「让重复劳动消失」本身就是奖励，与程序员心智天然契合。

> 对 Codestead 的直接启示：每次 2~10 分钟的游玩必须保证「至少推进一条线 + 留下一个明日之诺」。

---

## 2. 种植与浇水节奏

SDV 浇水规则（[Watering Cans 页](https://stardewvalleywiki.com/Watering_Cans)）：

- 每株未成熟作物**每天浇一次**；当天没浇**不会死，只是不生长**（宽容设计，关键！）；
- 雨天室外作物自动豁免浇水；
- 多次收获的成熟作物也需每日浇水；单次收获的成熟作物可以不浇、留在地里等收；
- 保湿土壤（fertilizer）与洒水器（sprinkler）逐步消解浇水劳动。

设计解读：浇水是「每日仪式」——一个低难度、强反馈、可冥想的重复动作，给每天一个固定开场；
「不浇不死」保证它是节奏器而非惩罚器。雨天豁免提供随机的「假日惊喜」。

**Codestead 采用**：完整继承「每日一浇、不浇停滞不死、雨天豁免」。绝不引入真实时间枯萎（见 §8 FarmVille 教训）。

---

## 3. 作物经济曲线：方法论 + SDV 春季真实数值

### 3.1 SDV 春季作物原始数据

售价/生长天数/XP 来自各作物 wiki 页 infobox；种子购价与金币/天来自 [Carl's Guides 春季作物表](https://www.carlsguides.com/stardewvalley/farming/crop-prices-spring.php)：

| 作物 | 种子价 | 基础售价 | 生长天数 | 再生天数 | 金币/天 | 农业 XP |
|---|---:|---:|---:|---:|---:|---:|
| 防风草 Parsnip | 20g | 35g | 4 | — | 3.75 | 8 |
| 蒜 Garlic（第二年） | 40g | 60g | 4 | — | 5.0 | 12 |
| 土豆 Potato | 50g | 80g（25% 概率多收 1 个，期望≈100g） | 6 | — | ≈8.3 | 14 |
| 甘蓝 Kale | 70g | 110g | 6 | — | 6.6 | 17 |
| 青豆 Green Bean | 60g | 40g | 10 | 3 | ≈6.4（多次收获摊薄） | 9 |
| 花椰菜 Cauliflower | 80g | 175g | 12 | — | 7.9 | 23 |
| 大黄 Rhubarb（沙漠解锁后） | 100g | 220g | 13 | — | 9.2 | 26 |
| 草莓 Strawberry（蛋日节限定） | 100g | 120g | 8 | 4 | 11.7（越早种越高） | 18 |
| 郁金香 Tulip | 20g | 30g | 6 | — | 1.67 | 7 |
| 蓝爵士 Blue Jazz | 30g | 50g | 7 | — | 2.8 | 10 |

### 3.2 从数据反推的平衡方法论

把上表画成曲线，能提炼出 SDV 的四条定价法则：

1. **周期越长、本金越高 → 日收益越高**。防风草（4 天）3.75 g/天 → 花椰菜（12 天）7.9 g/天 → 大黄（13 天）9.2 g/天。这是对「资金锁定 + 错过补种风险」的补偿，让升级作物始终有吸引力。
2. **入门作物 = 低门槛低回报教学**。防风草 20g 种子、4 天回本 75%，让第一周就完成「种→收→卖」的完整闭环教学，但日收益垫底，玩家很快「毕业」。
3. **再生作物奖励长期承诺**。草莓/青豆首次生长慢，但每 3~4 天再收一茬，越早投入总收益越高——奖励规划，制造「这一季开局怎么种」的策略题。
4. **限定渠道作物 = 事件奖励**。草莓只在节日卖、大黄要解锁沙漠，稀缺性本身是进度奖励。

可操作的反推公式（设计新作物时按此校验）：

```
goldPerDay = (sellPrice × expectedYield − seedPrice / harvestCount) / totalDays
设计目标：goldPerDay ≈ 基准值 × (1 + 0.6 × tier)，tier 随解锁进度上升
即：sellPrice ≈ seedPrice + goldPerDayTarget × growthDays
```

### 3.3 XP 与品质系统（[Farming 页](https://stardewvalleywiki.com/Farming)）

- 收获 XP 公式：`XP = ⌊16 × ln(0.018 × sellPrice + 1)⌋`——XP 与售价对数挂钩，贵作物给更多 XP 但边际递减，防止刷钱=刷级完全等价；
- 品质售价乘数：银 1.25×、金 1.5×、铱 2×；
- 金品质概率：`0.2×(farmingLevel/10) + 0.2×fertilizer×((farmingLevel+2)/12) + 0.01`，银 = 2×金概率（上限 75%）。
  品质系统让「同一动作」随等级产生更好结果，是廉价而有效的成长可视化。

---

## 4. 日循环结构（[Day Cycle 页](https://stardewvalleywiki.com/Day_Cycle)）

- 一天 = 游戏内 6:00 → 次日 2:00（20 小时）；**0.7 真实秒 = 1 游戏分钟**，即 10 游戏分钟 = 7 秒，**一整天 = 14 真实分钟**；一季 28 天 ≈ 6.5 小时。
- 睡觉触发存档 + 日结算（当日出售收益清单）——天然的会话边界与小结仪式；
- 午夜后睡觉体力恢复打折（1am ≈75%、2am 前 ≈50%）；2am 强制晕倒，在屋外晕倒扣 10% 金币（上限 1000g）。惩罚存在但温和，制造「赶在午夜前回家」的轻度张力；
- 菜单/对话/过场会暂停时间（单机），玩家可以随时喘息。

> 对 Codestead 的关键启示：SDV 一天 14 分钟对「2~10 分钟候车间隙」太长。需要压缩日长，让**日结算屏成为天然的放下点**——结算完正好切回工作。

---

## 5. 工具与升级（[Tools](https://stardewvalleywiki.com/Tools) / [Watering Cans](https://stardewvalleywiki.com/Watering_Cans)）

喷壶升级表（铁匠铺，需逐级升级，每次升级 2 天拿不到工具）：

| 等级 | 价格 | 材料 | 容量 | 范围 |
|---|---:|---|---:|---|
| 初始 | — | — | 40 次 | 1 格 |
| 铜 | 2,000g | 铜锭×5 | 55 | 直线 3 格 |
| 钢 | 5,000g | 铁锭×5 | 70 | 直线 5 格 |
| 金 | 10,000g | 金锭×5 | 85 | 3×3 |
| 铱 | 25,000g | 铱锭×5 | 100 | 6×3 |

设计要点：

- 升级直接作用于**每日仪式的效率**（一次浇 9 格 vs 1 格），收益每天都能感受到；
- 「升级期间 2 天没有工具」是一个有趣的牺牲决策（玩家学会挑雨天前送修）——把一次购买变成一道规划题；
- 技能等级附带 proficiency（降低工具体力消耗），数值成长与购买成长双轨并行。

---

## 6. 建造与解锁节奏（[Carpenter's Shop 页](https://stardewvalleywiki.com/Carpenter%27s_Shop)）

| 项目 | 价格 | 材料 | 工期 |
|---|---:|---|---|
| 背包 12→24 格 | 2,000g | — | 即时 |
| 背包 24→36 格 | 10,000g | — | 即时 |
| 鸡舍 Coop | 4,000g | 木×300 石×100 | 3 天 |
| 谷仓 Barn | 6,000g | 木×350 石×150 | 3 天 |
| 筒仓 Silo | 100g | 石×100 黏土×10 铜锭×5 | 2 天 |
| 水井 Well | 1,000g | 石×75 | 2 天 |
| 房屋升级 1（厨房） | 10,000g | 木×450 | 数天 |
| 房屋升级 2（房间+娃） | 65,000g | 硬木×100 | 数天 |
| 房屋升级 3（地窖） | 100,000g | — | 数天 |

节奏规律：**价格按 ~2.5× 一档递增**（4k → 10k → 20k；10k → 65k → 100k），每档解锁全新玩法维度（动物→人生阶段→陈酿），而非单纯数值膨胀；建造需要等待数日，又是一个「明日之诺」。

---

## 7. 进度感：技能等级与职业分支（[Farming/Skill](https://stardewvalleywiki.com/Farming)）

农业等级 XP 阈值（累计）：

| 等级 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| XP | 100 | 380 | 770 | 1,300 | 2,150 | 3,300 | 4,800 | 6,900 | 10,000 | 15,000 |

约为二次曲线（≈ `50×level² + 50×level`，前期升级极快：13 个防风草升 1 级）。每级解锁 1~3 个配方（稻草人→洒水器→优质洒水器→铱洒水器……），**5 级与 10 级是职业二选一**：

- 5 级：Rancher（动物产品 +20%）vs **Tiller（作物 +10%）**；
- 10 级（Tiller 线）：**Artisan（工匠品 +40%）** vs Agriculturist（作物生长 −10% 时间）。

设计要点：前密后疏的解锁节拍 + 不可兼得的分支选择（身份认同），再加运输收集图鉴（每种作物「第一次卖出」点亮条目）和成就，构成三套互补的进度可视化。

---

## 8. 轻量农场游戏参照

### 8.1 Farm RPG（farmrpg.com，网页/移动，菜单式）

- 定位「cozy、无广告、无压力」，纯菜单 UI，单次操作几十秒；来源：[farmrpg.com](https://farmrpg.com/)、[ImproveLoop 攻略](https://improveloop.com/loop/farmrpg)、[buddy.farm 数据站](https://buddy.farm/)。
- **作物按真实时间异步生长**，等级解锁阶梯（节选）：辣椒 1 分钟（Lv1，种子 9 银）→ 胡萝卜 2 分钟 → 豌豆 3 分钟 → 萝卜 10 分钟 → 土豆 25 分钟 → 番茄 30 分钟 → 韭葱 1 小时 → 西瓜 2 小时 → 玉米 4 小时（种子 2,960 银）→ 卷心菜 8 小时。
- 取舍分析：放弃了空间玩法（没有地图/角色移动）、放弃日循环，换来「任何 30 秒空隙都能玩一轮」；用海量收集与任务弥补深度。**借鉴**：生长时长阶梯从分钟级起步、回访即有收获；**不借鉴**：真实时间驱动（Codestead 要的是「在场的 2~10 分钟」而非全天挂机），纯菜单形态（我们要游戏世界）。

### 8.2 FarmVille（Zynga，经典网页农场）

- 预约机制（appointment mechanics）鼻祖：作物按真实时间生长，**成熟后约 1×生长时长内必须收割，约 2.5× 后枯萎报废**（来源：[FarmVille Wiki/玩家攻略](https://farmvillesuccessdotcom.wordpress.com/seeds-and-crops/withering-crops-in-farmville/)、[Gamasutra/Game Developer 分析](https://www.gamedeveloper.com/design/beyond-wither-supercompensation-in-games)、[Adrian Crook 分析](https://adriancrook.com/should-farmvilles-famous-wither-mechanic-be-left-to-rot/)）。
- 枯萎利用**损失厌恶**强迫玩家按时回访，留存有效但制造焦虑——后期 Zynga 自己都加入了「枯萎保护」。
- **Codestead 的结论：明确不采用**。我们的玩家本来就被「等 AI 干完活」牵着走，游戏再加一个真实时间闹钟是双重焦虑，违反「低压候车室」定位。时间只在游戏内流动，关掉浏览器世界就暂停。

---

## 9. Codestead 机制子集提案（含具体数值）

### 9.1 总体取舍

| 维度 | SDV | Codestead 提案 | 理由 |
|---|---|---|---|
| 时间驱动 | 游戏内时钟，一天 14 分钟 | 游戏内时钟，**一天 ≈ 3 分钟**，不玩即暂停 | 2~10 分钟 ≈ 1~3 个游戏日，每次游玩横跨至少一次「过夜」回报 |
| 浇水 | 每日一次，不浇停滞 | 完整继承 + 雨天豁免 | 低压节奏器 |
| 枯萎 | 仅换季清场 | 无任何真实时间枯萎 | 低压定位（§8.2） |
| 体力 | 有 | **第一版不做**（仅时间约束） | 减一套数值；时间稀缺已足够产生取舍 |
| 品质 | 银/金/铱 | M3 后再加（先只有普通品质） | 控制 M1 范围 |
| 职业分支 | 5/10 级二选一 | 保留（简化为 5 级一次） | 身份认同性价比高 |

### 9.2 日循环

- 游戏内一天 6:00–22:00（16 小时），**1 游戏分钟 = 0.1875 真实秒**（10 游戏分钟 = 1.875 秒），整天 = 3 分钟；
- 22:00 自动入睡（无晕倒惩罚），弹出**日结算屏**：今日收成/收入/明日预告（XX 明天成熟、建筑还差 1 天）——这是设计出来的「放下点」，结算屏上同时平静地显示 agent 会话状态（感知不干预）；
- 任何菜单/离开页面即暂停；存档随日结算落盘（localStorage / 本地文件）。

### 9.3 起步作物表（T1~T3，按 §3.2 公式生成，goldPerDay 基准 4，tier 增幅 0.6）

| id | 名称 | tier | 种子价 | 售价 | 生长天数 | 再生 | 金币/天 | XP |
|---|---|---|---:|---:|---:|---:|---:|---:|
| turnip | 芜菁 | T1 | 20 | 36 | 4 | — | 4.0 | 8 |
| radish_quick | 小萝卜 | T1 | 10 | 18 | 2 | — | 4.0 | 5 |
| potato | 土豆 | T2 | 50 | 89 | 6 | — | 6.5 | 14 |
| bean_vine | 豆藤 | T2 | 60 | 30/茬 | 8 | 2 | ≈7.5（4 茬计） | 9/茬 |
| cabbage | 卷心菜 | T3 | 80 | 178 | 10 | — | 9.8 | 22 |
| berry | 浆果 | T3 | 100 | 60/茬 | 8 | 3 | ≈11（多茬） | 16/茬 |

小萝卜（2 天）保证**首次 10 分钟游玩内完成完整「种→收→卖」闭环**；豆藤/浆果教再生作物策略。

数据结构示例（`packages/shared` 中的 `CropDef`）：

```ts
interface CropDef {
  id: string;              // "turnip"
  nameKey: string;         // i18n key
  tier: 1 | 2 | 3;
  seedPrice: number;       // 20
  sellPrice: number;       // 36 (per harvest unit)
  growthDays: number;      // 4
  regrowDays?: number;     // bean_vine: 2
  stageDays: number[];     // [1, 1, 1, 1] -> sprite stages
  season: Season[];        // ["spring"]
  xp: number;              // 8, ≈ floor(16 * ln(0.018 * sellPrice + 1))
  unlock: { farmLevel: number };
}
```

### 9.4 工具与升级（3 档即可）

| 喷壶 | 价格 | 范围 | 锄头同步 |
|---|---:|---|---|
| 木 | 初始 | 1 格 | 1 格 |
| 铜 | 500g | 直线 3 格 | 直线 3 格 |
| 金 | 2,500g | 3×3 | 3×3 |

升级即时生效（网页轻量版不做「送修等 2 天」），但洒水器作为农场等级高阶解锁保留「自动化幻想」。

### 9.5 解锁与进度

- **农场等级 1~10**：XP 阈值 `100, 380, 770, 1300, 2150, 3300, 4800, 6900, 10000, 15000`（直接复用 SDV 曲线，前快后慢）；
- 每级解锁：新种子（按 tier）→ 背包扩容（12→24 格，1,000g）→ 洒水器配方（Lv6）→ 建筑图纸；
- **Lv5 职业二选一**：「园艺师」（作物 +10% 售价）vs「工匠」（加工品路线，M3 启用）；
- 建筑（M3）：鸡舍 2,000g+木 150（工期 2 游戏日）→ 加工棚 6,000g → 温室 15,000g，价格 ~2.5×/档；
- 收集图鉴：每种作物首次售出点亮，全图鉴有成就（对应 SDV 运输列表）。

### 9.6 数值自检清单（实现 M1 时按此验收）

1. 新档前 10 分钟（≈3 游戏日）：能完成小萝卜一个完整周期 + 升到农场 Lv2；
2. 任意一次 2 分钟游玩：至少能「浇完水 + 看到一个进度条前进」；
3. 任意一次离开：无任何会在真实时间里恶化的状态（零焦虑承诺）；
4. 每档新作物 goldPerDay 比上一档高 50%~70%，但需要更多本金与天数；
5. 日结算屏停留时不强制点击倒计时——玩家想看多久看多久（感知不干预）。

---

## 10. 来源

- [Stardew Valley Wiki — Day Cycle](https://stardewvalleywiki.com/Day_Cycle)（日循环、0.7s/游戏分钟、晕倒惩罚）
- [Stardew Valley Wiki — Watering Cans](https://stardewvalleywiki.com/Watering_Cans)（浇水规则、喷壶升级表）
- [Stardew Valley Wiki — Tools](https://stardewvalleywiki.com/Tools)（升级流程、背包价格）
- [Stardew Valley Wiki — Farming](https://stardewvalleywiki.com/Farming) 与 [Farming/Skill](https://stardewvalleywiki.com/mediawiki/index.php?title=Farming/Skill)（XP 表、XP 公式、品质公式、职业）
- [Stardew Valley Wiki — Carpenter's Shop](https://stardewvalleywiki.com/Carpenter%27s_Shop)（建筑价格与工期）
- 各作物页 infobox：[Parsnip](https://stardewvalleywiki.com/Parsnip)、[Potato](https://stardewvalleywiki.com/Potato)、[Strawberry](https://stardewvalleywiki.com/Strawberry)、[Cauliflower](https://stardewvalleywiki.com/Cauliflower)、[Kale](https://stardewvalleywiki.com/Kale)、[Green Bean](https://stardewvalleywiki.com/Green_Bean)、[Rhubarb](https://stardewvalleywiki.com/Rhubarb)、[Garlic](https://stardewvalleywiki.com/Garlic)
- [Carl's Guides — Spring Crops & Profit per Day](https://www.carlsguides.com/stardewvalley/farming/crop-prices-spring.php)（种子购价、金币/天）
- 循环分析：[Kinglink Reviews — How Stardew Valley Works](https://kinglink-reviews.com/2020/02/23/how-stardew-valley-work-the-three-main-phases-of-farm-simulators/)、[Medium — Stardew Valley: Player Engagement Done Right](https://medium.com/@shakeebzacky/stardew-valley-player-engagement-done-right-7d25f9dc00e9)、[GameRant — Perfect Gameplay Loops](https://gamerant.com/stardew-valley-other-games-perfect-best-gameplay-loops/)、[Kokutech — Stardew Valley Design Analysis](https://www.kokutech.com/blog/gamedev/design-patterns/world-building/stardew-valley)
- Farm RPG：[官网](https://farmrpg.com/)、[ImproveLoop 数据](https://improveloop.com/loop/farmrpg)、[buddy.farm（Pepper Seeds 9 银 / Corn Seeds 2,960 银）](https://buddy.farm/i/pepper-seeds/)
- FarmVille 预约/枯萎机制：[Game Developer — Beyond "Wither"](https://www.gamedeveloper.com/design/beyond-wither-supercompensation-in-games)、[Game Developer — Appointment Mechanics](https://www.gamedeveloper.com/design/how-big-games-use-appointment-mechanics-to-get-gamers-keep-coming-back)、[Adrian Crook — Should FarmVille's wither mechanic be left to rot?](https://adriancrook.com/should-farmvilles-famous-wither-mechanic-be-left-to-rot/)、[枯萎时间数据](https://farmvillesuccessdotcom.wordpress.com/seeds-and-crops/withering-crops-in-farmville/)
