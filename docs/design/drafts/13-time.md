# 13 — 时间系统设计稿（time）

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：草案
> 负责子系统：游戏内时钟、日结构、睡觉与跨天结算、季节与年、暂停规则、生长 tick 联动。
> 上位约束：`00-constitution.md`（尤其 §3 三支柱、§4.3 时间铁律、§4.4 经济基准）；
> 依据：`research/mechanics.md` §4/§9.2、`tech-stack.md` §1（sim 层）/§3（目录）。
> 实现位置：`packages/game/src/sim/time/`（纯 TS，零 Phaser 依赖，确定性 tick）；驱动器在 `packages/game/src/scenes/`。

---

## 0. 设计立场（对照三支柱）

| 支柱 | 时间系统的承诺 |
|---|---|
| 游戏第一 | 3 分钟一天 + 夜间结算把「投入→过夜→回报」压进一次候车间隙；床交互让任何短会话都能主动「快进到明天」，保证每次游玩跨至少一次过夜回报 |
| 零焦虑承诺 | 现实时间对游戏状态的影响**严格为零**：sim 层禁止读墙钟；tab 隐藏/失焦/菜单/AFK 一律暂停；22:00 自动入睡无任何惩罚；不显示「一天进度条」这类倒计时元素 |
| 感知不干预 | 暂停只停**模拟**，不停 HUD——WS 推送与会话面板在暂停时照常更新；日结算屏平静展示会话状态，无倒计时、任意键关闭 |

---

## 1. 核心数值表（单一事实源）

以下常量定义于 `sim/time/constants.ts`，全部为 `as const` 导出，其他子系统**只准引用、不准复制字面量**：

| 常量 | 值 | 说明 |
|---|---|---|
| `REAL_MS_PER_GAME_MINUTE` | **187.5** ms | 1 游戏分钟 = 0.1875 真实秒（宪法 §4.3） |
| `DAY_START_MINUTE` | **360**（6:00） | 每天从 6:00 开始 |
| `DAY_END_MINUTE` | **1320**（22:00） | 到点自动入睡 |
| `GAME_MINUTES_PER_DAY` | **960** | 16 游戏小时 |
| `REAL_SECONDS_PER_DAY` | **180** | 1 游戏日 = 3 真实分钟 |
| `CLOCK_DISPLAY_STEP` | **10** 游戏分钟 | 时钟 UI 按 10 分钟跳字（每 1.875 真实秒刷新一次） |
| `DAYS_PER_SEASON` | **28** | 一季 28 天 |
| `SEASONS` | `['spring','summer','fall','winter']` | M1 锁春季，轮替 M3 启用 |
| `DAYS_PER_YEAR` | **112** | 4 季 × 28 天 |
| `RAIN_PROBABILITY.spring` | **0.20** | 春季雨概率（每夜掷一次） |
| `RAIN_FORCED_SUNNY_DAYS` | `[1]` | 第 1 天强制晴（保证新手日完整教学浇水仪式） |
| `RAIN_MAX_CONSECUTIVE` | **2** | 连雨 ≤2 天，第 3 天强制晴（保住浇水仪式的存在感） |
| `AFK_PAUSE_AFTER_MS` | **90_000** 真实 ms | 90 秒无输入 → 软暂停（仅驱动器层，非 sim） |
| `ACCUMULATOR_CLAMP_MS` | **250** 真实 ms | 单帧最大消费时长，超出丢弃（防止节流后的时间跳跃） |
| `AUTOSAVE_DEBOUNCE_MS` | **5_000** 真实 ms | 暂停触发的自动存档去抖（仅驱动器层） |
| `NIGHT_FADE_OUT_MS` / `NIGHT_FADE_IN_MS` | 600 / 400 真实 ms | 入睡/醒来渐隐渐显（纯表现，不影响 sim） |
| `CLOCK_AMBER_FROM_MINUTE` | **1290**（21:30） | 时钟变琥珀色作视觉提示（无弹窗、无倒计时数字） |

派生换算（设计沟通用）：10 游戏分钟 = 1.875s；1 游戏小时 = 11.25s；玩家单次游玩 2~10 真实分钟 ≈ 0.67~3.3 游戏日。

---

## 2. 时间状态与数据结构

