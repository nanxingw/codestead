# 资产来源与致谢（ATTRIBUTION）

> M3 更新。逐文件的机器可读溯源见 `assets/manifest.json`（含 sha256 与核验日期）。
> 许可白名单：**CC0-1.0** 与 **OFL-1.1（仅字体）**（GDD §11.1，验收红线 5）。
> 音频管线：`pnpm assets:audio`（loudnorm 统一响度 + ogg/m4a 双格式，见
> `assets-src/tools/build-audio-m3.mjs`）；CI 门禁 `pnpm check:audio`。

## Kenney（kenney.nl）— CC0-1.0

感谢 Kenney 慷慨的 CC0 素材。CC0 不要求署名，此处自愿致谢。

| 包                                                                | 用途                                                                                                                                                         | 下载核验                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| [Roguelike/RPG pack](https://kenney.nl/assets/roguelike-rpg-pack) | 地形 tileset（草地/泥土路/池塘/房屋构件/栅栏/市场摊位/树木等 45 个 tile 选裁）、3 个拾取物图标（倒木/碎石/野花）                                             | sha256 `8e7d2378…a5a9524b`（manifest 有全文） |
| [Impact Sounds](https://kenney.nl/assets/impact-sounds)           | `hoe_till`；M3：`step_grass_0..2`、`build_place`                                                                                                             | manifest                                      |
| [Interface Sounds](https://kenney.nl/assets/interface-sounds)     | `seed_plant` / `harvest_pop` / `item_get` / `ui_error`；M3：`ui_tick/click/open/close`、`egg_collect`、`process_done`、`quest_chime`、`blip_talk`            | manifest                                      |
| [RPG Audio](https://kenney.nl/assets/rpg-audio)                   | `coins`；M3：`step_dirt_0..2`、`build_refund`                                                                                                                | manifest                                      |
| [Music Jingles](https://kenney.nl/assets/music-jingles)           | `jingle_levelup`（Pizzicato 07）；M3：`jingle_day_end`（Steel 07）、`jingle_collect`（Pizzicato 03）、`jingle_quest`（Sax 07）、`build_complete`（Steel 04） | manifest                                      |
| [UI Audio](https://kenney.nl/assets/ui-audio)                     | `session_chime`（click1；M2 会话面板提示音，客户端 40% 音量播放）；M3：`hud_soft_tick`（rollover2，默认关）                                                  | manifest                                      |

## FreePD（经 GitHub 镜像 [0lhi/FreePD](https://github.com/0lhi/FreePD)）— CC0-1.0

BGM 三首（GDD §11.6/§11.1 来源 A5「FreePD GitHub 镜像」）。freepd.com 已于 2025 年
关站；镜像仓库以仓库级 CC0-1.0 LICENSE 再分发全部曲目，作者信息已对照
freepd.com 的 Wayback Machine 存档页逐曲核验（2024-11/2025-01 快照）。
CC0 不要求署名，此处自愿逐曲致谢：

| 轨道           | 曲目                                    | 作者                             | 处理                                              |
| -------------- | --------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `bgm_day_a`    | Happy Whistling Ukulele（Upbeat，123s） | Rafael Krux（orchestralis.net）  | loudnorm −16 LUFS，整曲                           |
| `bgm_day_b`    | Pickled Pink（Upbeat，175s）            | Kevin MacLeod（incompetech.com） | 截取 150s + 2s 尾部淡出（§11.6 90~150s 循环窗口） |
| `bgm_rain_day` | Lovely Piano Song（Romance，96s）       | Rafael Krux（orchestralis.net）  | loudnorm −16 LUFS，整曲                           |

每曲的镜像下载 URL 与源 mp3 sha256 见 manifest（`sourceDownload` / `sourceSha256`）。

## Fusion Pixel Font — OFL-1.1

- [TakWolf/fusion-pixel-font](https://github.com/TakWolf/fusion-pixel-font) v2026.05.07，12px proportional（zh_hans + latin 两个 woff2）。
- 上游字形来自 Ark Pixel Font / Cubic 11 / Galmuri 等（均 OFL-1.1）。
- 许可全文随发行物附带：`assets/fonts/fusion-pixel-12px/LICENSE-OFL.txt`。
- 这是仓库中唯一的非 CC0 资产（GDD §11.1 F1 条目钦定）。

## 自绘 / 程序生成 — 以 CC0-1.0 献出

- 作物全部生长阶段帧、物品/种子袋/工具/HUD 图标、UI 9-slice、雨滴/水花特效、玩家四向行走与挥具动画：由 `assets-src/tools/build-atlases.mjs` 按 CODE-28 调色板（GDD §11.2）程序生成；manifest 中标注 `placeholder: true` 的帧计划在后续里程碑由 Aseprite 手绘替换（许可不变）。
- M2 会话面板 8×8 状态图标（!/⚠/✓/◐×4 帧/○/?/⌁，含 `_hollow` 描边变体）与 `hud_panel` 9-slice：同管线自绘（hud-sessions §3.1/§12-D5 规格；HUD 色 token 见 GDD A-8/§7.4），以 CC0 献出。
- 耕地干/湿 tile、水井 2×2、碰撞标记 tile：`assets-src/tools/build-terrain.mjs` 程序生成。
- `water_pour.ogg`：Kenney 各包中无 CC0 浇水声，暂以 ffmpeg 合成的滤波噪声占位（self-made，CC0，manifest 标注 placeholder）。
- `whiff`（M3）：Kenney 各包中无 CC0 挥空声，ffmpeg 合成带通噪声占位（self-made，CC0，placeholder）。
- `ambience/rain_loop`（M3）：freesound 的 CC0 实录雨声需逐条登录核验，本里程碑先以 ffmpeg 合成的滤波粉噪雨底占位（self-made，CC0，placeholder），后续替换为实录。
- `maps/farm.tmj`：按 GDD §1.3 分区表由 `assets-src/tools/gen-map.mjs` 生成。

## 风格参考红线

Sprout Lands / Sunnyside / Cozy Farm 仅作风格参考，仓库不含其任何文件；星露谷（Stardew Valley）本体素材绝对禁止入库（GDD §11.1）。
