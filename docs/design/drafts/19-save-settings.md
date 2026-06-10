# 19 存档与设置（save-settings）设计稿

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：草案 ｜ 负责域：存档（save）与设置（settings）
> 上位约束：`docs/design/drafts/00-constitution.md`（冲突时以宪法为准）；技术依据：`docs/design/tech-stack.md`（§1 存档行、§3 目录结构、§6 风险 8）；数值依据：`docs/design/research/mechanics.md` §9。
> 代码落点：schema 在 `packages/shared/src/save.ts`；实现在 `packages/game/src/storage/`；设置 UI 在 `packages/game/src/scenes/`（菜单场景）。

---

## 0. 三支柱自检（宪法 §3）

| 支柱 | 本子系统的承诺 |
|---|---|
| 游戏第一 | 存档/设置完全隐形：玩家正常游玩永远不需要想起「存档」二字；唯一可见痕迹是日结算屏角落一个安静的「已保存 ✓」 |
| 零焦虑承诺 | 任意时刻关页/切 tab/断电，损失 ≤ 30 真实秒；存档内**不存在任何由真实时钟驱动游戏逻辑的字段**（真实时间戳仅作展示信息）；无任何「存档过期/损坏即重来」——损坏走三层恢复链 |
| 感知不干预 | 设置里所有 HUD/quest 开关只控制「展示与频率」，不产生任何反向干预；思考笔记内容**不入浏览器存档**（只存引用 id），笔记本体始终在 `~/.codestead/notes/`（本机、daemon 侧） |

---

## 1. 范围与非目标

**范围（本稿交付）**：存档内容清单与 zod schema（v1）、存储选型与键位规划、存档生命周期状态机（加载/迁移/恢复/多标签互斥）、自动存档时机与节流、版本迁移策略、JSON 导入导出、设置项清单与 schema、可访问性（五态配色 + 减少动效）。

**非目标（明确不做）**：
- 云存档 / 账号体系 / 任何上传（宪法 M5 永久 Out）；
- 多存档槽（M1 单槽，键名已预留维度，见 §2.3 与开放问题）；
- 存档加密 / 防作弊（单机自娱，导出 JSON 本来就可编辑——视为 feature）；
- daemon 本机落盘存档端点（tech-stack 风险 8 的 M3+ 增强，本稿仅留接口缝）。

---

## 2. 存储方案选型

### 2.1 存档主存储：IndexedDB（经 `idb-keyval@^6.2.5`）

tech-stack §1 已裁决，此处补足本子系统视角的对照论证：

| 维度 | localStorage | IndexedDB（idb-keyval） | 裁决 |
|---|---|---|---|
| 容量 | ~5MB 且按 UTF-16 计 | 起步数百 MB（按磁盘配额） | 存档 worst ≈ 450KB（§3.3），localStorage 勉强够但无余量（M3 建筑/图鉴只会更大） → IDB |
| 阻塞性 | 同步、阻塞主线程 | 异步事务 | 我们在 `visibilitychange` 等敏感时机写档，同步写一帧 450KB 字符串会肉眼可见卡顿 → IDB |
| 写入原子性 | 单 key 原子但无事务语义保证（部分浏览器崩溃场景有丢写报告） | 单 key put 即事务，崩溃时要么旧值要么新值 | IDB |
| 可持久化申请 | 无独立机制 | `navigator.storage.persist()` 覆盖整个 origin 存储（含两者） | 平手（persist 对 origin 生效） |
| 结构 | 仅字符串 | 结构化克隆，直接存 JS 对象（省去 stringify 双份内存峰值） | IDB |

**用法收敛**：只用 `get/set/del` 三个原语操作**单个版本化 JSON 文档**（不做多 store、不做索引），`idb-keyval` 的 `createStore('codestead', 'kv')` 自建库，避开默认库名撞车。

### 2.2 设置存储：localStorage（与存档分离）

设置**不放进存档文档**，单独存 localStorage，理由：

1. **启动同步可读**：语言、音量、reducedMotion 在 Phaser boot 第一帧前就要用（加载屏文案、是否播 BGM、是否播 logo 动画），localStorage 同步读免去一次异步竞态；
2. **生命周期独立**：「删除存档重开新档」不应重置玩家的音量与可访问性偏好；导入他人存档也不应带入他人设置；
3. **体积极小**：< 1KB，localStorage 的全部缺点（容量/阻塞）在此量级不存在；
4. **损坏代价不对称**：设置损坏 = 静默回退默认值即可（zod 失败不弹任何错误）；存档损坏 = 必须走恢复流程。分开存把两种错误处理路径解耦。

### 2.3 键位规划

| 存储 | 键 | 内容 | 写入方 |
|---|---|---|---|
| IDB `codestead/kv` | `save:slot0` | 当前存档 `SaveDoc`（结构化对象） | 自动/手动存档 |
| IDB `codestead/kv` | `save:slot0:backup` | 上一个游戏日结算时的完整存档（滚动备份，深度 1） | 仅日结算存档时轮换 |
| IDB `codestead/kv` | `save:slot0:corrupt` | 最近一次校验失败的原始数据（留证 + 支持人工抢救），新损坏覆盖旧的 | 恢复流程 |
| localStorage | `codestead.settings.v1` | `Settings` JSON 字符串 | 设置界面，写入即生效即落盘 |