```ts
// sim/time/types.ts —— 纯数据，可直接 JSON 序列化进存档
export type Weather = 'sunny' | 'rain';
export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export interface TimeState {
  day: number;             // 绝对天数，1 起；永不回绕
  minuteOfDay: number;     // 360..1320，整数
  weatherToday: Weather;   // 今天天气（开档：sunny）
  weatherTomorrow: Weather;// 明天天气（结算夜已掷出，供「明日预告」）
  rngState: string;        // 序列化 PRNG（mulberry32/sfc32），天气只在结算夜消耗
}

// 派生视图（不入存档，纯函数计算）
export interface ClockView {
  season: Season;          // M1: 恒为 'spring'；M3+: SEASONS[floor((day-1)/28) % 4]
  dayOfSeason: number;     // ((day-1) % 28) + 1
  year: number;            // floor((day-1) / 112) + 1
  hh: number; mm: number;  // mm 向下取整到 10 分钟
  phase: 'dawn' | 'day' | 'golden' | 'dusk';  // 见 §7 光照表
}
```

**确定性铁律**（ESLint 强制，见 §10 验收）：

1. `sim/**` 禁止 `Date.now` / `performance.now` / `new Date()` / `Math.random`（`no-restricted-properties` + `no-restricted-syntax`）；
2. sim 只接收**整数游戏分钟**：`advanceMinutes(state, n)`；真实毫秒→游戏分钟的累加换算只发生在驱动器（Phaser 侧）；
3. 一切随机（天气）经 `rngState` 显式流转——同 seed + 同操作序列 ⇒ 字节相同的存档（headless 回放测试的根基）。

---

## 3. 一天的结构

```
6:00 ──────────── 白天（可玩时段，全长 960 游戏分钟 = 3 真实分钟）──────────── 22:00
 │                                                                        │
 │ 醒来即可行动；若今日有雨：作物已在结算夜自动浇过（见 §5 流程第 8 步）        │ 自动入睡
 │ 21:30 时钟数字变琥珀色（纯视觉提示，无弹窗/无倒计时）                       ▼
 └────────────────────────────────────────────────────────► NightUpdate → 日结算屏
```

- **没有可玩的深夜**：22:00 即入睡，无晕倒、无金币扣减、无体力概念（M1 无体力）；
- **商店营业时间：6:00–22:00 全天**，即整个可玩时段不打烊。理由：一天仅 3 真实分钟，任何「打烊时刻」都等价于真实时间压力，违反零焦虑承诺。M1 商店形态为农场地图上的售货摊/邮购目录（无 NPC 值守）；M4 若加 NPC 店主，其作息仅是表现层动画，**不影响可交易性**；
- **床（手动睡觉）**：与床交互 → 确认对话框「现在睡觉吗？」（对话框本身即暂停）→ 确认即触发与 22:00 完全相同的 NightUpdate。无早睡惩罚、无奖励。**这是短会话的关键设施**：2 分钟游玩若没自然跨夜，玩家浇完水即可上床主动领取「过夜回报」。提前睡觉压缩日长属预期内策略——经济全部按「夜数」计价（生长/工期/再生都只在结算夜推进），不会失衡；
- **时钟显示**：24 小时制，10 分钟跳字（`14:30` → 1.875s 后 `14:40`）。**不做「今日剩余时间」进度条**——进度条即倒计时，制造焦虑。

---

## 4. 时间系统状态机

sim 内核只有 RUNNING 中的分钟推进与 NightUpdate 两件事；暂停与界面态由驱动器（game shell）管理：

```
                     暂停源集合非空（任一激活）
          ┌────────────────────────────────────────┐
          ▼                                        │
     ┌─────────┐         暂停源清空            ┌─────────┐
     │ PAUSED  │ ─────────────────────────────► │ RUNNING │ ◄──── 读档后点击「回到农场」
     └─────────┘                                └────┬────┘       （boot_gate 是暂停源之一）
          ▲                                          │ minuteOfDay 达到 1320（22:00）
          │                                          │ 或 床交互确认
          │ 任意键 / 点击                             ▼
     ┌─────────────┐      NightUpdate        ┌──────────────────┐
     │ DAY_SUMMARY │ ◄────────────────────── │ NIGHT_TRANSITION │
     └─────────────┘    （同步原子，不可中断） └──────────────────┘
     （本身是暂停源；               （输入冻结 + 600ms 渐隐；渐隐是表现层，
      关闭后回 RUNNING，             状态变更在单次同步调用内完成）
      新的一天 6:00 起跳）
```

