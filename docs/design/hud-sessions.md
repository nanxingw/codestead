# 会话 HUD（hud-sessions）设计定稿

> 版本 v1.0 ｜ 2026-06-10 ｜ 状态：**定稿**（由 `drafts/17-hud-sessions.md` v1.0 定稿，取代该草稿）｜ 负责子系统：hud-sessions（M2）
> 上位约束：`drafts/00-constitution.md`（设计宪法 v1.0），尤其 §3 支柱三「感知不干预」、§4.2 像素规格、§5 M2 边界。
> 协议与信号源依据：`docs/design/tech-stack.md` §4.1/§5（已与本稿 §10.4 双向对齐）、`docs/design/research/hooks.md`、`docs/design/research/daemon.md`。
> 实现落点：`packages/game/src/hud/`（独立 store，零经济绑定）+ `packages/game/src/net/`（WS 客户端）。

---

## 1. 范围与定位

### 1.1 一句话

左上角一块**安静的告示牌**：你抬眼就知道每个 Claude Code 会话在干嘛、等了你多久；它永远不出声（默认）、不弹窗、不动你的农场。

### 1.2 范围内 / 范围外

| In（本稿定义） | Out（明确不做 / 归属他处） |
|---|---|
| 左上角会话面板完整 UX：五态视觉语言、行内字段、排序/折叠/溢出、克制提示、空态与断连态、设置项 | 状态机的**实现**与三源仲裁工程（daemon 子系统，tech-stack §4.1） |
| **会话四态状态机的语义定稿**（§7：转移图与转移表，daemon 实现与 HUD 文案共同遵守） | hooks 安装器（daemon 子系统） |
| 客户端连接状态机（重连/降级/版本不匹配） | 日结算屏整体（day-cycle 子系统） |
| 日结算屏「会话一行」的展示格式（数据由本 store 提供） | M4 quest 的 NPC/对话呈现（quest 子系统；HUD 不挂 quest 角标） |
| 与 daemon 的消息协议字段→UI 映射 + 心跳/端点发现两条增补（已转正，§10.3） | 任何「干预」：聚焦终端、暂停游戏、经济奖励 |
| HUD 自身设置与持久化（localStorage，不进农场存档） | |

### 1.3 三支柱对照（宪法 §3 自检）

1. **游戏第一**：HUD 是叠加层（UIScene），不占用任何玩法输入；默认占屏 ≤ 152×90 逻辑 px（约 6% 屏幕面积），可一键折叠/隐藏；角色走到面板下方时自动淡出，不挡操作。
2. **零焦虑承诺**：HUD 展示的是**现实会话的现实时长**——这是全游戏唯一允许出现真实时间的地方，且它**只读不写**：任何会话状态、任何真实时长都不驱动、不修改任何游戏状态（无奖励、无惩罚、无解锁）。文案全部使用平静措辞（「等待输入」而非「卡住了！」），无红色全屏、无闪烁倒计时。
3. **感知不干预**：状态变化的提示上限是「行内一次 600ms 微高亮」；无模态、无 toast 弹窗、无焦点抢占、无强制暂停；提示音默认关闭；整个面板可隐藏（隐藏后零渲染开销）。

---

## 2. 信息架构：单条会话显示什么

### 2.1 行内字段（常驻可见）

每条会话一行，三段式：`[状态图标] [显示名] [已持续时长]`

| 字段 | 来源（SessionInfo） | 规则 |
|---|---|---|
| 状态图标 | `state` (+`error`) | 8×8 像素图标 + 状态色，见 §3.1；图标形状互不相同（色盲冗余） |
| 显示名 | `title` → `cwd` basename → tty → `sessionId` 前 8 位 | 按回退链取第一个非空值；超宽截断加 `…`（可用宽度 100px ≈ 8 个 CJK / 16 个 ASCII）；同名冲突时追加 `·父目录名`（再截断） |
| 已持续时长 | `since`（进入当前状态的时刻） | `now − since`，右对齐，格式见 §2.3；`unknown` 态显示 `—` |

### 2.2 悬停 tooltip（按需可见，250ms 悬停延迟）

| 行 | 内容 | 来源 |
|---|---|---|
| 1 | 完整标题 | `title`（不截断，最宽 220px 内换行 ≤2 行） |
| 2 | 工作目录（`~` 缩写 home） | `cwd` |
| 3 | 「最近输入：…」≤2 行（约 28 CJK 字符） | `subtitle`（last-prompt 截断） |
| 4 | 状态行：`等待输入 · 14:32 起（12 分钟）` | `state` + `since` |
| 5 | 小字：`信号源：hooks` | `source`（`process` 时附「置信度低」） |
| 6 | 仅出错时：`API 错误：限流（rate_limit）` | `error.kind` 映射表见 §2.4 |
| 6' | 仅 unknown 时：`未接入 hooks——在终端运行 npx codestead install` | 固定文案 |

隐私注意：第 2、3 行属于工作内容的「标题级」信息，仅在本机渲染、永不落日志；开启 `streamerMode`（§9）后这两行不显示（直播/共享屏幕场景）。

### 2.3 时长格式（粗粒度，避免秒针焦虑）

| 区间 | 显示 | 示例 |
|---|---|---|
| < 1 分钟 | `刚刚` | 刚刚 |
| 1–59 分钟 | `{m}m` | 12m |
| 1 小时–9 小时 59 分 | `{h}h{m}m` | 1h23m |
| 10–23 小时 | `{h}h` | 12h |
| ≥ 24 小时 | `{d}d` | 2d |

