# M1-core 评审遗留清单

> 来源：M1 开发工作流三视角评审（34 条发现，10 条已当场修复）。
> 本文件是裁决后的遗留项台账：「polish 批次」归 M1.5 执行；「待 owner 裁决」项**任何 agent 不得擅自处置**，等项目所有者拍板后回填 GDD 再实现。

## A. M1.5 执行项（polish 批次 / M1.5 范围）

1. tool_upgrade 生效：铜/金档范围交互本就归 M1.5；M1.5 落地前不对外发布（或临时在 SHOP_CATALOG_M1 隐藏 4 条 tool_upgrade）。
2. 开垦帽达帽反馈后半：计数器闪烁一次 + toast「农场 Lv N 后可打理更多田地」（US36）。
3. 路牌可读（US5）：ReadingPanel 增 'sign' 分支 + strings 增 gate_sign/signpost_junction + UIScene 路由。
4. 门廊信一次性语义（US86）：SimApi 加 markIntroLetterRead（bumpCounter 'introLetterRead'，零 schema 改动），UIScene 首读调用，未读时信件 tile 高亮。
5. reducedMotion 清单剩余项（US97/§10.8）：雨粒子密度 30%、场景淡入淡出 0ms。
6. economy.ts buy() 种子分支绕过 debit()（US63 钱包纪律）：改走 debit + INSUFFICIENT_GOLD 防御。
7. WorldScene SimEvent 双通道收敛为订阅单通道；zoneUnlocked 烟花移至天亮后播（幂等）。
8. settleShipping 不得静默销毁「已知但不可定价」物品（§4.8 零损失）：保留无 sellPrice 行供取回 + import→settle 回归测试。
9. SaveManager.performSave 的 snapshot/advanceMeta/composeSaveDoc 包进 try/catch 走 onSaveFailed({kind:'io'}) + 单测。
10. PlayerController 大 delta 穿墙：位移切片 ≤8px 或 clamp deltaMs ≤100 + 回归测试。
11. I6 后半（gpd 随 tier 严格递增）补按季分组单调断言。
12. README 更新 M1 状态 + US109 已知限制明示（同档双 tab 未定义、仅 IDB 无降级、Windows M5 补位）。
13. NEW 角标存活期：「解锁后首个游戏日」语义确认后改 night-update 清理条件（轻owner项，缺省按现实现）。
14. 结算屏「明早西田开放 · 12→18」预告行 + level_up 横幅帽数字（需先在 GDD §2.5 扩展 TomorrowItem/DaySummary 形状——doc 改动属轻微笔误级，M1.5 可顺手回填）。

## B. 待 owner 裁决（不要擅自实现）

