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

## C. 后续里程碑提醒

- M5 前：Phaser 单 chunk 1.41MB（gzip 393KB）超 Vite 500KB 警告线 → manualChunks 分包评估。
- M2 落地后：左上预留区 scrim 开洞的视觉突兀自然消失。