`slot0` 维度为未来多槽预留；M1~M5 固定单槽。**禁止**任何代码绕过 `SaveStorage` 接口直接触碰这些键（ESLint `no-restricted-imports` 把 `idb-keyval` 限制在 `storage/**` 内）。

### 2.4 存储降级链

```
IndexedDB 可用？ ──是──► 正常模式（主路径）
      │否（隐私模式禁用 / 配额策略 / 企业策略）
      ▼
localStorage 可用？ ──是──► 降级模式：同一 SaveStorage 接口的 localStorage 适配器
      │                    （JSON.stringify 存 save:slot0；>4MB 拒写并提示导出）
      │                    顶部常驻一条安静的提示：「存储受限，建议定期导出存档」
      │否
      ▼
内存模式：可玩但刷新即丢；每次日结算屏附带「导出存档」按钮高亮提示
```

启动时调用一次 `navigator.storage.persist()`（非阻塞、不 await 结果再开局）；被拒绝时**不弹窗**，仅在设置页「存档」区显示一行小字「浏览器未授予持久存储，清理站点数据可能删除存档，建议偶尔导出」。

---

## 3. 存档内容清单（SaveDoc v1）

### 3.1 字段总表

| 区块 | 字段 | 类型/取值 | 里程碑 | 数据归属（对齐对象） |
|---|---|---|---|---|
| `schemaVersion` | — | `1` | M1 | shared |
| `meta` | `saveId` | uuid v4，建档时生成，导入去重用 | M1 | storage |
| | `appVersion` | 写档时游戏版本字符串 | M1 | storage |
| | `createdAtReal` / `savedAtReal` | ISO 8601，**仅展示**（设置页「上次保存」、导入预览） | M1 | storage |
| | `saveCount` | 累计写档次数（诊断用） | M1 | storage |
| | `playTimeRealSeconds` | 累计在场游玩时长（统计展示，**不参与任何游戏逻辑**） | M1 | storage |
| `time` | `day` | ≥1 整数，第几个游戏日 | M1 | sim/time |
| | `season` | `'spring'`（M1 唯一；M3 换季时扩枚举 = 升 schema） | M1 | sim/time |
| | `minuteOfDay` | 360~1320（6:00~22:00） | M1 | sim/time |
| | `weatherToday` / `weatherTomorrow` | `'sunny' \| 'rain'`；明日天气**预滚**入档，保证日结算「明日预告」与重开后一致 | M1 | sim/time |
| | `rngState` | 确定性 PRNG 序列化态（sfc32 的 4×u32 hex 串） | M1 | sim |
| `player` | `tileX/tileY` | 0~63 | M1 | farming/map |
| | `facing` | `'up'\|'down'\|'left'\|'right'` | M1 | farming/map |
| | `gold` | ≥0 整数，新档 **100** | M1 | economy |
| | `selectedSlot` | 0~23 | M1 | inventory |
| `tools` | `hoe` / `wateringCan` | 档位 1~3（1 木初始 / 2 铜 500g / 3 金 2,500g，即时生效） | M1 | economy/tools |
| `inventory` | `capacity` | `12 \| 24`（扩容 1,000g） | M1 | inventory |
| | `slots[]` | `{ itemId, quantity(1~999) } \| null`，定长 = capacity | M1 | inventory |
| `world` | `farmTiles` | 稀疏 record，key `"x,y"`，值见 §3.2 TileState；**未开垦格不入档** | M1 | farming |
| | `shippingBin[]` | 出售箱内容（日结算清算并入 gold） | M1 | economy |
| `progress` | `farmLevel` / `xp` | 1~10 / 累计 XP（阈值表见宪法 §4.4） | M1 | progression |
| | `profession` | `'gardener' \| 'artisan' \| null`（Lv5 二选一，M3 生效，字段先行） | M1 占位 | progression |
| | `collectionLog[]` | 首次售出过的 cropId 列表（图鉴） | M1 | progression |
| | `stats` | `totalGoldEarned / totalHarvests / harvestsByCrop` | M1 | progression |
| `quests` | `completedQuestIds[]` | 已完成 quest id | M4（容器 M1 先建） | quest |
| | `noteRefs[]` | 思考笔记的文件 id 引用；**笔记内容永不入档**（本体在 `~/.codestead/notes/`，隐私 + 单一事实源 + 浏览器清数据不殃及笔记） | M4 | quest/daemon |
| （无） | 建筑、品质、洒水器布置 | **v1 不含**，M3 经 schema v2 迁移加入（见 §5 示例） | M3 | building |

**「真实时间不入 sim」纪律**：`meta.*Real` 与 `playTimeRealSeconds` 是仅有的真实时间字段，全部位于 `meta` 区块且只供 UI 展示。代码层面以 shared 包单元测试守护：`restoreSim(doc)` 的输入类型里根本拿不到 `meta`（serialize/restore 的参数是 `Omit<SaveDoc, 'meta' | 'schemaVersion'>`），从类型上杜绝「读真实时钟算生长」。