1. **镰刀**：§6.1 物品表无镰刀 vs §3.5 工具表/T9/US42 含镰刀——是否入 M1 物品表 + 新档发放 + queryAction sickle 分支。
2. **SaveDoc v1 缺 unlockedZones**：白天中途读档围栏重现至次晨（hydrate 按等级派生已兜底）。直接改 v1（未对玩家发布）还是走 v2 迁移链。
3. **脚本 R 节奏 vs §4.6 带宽表**：严格执行规则④使 D14 晨达 Lv4，表载 Lv3。修表还是钉死购种拆分；裁决后收紧 script-r.test 双读断言。
4. **蔓越莓违反 I2 准入**（2×40 < 种价 150）：改价或改 I2 口径；裁决后删 crop-data.test 豁免。
5. **DaySummary.shipped 形状**：材料行无展示载体（金额已正确计入 goldEarned）。是否扩展为 itemId 维度。
6. **§3.1/§3.3 再生倒数措辞 vs §3.6 钦定日程**字面矛盾（代码按 §3.6，doc-only）。
7. **SaveDoc 不存每日拾取点状态**：读档可重复拾取（≤66g/日/次）。v2 是否加 pickups 字段。
8. **water_pour SFX 无 CC0 来源**（freesound 需 OAuth）：现为 ffmpeg 合成占位，需定替换渠道。
9. **§6.9 slots「zod 修复」vs shared schema refine 严格拒绝**：此类档现进 RECOVERY 而非静默修复，两处文档矛盾。
10. 其余实现期已记录的小口径问题见 M1 工作流输出（鼠标超距光标、信件「非模态」语义、快捷栏切换音、主菜单归属、日结算 400ms 常量收编、夜结算玩家位置、雨天色值确认、池塘 67 tile、建筑预留地 zone 命名、carpenter_bench 位置、intro_letter 已读入档口径、宽容加载测试归属、playTimeRealSeconds 口径、导入成功后运行时序、meta NEW 角标簿记不入档、time.season 存/不存）。
11. **US26 右键拆堆的 sim 通道形态（待 owner 追认）**：PRD 02 自身两条款冲突——§6.7 右键「拿 ⌈n/2⌉ / 放 1」需要 `moveItem`/`discardItem` 无法表达的拆堆通道 vs InventoryApi 零变更红线。M1.5 评审修复批次已按评审意见落地：**新增 SimCommand `splitItem{from,to,count}`**（sim/inventory.ts `splitAt`；InventoryApi 六方法与存档 schema 均未动，红线字面成立），右键语义全量实装并入 fuzz（test/inventory-drag-fuzz.test.ts 两条 §6.7 规约测试已解除 skip）。已知有界偏差：背包全满时右键拿半堆退化为拒绝+提示（虚拟手持需一个空格作锚位；divergence 注记见 test/helpers/drag-store-contract.ts）。待 owner 追认通道形态：保留 `splitItem` / 改 `moveItem` 加 `count` 字段 / 否决则回退并顺延 M3。
12. **成就开启模式勤奋 bot Lv5 首达日出带（待 owner 校准裁决）**：PRD 02 Further Notes 点名的风险实测成立——achievements ON 的脚本 R 28 天推演 Lv5 首达 **D21**（部分天气种子 D22；OFF 模式各种子均 D24），低于 §5.8 验收带 [22,27] 下沿 1 天。按校准纪律（PRD 02：出带回 GDD 修订、不得实现侧私调），现状以 `it.fails` 钉死在 src/sim/__tests__/pacing-achievements-on.test.ts（另有 [21,27] 漂移护栏为常规断言）；待 owner 裁决：缩 #1~#14 的 305 XP 预算 / 放宽带宽 / 接受 D21 并改 §5.8——裁决落地后该 `it.fails` 自动转红提醒移除标记。

## C. 后续里程碑提醒

- M5 前：Phaser 单 chunk 1.41MB（gzip 393KB）超 Vite 500KB 警告线 → manualChunks 分包评估。
- M2 落地后：左上预留区 scrim 开洞的视觉突兀自然消失。

## F. M3 交付后的待 owner 裁决项（实现按保守口径占位，回填 GDD 后单点替换）

