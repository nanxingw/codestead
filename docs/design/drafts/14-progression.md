# 14 进度系统（Progression）设计稿

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：草案 ｜ 负责子系统：progression
> 上游依据：`00-constitution.md`（最高约束）、`docs/design/research/mechanics.md` §3/§7/§9、`docs/design/tech-stack.md` §3/§5。
> 范围：农场等级与经验来源、每级解锁表、成就系统、第一周/第一月长线目标、进度感呈现。
> 实现位置：`packages/game/src/sim/progression/`（纯 TS，零 Phaser 依赖）+ 渲染层订阅事件。

---

## 0. 三支柱自检（宪法 §3 逐条对照）

| 支柱 | 本子系统的回应 |
|---|---|
| 游戏第一 | 进度是「多目标并行」的骨架：金币、XP、解锁、成就、图鉴互不阻塞，任何 2 分钟游玩至少推进一条；每级解锁直接改变玩法（新作物/新工具/新耕地），不做纯数值膨胀 |
| 零焦虑承诺 | 所有进度只由游戏内事件驱动；**禁止**「连续登录」「限时成就」「赛季排行」类任何与真实时间挂钩的进度（§4.1 红线）；升级与成就永不倒退、永不过期 |
| 感知不干预 | 升级/成就提示为非模态横幅与飘字，不暂停模拟、不弹模态窗；职业选择由玩家主动到农舍触发，不强制弹出；进度系统与 session HUD、quest 频率零绑定 |

---

## 1. 农场等级与 XP 阈值

### 1.1 阈值表（宪法 §4.4 十个数值的工程化映射）

宪法给出 10 个累计阈值（100 … 15,000），而 Lv1→Lv10 只有 9 次升级。本稿采用以下映射（**全部 10 个数值原样保留，不改任何数字**）：

- 新档从 **Lv1、累计 XP = 0** 开始；
- 表中第 k 项（k = 1..9）= **升至 Lv(k+1) 所需累计 XP**；
- 第 10 项 **15,000 = XP 硬封顶（精通条）**：达到 Lv10（10,000）后 XP 继续累积到 15,000 封死，填满触发成就「精通」（§4.3 #22）。

> ⚠️ 此映射保证宪法验收红线 1（前 10 分钟升 Lv2）可达成（见 §1.4 推演）；若按「15,000 = Lv10」的 SDV 原始映射，Lv2 需 380 XP，红线 1 数学上不可能。已列入开放问题 §11-Q1，请在宪法层面确认或修宪固化本映射。

| 等级 | 累计 XP | 区间增量 | 备注 |
|---:|---:|---:|---|
| Lv1 | 0 | — | 新档起点 |
| Lv2 | 100 | 100 | 红线 1 目标（前 10 真实分钟） |
| Lv3 | 380 | 280 | |
| Lv4 | 770 | 390 | |
| Lv5 | 1,300 | 530 | **M1 等级帽**；职业二选一（M3 实装） |
| Lv6 | 2,150 | 850 | M3 起可达 |
| Lv7 | 3,300 | 1,150 | |
| Lv8 | 4,800 | 1,500 | |
| Lv9 | 6,900 | 2,100 | |
| Lv10 | 10,000 | 3,100 | 满级 |
| （精通） | 15,000 | 5,000 | XP 封顶，仅填条 + 成就，无等级 |

```ts
// packages/game/src/sim/progression/levels.ts
export const XP_THRESHOLDS = [0, 100, 380, 770, 1_300, 2_150, 3_300, 4_800, 6_900, 10_000] as const;
export const XP_CAP = 15_000;          // mastery bar cap (constitution §4.4 10th value)
export const M1_LEVEL_CAP = 5;         // removed in M3

/** Level is ALWAYS derived from cumulative xp — never stored. */
export function levelForXp(xp: number): number {
  let lv = 1;
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) { lv = i + 1; break; }
  }
  return lv;
}
```

### 1.2 XP 来源表（经验来源唯一权威表）