刷新节奏：每 **5 真实秒**重算一次文本（不逐秒跳动）；时长刷新**不触发**行重排（§5.3）。`now − since < 0`（时钟皮）一律钳为 0。

### 2.4 `error.kind` → 文案映射（StopFailure 时 state=blocked 且带 error）

| kind | 行内 | tooltip |
|---|---|---|
| `rate_limit` | 图标换 ⚠ | API 错误：限流（rate_limit），稍后会自动恢复 |
| `overloaded` | 图标换 ⚠ | API 错误：服务过载（overloaded） |
| `authentication_failed` | 图标换 ⚠ | API 错误：认证失败，需要到终端重新登录 |
| `billing_error` | 图标换 ⚠ | API 错误：计费问题，需要到终端处理 |
| 其他 / 未识别 | 图标换 ⚠ | API 错误（{kind}） |

---

## 3. 视觉语言（像素规格）

> 五态色值唯一事实源 = `packages/shared/src/theme.ts`（CODE-28），见 game-design.md §7.3 / 附录 A-8。

### 3.1 五态视觉总表

注意力梯度（由强到弱）：**blocked > done > working > idle ≈ unknown**。唯一持续动效给 blocked（它是「等你」的状态），working 用低频小动效表达「活着」，其余全静态。

| state | 中文标签 | 颜色（hex） | 8×8 图标（形状冗余） | 动效 | 进入时一次性提示 |
|---|---|---|---|---|---|
| `blocked` | 等待输入 | `#e8a33d`（amber） | `!` 实心感叹号 | 呼吸：alpha 0.55↔1.0，周期 2000ms（满足 ≤0.5Hz 光敏红线），**4 档阶梯**（非平滑渐变，守像素感） | 行背景微高亮 600ms |
| `blocked`+error | API 错误 | `#d96a6a`（red.mid 修饰） | `⚠` 三角含叹号 | 同上 | 同上 |
| `done` | 已完成 | `#62a64f`（green.light） | `✓` 对勾 | 静态 | 行背景微高亮 600ms |
| `working` | 工作中 | `#4fa4e8`（water.light） | `◐` 四分旋转点（4 帧 spinner） | 4 帧循环，333ms/帧（≈3fps，余光可感但不抢眼） | 无 |
| `idle` | 空闲 | `#9aa0a6`（ui.textDim） | `○` 空心圆 | 静态 | 无 |
| `unknown` | 未知 | `#8a8198` | `?` 空心问号 | 静态 | 无 |

低置信度修饰：当 `source === 'process'` 时，图标改为**描边（hollow）版本**，同色——「我们看见它，但不确定它在干嘛」。

色盲自检：error 红（`#d96a6a`）与 done 绿（`#62a64f`）靠形状（`⚠` vs `✓`）区分；blocked（amber `!`）与 working（blue `◐`）靠形状+动效区分；五态在 deuteranopia/protanopia 模拟下可分（§13-7）。

### 3.2 面板规格（逻辑分辨率 640×360 下）

| 项 | 数值 |
|---|---|
| 面板锚点 | 左上 `(4, 4)` 逻辑 px |
| 面板宽度 | **152 px**（展开态固定宽） |
| 行高 | **14 px**（12px 字体 + 2px 行距） |
| 内边距 | 上下左右各 3 px |
| 行内列宽 | 图标列 12px（8×8 图标居中）｜ 间隙 2px ｜ 标题 100px ｜ 时长右对齐 32px |
| 面板高度 | `6 + 行数×14 (+14 溢出行)`；默认 5 行 + 溢出行 = **90 px**；硬上限 9 行 = 146 px |
| 背景 | `#14141C` @ alpha 0.78（GDD §7.4 现值，维持；设置可调 0.6/0.8/1.0） |
| 边框 | 1px `#3A3A52`（GDD §7.4 现值，维持），直角（不做圆角，16px 网格像素风） |
| 文字主色 / 次色 | `#f4e3c2`（ui.text）/ `#9aa0a6`（ui.textDim）（时长、溢出行、空态用次色） |
| 高亮闪 | 行背景叠 `#FFFFFF` @ 12%，600ms 内 3 档阶梯淡出 |
| 自动淡出 | 玩家精灵的屏幕投影矩形与面板相交 → 面板 alpha 降至 0.25（150ms、3 档）；离开后 300ms 恢复 |

渲染规范（继承宪法 §4.2）：全部贴 UIScene（不随相机滚动）；坐标取整、禁用非整数位移；图标走 spritesheet 最近邻；不使用平滑 tween，所有动效按离散帧/档位步进。

### 3.3 字体

- 行内文字 12px 像素字体；**必须覆盖 CJK**（会话标题 `ai-title` 常为中文）；
- 选型建议：**Fusion Pixel 12px（缝合像素字体，OFL-1.1，可再分发）**，符合宪法 §4.6「可在 manifest.json 中追溯到 CC0/可再分发许可」的红线（Kenney 字体无 CJK，不够用）；
- 落地：Fusion Pixel woff2 全字库（不裁字库，≤4MB，M4 AI 文本含生僻字）+ `document.fonts.load` 完成后进 BootScene；缺字回退链 Fusion Pixel → system-ui（生僻字允许带 AA）；manifest.json 记录字体来源/许可/redistributable=true。⚠ 这是对 assets 子系统的新增依赖（§12-D5），最终选型列开放问题（§14）。

### 3.4 提示音（默认关闭）