**暂停源表**（驱动器维护一个 `Set<PauseSource>`；集合非空 ⇒ `timeScale = 0`，不调用 `advanceMinutes`；无部分倍速、无快进）：

| 来源 id | 触发 | 解除 | 备注 |
|---|---|---|---|
| `tab_hidden` | `document.visibilitychange` → hidden | → visible | 浏览器 rAF 节流与否无关紧要，反正已停 |
| `window_blur` | `window` blur 事件 | focus 事件 | 「与终端同屏」场景：切去终端即停。设置项 `pauseOnBlur` 默认 **true**（开放问题 Q2） |
| `afk` | 90s 无 keydown/mousedown/mousemove/wheel | 任意上述输入 | 软暂停遮罩（§8.3）；输入即恢复，遮罩淡出 |
| `menu` | Esc 菜单打开 | 关闭 | 宪法 §4.5 |
| `dialog` | 任何模态：NPC 对话、确认框、商店界面、quest 面板 | 关闭 | M4 quest 复用此源 |
| `day_summary` | 日结算屏出现 | 任意键/点击 | 停留不限时 |
| `boot_gate` | 读档完成、等待首次交互 | 点击「回到农场」 | 顺带满足浏览器音频自动播放策略 |

**暂停时各层行为**（感知不干预的关键拆分）：

| 层 | 暂停时 |
|---|---|
| sim（时间/作物/经济） | 完全冻结，零状态变更 |
| 渲染 | 继续跑（环境动画如水面微光可继续——纯表现，非 sim 状态） |
| HUD / WS 客户端 | **照常接收与刷新**——会话状态是真实世界信息，永不冻结 |
| 音频 | `tab_hidden` 时静音；其余暂停源仅降低 BGM 音量（表现层细节，可调） |

**允许使用真实时间的白名单**（除此之外出现墙钟即 bug）：HUD 会话 `since` 显示、WS 重连退避、自动存档去抖、AFK 计时、渐隐动画时长、daemon 侧 quest 节流（≤1 个/15 真实分钟，属 M4 daemon 职责，非游戏状态）。

---

## 5. 跨天结算 NightUpdate（核心流程）

触发：`minuteOfDay` 推进中跨越 1320，或床确认。**单次同步纯函数调用**，不可被暂停打断（渐隐动画可暂停，状态已先行提交）：

```ts
// sim/night/runNight.ts
function runNight(state: GameState): { state: GameState; summary: DaySummary };
```

**阶段顺序（固定、有编号，跨子系统对齐的合同）**：

| # | 阶段 | 归属子系统 | 行为 |
|---|---|---|---|
| 1 | `settleShipping` | 经济 | 出售箱内全部物品按 sellPrice 结算 → 金币入账、清空箱子、记录图鉴首售（M3）。白天可随时取回箱内物品，入夜才锁定结算 |
| 2 | `growCrops` | 农作 | 每块种植格：若 `wateredToday == true` **或** `weatherToday == 'rain'`（露天格），则生长进度 +1 天（按 `CropDef.stageDays`）；再生作物的 `regrowDays` 倒数同样在此推进。**作物白天不生长，生长只发生在结算夜，每夜至多 +1 天**——这就是「时间与生长 tick 的联动」的全部 |
| 3 | `resetWatered` | 农作 | 所有 `wateredToday` 置 false，浇水视觉恢复干土 |
| 4 | `progressConstruction` | 建造（M3） | 在建建筑 `nightsRemaining--`，归零即竣工。工期按「睡过的夜数」计，与早睡晚睡无关 |
| 5 | `produceAnimals` | 动物（M3） | 鸡舍基础产出判定 |
| 6 | `advanceDay` | 时间 | `day++`，`minuteOfDay = 360` |
| 7 | `seasonCheck` | 时间+农作（M3） | 若 `dayOfSeason` 回绕到 1：换季。换季夜清除过季作物（温室豁免）；**换季前 3 天起**日结算屏「明天」栏预告「秋季将至，卷心菜需在 N 天内收获」。M1 此阶段为空操作（锁春） |
| 8 | `rollWeather` | 时间 | `weatherToday ← weatherTomorrow`；用 `rngState` 掷新的 `weatherTomorrow`（按 §1 概率与约束：强制晴日、连雨 ≤2）。若新的 `weatherToday == 'rain'`：露天作物格全部置 `wateredToday = true`（雨天豁免在此落地；雨天中途新播种的格子由播种动作即时置湿） |
| 9 | `buildSummary` | 时间 | 汇总 1~8 阶段产出 + 白天累积的 `dayLog` → `DaySummary`，清空 `dayLog` |
| 10 | `autosave` | 存档 | 全量快照写 IndexedDB（idb-keyval），含 `schemaVersion`。失败不阻塞结算屏，但显示温和的「存档失败，建议导出 JSON」提示 |