| 来源 | XP | 触发事件 | 里程碑 | 设计理由 |
|---|---:|---|---|---|
| 锄地 | **0** | `tileTilled` | M1 | 防「锄了又填」无限刷 |
| 浇水 | **0** | `tileWatered` | M1 | 浇水是节奏器不是 grind 源 |
| 播种 | **+3 / 株** | `cropPlanted` | M1 | 让第一天就有 XP 反馈；上限受耕地格数物理约束，无无限刷（§1.3） |
| 收获 | **CropDef.xp / 次**（再生作物每茬都给） | `cropHarvested` | M1 | 主要来源；数值取 mechanics §9.3 作物表（表值为准，公式 `⌊16×ln(0.018×sellPrice+1)⌋` 仅用于估算新作物） |
| 出售 | **0** | `itemSold` | M1 | XP 在收获时点已计，金币与 XP 解耦 |
| 工具升级 | **0**（由成就 #11/#12 一次性给） | — | M1 | 避免「花钱=刷级」直通 |
| 建筑竣工 | 鸡舍 **+150** / 加工棚 **+300** / 温室 **+500** | `buildingCompleted` | M3 | 一次性；约为造价的 3%~7.5%，对冲 Lv6+ 区间增量变大 |
| 洒水器放置 | **0**（成就 #17 一次性 +30） | `sprinklerPlaced` | M3 | |
| quest 完成 | **reward.xp，daemon 端 clamp 到 [5, 50]** | `questReward` | M4 | 频率本身受限（全局 ≤1 个/15 真实分钟），XP 占比天然 <10%，游戏第一 |
| 成就解锁 | 见 §4.3 成就表 | `achievementUnlocked` | M1 起 | 总预算受控（§4.4） |

收获 XP 权威值（与 mechanics §9.3 / 宪法 §4.4 起步 6 作物对齐）：

| crop id | turnip | radish_quick | potato | bean_vine | cabbage | berry |
|---|---:|---:|---:|---:|---:|---:|
| XP/次（茬） | 8 | 5 | 14 | 9 | 22 | 16 |

> **品质不改 XP**（M3 引入品质后）：XP 一律按基础售价对应的表值计算，银/金品质只乘售价（1.25×/1.5×），不乘 XP——防止 M3 后 XP 通胀打乱 Lv6~10 节奏。

### 1.3 防刷规则

1. 锄地/浇水/移动/对话 XP 恒为 0；
2. 播种 XP 的物理上限 = 耕地格数 × 补种频率：24 格 × 最快 2 天/轮（小萝卜）= 36 XP/天上限，且每次播种都消耗种子金币（10g/3 XP 是可接受的金币→XP 汇率兼金币回收）；
3. 再生作物（bean_vine/berry）**仅首次播种给播种 XP**，各茬收获给收获 XP；
4. 成就 XP 一次性、幂等（`achievements` 已解锁集合判重）；
5. quest XP 由 daemon 在 zod schema 层 clamp（`reward.xp: z.number().int().min(5).max(50)`，写入 `packages/shared/src/quest.ts`）。

### 1.4 节奏校验（设计推演，须以 sim 快进测试复核）

**红线 1 复验（新档前 10 真实分钟 ≈ 3 游戏日）**，勤奋路径：

| 游戏日 | 动作 | XP 增量 | 累计 |
|---|---|---:|---:|
| Day1 | 锄 12 格（成就#1 +5）；买 10 小萝卜种（100g 花光）；播 10（+30，成就#2 +5）；浇水 | +40 | 40 |
| Day1→2 | 日结算（成就#6「过夜」+5） | +5 | 45 |
| Day2 | 浇水 | 0 | 45 |
| Day3 | 收 10 小萝卜（+50，成就#3 +10）→ **累计 105 ≥ 100，Lv2** | +60 | 105 |

Lv2 达成点 ≈ 第 3 游戏日上午 ≈ **6.5~7.5 真实分钟** ✓（出售 180g、成就#4 +10 为冗余余量）。

**28 日（第一月）勤奋路径预估**（12→24 格、按宪法收入曲线 30~80 → 200~350 g/日折算 XP）：

| 游戏日 | 3 | 7 | 9~10 | 14 | 16~17 | 21 | 24~27 |
|---|---|---|---|---|---|---|---|
| 累计 XP（含成就） | ~105 | ~260 | ~390 | ~660 | ~790 | ~1,050 | ~1,300+ |
| 等级 | **Lv2** | Lv2 | **Lv3** | Lv3 | **Lv4** | Lv4 | **Lv5** |

休闲路径（每天只浇水+顺手收获、不优化配比）：预计 Lv4 ≥ Day28、Lv5 落在第二月——可接受，M1 验收以勤奋路径为准（§10）。

**M3 后展望**（32~42 格 + 洒水器 + 建筑 XP）：日 XP 约 80~120，Lv6 ≈ Day35、Lv8 ≈ Day65、Lv10 ≈ Day100~115（≈5~6 真实小时累计游玩）。属长线目标，无需精确，sim 测试只卡 M1 段。

---

## 2. 每级解锁表（Lv1~10 全蓝图）

> 「实装」列标注内容落地的里程碑；M1 内玩家可达 Lv5，Lv6+ 内容在 M1 不展示具体名目（只显示「更高等级待解锁」剪影，防止给 M1 玩家虚假承诺）。