| 项 | 规格 |
|---|---|
| 触发 | 仅 `→ blocked` 与 `→ done` 两种进入事件（按设置档位） |
| 音色 | Kenney UI Audio 中柔和单击类（木鱼/软 click），音量 40%，≤ 200ms |
| 全局冷却 | 20 秒内最多响一次（多会话齐变也只响一次） |
| 后台行为 | tab 隐藏时默认不响；`soundInBackground` 开启后才响（opt-in，见 §9） |
| 默认值 | **off**（克制优先；是否对 blocked 默认开启列开放问题 §14） |

---

## 4. 布局草图（ASCII）

### 4.1 展开态（默认，displayMode=expanded）

```
(4,4)
┌────────────────────────────────────┐ 152px
│ !  codestead-api            12m    │  ← blocked，图标呼吸，amber #e8a33d
│ ⚠  支付服务重构              3m    │  ← blocked+error（rate_limit）
│ ✓  重构 hud store            8m    │  ← done，绿 #62a64f
│ ◐  docs 站点迁移            47m    │  ← working，蓝 #4fa4e8，3fps 旋转
│ ○  scratch                  2h     │  ← idle，灰 #9aa0a6（静态）
│ +2 个会话                          │  ← 溢出行（次色，含 1 unknown）
└────────────────────────────────────┘
```

### 4.2 折叠态（displayMode=collapsed，高 14px）

```
┌──────────────────────┐
│ !2  ✓1  ◐3           │   ← 仅显示计数非零的状态组，顺序固定 ! ✓ ◐ ○ ?
└──────────────────────┘
```

### 4.3 悬停 tooltip（出现在面板右侧、同行 y，宽 ≤220px）

```
┌────────────────────────────────────┐ ┌──────────────────────────────────┐
│ !  codestead-api            12m    │ │ 修复 webhook 重试风暴            │
│ …                                  │ │ ~/work/codestead-api             │
└────────────────────────────────────┘ │ 最近输入：帮我看看为什么重试队列…│
                                       │ 等待输入 · 14:32 起（12 分钟）   │
                                       │ 信号源：hooks                    │
                                       └──────────────────────────────────┘
```

### 4.4 空态（已连接、0 个会话）

```
┌────────────────┐
│ ○  暂无会话    │   ← 次色，14px 单行小条；不再缩小、不闪烁
└────────────────┘
```

### 4.5 断连态（曾连接成功过，daemon 掉线）

```
┌──────────────────────────┐
│ ⌁  会话服务已断开 · 重试中│  ← 灰色 #8a8198，静态；游戏完全不受影响
└──────────────────────────┘
```

从未成功连接过的玩家（纯 M1 玩家、未装 daemon）：**什么都不显示**（见 §8.2 everConnected 门控）——不能让单机玩家看到一个「坏掉的」面板。

### 4.6 日结算屏中的「会话一行」（数据接口，渲染归 day-cycle 子系统）

```
  会话 · ◐ 工作中 2 ｜ ! 等待输入 1 ｜ ✓ 已完成 1
```

规则：平静陈述、无动效、无按钮、无催促文案；断连或 0 会话时**整行省略**（不显示「无会话」，保持结算屏纯净）。日结算屏展示期间左上面板隐藏（避免同屏重复），结算屏关闭后恢复。

---

## 5. 多会话：排序、折叠、溢出

### 5.1 排序键（元组，依次比较）

1. `stateRank`：blocked(0) → done(1) → working(2) → idle(3) → unknown(4)；
2. 同 rank 内按 `since` **升序**（进入该状态最早的在前——等你最久的 blocked 排最上）；
3. 终极平手：`sessionId` 字典序（保证完全确定性）。

### 5.2 溢出规则（行数 > maxRows，默认 5）

- 取排序后前 `maxRows` 行显示，余下折进溢出行 `+N 个会话`（次色，悬停 tooltip 列出被折叠会话的「图标+名字」清单，最多 12 条）；
- **blocked 永不被折叠**：若 blocked 数量 > maxRows，面板临时扩到 blocked 全显（硬上限 9 行，再多也进溢出行）；
- `showIdle=false` / `showUnknown=false` 时对应状态不显示也不计入溢出数（彻底安静）。

### 5.3 防跳动（重排纪律）

- 仅在以下事件重排：`snapshot` 全量、会话 `state` 变化、会话增删、设置变更；
- 时长每 5s 的文本刷新**绝不**触发重排；
- 重排为瞬时换位（无位移动画），但同一会话 10 秒内最多参与一次重排（短时抖动合并：状态机快速 working↔done 抖动时，显示层取最后一个稳定值）。

---

## 6. 状态变化的克制提示

### 6.1 允许的提示（全部行内、非模态）

| 时机 | 提示 | 上限 |
|---|---|---|
| 会话 → blocked / → done | 该行背景 600ms 微高亮（§3.2） | 同一会话 8 秒内最多一次 |
| 会话处于 blocked 期间 | 图标持续慢呼吸 | 唯一允许的持续动效 |
| 任意状态变化（折叠态） | 对应计数组数字直接更新，组首次出现时整条 chip 高亮 600ms | 同上 |
| 存在 blocked 且 tab 隐藏 | 浏览器标签页标题前缀 `● `（`tabBadge` 设置，默认开） | 纯标题文本，无 Notification API |
| H 键切到 hidden | 原面板位置淡出小字 `会话面板已隐藏（按 H 恢复）`，800ms 自动消失 | 仅按键回执 |