> 注意第 8 步在 `advanceDay` 之后：结算屏上的「明天」= 移位后的 `weatherToday`（即 day N+1 当天），文案务必取这个字段而不是 `weatherTomorrow`。

**白天日志 `dayLog`**（结算屏数据来源，随动作即时累积）：

```ts
interface DayLog {
  harvested: { cropId: string; count: number }[]; // 收割入包即记
  xpGained: number;                               // 收获 XP 即时入账（宪法公式），此处仅累计展示
  levelUps: number[];                             // 当日升到的等级
  goldSpent: number;                              // 购买种子/升级支出
}

interface DaySummary {
  day: number; season: Season; dayOfSeason: number; year: number;
  harvested: DayLog['harvested'];
  shipped: { cropId: string; count: number; gold: number }[];
  goldEarned: number; goldBalance: number;
  xpGained: number; levelUps: number[];
  tomorrow: TomorrowItem[];   // 「明日之诺」条目，见下
  weatherNext: Weather;       // = 移位后的 weatherToday
}

type TomorrowItem =
  | { kind: 'rain' }                                        // ☔ 明日有雨，作物自动浇水
  | { kind: 'cropReady'; cropId: string; inDays: number }   // 🌱 土豆还有 2 天成熟（inDays==1 → 明天成熟！）
  | { kind: 'construction'; buildingId: string; inDays: number } // 🔨 鸡舍还差 1 天竣工（M3）
  | { kind: 'seasonEnd'; inDays: number };                  // 🍂 距换季还有 3 天（M3）
```

「明日之诺」生成规则：按 `inDays` 升序取**至多 3 条**；若一条都没有（地里全空、无在建），固定显示「商店有新鲜种子等你」——保证结算屏永远有一条向前看的内容（宪法支柱 1）。

---

## 6. 季节与年

- **历法**：1 年 = 4 季 × 28 天 = 112 天；`season/dayOfSeason/year` 全部由绝对 `day` 派生（§2 公式），存档只存 `day`，无独立季节字段可错乱；
- **M1（锁春）**：`seasonCheck` 空操作，日历显示「春 · 第 N 天」，N 按 28 回绕（第 29 天显示「春 · 第 1 天」，年数照常 +1 进位规则冻结为恒 year 1 的显示——绝对 `day` 仍单调递增，存档无歧义）；全部 6 种起步作物 `season: ['spring']`；
- **M3+（轮替启用）**：
  - 换季影响仅两条：**作物可种集合**随季变化；**换季夜清除过季作物**（温室豁免）；
  - 防焦虑配套（不可裁剪）：换季前 3/2/1 天，日结算屏「明天」栏必含 `seasonEnd` 预告与受影响作物清单；商店在换季前 3 天停售本季内来不及成熟的种子（按 `growthDays > 剩余天数` 过滤），并显示「来不及在本季成熟」标注——宁可不卖，不让玩家踩坑；
  - 冬季的玩法定义（休耕？温室季？）**不在本稿范围**，归 M3 建造稿与农作稿联合设计；本稿仅保证历法与钩子就位；
- **年**：无老化、无年度事件（节日不在 M1~M5 范围）；year 仅作日历显示与存档统计。

---

## 7. 光照与昼夜表现（纯表现层，由 `minuteOfDay` 派生）

| 时段 | phase | 表现 |
|---|---|---|
| 6:00–7:30 | `dawn` | 暖橙色 tint 从 25% 渐退到 0 |
| 7:30–17:00 | `day` | 无 tint |
| 17:00–19:00 | `golden` | 暖金 tint 渐升到 15% |
| 19:00–22:00 | `dusk` | 蓝紫 tint 渐升到 45%（22:00 入睡时达到峰值，自然引出渐隐） |