### 3.2 zod schema 草案（`packages/shared/src/save.ts`）

```ts
import { z } from 'zod';

export const SAVE_SCHEMA_VERSION = 1;

const CropStateSchema = z.object({
  cropId: z.string(),                                  // must exist in crop table
  daysGrown: z.number().int().min(0),                  // completed growth days
  mature: z.boolean(),
  regrowDaysLeft: z.number().int().min(0).nullable(),  // regrowing crops only
});

const TileStateSchema = z.object({
  tilled: z.literal(true),       // untilled tiles are simply absent (sparse)
  wateredToday: z.boolean(),
  crop: CropStateSchema.nullable(),
});

const ItemStackSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().min(1).max(999),
});

export const SaveDocV1Schema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    saveId: z.string().uuid(),
    appVersion: z.string(),
    createdAtReal: z.string(),     // ISO 8601, display only
    savedAtReal: z.string(),       // ISO 8601, display only
    saveCount: z.number().int().min(0),
    playTimeRealSeconds: z.number().min(0),   // stats display only
  }),
  time: z.object({
    day: z.number().int().min(1),
    season: z.literal('spring'),
    minuteOfDay: z.number().int().min(360).max(1320),
    weatherToday: z.enum(['sunny', 'rain']),
    weatherTomorrow: z.enum(['sunny', 'rain']),
    rngState: z.string().regex(/^[0-9a-f]{32}$/),      // sfc32: 4 x u32 hex
  }),
  player: z.object({
    tileX: z.number().int().min(0).max(63),
    tileY: z.number().int().min(0).max(63),
    facing: z.enum(['up', 'down', 'left', 'right']),
    gold: z.number().int().min(0),
    selectedSlot: z.number().int().min(0).max(23),
  }),
  tools: z.object({
    hoe: z.number().int().min(1).max(3),
    wateringCan: z.number().int().min(1).max(3),
  }),
  inventory: z.object({
    capacity: z.union([z.literal(12), z.literal(24)]),
    slots: z.array(ItemStackSchema.nullable()).max(24),
  }),
  world: z.object({
    farmTiles: z.record(z.string().regex(/^\d{1,2},\d{1,2}$/), TileStateSchema),
    shippingBin: z.array(ItemStackSchema),
  }),
  progress: z.object({
    farmLevel: z.number().int().min(1).max(10),
    xp: z.number().int().min(0),
    profession: z.enum(['gardener', 'artisan']).nullable(),
    collectionLog: z.array(z.string()),
    stats: z.object({
      totalGoldEarned: z.number().int().min(0),
      totalHarvests: z.number().int().min(0),
      harvestsByCrop: z.record(z.string(), z.number().int().min(0)),
    }),
  }),
  quests: z.object({
    completedQuestIds: z.array(z.string()),
    noteRefs: z.array(z.string()),
  }),
});

export type SaveDocV1 = z.infer<typeof SaveDocV1Schema>;
export type SaveDoc = SaveDocV1;   // alias always points at current version
```

新档初始值（与宪法 §4.4 / mechanics §9 对齐）：`gold=100`、`capacity=12`、双工具档位 1、`day=1`、`minuteOfDay=360`、`season='spring'`、`farmLevel=1`、`xp=0`、`farmTiles={}`、**`weatherToday='sunny'`（第 1 日强制晴，保证浇水教学成立——farming 草案需确认）**、`weatherTomorrow` 由 rng 预滚。

### 3.3 体积预算

单个种了作物的 tile 条目 JSON ≈ 110 字节。worst case 全图 64×64=4,096 格全部开垦种植 ≈ **450KB**；实际可耕区按 farming 草案预计 ≤ 1,200 格 ≈ **130KB**；典型 M1 存档（24 格耕地）**< 20KB**。预算线：**软上限 1MB**（写档时超过则 `console.warn` + 设置页提示，提示导出），IDB 实际配额远高于此，纯属异常检测。

---

## 4. 存档生命周期

### 4.1 启动加载状态机

```
            ┌──────┐  fire-and-forget: navigator.storage.persist()
            │ BOOT │  + Web Locks 抢占（见 4.4）
            └──┬───┘
               ▼
         ┌──────────┐   get('save:slot0') 为空
         │ LOADING  ├──────────────────────────► NEW_GAME ──► RUNNING
         └────┬─────┘                            （§3.2 初始值建档并立即写盘）
              │ 读到 doc
              ▼
     ┌─ doc.schemaVersion ─┐
     │= CURRENT             │< CURRENT              │> CURRENT
     ▼                      ▼                       ▼
 VALIDATE ◄──成功── MIGRATING（在副本上         TOO_NEW（只读：提示
 （safeParse）       逐版执行迁移链 §5）          「存档来自更新版本」，
     │成功               │任一步失败               仅提供 [导出JSON]，
     ▼                   ▼                         绝不写盘）
  RUNNING            RECOVERY ◄──失败──────┘
                         │
                         ▼
              ┌─────────────────────────┐
              │ 1) 原始数据移入 corrupt 键 │
              │ 2) 读 backup 键并校验      │
              └──────┬──────────────────┘
            backup 可用│            │backup 不可用
                      ▼            ▼
            三选一对话框        二选一对话框
            [用昨日备份]        [导入 JSON]
            [导入 JSON]         [开新农场]
            [开新农场]
```