tabBadge 定性：标签页标题前缀 `● ` 是 **HUD 唯一对游戏外 UI 的被动提示**——刻意保持纯文本标题前缀、不使用 Notification API、设置一键可关（§9 `tabBadge`）。与「声音默认 off」并列的取舍理由：声音是侵入式输出，故默认关；badge 是被动可见信息，且直接服务「到点就能回去」，故默认开；内测后复核两者默认值。

### 6.2 反模式清单（永久禁止，违者打回）

1. 任何模态弹窗、toast、全屏变色、屏幕震动、相机移动；
2. 任何强制暂停 / 抢键盘焦点 / 拦截玩家当前操作；
3. 浏览器系统通知（Notification API）——M2~M5 一律不用（未来若做必须 opt-in 修订本稿）；
4. 会话状态与游戏经济/XP/解锁的任何绑定（含「切回工作给奖励」这种反向绑定）；
5. NPC / 游戏世界内角色播报会话状态（世界与工作之间只有左上角这一扇窗）；
6. 催促性文案（「快去看看！」「已经等了很久了！」）；时长只陈述，不评价；
7. 默认开启的声音。

---

## 7. 会话四态状态机（语义定稿）

> 状态机的**实现**在 daemon 侧（tech-stack §4.1：纯函数 reducer `(state, signal) => state` + 三源仲裁 + staleness 过期校验），HUD 完全信任服务端状态、不做语义判断（§8.3）。本节是四态语义与转移条件的**定稿定义**：daemon 实现与 HUD 文案共同遵守；本节是 tech-stack §4.1 事件映射的规范化展开，二者一致。
>
> **实施分期注记（M2）**：M2 第一版信号源收敛为两源——hooks（语义主路）+ transcript fs.watch（Esc 中断盲区兜底）；ps 轮询、unknown 态展示、§2.2 第 6' 行安装指引、kill -9 收尸推至 M2 末。过渡期幽灵会话以「idle 持续 ≥12 小时摘牌」近似收尸。本节状态机语义定义原样保留，其中 unknown / ps 相关行分期实现（M2 末）；验收同步拆分见 §13。

### 7.1 状态集合

- **核心四态**：`working` / `blocked` / `done` / `idle`——仅由 hooks / transcript 信号驱动迁移；
- **展示态** `unknown`：仅被 ps 轮询发现、从未收到任何 hook 的会话；不参与四态转移，首个 hook 到达后按该 hook 语义并入四态（`source` 升为 `hooks`）；
- **生命周期伪态**：`（未注册）`（daemon 尚不知道该会话）与`（注销）`（推送 `sessionRemoved`），不在面板出现。

### 7.2 转移图

```
                       SessionStart(startup/resume/clear)
        (未注册) ────────────────────────────────────────────> idle
            │                                                  │ ▲
            │ ps 发现 claude 进程且无任何 hook 记录              ① │ │ ⑦
            ▼                                                  ▼ │
        unknown ···首个 hook 到达，按其语义并入四态···>         working <───⑥─── done
            │                                                 │ ▲               ▲ ▲
            │                                               ② │ │ ④           ③ │ │ ⑤
            ▼                                                 ▼ │               │ │
         (注销) <── SessionEnd / ps 进程消失（任意态）────── blocked ─────────────┘ │
                                                              └──────────────────┘
```

边标注（触发事件 × 信号源）：

- **①** `idle → working`：`UserPromptSubmit`｜`PreToolUse` / `PostToolUse` / `PostToolUseFailure`（hooks）｜transcript jsonl 追加（fs.watch，低优先级修正，仅当 hooks 信号缺失/过期）；
- **②** `任意态 → blocked`：`PermissionRequest`｜`Notification(permission_prompt)`（等待授权/输入）｜`StopFailure`（附 `error.kind`，如 rate_limit / billing_error）；
- **③** `working → done`：`Stop`｜`Notification(idle_prompt)`（hooks）｜transcript 静默 ≥90s 且无 blocked 信号（兜底「Esc 中断不触发 Stop」盲区）；
- **④** `blocked → working`：`UserPromptSubmit`｜`PreToolUse` / `PostToolUse`（授权通过继续干活，或 API 错误恢复后信号重现）；
- **⑤** `blocked → done`：`Stop`｜`Notification(idle_prompt)`（等待授权期间被收尾）；
- **⑥** `done → working`：`UserPromptSubmit`（玩家回到对话；done 同时被消解＝已查看）；
- **⑦** `done → idle`：done 持续 **30 分钟**无人查看 → staleness 降级（HUD 跟随，绝不自行降级）；
- **另**：`SessionStart(compact)` → `working`（任意态；自动压缩发生在任务执行中，维持/恢复工作态）。

### 7.3 转移总表（事件为行，权威定义）

| 触发事件 | 信号源 | 自 | 至 | 说明 |
|---|---|---|---|---|
| `SessionStart(startup/resume/clear)` | hooks | （未注册）/任意 | `idle` | 注册会话；重置 `since` |
| `SessionStart(compact)` | hooks | 任意 | `working` | 自动压缩 = 任务进行中 |
| `UserPromptSubmit` | hooks | 任意 | `working` | 同时消解 done（已查看） |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | hooks | 任意 | `working` | 工作心跳，刷新 `lastSignalAt` |
| `PermissionRequest` ∪ `Notification(permission_prompt)` | hooks | 任意 | `blocked` | 等待用户授权/输入 |
| `Stop` ∪ `Notification(idle_prompt)` | hooks | working/blocked | `done` | 一轮工作完成、未查看 |
| `StopFailure` | hooks | 任意 | `blocked` (+`error.kind`) | 文案映射见 §2.4 |
| `SessionEnd` | hooks | 任意 | （注销） | 推送 `sessionRemoved` |
| transcript jsonl 追加 | fs.watch | idle/done | `working` | 仅当 hooks 缺失/`lastSignalAt` 过期时生效 |
| transcript 静默 ≥90s 且无 blocked 信号 | fs.watch | working | `done` | Esc 中断盲区兜底 |
| done 持续 30 分钟 | 定时器 | done | `idle` | staleness 降级（边界情况 §11-13） |
| 发现 claude 进程且无任何 hook | ps 轮询(2s) | （未注册） | `unknown` | 显式低置信，tooltip 给安装指引 |
| 该会话首个 hook 到达 | hooks | unknown | 按该 hook 语义 | `source` 升为 hooks |
| 进程消失（kill -9 等） | ps 轮询 | 任意 | （注销） | 收尸，防幽灵会话 |