雨天：全天叠加 10% 冷灰 + 雨粒子 + 雨声循环。tint 插值按 10 游戏分钟一档步进（与时钟刷新同步即可，无需逐帧），杜绝非整数像素位移风险（宪法 §4.2 不涉及，tint 仅颜色变换，安全）。

---

## 8. UI 草图（ASCII）

### 8.1 时钟组件（右上角；左上角留给会话 HUD）

```
                                        ┌────────────────────────┐
                                        │  春 · 第 3 天    ☀ 14:30 │   ← 10 分钟跳字
                                        └────────────────────────┘
                                        （21:30 后时间数字变琥珀色；
                                          雨天 ☀ 换 ☔；无进度条、无倒计时）
```

### 8.2 日结算屏（22:00 / 床确认后；任意键关闭、停留不限时）

```
   ╔════════════════════════════════════════════════════╗
   ║                  第 3 天 · 春 · 夜                   ║
   ║────────────────────────────────────────────────────║
   ║   今日收成      小萝卜 ×4    芜菁 ×2                 ║
   ║   出售箱结算    +96 g        （金币 142 → 238）      ║
   ║   获得经验      +26 XP       Lv1 ▓▓▓▓▓▓░░░░ 64/100  ║
   ║────────────────────────────────────────────────────║
   ║   明天                                              ║
   ║    ☔  明日有雨，作物已自动浇水                        ║
   ║    🌱  土豆还有 2 天成熟                              ║
   ║────────────────────────────────────────────────────║
   ║   会话    api-refactor   ● working                  ║
   ║           bugfix-1138    ◐ blocked · 在等你          ║
   ║────────────────────────────────────────────────────║
   ║            按任意键开始新的一天（不着急）               ║
   ╚════════════════════════════════════════════════════╝
```

要点：会话区由 HUD store 实时驱动（结算屏开着时状态也会更新）；blocked 文案用「在等你」而非警示色——平静陈述，不催促；无「点击继续」倒计时。

### 8.3 AFK 软暂停遮罩（90s 无输入）

```
              （画面整体压暗 20%，遮罩淡入 300ms）

                  ┌────────────────────────┐
                  │    ⏸  农场在等你回来      │
                  │    时间已停 · 零损失      │
                  └────────────────────────┘

              （任意输入立即恢复，遮罩淡出；不弹窗、不出声）
```

`tab_hidden` / `window_blur` 恢复（refocus）时不显示任何遮罩，直接继续——切换成本必须为零。

---

## 9. 驱动器与 tick 管线（实现规格）

```
Phaser update(time, delta)                          packages/game/src/scenes/
  │
  ├─ if pauseSources.size > 0 → return              （sim 完全不被调用）
  │
  ├─ accumulatorMs += min(delta, ACCUMULATOR_CLAMP_MS)   ← 250ms 钳制：系统休眠/
  │                                                        节流恢复后的大 delta 直接丢弃
  ├─ while (accumulatorMs >= 187.5):
  │     accumulatorMs -= 187.5
  │     events = sim.advanceMinutes(state, 1)        ← sim 永远整分钟推进，逐分处理
  │     │                                              保证 22:00 边界不会被跨步越过
  │     ├─ on CLOCK_TICK(每 10 分钟) → 刷新时钟 UI / 光照档位
  │     └─ on DAY_END(minuteOfDay==1320) →
  │           进入 NIGHT_TRANSITION：冻结输入 → runNight()（同步原子）
  │           → 渐隐 600ms → 显示 DaySummary（加入暂停源 day_summary）
  │           → 丢弃 accumulator 余量
  └─ 渲染照常
```

- `advanceMinutes` 一次只走 1 分钟：避免「一帧跨多分钟越过 22:00」的边界 bug，960 次/游戏日的调用量可忽略；
- **存档触发点**（与存档子系统的接口合同）：
  1. NightUpdate 第 10 阶段（权威自动存档，必发）；
  2. 暂停源 `tab_hidden` 或 `window_blur` **进入**时（去抖 ≥5s）——玩家切去终端的瞬间存档已落盘，之后无论何时关 tab 都零丢失；`pagehide` 上再补一次 best-effort 写（IndexedDB 在 pagehide 中不保证完成，但前一条已兜底，典型流程「blur → 稍后关页」损失为 0，最坏损失 ≤ 上次去抖窗口内的操作）；
  3. 手动存档（Esc 菜单，任意时刻，存盘中段日内状态）。