| 等级 | 解锁内容 | 实装 |
|---|---|---|
| **Lv1**（起点） | T1 种子上架：芜菁 turnip（20g）、小萝卜 radish_quick（10g）；木锄/木喷壶（1 格）；耕地 **12 格**；背包 12 格 | M1 |
| **Lv2** | 土豆 potato 种子上架（T2，50g）；**铜档工具可购**（500g，直线 3 格，即时生效） | M1 |
| **Lv3** | 豆藤 bean_vine 种子上架（T2 再生，60g）；耕地 **+6 → 18 格**（东侧围栏门打开） | M1 |
| **Lv4** | 卷心菜 cabbage 种子上架（T3，80g）；**金档工具可购**（2,500g，3×3，即时生效） | M1 |
| **Lv5** | 浆果 berry 种子上架（T3 再生，100g）；耕地 **+6 → 24 格**（南侧围栏门打开）；**职业二选一**：园艺师（作物售价 +10%）vs 工匠（加工品售价 +25%，数值待 economy/building 确认） | 种子/耕地 M1；职业 M3 |
| **Lv6** | **洒水器配方**（宪法定点）；鸡舍图纸（2,000g + 材料，工期 2 游戏日） | M3 |
| **Lv7** | 加工棚图纸（6,000g）；耕地 **+8 → 32 格** | M3 |
| **Lv8** | 高级洒水器配方（3×3）；新作物档 T4 一组（数值按宪法公式 `goldPerDay ≈ T3 × 1.5~1.7` 校验后入表） | M3 |
| **Lv9** | 温室图纸（15,000g）；耕地 **+10 → 42 格** | M3 |
| **Lv10** | 成就「农场大师」；纪念雕像（装饰物，农舍前）；XP 条转为精通条（→15,000 封顶） | M3 |

不挂等级的解锁：**背包 12→24 格（1,000g）**——QoL 不是 power，M3 上线后无等级门槛直接可购（开放问题 Q4）。

### 2.1 耕地扩张规格

- 农场地图（≤64×64）上预置 5 个围栏分区：`plot_home`(12) / `plot_east`(6) / `plot_south`(6) / `plot_west`(8) / `plot_north`(10)，合计 42 格上限；
- 解锁 = 对应围栏门 tile 替换为开门状态 + 区内地块变为可锄；区域本身始终可行走（无碰撞变化，玩家站在区内升级也安全）；
- 数据驱动：分区与等级的映射写在地图 `.tmj` 的对象层属性 `unlockLevel` 中，sim 层读表，不硬编码坐标；
- 具体围栏/门的 tile 坐标依赖农场地图设计稿（开放问题 Q5）。

### 2.2 商店展示规则（解锁感知的主要载体）

- 已解锁：正常条目；**解锁后首个游戏日内带 `NEW` 角标**；
- 未解锁且属于「下一级 / 下两级」：**剪影 + 「Lv N 解锁」**——透出近期目标，制造明日之诺；
- 更远的解锁（>2 级）：折叠为一行「更高等级还有 N 项待解锁」，不展示名目（防止目标过载）；
- M1 中 Lv6+ 条目一律走「折叠」分支。

### 2.3 M1 等级帽与 M3 迁移

- M1 中 `effectiveLevel = min(levelForXp(xp), 5)`；**XP 不封帽**，超过 1,300 继续累积；
- M3 版本移除帽：存档加载时 `levelForXp(xp)` 若 > 5，按序补发 Lv6..N 的 `levelUp` 事件（解锁逐级生效、横幅入队列逐条播，见 §6.4）；
- 该行为写入存档迁移函数（`schemaVersion` 递增），并有专门测试（§10 #7）。

### 2.4 职业（Lv5，M3 实装）

- 触发：玩家在农舍内与「职业证书桌」交互（玩家主动，不弹窗不打断）；达到 Lv5 后日结算屏温和提示一次「农舍里有一份证书等你签署」，之后不再重复；
- 二选一、**永久不可改**（宪法术语表「不可兼得」）；确认对话框需二次确认并明示不可逆；
- 未选择不阻塞任何升级与解锁；
- M1 存档升至 ≥Lv5 后进入 M3 版本：同一张桌子补触发，规则一致；
- 效果实现：`profession` 作为 economy 计价管线的乘数挂点（园艺师：作物售出 ×1.10 向下取整；工匠：加工品售出 ×1.25 向下取整）。

---

## 3. 状态机与数据结构

### 3.1 sim 层接口（`packages/game/src/sim/progression/`）