恢复对话框（ASCII，语气遵循低压基调——不出现「损坏/错误」等吓人字眼大写红字）：

```
┌───────────────── 存档恢复 ─────────────────┐
│  这份存档读取时没有通过校验。               │
│  别担心，找到一份昨天的备份：               │
│     第 11 天 · 春 · 金币 421 · 农场 Lv3     │
│                                            │
│   [▶ 从备份继续]   [导入 JSON…]  [开新农场] │
│                                            │
│   原始数据已保留，可在设置→存档 中导出。     │
└────────────────────────────────────────────┘
```

### 4.2 自动存档触发表

| # | 触发器 | 时机 | 节流规则 | 备注 |
|---|---|---|---|---|
| A | **日结算存档**（主存档点） | 22:00 过夜结算计算完成后、结算屏渲染前 | 无（必存） | 唯一会轮换 backup 的存档；写完结算屏角落亮「已保存 ✓」 |
| B | **tab 隐藏** | `visibilitychange → document.hidden` | 跳过节流，立即写 | 玩家「随时被打断离开」的主路径；此时 sim tick 已停（宪法 §4.3） |
| C | **关键事件** | 工具升级 / 背包扩容 / 职业选择 / 农场升级 / quest 奖励发放 / 导入完成 | 5 真实秒合并窗口 | 不可逆事件不容丢失 |
| D | **脏数据轮存** | 任何 sim 状态变更置 dirty 标记 | 每 30 真实秒检查，dirty 才写 | 把「硬关窗口不切 tab」的损失上界压到 30s |
| E | **手动保存** | 设置页 [保存] 按钮 | 立即 | 给不信任自动存档的玩家一颗定心丸 |
| F | **pagehide** | 关页兜底 | 立即发起（best-effort） | IDB 写入在 pagehide 后不保证完成，故 B/D 才是真保障，F 只是顺手 |

补充规则：
- 写档全程异步、绝不暂停 sim（写的是 serialize 出的不可变快照，无 torn read）；
- 同一时刻只允许一个在途写（in-flight）；新触发到来时若有在途写则标记 queued，写完立即补写一次（合并掉中间状态）；
- **菜单/结算屏打开（暂停态）期间** dirty 不会新增，轮存 D 自然静默。

### 4.3 写入原子性与备份轮换

```
save(trigger):
  1. doc = serializeSim(simState) + meta 更新（savedAtReal、saveCount++ …）
  2. SaveDocSchema.safeParse(doc)            // 写前自检：失败 = 程序 bug
       失败 → 不写盘，console.error，保留上一份好档（绝不写坏档覆盖好档）
  3. if trigger == 日结算:
       set('save:slot0:backup', lastPersistedDoc)   // 先备份后覆盖
  4. set('save:slot0', doc)                  // IDB 单 key put 自身原子
  5. lastPersistedDoc = doc; 清 dirty
```

IDB 单键 put 是事务性的（崩溃时要么旧值要么新值），所以 backup 防御的不是「写一半」，而是**逻辑性坏档**（带 bug 的新版本写出了能存但不该存的数据）——备份深度 1（昨日结算时刻）+ corrupt 键留证 + JSON 导出，共三层恢复手段。

**日结算存档写入的是「已过夜」状态**：`day+1`、`minuteOfDay=360`、作物已按昨日浇水情况生长、`wateredToday` 全部重置、`shippingBin` 已清算入 gold。即：在结算屏期间刷新页面，重开直接落在新一天清晨——损失的只是「看结算屏」这个展示动作，无任何状态损失。

### 4.4 多标签页互斥

两个同 origin 标签页同时跑 sim 会交叉写档。方案：**Web Locks 持锁 + BroadcastChannel 做接管 UX**。

```
启动:  navigator.locks.request('codestead-slot0', { ifAvailable: true }, lock => …)
  ├─ 拿到锁 → 持有至页面关闭，正常进游戏
  └─ 没拿到 → 显示「接管」屏（不进游戏、不读写存档）:

      ┌──────────────────────────────────────┐
      │  Codestead 已经在另一个标签页里运行。  │
      │                                      │
      │     [在这里继续玩]      [关闭本页]    │
      └──────────────────────────────────────┘

  [在这里继续玩] → BroadcastChannel('codestead-slot0') 发 {type:'takeover'}
    旧页收到 → 立即 save() → 停 sim → 释放锁 → 显示「已在其他标签页继续」静屏
    新页等待锁释放（上限 3s）→ 拿锁 → 正常 LOADING 流程
    3s 超时（旧页已死但锁未回收等异常）→ 提示刷新重试
```

Web Locks 在目标浏览器（桌面 Chrome/Edge/Firefox/Safari 16+）全可用；不可用的兜底 = BroadcastChannel claim/held 握手（claim 后等 250ms 无 held 回应即视为独占）。

---

## 5. 存档版本号与迁移策略

### 5.1 规则