1. **品质判定机制**：现为 PROVISIONAL 平坦分布（金 5%/银 20%/普 75%，seeded RNG，已接入收获路径）；裁决机制后只需替换 `PROVISIONAL_QUALITY_ROLL` 常量。
2. **洒水器成本**：占位 500g+石20（Lv6）/ 2000g+石60（Lv8），`provisional:true` 标注；GDD §8.2 待回填。另：洒水器无拆除/搬迁通道（只放不收），建议补 removeSprinkler 100% 返还。
3. **鸡交易入口**：实现为鸡舍面板（买 200g/回收 100g/捡蛋）；拆带鸡鸡舍=鸡自动 100g 回收+蛋退回。GDD §8.3 待回填。
4. **M3 itemId 命名**：animal_egg（material 类）/artisan_mayonnaise/artisan_jam_*/artisan_dried_*；GDD §6.1/A-14 待回填。
5. **室内场景形态**：鸡舍/加工棚以面板替代走入式室内；仓库箱 UI、温室室内场景待后续批次；温室 24 格室内耕地建模为建筑脚印内世界坐标 tile（功能等价，待 owner 追认）。
6. **季节轮替与 T4 作物**：未启用（B-11），NightUpdate #8 保持空操作框架。
7. **合成占位音频**：whiff/rain_loop/water_pour 为 ffmpeg 合成（manifest 已标注），待真实 CC0 录音替换；FreePD 官网已关停，BGM 走 0lhi/FreePD GitHub 镜像（CC0 已核验）。
8. **GDD 回填清单**：v2 schema 新增块（farmhouse/unlockedZones/clearedResourceNodes 入 §10.2）、日拾取 faucet 66g→92g（§4.7 与 §8.1 现互相矛盾）、§5.8「2000 XP⇒Lv6」散文与 §5.1 阈值表矛盾（按表实现）、#22 金牌匾实体形态。

## E. M2 交付后的遗留事项

1. **daemon Origin 白名单缺 4173**：`vite preview` 默认端口被静默拒绝（M2~M4 期间需用 `--port 5173`，或把 4173 加入 DEV_ALLOWED_ORIGINS；M5 同源托管后消失）→ 建议 M5 前补文档或加白。
2. **真实 hook fixture 待采集**（需用户本人执行）：在真实环境跑 `packages/daemon` 录制器 → scrub 脱敏 → 落 `test/fixtures`，即可把 reducer 回放测试的最后一个 `it.todo` 转正（fixtures/README 有手工流程）。
3. **QUEST_LAUNCH_ARG_MARKER='codestead-quest' 待 M4 落实**：M4 headless spawner 的 argv 必须含该标记，否则 ps 双重过滤第二腿失效（M4 实现时核对，并回填 tech-stack §4.2/ai-quests）。
4. **8×8 状态图标 spritesheet 未落地**：HUD 图标现用像素字体字形（!/✓/◐）渲染，视觉可用；正式图标随后续资产批次。
5. **验收 §13-1/3/4 真机联调实测**（p95 ≤1s、断连 ≤5s、12 会话 ≤2ms/帧）：纯单测无法覆盖，建议真实使用时观察。
6. **hud-sessions §2.1 显示名回退链含 tty 但 SessionInfo 无 tty 字段**：process-only 会话回退到 'ps-<pid>'，若要 tty 回退需先修订设计文档（owner）。

## D. M1 发布前置缺口（需真人执行，agent 不可代办）

1. **红线 1 真人 playtest 未执行、未归档**（PRD 02 测试决策 12 / 实现决策 12；§0.5 红线 1）：需 ≥2 名未读任何文档、无农场游戏经验的测试者，无口头提示，记录 10 真实分钟内首次「种→收→卖」与 Lv2 达成情况及全部卡点；结论与改动记录归档至 `docs/playtests/m1-redline1-YYYYMMDD.md`（线下人工记录，无遥测）。失败时只允许动可调面（新手引导三件套文案/呈现、明日之诺、NEW 角标、toast 文案——已由 test/redline1-onboarding-copy.test.ts 钉死口径）后复测；数值/状态机改动必须先回 GDD 修订。**PRD 02 出厂判定 = 全部测试资产绿 + 红线 1~3 成立：此项不闭合不得宣布 M1 出厂。**
2. **US22 升级视觉三件套的人工验收走查记录**（PRD 02 测试决策 11）：三件已实装于 src/world/upgrade-fx.ts（水弧随档位加宽、铜/金档挥动残影、范围浇水湿色扩散；残影与扩散在 reducedMotion 下按约跳过），渲染层不写单测，「肉眼可辨」需人工走查并留记录（可并入 playtest 当日清单：含范围框跟随朝向、成就 toast 位置/时长/不抢焦点、成就页全键盘、提示队列溢出合并文案）。