- 读档恢复：精确恢复 `day/minuteOfDay/天气/rng`，以 `boot_gate` 暂停态等待首次点击。

---

## 10. 边界情况清单

| # | 情形 | 规则 |
|---|---|---|
| 1 | 浏览器 tab 节流/系统休眠/合盖后回来 | rAF 间隙巨大 delta 被 250ms 钳制丢弃 + 期间本就处于 `tab_hidden` 暂停 → 状态零变化 |
| 2 | 22:00 整时玩家正在走路/挥锄 | 输入冻结，当前动画自然结束或直接渐隐；无任何惩罚或动作回滚（动作产生的状态在 NightUpdate 前已提交） |
| 3 | NightUpdate 中途切 tab | 状态变更是单次同步调用，不可能「中途」；只有渐隐动画可被暂停，回来继续播或直接出结算屏 |
| 4 | 雨天中途播种 | 播种动作检测 `weatherToday=='rain'` → 该格立即 `wateredToday=true` |
| 5 | 床确认对话框开着跨 22:00 | 不可能：对话框是暂停源，时间停在 21:5x；关闭后继续走到 22:00 自然入睡 |
| 6 | 第 28 天夜（M1） | `seasonCheck` 空操作，日历回绕显示「春 · 第 1 天」，作物不受影响 |
| 7 | 出售箱为空时入睡 | `settleShipping` 零产出；结算屏出售行显示「今天没有出售」（不是错误态） |
| 8 | 整天什么都没做就 22:00 | 结算屏照常出现：收成空、出售空，但「明天」栏仍按规则给至少 1 条（兜底文案）——离开时永远有「明日之诺」 |
| 9 | 同一存档开两个 tab | `BroadcastChannel('codestead-save')` 互斥：后开的 tab 显示「农场已在另一个标签页打开」并以只读暂停态挂起（防止双写存档）。简单实现，M1 必做 |
| 10 | 存档写入失败（隐私模式/配额） | 不阻塞游玩；结算屏与菜单显示温和提示 + 一键导出 JSON；`navigator.storage.persist()` 在首次存档时申请 |
| 11 | 玩家用「浇水→上床」循环极速过日 | 预期内策略，明确允许：所有进度按夜数推进，瓶颈是白天动作本身的真实耗时；无需限制（零焦虑 > 防滥用） |
| 12 | 读档后版本中常量变更（如改了日长） | 时间存档只存 `day/minuteOfDay/天气/rng`，不存换算常量；`minuteOfDay` 越界时 clamp 到 [360,1320] 并记迁移日志 |
| 13 | `requestAnimationFrame` 与 `visibilitychange` 触发顺序的浏览器差异 | 恢复 RUNNING 前先重查 `document.visibilityState === 'visible' && document.hasFocus()`（若 `pauseOnBlur` 开），以查询结果为准而非事件序 |

---

## 11. 对其他子系统的依赖与接口假设

| 子系统（预计稿号） | 本稿假设 | 需要确认 |
|---|---|---|
| 农作（11-farming） | 格子持有 `wateredToday` 标志；生长仅在 NightUpdate #2 推进，每夜至多 +1 天；`CropDef.stageDays/regrowDays` 同 mechanics §9.3；雨天豁免=结算夜批量置湿（#8）+ 雨中播种即时置湿 | 生长阶段是否有「成熟后过熟」概念（本稿假设**没有**——成熟作物无限期等待收割，符合零焦虑） |
| 经济/商店（12-economy 假设） | 出售走**出售箱**、夜结算（NightUpdate #1）；白天可取回箱内物品；商店全天营业不打烊；收获 XP 即时入账、结算屏只汇总 | 是否另设「即时收购」渠道；出售箱容量是否无限（本稿假设无限） |
| 存档（save schema，shared 包） | 时间切片 schema 见 §2/§12；存档触发点见 §9；`schemaVersion` 迁移链由存档稿统一 | 确认 zod schema 归属 `packages/shared/src/save.ts` |
| 地图（M1 farm map） | 地图含初始小屋/帐篷与**可交互的床**（手动睡觉的载体）、出售箱、售货摊各 1 处 | 床的位置应靠近农田出入动线（减少「去睡觉」的步行摩擦） |
| HUD（M2） | HUD store 独立于 sim，暂停时照常更新；结算屏从 HUD store 读当前会话列表渲染会话区 | 无 |
| 建造（M3） | 工期字段为 `nightsRemaining`，NightUpdate #4 递减；「2 游戏日工期」= 2 个结算夜 | 换季夜与竣工夜同时发生时的结算屏排版 |
| quest/NPC（M4） | quest 面板复用 `dialog` 暂停源；daemon 的 15 真实分钟节流不属于游戏状态（白名单） | NPC 作息动画与「商店不打烊」的表现层协调 |
| 渲染场景 | 仅消费 `ClockView`（含 phase）做 tint 与时钟 UI；禁止反向写时间状态 | 无 |