1. `schemaVersion` 为从 1 起的整数；**任何**对已发布 schema 的字段增删改（含枚举扩值）都必须升版本——不存在「兼容性小改不升版」的灰色地带；
2. 迁移链是纯函数数组，每步只负责 `v → v+1`，存在 `packages/shared/src/save.ts`，与 schema 同 PR 提交、同 PR 写迁移单测（fixture：上一版真实导出的 JSON）；
3. 迁移**在副本上执行**，全链成功且终版 `safeParse` 通过后才落盘；任一步失败 → 原档原样保留，进 RECOVERY；
4. 迁移成功后立即写一次盘（迁移结果即新的 lastPersistedDoc），并把**迁移前原档**写入 backup 键（旧版本档比昨日备份更值得保）；
5. `schemaVersion > CURRENT`（用户回退了游戏版本，或导入了新版导出的档）→ TOO_NEW 只读态，仅允许导出，绝不尝试「向下迁移」。

### 5.2 代码骨架

```ts
// packages/shared/src/save.ts
type Migration = (doc: unknown) => unknown;   // v[i] -> v[i+1], pure, throws on impossible input

export const MIGRATIONS: Record<number, Migration> = {
  // 1: (doc) => ({ ...doc, schemaVersion: 2, world: { ...doc.world, buildings: [] } }),
  //    ^ M3 加建筑时的真实示例：v1 -> v2 补空 buildings 数组
};

export function migrateSaveDoc(raw: unknown):
  | { ok: true; doc: SaveDoc; migratedFrom: number | null }
  | { ok: false; reason: 'too-new' | 'invalid'; detail?: string } {
  const version = (raw as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version !== 'number') return { ok: false, reason: 'invalid', detail: 'no schemaVersion' };
  if (version > SAVE_SCHEMA_VERSION) return { ok: false, reason: 'too-new' };

  let doc: unknown = structuredClone(raw);
  for (let v = version; v < SAVE_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: 'invalid', detail: `missing migration ${v}` };
    try { doc = step(doc); } catch (e) { return { ok: false, reason: 'invalid', detail: String(e) }; }
  }
  const parsed = SaveDocSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, reason: 'invalid', detail: parsed.error.message };
  return { ok: true, doc: parsed.data, migratedFrom: version < SAVE_SCHEMA_VERSION ? version : null };
}
```

### 5.3 失败处理矩阵

| 情形 | 行为 |
|---|---|
| 缺 `schemaVersion` / 非对象 | RECOVERY（原始数据进 corrupt 键） |
| 版本太新 | TOO_NEW 只读 + 导出按钮 |
| 迁移链断档（漏写迁移函数） | RECOVERY；CI 有守护测试：对 1..CURRENT-1 每个版本断言 `MIGRATIONS[v]` 存在 |
| 迁移抛错 / 终验失败 | RECOVERY，原档不动 |
| 迁移成功 | 老档进 backup，新档落盘，无感继续 |

---

## 6. 导入导出

### 6.1 导出

- 入口：设置页「存档」区 [导出]；恢复对话框、TOO_NEW 屏、内存模式日结算屏也提供；
- 格式：**就是 SaveDoc 本身**（pretty-print 2 空格缩进，方便玩家肉眼查看/手改），不加包裹层、不加校验和（zod 即校验）；
- 文件名：`codestead-save-day012-20260610-1430.json`（游戏日 + 真实日期时间，真实时间仅出现在文件名这种「展示」位置）；
- 实现：`Blob` + `URL.createObjectURL` + 临时 `<a download>` 点击，无任何网络请求。

### 6.2 导入

```
[导入…] → <input type=file accept=".json,application/json">
  → 读文本 → JSON.parse（失败→提示「不是有效的 JSON 文件」）
  → migrateSaveDoc()（失败→按 §5.3 文案提示，现有存档不动）
  → 预览确认屏：

┌──────────────── 导入存档 ────────────────┐
│  即将导入：                              │
│    第 12 天 · 春 · 金币 1,204            │
│    农场 Lv4 · 图鉴 5/6 · 游玩 1.2 小时    │
│    导出于 2026-06-09 18:02（v0.3.0）     │
│                                          │
│  当前存档（第 3 天 · 金币 85 · Lv1）      │
│  将被替换，并自动备份到「昨日备份」。      │
│                                          │
│        [确认导入]          [取消]         │
└──────────────────────────────────────────┘

  → 确认：现存档写入 backup 键 → 新档写 slot0 → 重启场景（RUNNING）
```

边界：导入文档的 `saveId` 与当前相同（导回自己的旧导出）不做特殊处理，同样走替换+备份；导入期间 sim 处于菜单暂停态，无并发写。

---

## 7. 设置系统

### 7.1 设置项清单与默认值