### 7.4 仲裁与过期规则

1. **信号源优先级**：hooks > transcript > ps；低优先级信号仅在高优先级**缺失或过期**（按每会话 `lastSignalAt` 校验）时才允许修正状态——`source` 字段始终记录当前状态的最高置信来源；
2. **迁移幂等**：同态重复事件只刷新 `lastSignalAt`、**不重置 `since`**（`since` = 首次进入当前状态的时刻，保证 HUD 时长不被心跳清零）；
3. **过期纪律**：全状态 `lastSignalAt` 过期校验杜绝「卡在 working」——working 静默走 ③ 降 done；done 超时走 ⑦ 降 idle；blocked 合法长寿（等人没有超时）；unknown 仅靠 ps 维持，进程消失即注销；
4. **daemon 重启恢复**：扫 `~/.claude/projects/**/*.jsonl` mtime 重建会话表，重建后以 `snapshot` 全量推送；
5. **headless 过滤**：M4 关卡生成的 `claude -p` 会话被 tty 规则 + 启动参数双重过滤，**永不进入状态机、永不出现在 snapshot**（§12-D2-A4）。

---

## 8. 客户端状态机

### 8.1 连接状态机（HUD store 内，纯 reducer，可表驱动测试）

```
                +-----------+   WS_OPEN(发auth)    +--------------+  HELLO_OK+SNAPSHOT  +------+
  (everConnected| CONNECTING| --------------------> | HANDSHAKING  | ------------------> | LIVE |
   或游戏启动)  +-----------+                       +--------------+                     +------+
        ^            | WS_CLOSE/ERROR/超时(10s)         | PROTO_MISMATCH                  |   ^
        |            v                                  v                    HEARTBEAT    |   | 任意消息
        |       +---------+  RETRY_TIMER          +--------------+          _TIMEOUT(75s) v   |
        +------ | BACKOFF | <--- 1s,2,4,…cap 30s  | INCOMPATIBLE |                      +-------+
                +---------+      (±20% jitter,    |（5min 慢重试）|                      | STALE |
                     ^            连败10次后 60s)  +--------------+                      +-------+
                     |                                                                       |
                     +------------------------- WS_CLOSE/ERROR ------------------------------+
```

| 状态 | 面板表现 |
|---|---|
| CONNECTING / HANDSHAKING | everConnected=true：显示断连小条（§4.5，文案「连接中…」）；false：不显示任何东西 |
| LIVE | 正常面板（§4.1–4.4） |
| STALE | 面板保留最后数据，整体降为 60% alpha，追加一行次色小字「数据可能过期」 |
| BACKOFF | 断连小条（§4.5）；会话列表清空（不展示陈旧的 working 骗人） |
| INCOMPATIBLE | 小条文案「守护进程需要更新（codestead 版本不匹配）」 |

补充规则：`sessionUpsert`/`sessionRemoved` 在收到首个 `snapshot` 之前一律丢弃；重连成功后以新 `snapshot` 整体替换本地表，但保留「高亮冷却 / 声音冷却」时间戳（按 sessionId 键），防止重连风暴触发一排高亮。

### 8.2 everConnected 门控

- localStorage `codestead.hud.v1.everConnected`（boolean，默认 false）；
- 首次 HELLO_OK 置 true；此前所有连接失败 silent——**没装 daemon 的玩家看不到 HUD 的任何痕迹**（游戏第一）；
- 设置菜单（§9）不受门控：始终显示连接状态与安装指引文案「运行 npx codestead 以启用会话面板」。

### 8.3 会话显示规则（客户端不自行迁移状态）

- 四态语义、staleness 降级（done→idle 30 分钟）、Esc 中断兜底、幽灵会话收尸全部由 daemon 状态机负责（语义定义见 §7，实现见 tech-stack §4.1）；**HUD 完全信任服务端状态**，客户端只做展示层的抖动合并（§5.3）；
- 宪法「时间即停」只约束 sim 层：tab 隐藏、菜单打开、结算屏打开时 **WS 连接与 HUD 数据更新照常**（HUD 反映的是现实，不是游戏模拟）；tab 隐藏期间暂停所有动效渲染，恢复可见时重算时长文本。

---

## 9. 设置项（Esc 菜单 → 设置 → 会话面板）

持久化：localStorage key `codestead.hud.v1`（zod 校验，损坏即重置默认）。**不进农场存档 schema、不随 JSON 导出**——HUD 是机器/浏览器偏好，不是游戏进度（对 save 子系统零影响）。