```ts
// types.ts
export type XpSource = 'plant' | 'harvest' | 'build' | 'quest' | 'achievement';
export type Profession = 'horticulturist' | 'artisan';

export interface ProgressionState {
  xp: number;                                   // cumulative, 0..XP_CAP, monotonic
  profession: Profession | null;                // M3; null = not chosen
  counters: Partial<Record<CounterId, number>>; // achievement counters (§4.2)
  achievements: AchievementId[];                // unlocked, append-only
  xpHistory: number[];                          // xp gained per game day, last 3 entries (for ETA hint)
}

export type ProgressionEvent =
  | { type: 'xpGained'; source: XpSource; amount: number; total: number }
  | { type: 'levelUp'; level: number; unlocks: UnlockDef[] }       // one event PER level
  | { type: 'achievementUnlocked'; achievement: AchievementDef }
  | { type: 'masteryReached' };                                    // xp hits XP_CAP

export interface UnlockDef {
  id: string;                                   // "seed.potato" | "tool.copper" | "plot.east" | ...
  kind: 'seed' | 'tool' | 'plot' | 'recipe' | 'blueprint' | 'profession' | 'cosmetic';
  minLevel: number;
  milestone: 'M1' | 'M3';
}
```

```ts
// reducer.ts — pure, deterministic, no Date.now(), no Math.random()
export function grantXp(
  state: ProgressionState, source: XpSource, amount: number, levelCap: number,
): [ProgressionState, ProgressionEvent[]] {
  // 1. next.xp = min(state.xp + max(0, floor(amount)), XP_CAP)
  // 2. for each level crossed between levelForXp(prev) and min(levelForXp(next), levelCap):
  //      emit levelUp with UNLOCKS_BY_LEVEL[lv]  (multiple events when multi-level jump)
  // 3. if next.xp === XP_CAP && prev.xp < XP_CAP: emit masteryReached
  // 4. run achievement checks for counters affected by level/xp (e.g. farm_master)
}

export function bumpCounter(
  state: ProgressionState, id: CounterId, delta: number,
): [ProgressionState, ProgressionEvent[]] {
  // increments counter; evaluates achievement defs bound to this counter; idempotent unlock;
  // achievement rewards recursively call grantXp(source='achievement') — see §8.3 loop guard
}
```

进度状态机（每个事件原子处理，事件间无中间态外泄）：

```
                       +----------------------------+
 farming/economy/...   |        progression          |
 game events ───────▶  |  bumpCounter / grantXp      | ──events──▶ UI queue (§6.4)
 (planted/harvested/   |                             | ──state───▶ shop.isUnlocked / plots
  sold/built/quest)    |  xp ──derive──▶ level       |             save (on day-summary autosave)
                       +----------------------------+
   level: 由 xp 纯函数推导，永不直接存储/直接修改（防漂移）
```

### 3.2 存档字段（并入 `packages/shared/src/save.ts`）

```ts
export const progressionSaveSchema = z.object({
  xp: z.number().int().min(0).max(15_000),
  profession: z.enum(['horticulturist', 'artisan']).nullable(),
  counters: z.record(z.string(), z.number().int().min(0)),
  achievements: z.array(z.string()),
  xpHistory: z.array(z.number().int().min(0)).max(3),
});
// 迁移：旧档无此字段 → 全默认（xp:0, profession:null, counters:{}, achievements:[], xpHistory:[]）
```

不存：`level`（derive）、耕地解锁状态（derive of level）、商店解锁（derive）。**单一事实源 = xp + counters + achievements + profession**。

---

## 4. 成就系统

### 4.1 设计原则

1. **零焦虑红线**：禁止任何与真实时间相关的成就——无「连续登录 N 天」、无「限时挑战」、无「赛季」；一律用**累计型**计数（累计 N 游戏日、累计 N 次）；
2. 成就永不失败、永不过期、不可错过（missable 为零：所有成就在任意存档时点都仍可达成）；
3. 解锁提示走非模态 toast（§6.3），与升级横幅共用队列；
4. M1 实装范围：计数器全量埋点 + 教学/里程碑成就（#1~#14）+ 简版成就页；收集图鉴 UI、建造/职业/满级成就随 M3，quest 成就随 M4（开放问题 Q3）。

### 4.2 计数器表（`CounterId`，M1 全量埋点）

| CounterId | 触发 | 用途 |
|---|---|---|
| `tillCount` | 每次锄地 | #1 |
| `plantCount` | 每次播种 | #2 |
| `harvestCount` | 每次收获（含再生茬） | #3 #9 |
| `waterCount` | 每次浇水 | #10 |
| `sellCount` / `goldEarned` | 出售件数 / 累计获得金币（毛收入，含 quest 奖励） | #4 #7 #8 |
| `soldCrops:<cropId>` | 每种作物累计售出件数 | #13、收集图鉴（M3） |
| `sleepCount` | 每次日结算 | #6、累计游玩 N 游戏日类 |
| `rainDaysSeen` | 雨天清晨 +1 | #5 |
| `toolUpgrades` | 每次工具升级 | #11 #12 |
| `regrowChainMax` | 单株再生作物最长连收茬数（取 max） | #14 |
| `buildingsBuilt` / `built:<id>` | 建筑竣工（M3） | #15 #16 |
| `sprinklersPlaced` | 洒水器放置（M3） | #17 |
| `questsCompleted` / `notesWritten` | quest 完成 / 笔记落盘（M4） | #19 #20 |