| 区块 | 键 | 取值 | 默认 | 生效里程碑 | 生效方式 |
|---|---|---|---|---|---|
| audio | `master` | 0~100 | **80** | M1 | 即时；实际通道音量 = master/100 × channel/100 |
| audio | `bgm` | 0~100 | **60** | M1 | 即时 |
| audio | `sfx` | 0~100 | **80** | M1 | 即时（调节时播一声示例音效反馈） |
| audio | `muted` | bool | **false** | M1 | 即时；独立于音量值（解除静音回到原音量） |
| hud | `enabled` | bool | **true** | M2 | 即时显隐左上角会话面板 |
| hud | `compact` | bool | **false** | M2 | false=会话列表；true=仅 5 色计数徽章一行 |
| quests | `enabled` | bool | **true** | M4 | 总开关（宪法 M4「可整体关闭」）；off 时 NPC 仍在但只说闲话 |
| quests | `frequency` | `'low' \| 'normal'` | **`'low'`** | M4 | low=全局 ≥30 真实分钟/个；normal=≥15 分钟/个（**15 分钟是宪法硬上限，无更高档**）|
| general | `language` | `'zh-CN' \| 'en'` | **`'zh-CN'`** | M1（en 文案 M5） | 切换后即时换 UI 文案（i18n key 全量预载，无需刷新——i18n 子系统需确认） |
| accessibility | `reducedMotion` | `'system' \| 'on' \| 'off'` | **`'system'`** | M1 | system=跟随 `prefers-reduced-motion`；生效内容见 §8.2 |

> 默认 `quests.frequency='low'` 是对宪法「默认克制」的落实：默认比硬上限再克制一倍。

### 7.2 Settings schema（与存档分离，独立版本号）

```ts
// packages/game/src/storage/settings.ts （game 内部；跨边界部分见 7.4）
import { z } from 'zod';

export const SETTINGS_VERSION = 1;

export const SettingsV1Schema = z.object({
  settingsVersion: z.literal(1),
  audio: z.object({
    master: z.number().int().min(0).max(100),
    bgm: z.number().int().min(0).max(100),
    sfx: z.number().int().min(0).max(100),
    muted: z.boolean(),
  }),
  hud: z.object({ enabled: z.boolean(), compact: z.boolean() }),
  quests: z.object({ enabled: z.boolean(), frequency: z.enum(['low', 'normal']) }),
  language: z.enum(['zh-CN', 'en']),
  accessibility: z.object({ reducedMotion: z.enum(['system', 'on', 'off']) }),
});
export type Settings = z.infer<typeof SettingsV1Schema>;

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 1,
  audio: { master: 80, bgm: 60, sfx: 80, muted: false },
  hud: { enabled: true, compact: false },
  quests: { enabled: true, frequency: 'low' },
  language: 'zh-CN',
  accessibility: { reducedMotion: 'system' },
};
```

读取策略：boot 时同步读 localStorage → `safeParse` 失败或缺失 → **静默回退 `DEFAULT_SETTINGS` 并回写**（设置永不进恢复流程、永不打扰玩家）。设置迁移策略同 §5 但简化：失败即重置默认（损失可接受）。每次修改即写回（同步、<1KB，无节流必要）。

### 7.3 设置 UI（Esc 菜单 →「设置」页签）

```
┌──────────────────── 设置 ────────────────────┐
│  音频                                         │
│    主音量        ◄ [▮▮▮▮▮▮▮▮░░] 80 ►          │
│    背景音乐      ◄ [▮▮▮▮▮▮░░░░] 60 ►          │
│    音效          ◄ [▮▮▮▮▮▮▮▮░░] 80 ►          │
│    全部静音      [ 关 ]                       │
│  会话面板                                     │
│    显示面板      [ 开 ]                       │
│    紧凑模式      [ 关 ]                       │
│  村民任务                                     │
│    启用任务      [ 开 ]                       │
│    出现频率      [ 稀少（≥30 分钟）▾ ]         │
│  通用                                         │
│    语言          [ 简体中文 ▾ ]                │
│    减少动效      [ 跟随系统 ▾ ]                │
│  存档                                         │
│    [立即保存]  [导出 JSON]  [导入 JSON…]       │
│    上次保存：第 12 天 · 8 秒前   存储：正常 ✓  │
│                                               │
│         [恢复默认设置]        [返回 Esc]       │
└───────────────────────────────────────────────┘
```

- 全键盘可操作：↑↓ 移动焦点、←→ 调滑杆/切枚举、Enter 触发按钮、Esc 返回；鼠标等价（宪法 §4.5 双轨）；
- 「存储：正常 ✓ / 受限（localStorage）/ 内存模式」对应 §2.4 降级链状态；
- M1 构建里「会话面板」「村民任务」两区显示为灰色 + 「M2 / M4 可用」角标（让设置页结构从第一天起稳定，避免后续 UI 迁移）。

### 7.4 quest 设置与 daemon 的接口（M4 接口假设）

`quests.*` 设置存在 game 侧（本稿管辖），但执行节流的是 daemon。提议在 shared 协议中新增一条 game→daemon 消息（**需 quest/daemon 子系统认领**）：

```ts
{ v: 1, type: 'clientPrefs', payload: { quests: { enabled: boolean, minIntervalRealMinutes: 15 | 30 } } }
```

- 连接建立（auth 通过）后与每次设置变更时发送；
- daemon 以「**双方较严者生效**」合并自身配置（daemon 配置文件里也可关 quest）；
- daemon 未实现该消息时（版本错配）game 侧兜底：对收到的 `questOffer` 按本地频率/开关直接丢弃——保证「可整体关闭」承诺不依赖 daemon 配合。

---

## 8. 可访问性