**实施分期**：M2 首版仅暴露 6 项 = `displayMode` / `maxRows` / `opacity` / `sound` / `tabBadge` / `streamerMode`（`streamerMode` 因隐私优先原则保留首版；`tabBadge` 因需保证一键可关保留首版）；`showIdle` / `showUnknown` / `autoFade` / `soundInBackground` 推至 M2 末，期间行为按默认值固定（idle/unknown 照常显示、autoFade 行为保留但不暴露开关、后台不响）。

| key（代码标识符） | 设置名（UI 文案） | 取值 | 默认 | 分期 |
|---|---|---|---|---|
| `displayMode` | 显示模式 | expanded / collapsed / hidden | expanded | M2 首版 |
| `maxRows` | 最多显示行数 | 3 / 5 / 7 / 9 | 5 | M2 首版 |
| `showIdle` | 显示空闲会话 | bool | true | M2 末（首版固定 true） |
| `showUnknown` | 显示未接入 hooks 的会话 | bool | true | M2 末（首版固定 true；unknown 态本身亦 M2 末） |
| `opacity` | 面板不透明度 | 0.6 / 0.8 / 1.0 | 0.8 | M2 首版 |
| `autoFade` | 角色经过时自动淡出 | bool | true | M2 末（首版行为保留、不暴露开关） |
| `sound` | 状态提示音 | off / blocked / blocked+done | off | M2 首版 |
| `soundInBackground` | 切到其他标签页时也提示音 | bool（仅 sound≠off 可改） | false | M2 末（首版固定 false，后台不响） |
| `tabBadge` | 有会话等待输入时标签页加 ● | bool | true | M2 首版 |
| `streamerMode` | 隐私模式（隐藏路径与最近输入） | bool | false | M2 首版 |

`tabBadge` 是 HUD 唯一对游戏外 UI 的被动提示——刻意保持纯文本标题前缀、不使用 Notification API、设置一键可关；与「声音默认 off」的取舍对照见 §6.1。

快捷键：**H** 循环 expanded → collapsed → hidden（与宪法 §4.5 已占用键 WASD/E/1-9/Esc 无冲突）；设置页同步反映。`hidden` 状态下面板容器 `setVisible(false)` 且无逐帧逻辑（零开销），但 store 仍接收 WS 更新（tabBadge 仍工作）。

---

## 10. 与 daemon 的消息协议（定稿，与 tech-stack §5 完全一致）

### 10.1 消费的消息

HUD 仅消费以下 5 + 1 种；quest* 消息归 M4 quest 子系统，HUD 不处理。所有消息为 JSON 文本帧，envelope `{ v: 1, type, payload }`，schema 以 `packages/shared/src/protocol.ts`（zod）为单一事实源。

| 消息 | 方向 | HUD 用途 |
|---|---|---|
| `auth { token }` | game→daemon | 连接后首条；token 经 `/handshake` 获取（§10.3 P2） |
| `hello { protocol, daemonVersion }` | daemon→game | protocol≠1 → INCOMPATIBLE；daemonVersion 显示在设置页 |
| `snapshot { sessions: SessionInfo[] }` | daemon→game | 全量重建本地会话表 |
| `sessionUpsert { session }` | daemon→game | 单条更新；state 变化时按 §6.1 提示 |
| `sessionRemoved { sessionId }` | daemon→game | 摘行；若该行正被悬停则同时关 tooltip |
| `heartbeat { at }` | daemon→game | 每 25s 一条；客户端 75s 未收任何消息 → STALE（§8.1） |

### 10.2 SessionInfo 字段 → UI 映射（逐字段，与 tech-stack §5 的 `SessionInfo` 全集一致）

| 字段 | 类型 | UI 用途 | 缺省/异常处理 |
|---|---|---|---|
| `sessionId` | string | React-key 等价物：行身份、冷却表键、排序平手键 | 必有 |
| `title` | string\|null | 显示名第一优先 | null → cwd basename |
| `subtitle` | string\|null | tooltip「最近输入」 | null → 该行省略 |
| `cwd` | string | 显示名回退、tooltip 路径、同名消歧 | 空串（process-only 会话）→ 回退 tty/sessionId（见 §12-D2 假设 A3） |
| `state` | 五态枚举 | 图标/颜色/排序/计数 | 未识别值 → 按 unknown 渲染（向前兼容） |
| `since` | ISO 8601 | 已持续时长、排序 | 解析失败 → 显示 `—`，排序按收到时刻 |
| `lastSignalAt` | ISO 8601 | 不直接展示（staleness 归 daemon）；tooltip 调试备用 | — |
| `source` | hooks/transcript/process | `process` → 图标描边版 + tooltip「置信度低」 | — |
| `error?.kind` | string | §2.4 文案映射，图标换 ⚠ | 未识别 kind → 通用文案 |

### 10.3 心跳与端点发现（草稿增补提案，已转正入协议）

两条均为**向后兼容的加法**，按 tech-stack §5 演进规则不升 `PROTOCOL_VERSION`，已同步写入 tech-stack §5 协议草案。

**P1 心跳**（支撑 STALE 态；daemon 进程僵死时 TCP 不一定及时断）：

```ts
// daemon → game，每 25s 一条
{ v: 1, type: 'heartbeat', payload: { at: string /* ISO 8601 */ } }
// 客户端 75s（3 个周期）未收到任何消息 → STALE
```

**P2 握手发现端点**（浏览器读不到 `~/.codestead/daemon.json`，必须有 HTTP 途径拿 port+token）：

```
GET http://127.0.0.1:43110/handshake        // 端口被占递增时游戏按 43110–43119 顺序探测
→ 200 { "port": 43110, "wsPath": "/ws", "token": "…", "daemonVersion": "…" }
CORS：仅放行开发期 Vite origin 白名单；M5 daemon 托管后同源、无 CORS 面
```