### 4.3 成就清单（id 为英文标识符；奖励即时发放）

| # | id | 名称 | 条件 | 奖励 | 实装 |
|---|---|---|---|---|---|
| 1 | `first_till` | 破土 | `tillCount ≥ 1` | +5 XP | M1 |
| 2 | `first_seed` | 第一粒种子 | `plantCount ≥ 1` | +5 XP | M1 |
| 3 | `first_harvest` | 第一次收获 | `harvestCount ≥ 1` | +10 XP, +20g | M1 |
| 4 | `first_sale` | 第一桶金 | `sellCount ≥ 1` | +10 XP, +20g | M1 |
| 5 | `rain_blessing` | 雨天的馈赠 | `rainDaysSeen ≥ 1` | +10 XP | M1 |
| 6 | `first_sunrise` | 过夜 | `sleepCount ≥ 1` | +5 XP | M1 |
| 7 | `nest_egg` | 小有积蓄 | `goldEarned ≥ 1,000` | +25 XP | M1 |
| 8 | `moneybags` | 千金 | `goldEarned ≥ 10,000` | +50 XP, +200g | M1 |
| 9 | `hundred_harvests` | 百次收获 | `harvestCount ≥ 100` | +30 XP | M1 |
| 10 | `steady_hands` | 如常浇灌 | `waterCount ≥ 200` | +20 XP | M1 |
| 11 | `tooled_up` | 装备升级 | `toolUpgrades ≥ 1` | +20 XP | M1 |
| 12 | `gilded` | 黄金装备 | 两件工具均金档 | +40 XP | M1 |
| 13 | `six_crops` | 初识六谷 | 6 种起步作物各售出 ≥1 | +50 XP, +100g | M1 |
| 14 | `regrow_expert` | 再生行家 | `regrowChainMax ≥ 4` | +25 XP | M1 |
| 15 | `homestead` | 安家 | `buildingsBuilt ≥ 1` | +50 XP | M3 |
| 16 | `tycoon` | 建筑大亨 | 三种建筑齐 | +100 XP, +500g | M3 |
| 17 | `automation_dream` | 自动化之梦 | `sprinklersPlaced ≥ 1` | +30 XP | M3 |
| 18 | `signed_papers` | 职业认定 | 选定职业 | 纪念性（0 XP） | M3 |
| 19 | `first_quest` | 智者 | `questsCompleted ≥ 1` | 由 quest reward 发放（成就本体 0 XP） | M4 |
| 20 | `notebook` | 思考的痕迹 | `notesWritten ≥ 10` | +30 XP | M4 |
| 21 | `farm_master` | 农场大师 | 达到 Lv10 | **0 XP**, +1,000g, 纪念雕像 | M3 |
| 22 | `mastery` | 精通 | XP = 15,000 封顶 | **0 XP**, 金色农场牌匾（装饰） | M3 |

### 4.4 成就 XP 预算

- M1 段（#1~#14）合计 **305 XP**，其中前 10 分钟可得 ~35 XP；占 Lv5 总需求 1,300 的 **23%**——刻意偏高，用于把休闲路径也拉进「第一月见 Lv4~5」的带宽；
- M3/M4 段合计 230 XP，占 Lv5→Lv10 区间 8,700 的 2.6%——后期成就是纪念品不是引擎；
- **不变量**：任何依赖等级/XP 的成就（#21 #22）XP 奖励必须为 0（§8.3 防反馈环）。

---

## 5. 第一周 / 第一月长线目标设计

> 设计单位是「回访 session」（2~10 分钟）而非「天」；每段节拍都要在离开时留下明确的明日之诺（宪法术语）。

### 5.1 第一周（游戏日 1~7 ≈ 21 真实分钟 ≈ 3~8 次回访）