### 8.1 五态配色：色弱友好是默认而非选项

调色板取 **Okabe-Ito**（针对各型色觉缺陷设计的标准安全色板），且执行**双编码纪律：颜色 + 图标形状，任何状态信息绝不允许只用颜色区分**。因此不设「色弱模式」开关——默认即安全。

| 状态 | 颜色 | HEX | 图标（16×16 像素字形） | 轮廓形状 | 语义 |
|---|---|---|---|---|---|
| working | 天蓝 | `#56B4E9` | 齿轮 ⚙（两帧交替） | 实心圆 ● | AI 干活中，安心种田 |
| blocked | 橙 | `#E69F00` | 手掌 ✋ | 三角 ▲ | 等你输入（唯一「值得注意」态） |
| done | 蓝绿 | `#009E73` | 对勾 ✓ | 方形 ■ | 完成未查看 |
| idle | 灰 | `#999999` | 暂停 ❚❚ | 空心圆 ○ | 空闲 |
| unknown | 紫红 | `#CC79A7` | 问号 ? | 菱形 ◆ | 未装 hooks / 不确定 |

落点：HEX 与字形作为设计 token 放 `packages/shared/src/theme.ts`（HUD、日结算屏的会话区、未来 daemon CLI 输出共用一份）。背景为深色 HUD 底板（`#1A1A2E` 90% 不透明）时上述五色对比度均 ≥ 3:1（图形要素 WCAG 1.4.11 线）。

deuteranopia/protanopia/tritanopia 三种模拟滤镜下的验收：blocked(橙) 与 done(蓝绿) 在最易混的 deuteranopia 下仍有亮度差，且形状（▲ vs ■）与图标（✋ vs ✓）双重兜底——**验收时关掉颜色（灰度滤镜）也必须能区分五态**。

### 8.2 减少动效（`reducedMotion`）

生效清单（on 或 system+媒体查询命中时）：

| 动效 | 正常 | 减少动效时 |
|---|---|---|
| blocked 状态徽章 1Hz 呼吸脉冲 | 有 | 静态：描边加粗 2px 替代 |
| working 齿轮两帧动画 | 有 | 静态单帧 |
| 日结算屏数字滚动、金币飞入 | 有 | 直接显示终值 |
| 场景切换淡入淡出 | 200ms | 即切（0ms） |
| 雨滴粒子密度 | 100% | 30%（保留天气可读性） |
| 收割弹出物抛物线 | 有 | 简化为 200ms 淡出 |

不受影响（属于游戏状态可读性，非装饰）：作物生长阶段 sprite 变化、角色走路动画（可读性必需，且为低频像素动画）。

### 8.3 其他基线

- 全部 UI 文本使用像素字体的 **2× 渲染档**（实际 ≥12 逻辑像素），640×360 下不出现 1× 微缩字；
- 声音信息均有视觉等价物（如 blocked 提示音对应徽章变化）——`muted` 不损失任何信息；
- 设置页焦点态有高对比描边（不只变色），满足键盘导航可见性。

---

## 9. 边界情况清单

| # | 情形 | 行为 |
|---|---|---|
| 1 | IDB 不可用（隐私模式/策略） | §2.4 降级链：localStorage 适配器 → 内存模式；同一 `SaveStorage` 接口，sim 无感 |
| 2 | `QuotaExceededError` | 重试 1 次 → 失败则提示导出 + 尝试释放 corrupt 键后再试；好档永不被截断覆盖 |
| 3 | 写档进行中再次触发存档 | 单在途写 + queued 合并（§4.2） |
| 4 | 写前 safeParse 失败（自产坏数据） | 不写盘、保留上一好档、`console.error`（这是 bug 不是用户问题） |
| 5 | 日结算屏期间刷新 | 重开落在新一天 6:00，零状态损失（§4.3 过夜后写档） |
| 6 | 硬关窗口（不切 tab 直接 ⌘W） | 损失 ≤30 真实秒（轮存 D 兜底；pagehide F 尽力） |
| 7 | 两个标签页同开 | Web Locks 互斥 + 接管流程（§4.4），后开页绝不写档 |
| 8 | 存档版本太新 | TOO_NEW 只读 + 导出，不写盘不迁移 |
| 9 | 导入非法/篡改 JSON | parse/migrate/validate 三关，任一失败现有存档纹丝不动 |
| 10 | 浏览器清站点数据 | 存档+设置全失；缓解：`storage.persist()` + 导出习惯引导（设置页常驻提示文案） |
| 11 | 设置 JSON 损坏 | 静默重置默认并回写，绝不打扰 |
| 12 | 系统时钟回拨/前跳 | 无影响——没有任何游戏逻辑读真实时钟（§3.1 纪律 + 类型隔离） |
| 13 | `farmTiles` 出现越界键（如 "99,99"） | schema 的 key regex + tile 坐标范围校验拦截 → 进恢复流程，不带病运行 |
| 14 | 存档里 cropId 在作物表中不存在（版本回退） | load 后置物校验：未知 cropId 的 tile 降级为「已开垦无作物」，未知 itemId 物品移除并 console.warn（宽容加载，不整档拒绝）|

---

## 10. 对其他子系统的依赖与接口假设