实现期渐进回退（daemon 心跳/握手未落地前的过渡行为）：无 heartbeat = 不进 STALE；握手不可用 = 按 43110 固定口直连。

### 10.4 与 tech-stack.md 的一致性裁决记录（双向说明）

定稿时逐项核对了 tech-stack §4.1/§5 与本稿协议字段，发现三处不一致，均按「更合理者为准」裁决并已**双向修订**：

| # | 不一致点 | tech-stack 原文 | 本稿立场 | 裁决与理由 | 双向动作 |
|---|---|---|---|---|---|
| 1 | WS 载荷字段集 | §4.1-4「载荷最小化：仅 sessionId/title/subtitle/cwd/state/since」，与同文 §5 `SessionInfo`（含 `lastSignalAt/source/error?`）自相矛盾 | HUD 需要 `source`（低置信描边）、`error`（API 错误态）、`lastSignalAt`（调试） | **以 §5 全字段为准**——三个字段都有明确 UI 消费方；「载荷最小化」的真实语义是 transcript 内容永不过 WS，与字段全集不冲突 | tech-stack §4.1-4 已改为引用 §5 字段全集；本稿 §10.2 逐字段对齐 |
| 2 | 游戏端端点发现 | §4.1-5 与风险表 #13：「daemon 写 `~/.codestead/daemon.json`……供游戏发现」 | 浏览器无法读本机文件，物理不可行 | **以本稿 P2 `/handshake` + 43110–43119 顺序探测为准**；`daemon.json` 保留给 CLI 与本机工具 | tech-stack §4.1-5、§5 演进说明、风险 #13 已同步；本稿 §10.3 定义端点契约 |
| 3 | 心跳消息 | §5 协议草案无 `heartbeat` | daemon 僵死时 TCP 不一定及时断，STALE 态无从判定 | **采纳本稿 P1**，向后兼容加法、不升版本 | tech-stack §5 已加 `heartbeat`；本稿 §8.1 的 75s 超时规则不变 |

---

## 11. 边界情况清单

| # | 情况 | 行为 |
|---|---|---|
| 1 | 0 个会话（已连接） | §4.4 空态小条，静态常驻 |
| 2 | 从未连接成功（未装 daemon） | 完全不渲染（§8.2）；设置页有安装指引 |
| 3 | daemon 中途被 kill | ≤5s 进 BACKOFF（TCP close）→ 断连小条；游戏不受任何影响 |
| 4 | daemon 重启 | 重连后 snapshot 全量替换；高亮/声音冷却表按 sessionId 保留，不触发高亮风暴 |
| 5 | daemon 僵死（进程在、不发消息） | 75s 心跳超时 → STALE（数据置灰 +「数据可能过期」） |
| 6 | 协议版本不匹配 | INCOMPATIBLE 小条 + 5min 慢重试；设置页显示双方版本号 |
| 7 | snapshot 前收到 upsert | 丢弃 |
| 8 | 会话标题为长中文/emoji/混排 | 按渲染像素宽截断加 `…`；缺字形回退 `□`（不崩、不溢出） |
| 9 | 两会话同名（如两个 `api` 目录） | 追加 `·父目录名` 消歧 |
| 10 | working↔done 秒级抖动 | 显示层 10s 合并窗口取稳定值（§5.3）；计数即时、行序合并 |
| 11 | blocked 数量 > maxRows | 面板临时扩行，blocked 永不折叠（硬上限 9 行） |
| 12 | >12 个会话 | 前 9 行 + `+N` 溢出行；tooltip 清单最多 12 条 |
| 13 | done 长期无人理 | daemon 侧 30min 降级 idle（§7.2-⑦），HUD 跟随，不自行降级 |
| 14 | unknown 会话（未装 hooks / ps-only） | 灰 `?`、时长 `—`、排序最后、tooltip 给安装指引；可整体关闭显示 |
| 15 | tab 隐藏期间状态变化 | store 照常更新；动效暂停；tabBadge（●）生效；恢复可见瞬间重算时长、补一次（仅一次）当前 blocked 行高亮 |
| 16 | 玩家走到面板后面 | autoFade 降 alpha 0.25；面板区域**吞掉**鼠标点击（防止隔着面板误锄地），hidden 态不吞 |
| 17 | 悬停中会话被移除 | 行与 tooltip 同时消失 |
| 18 | 客户端/守护进程时钟皮 | 同机理论同钟；负时长一律钳 0 |
| 19 | 日结算屏打开 | 左上面板隐藏，改由结算屏渲染「会话一行」（§4.6）；关闭后恢复 |
| 20 | Esc 菜单打开 | 面板保持可见（sim 停，HUD 不停）；菜单若遮挡则面板压在菜单层之下 |
| 21 | 同机开两个游戏 tab | daemon 对多客户端广播即可；各自独立鉴权与渲染（无冲突） |
| 22 | localStorage 设置损坏 | zod safeParse 失败 → 重置默认值，静默 |

---

## 12. 依赖与接口假设