| 游戏日 | 玩家在做什么 | 进度里程碑 | 离开时的明日之诺 |
|---|---|---|---|
| 1 | 教学五连：锄→种→浇（小萝卜 ×10） | 成就 #1 #2 #6 | 「小萝卜后天成熟」 |
| 2~3 | 浇水；首收 + 首卖（180g） | **Lv2**（红线 1）；成就 #3 #4；土豆上架 NEW | 「土豆 6 天后是第一笔大钱」 |
| 4~5 | 混种小萝卜+芜菁+土豆；攒 500g | 铜工具入手（浇水 3 格/次，仪式效率肉眼可见） | 「芜菁明天熟」 |
| 6~7 | 滚动补种；可能遇到首个雨天（#5 假日惊喜） | `goldEarned` 逼近 1,000（#7）；XP ~260 | 「还差 ~120 XP 到 Lv3：豆藤 + 更多耕地」 |

第一周收口状态：Lv2 后期、铜工具、12 格满负荷、认识 3~4 种作物、6~8 个成就。**核心情绪：每次回来都有东西可收，每次离开都知道明天有什么。**

### 5.2 第一月（游戏日 1~28 ≈ 84 真实分钟，碎片化分布在 1~2 周真实时间）

四周弧线，每周一个新「玩法动词」：

| 周 | 主题 | 进度里程碑 | 周末收口（放下点叙事） |
|---|---|---|---|
| 周1（1~7） | 学会循环 | Lv2、铜工具 | 「农场转起来了」 |
| 周2（8~14） | 学会规划（再生作物） | **Lv3**（豆藤 + 耕地 18）；首次体验「一次播种多次收获」 | 「豆藤每两天给我发工资」 |
| 周3（15~21） | 学会投资（高档作物） | **Lv4**（卷心菜 + 金工具 2,500g）；#9 #10 #12 陆续弹出 | 「10 天后卷心菜是迄今最大单笔」 |
| 周4（22~28） | 冲刺与展望 | **Lv5**（浆果 + 耕地 24）；收入 200~350g/日（宪法毕业线）；存款瞄准 2,000g+ | 「浆果在长、图鉴差最后一格、农舍里有一份证书（M3 预告）」 |

月末刻意**不收口**两件事（跨月之诺）：浆果 8 天成熟横跨月线 → `six_crops` 图鉴成就落在第二月初；存款 2,000g ≈ M3 鸡舍首付。M1 仅春季不换季（宪法 §4.3），无任何「月末清场」损失。

---

## 6. 进度感的呈现

> 布局约束：**左上角永久属于 session HUD（宪法）**，progression 一律不占左上角。假设右上为时间/金币面板（依赖 UI 子系统稿，§9）。

### 6.1 常驻元素：等级徽章 + XP 细条（右上面板内）

```
                                        ┌──────────────────┐
                                        │ ☀ 春 7日  9:40    │
                                        │ ⛁ 482 g           │
                                        │ Lv2 ▓▓▓▓▓▓░░░░    │   ← 4px 高细条，进度 = (xp-下限)/(区间)
                                        └──────────────────┘
```

- 鼠标悬停细条显示 tooltip：`312 / 380 XP · 距 Lv3 还差 68`；
- 获得 XP 时：玩家头顶飘字 `+5 xp`（0.8s 上浮淡出，最近邻像素字体），细条同步生长 0.3s。

### 6.2 升级横幅（levelUp banner，非模态）

```
            ┌────────────────────────────────────────────┐
            │  ⬆ 农场等级 3！                              │
            │  解锁：豆藤种子 · 耕地 +6（东侧围栏已打开）      │
            └────────────────────────────────────────────┘
                     屏幕顶部中央，滑入 → 停留 3s → 滑出
```

- **不暂停模拟、不需点击、不抢输入**；伴随一次轻快音效（Kenney UI Audio）+ 角色脚下一圈像素粒子（≤0.6s）；
- 解锁耕地时，对应围栏门播放开门动画 + 短暂金色高亮（玩家视野外则不播，下次靠近时门已是开启态——状态由 sim 决定，动画只是装饰）；
- 横幅内容 = `levelUp` 事件携带的 `unlocks` 渲染，最多列 2 条，更多折叠为「等 N 项」。

### 6.3 成就 toast（右下角，非模态）

```
                                   ┌───────────────────────┐
                                   │ 🏅 成就：第一桶金        │
                                   │    +10 XP  +20g        │
                                   └───────────────────────┘
                                     滑入 2.5s 滑出
```

### 6.4 提示队列（banner/toast 统一通道）

- 同屏最多 1 条横幅 + 1 条 toast；其余 FIFO 排队，队列上限 8（溢出合并为「还有 N 项新进展，详见日结算」）；
- 对话/商店/日结算屏打开时队列**暂停弹出**（模拟已停，提示也不该叠在 UI 上），关闭后继续；
- 多级连升：每级独立横幅依次播（间隔 0.5s），保证每次解锁都被看见。

### 6.5 日结算屏的进度区块（与 day-summary 子系统对接）