---

## 12. 存档切片（供 shared 包 zod 定稿参考）

```ts
export const TimeSaveSchema = z.object({
  day: z.number().int().min(1),
  minuteOfDay: z.number().int().min(360).max(1320),
  weatherToday: z.enum(['sunny', 'rain']),
  weatherTomorrow: z.enum(['sunny', 'rain']),
  rngState: z.string(),          // 序列化 PRNG 状态
});
// dayLog 同样入档（中段日存档需要恢复结算屏数据来源）
```

---

## 13. 验收标准（sim 层 headless 测试逐条代码化）

1. **整日推进**：从 `{day:1, minuteOfDay:360}` 连续 `advanceMinutes` 960 次 → 恰好触发 1 次 `DAY_END`，`runNight` 后 `{day:2, minuteOfDay:360}`；
2. **确定性**：同 seed + 同操作脚本（含浇水/播种/睡觉序列）重放两次 → 最终存档 JSON 字节相同；
3. **零墙钟**：CI 中 `grep -rE 'Date\.now|performance\.now|new Date|Math\.random' packages/game/src/sim/` 零命中 + ESLint 规则常开；
4. **暂停零变化**：任一暂停源激活期间（模拟驱动器不调用 advance）序列化状态前后逐字节相同；tab 隐藏 1 真实小时等价于 0 游戏分钟；
5. **结算顺序**：出售箱金额先于 autosave 入账；`DaySummary.goldBalance` 等于存档中的金币数；
6. **天气约束**：10,000 夜模拟中——第 1 天恒晴；不存在 3 连雨；雨频率 20% ± 3%；雨日清晨全部露天种植格 `wateredToday==true`；
7. **明日之诺非空**：构造「空农场、无在建」状态跑 NightUpdate → `summary.tomorrow` 仍含 1 条兜底条目；
8. **快进 30 天经济回归**：headless 跑「每日全浇 + 即收即卖」脚本 30 天，产出落在宪法 §4.4 收入量级区间（与农作/经济稿共用此测试）；
9. **床等价性**：6:10 上床与 22:00 自动入睡产生的状态迁移除 `dayLog` 内容外完全同构；
10. **存档时机**：模拟 blur → 5s 内存档落盘；随后直接销毁内存状态再读档 → 与销毁前快照一致（最坏丢失 ≤ 去抖窗口）；
11. **宪法红线对照**：上述 4（红线 3「无真实时间恶化」）、7（红线「明日之诺」）即宪法 §7 的代码化；红线 2「2 分钟至少浇完水+看到进度条」由 6+8 联合保证（雨天豁免不剥夺进度：进度条=生长阶段在次夜推进）。

---

## 14. 开放问题（需对应负责人裁决）

1. **Q1（经济稿）**：是否在出售箱之外提供「售货摊即时卖出」？即时卖出会削弱结算屏的回报浓度，本稿倾向 M1 仅出售箱；
2. **Q2（产品）**：`pauseOnBlur` 默认 true 是否过于激进——双屏用户可能希望瞥着农场走时间？本稿默认 true（时间只为「在场」流动），设置项已预留；
3. **Q3（产品/农作）**：Esc 菜单是否加「回家睡觉」快捷项（免走路）？本稿 M1 不加（保留小屋的空间意义），若 playtest 反馈步行摩擦大再加；
4. **Q4（M3 联合）**：冬季玩法（休耕 vs 温室季）与换季清场的最终体验，归 M3 建造+农作联合稿；
5. **Q5（农作稿）**：雨天是否额外给小概率惊喜（如雨后野菜刷新）让「假日感」更强？纯加分项，不影响本稿合同。