| # | 依赖方 | 内容 | 状态 |
|---|---|---|---|
| D1 | `packages/shared` | 按 tech-stack §5 消费 `auth/hello/snapshot/sessionUpsert/sessionRemoved/heartbeat` 与 `SessionInfo`；`heartbeat` schema 已转正（§10.3 P1） | **已定稿**（tech-stack §5 已同步） |
| D2 | daemon 子系统 | **A1** staleness/降级/收尸全在服务端（语义按本稿 §7，HUD 不做语义判断）；**A2** `/handshake` 端点 + 43110–43119 探测约定（§10.3 P2，已转正、tech-stack 已同步）；**A3** process-only 会话的 `cwd` 可能为空串，daemon 尽力填充，HUD 已设回退链；**A4** headless（quest 生成）会话保证被过滤、永不出现在 snapshot | A1/A2/A4 已定稿；A3 待 daemon 实测确认 |
| D3 | game-ui / 布局子系统 | 左上角矩形 `(4,4)–(156,150)` 保留给会话面板；时钟/金币假设在右上、物品栏在底部（若布局稿冲突，以先定稿者协调） | 假设 |
| D4 | day-cycle / 日结算子系统 | 结算屏从 HUD store 读取五态计数，按 §4.6 格式渲染一行；断连/空时整行省略 | 接口已定义 |
| D5 | assets 子系统 | 新增：CJK 像素字体 woff2 全字库（建议 Fusion Pixel 12px，OFL-1.1，不裁字库 ≤4MB，非 BitmapText 图集）+ 8×8 状态图标 7 枚（!/⚠/✓/◐×4帧/○/?/⌁）+ 面板 9-slice；全部入 manifest.json 许可追溯 | 字体选型开放（§14-2） |
| D6 | 菜单/设置子系统 | 「设置 → 会话面板」承载 §9 的 10 个设置项（M2 首版仅暴露 6 项，分期见 §9）+ 连接状态/版本/安装指引展示 | 接口已定义 |
| D7 | save/storage 子系统 | HUD 设置走 localStorage，**不进**存档 schema 与 JSON 导出 | 零耦合，知会即可 |

---

## 13. 验收标准（M2 出厂自检，对照宪法 §7）

> 按实施分期拆为两栏（§7 分期注记、§9 设置分期）：M2 首版验收两源（hooks + transcript fs.watch）与首版 6 项设置；ps 轮询 / unknown / 推迟设置项在 M2 末补验。

### M2 首版

1. **延迟**：本机 hook 事件 → HUD 行更新，p95 ≤ 1 秒（含 daemon 转发）；
2. **像素**：五态图标与文字在 ×1/×2/×3 整数缩放下边缘锐利，无半像素、无抗锯齿渗色；
3. **断连健壮**：`kill <daemon>` 后 ≤5s 显示断连小条；重启 daemon 后 ≤10s 自动恢复并全量同步；全过程游戏帧率、输入、存档零影响；
4. **压力**：12 个并发会话 + 状态每秒翻转的烘焙流量下，HUD 每帧耗时 ≤2ms，面板高度不超过 146px，无行序抖动违反 §5.3；
5. **不干预**：全程零模态、零焦点抢占、零强制暂停、零经济变化（自动化断言：HUD store 对 sim store 无任何 import 与写入——ESLint no-restricted-imports 看护）；
6. **隐藏零开销**：displayMode=hidden 时无逐帧逻辑、无绘制调用（性能面板验证）；
7. **可达性**：deuteranopia / protanopia 模拟滤镜下五态可区分（形状冗余验收）；streamerMode 下截屏无路径与 prompt 内容；
8. **门控**：全新浏览器档案 + 无 daemon 启动游戏，画面上找不到 HUD 的任何痕迹；装好 daemon 后无需刷新页面即出现（探测重试自动发现）；
9. **状态机一致性（首版范围）**：daemon 状态机回放测试（hook 事件流 fixture）逐条覆盖 §7.3 转移总表中 hooks 与 transcript（fs.watch）信号行；HUD 文案/图标与 §7.1 状态集合一一对应；过渡期收尸按「idle 持续 ≥12 小时摘牌」验收；首版 6 项设置（§9）逐项生效，推迟项行为按默认值固定。

### M2 末补验

10. **未装 hooks**：仅 ps 发现的会话显示为 unknown（灰 `?`、时长 `—`），安装指引（§2.2 第 6' 行）只出现在 tooltip 与设置页，不在游戏世界中出现；
11. **收尸**：进程消失（kill -9 等）后 ps 轮询收尸、不留幽灵会话（替换首版的 idle ≥12 小时近似）；§7.3 转移总表 unknown / ps 相关行补齐回放覆盖；
12. **推迟设置项**：showIdle / showUnknown / autoFade / soundInBackground 暴露后按 §9 语义逐项验收。

---

## 14. 开放问题

1. **提示音默认值**：纯 off 最克制，但产品核心是「到点就能回去」——是否对 blocked 默认开（音量 40%、20s 冷却）？建议 M2 内测两周后用自家狗粮定夺；
2. **CJK 像素字体终选**：Fusion Pixel 12px（OFL-1.1）vs 方舟像素 Ark Pixel 12px（OFL-1.1）——按 12px 下中英混排观感定，体积预算口径以 GDD §11.3 woff2 全字库 ≤4MB 为准，需 M5 许可审计入 CREDITS；
3. **done→idle 的 30 分钟降级**是否暴露为 daemon 配置项并在 HUD 设置页透出（当前定死在 daemon）；
4. **favicon 角标**（tabBadge 的增强形态：动态 canvas favicon 画红点）——价值与实现成本待评估，M2 不做；
5. **折叠态点击行为**：点击 collapsed chip 临时展开 3 秒再自动折回，是否值得加（当前仅 H 键切换）；
6. **多机/远程会话**（ssh 上的 Claude Code）不在 M2~M5 范围，但 `SessionInfo` 是否预留 `host` 字段，留给 shared 协议定稿时讨论。