```
┌──────────────── 第 7 天 · 日结算 ────────────────┐
│ 今日收成   芜菁 ×4  小萝卜 ×6        收入 +252 g  │
│ ─────────────────────────────────────────────── │
│ 农场进度   Lv2 ▓▓▓▓▓▓▓░░░  312/380   今日 +43 XP │
│ 🏅 新成就   小有积蓄（+25 XP）                     │
│ ─────────────────────────────────────────────── │
│ 明日之诺   · 土豆还有 2 天成熟                     │
│            · 距 Lv3 还差 68 XP（约 2 天）          │
│ ─────────────────────────────────────────────── │
│ [ 会话：2 working · 1 blocked ]      （平静展示）  │
└──────────────── 任意键继续 · 不限时 ──────────────┘
```

- 「约 N 天」估算 = 剩余 XP ÷ `xpHistory` 近 3 日均值，向上取整；均值为 0 时显示「继续耕作即可升级」，**永不显示倒计时**；
- 数据接口：`getDaySummaryBlock(): { level, xpIntoLevel, xpForNext, todayXp, newAchievements, nextUnlockHints }`。

### 6.6 成就页（Esc 菜单 tab，M1 简版列表 / M3 加收集图鉴页）

```
┌─ 菜单 ▸ 成就（7/14） ───────────────────────┐
│ ✔ 破土            首次锄地          +5 XP    │
│ ✔ 第一次收获      …                +10 +20g  │
│ ◻ 百次收获        37/100           +30 XP    │
│ ◻ 初识六谷        4/6 种已售出      +50 +100g │
│ …                                            │
└──────── M3 起新增「图鉴」tab：6 作物格子 ──────┘
```

未完成成就显示实时计数（counters 直读），给「差一点」的微目标感。

---

## 7. 与其他子系统的依赖与接口假设

| 子系统（预计稿号） | progression 消费 | progression 提供 | 假设 |
|---|---|---|---|
| farming（11） | 事件 `tileTilled` `cropPlanted{cropId,count}` `cropHarvested{cropId,count,isRegrow}` `tileWatered`；`CropDef.xp` 字段 | 耕地分区解锁判定 `isPlotUnlocked(plotId)` | CropDef 含 `xp`、`unlock.farmLevel` 字段（mechanics §9.3 结构）；再生茬事件带 `isRegrow` 与连收茬数 |
| economy/shop（12） | 事件 `itemSold{itemId,count,gold}`、工具升级事件 | `isUnlocked(unlockId)` 商店/工具门槛查询；`profession` 售价乘数挂点 | 商店渲染剪影/折叠规则按 §2.2；`goldEarned` 计毛收入 |
| building（13，M3） | 事件 `buildingCompleted{buildingId}` `sprinklerPlaced` | 图纸等级门槛；建筑 XP 表（150/300/500） | 工期按游戏日计（宪法）；工匠职业乘数作用于加工棚产物 |
| time/day-summary | 日结算触发（`daySlept`、雨天信号） | `getDaySummaryBlock()` 数据 | 日结算屏归 time/UI 子系统渲染，本稿只供数据 |
| map | `.tmj` 对象层 `unlockLevel` 属性 | — | 围栏分区 12/6/6/8/10 的具体落位由地图稿定（Q5） |
| quest/daemon（M4） | `questReward{xp,gold,itemId}`（shared zod 已 clamp xp 5~50） | `questsCompleted` `notesWritten` 计数 | 奖励经 WS `questReward` 消息进 sim，离线/断连时不丢（daemon 重发或忽略，归 quest 稿定） |
| shared | — | `progressionSaveSchema`、`AchievementId`/`CounterId` 枚举 | 存档迁移链按 tech-stack §1「顺序迁移函数」 |
| UI/HUD | 渲染 §6 全部元素 | 事件队列 | **左上角不可用**（session HUD 专属）；右上面板存在 |

---

## 8. 边界情况