| 对象 | 本稿假设的接口 / 需对齐项 | 方向 |
|---|---|---|
| **sim 层**（tech-stack §1） | `serializeSim(state): SaveBody` / `restoreSim(body): SimState`，纯函数、确定性；PRNG 用 sfc32 且状态可序列化为 32 hex；sim 暴露 dirty 事件供轮存 D | 强依赖 |
| **farming 草案（11）** | TileState 形状（§3.2）：`tilled / wateredToday / crop{cropId, daysGrown, mature, regrowDaysLeft}`；生长结算发生在过夜时刻；可耕区 ≤1,200 格；**第 1 日强制晴天**（教学保证）——以上四点需 farming 稿确认或修订本稿 | 双向对齐 |
| **日循环/日结算子系统** | 结算流程顺序：过夜结算 → 调 `saveStorage.save('day-summary')` → 渲染结算屏（含「已保存 ✓」与会话区） | 强依赖 |
| **经济/进度子系统** | gold/xp/farmLevel/collectionLog/stats 的字段语义以宪法 §4.4 数值为准；关键事件（升级/扩容/职业）发出事件供触发器 C 监听 | 依赖事件 |
| **HUD（M2）** | 消费 `settings.hud.*`；五态 token 从 `shared/src/theme.ts` 取（§8.1）；HUD 自身不写任何存储 | 提供 |
| **quest/daemon（M4）** | 新增 `clientPrefs` 协议消息（§7.4，需 daemon 稿认领）；思考笔记本体在 `~/.codestead/notes/`，game 存档只存 `noteRefs`；game 侧对 `questOffer` 有本地兜底过滤 | 提供+假设 |
| **shared 包** | `save.ts`（SaveDoc schema + 迁移链）、`theme.ts`（五态 token）入 shared；Settings schema 留在 game（仅 `clientPrefs` 载荷过协议边界） | 落点声明 |
| **i18n（M5 前的文案模块）** | 语言切换不刷新页面（文案全量预载）；本稿 UI 全部文案走 i18n key | 假设 |

---

## 11. 验收标准

1. **基础闭环**：新档 → 玩到第一次日结算 → 强制刷新 → 重开后落在第 2 天 6:00，金币/耕地/背包/XP 与刷新前完全一致；
2. **零损失上界**：自动化测试模拟「任意时刻硬关页面」（Playwright 关 page，M5；M1 用单测模拟触发器时序）：恢复后状态落后真实游玩 ≤30 真实秒对应的 sim 进度；切 tab（visibilitychange）场景损失 = 0；
3. **迁移**：fixture 仓库保存每个历史版本的真实导出 JSON；CI 断言全部能迁移到 CURRENT 并通过 safeParse；删除迁移链中任意一环，守护测试必须红；
4. **恢复链**：人工向 `save:slot0` 写入畸形数据 → 重开进入恢复对话框 → 三个选项各自可达可用；原始数据可在 corrupt 键中找到；
5. **导入导出**：导出 → 浏览器清站点数据 → 导入 → 状态完整恢复（含图鉴与统计）；导入畸形文件，现有存档逐字节不变；
6. **设置独立性**：删档重开新农场后，音量/语言/动效设置保持；设置 JSON 损坏时静默重置且无任何对话框；
7. **可访问性**：灰度滤镜（彻底去色）下五态徽章可区分（形状+图标）；deuteranopia/protanopia 模拟下 blocked 与 done 可区分；`reducedMotion=on` 时 §8.2 清单全部动效消失，且 `prefers-reduced-motion: reduce` 在 `system` 档自动生效；
8. **多标签**：开两个 tab，后开者不产生任何 IDB 写；执行接管后旧 tab 停止写入且新 tab 正常续玩；
9. **零真实时钟**：把系统时钟前调 48 小时再加载存档 → sim 状态与不调钟完全一致（作物零生长、无任何变化）；
10. **不打扰审计**：从新档到 M1 毕业全程，存档/设置系统产生的对话框次数 = 0（恢复流程除外，且仅在数据确实损坏时出现）。

---

## 12. 开放问题

1. **多存档槽**：M1 单槽已定，但「想开第二块农场试 build」是合理诉求——建议 M3 复盘时决策（键名已预留 `slotN`）；
2. **quest 频率权威端**：`clientPrefs`（game 设置）与 daemon 自身配置文件双写时按「较严者生效」——此合并规则需 daemon/quest 子系统稿确认；
3. **导出是否附带设置**：当前裁决「导出仅存档、不含设置」（换机时设置重配成本极低）；若用户反馈强烈再加可选勾选；
4. **语言切换是否免刷新**：本稿假设 i18n 文案全量预载、即时切换；若 i18n 子系统选择按语言分包懒加载，则改为「切换后提示下次启动生效」；
5. **daemon 落盘存档端点**（tech-stack 风险 8 的 M3+ 增强）：触发条件建议定为「收到 ≥3 例清站点数据丢档反馈」或 M5 发布前评估，由谁立项待定；
6. **第 1 日强制晴天**：本稿为保证浇水教学闭环所做的假设，需 farming/天气稿确认（若天气稿坚持纯随机，需另设教学保护）。