1. **多级连升**：单次 `grantXp` 跨多个阈值 → 逐级发 `levelUp` 事件（解锁顺序确定性），横幅排队播放（§6.4）；
2. **M1 等级帽**：`effectiveLevel` 封 5，XP 照常累积；M3 迁移按序补发事件（§2.3）；
3. **XP 封顶**：`xp` clamp 15,000，到顶发 `masteryReached` 一次（幂等）；之后 `xpGained` 事件仍发（amount 实记为 0）供 UI 静默处理；
4. **成就反馈环**：成就奖励 XP → 可能升级 → 升级可能解锁成就（#21）→ 该类成就 XP 必须为 0（§4.4 不变量，单测覆盖）；
5. **同帧多事件**：一次 3×3 金喷壶收获 9 株 → 合并为一次 `cropHarvested{count:9}`，XP 一次性结算，飘字合并显示 `+126 xp`；
6. **耕地解锁与在场玩家**：分区平时可行走，解锁仅改「可锄」标志与门 tile，无碰撞突变；
7. **职业未选**：≥Lv5 且 `profession === null` 合法且不阻塞；只在达成当日的日结算提示一次；
8. **存档导入**：`xp`/`counters` 经 zod 校验，越界值 clamp 修复并记一条 console warn；`achievements` 中未知 id 保留不丢（向前兼容未来成就）；
9. **counters 溢出**：全部 `int ≥ 0`，单调递增，无上限需求（28 天满负荷 `waterCount` < 1,200）；
10. **时间即停**：本系统无任何真实时钟读取（代码评审 + ESLint 禁 `Date.now` 于 `sim/**` 之外的注入）；tab 隐藏时队列与动画随渲染层一起冻结，恢复后继续；
11. **quest XP 越界**：daemon 已 clamp，game 端 `safeParse` 再防一层；双重失败则丢弃该奖励并 log，不崩溃。

---

## 9. 验收标准（出厂自检，全部代码化为 sim 层 Vitest 用例）

1. **红线 1**：脚本化勤奋 bot（§1.4 路径）在 ≤3.5 游戏日（≤10.5 真实分钟换算）内达 Lv2，且完成一次完整种→收→卖；
2. **第一月节奏**：勤奋 bot 28 天快进 → Lv5 达成日 ∈ [22, 27]；休闲 bot（仅浇水+顺手收）28 天 → ≥Lv4；
3. **防刷**：锄地/浇水各 10,000 次 → XP 增量 = 0；播种 XP 受耕地格数约束的吞吐上限测试（24 格 ≤36 XP/天）；
4. **多级连升**：一次性 grant 2,000 XP → 依次产生 Lv2..Lv6（无帽）每级一个事件，解锁集合正确；M1 帽下同输入只发到 Lv5；
5. **帽迁移**：xp=2,400 的 M1 存档载入 M3 → 补发 Lv6 事件、洒水器/鸡舍解锁生效；
6. **derive 一致性**：任意存档导出→导入，`levelForXp(xp)`、解锁集合、成就集合与导出前完全一致（level 不入档）；
7. **成就幂等与环**：同条件重复触发只解锁一次；#21/#22 XP=0 断言；
8. **XP 封顶**：从 14,990 grant 100 → xp=15,000、`masteryReached` 恰一次；
9. **零真实时间**：`sim/progression/**` 无 `Date`/`performance` 引用（ESLint 规则断言）；
10. **提示克制**（M1 手测项）：升级/成就提示全程无模态、无暂停、无强制点击；日结算屏停留不限时。

---

## 10. 实装切片（与里程碑对齐）

| 里程碑 | progression 交付物 |
|---|---|
| M1 | `levels.ts`/`reducer.ts`/成就 #1~#14 + 计数器全量埋点；Lv1~5 解锁（种子/工具/耕地 12→24）；等级帽；§6.1~6.5 UI；存档字段与迁移；验收 #1~#4、#6~#10 |
| M2 | 无新增（HUD 里程碑；仅确认右上面板与左上 session HUD 无布局冲突） |
| M3 | 去帽 + Lv6~10 解锁；职业桌；建筑 XP；成就 #15~#18、#21~#22；图鉴页；验收 #5 |
| M4 | quest XP 入口（clamp 校验）；成就 #19 #20 |
| M5 | 成就/解锁文案中英双语 key 化 |

---

## 11. 开放问题

- **Q1（宪法级）**：XP 阈值映射采用本稿 §1.1 解释（Lv2=100 … Lv10=10,000，15,000=精通封顶）。10 个数值对 9 次升级存在歧义，且「15,000=Lv10」会使红线 1 不可达。请确认或修宪固化；
- **Q2**：工匠职业数值假设为「加工品售价 +25%」，待 economy（12）与 building（13）稿确认乘数与作用面；
- **Q3**：M1 范围原文未列成就系统；本稿建议 M1 纳入计数器埋点 + 成就 #1~#14 + 简版成就页（教学成就同时服务红线 1 节奏）。属对 M1 In 列表的轻微扩充，请 owner 裁决；
- **Q4**：背包扩容（1,000g）建议 M3 上线、不设等级门槛，与宪法 §4.4 消费档位并存，请 economy 稿对齐；
- **Q5**：耕地五分区（12/6/6/8/10）的围栏与门 tile 落位，待农场地图稿确定；`unlockLevel` 属性约定需写入地图制作规范；
- **Q6**：T4 作物组（Lv8）具体数值表留给 M3 内容包设计，须按宪法公式校验 goldPerDay ≈ T3 × 1.5~1.7。
