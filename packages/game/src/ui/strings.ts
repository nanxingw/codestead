/**
 * strings.ts — zh-CN UI string table (M1; en pass lands M5 per CLAUDE.md).
 *
 * Keys follow the sim nameKey conventions (`item.<id>` / `crop.<id>` / `shop.<entryId>`,
 * GDD §6.1/§3.6/§4.3) plus flat `ui.*` keys for chrome. Display strings never live in
 * sim — this is the render-side lookup.
 */

const STRINGS: Record<string, string> = {
  // ---- items (GDD §6.1) ----
  'item.hoe': '锄头',
  'item.watering_can': '喷壶',
  'item.seed_radish_quick': '小萝卜种子',
  'item.seed_turnip': '芜菁种子',
  'item.seed_potato': '土豆种子',
  'item.seed_bean_vine': '豆藤种子',
  'item.seed_cabbage': '卷心菜种子',
  'item.seed_berry': '浆果种子',
  'item.crop_radish_quick': '小萝卜',
  'item.crop_turnip': '芜菁',
  'item.crop_potato': '土豆',
  'item.crop_bean_vine': '豆荚', // bean_vine product displays as 豆荚 (ruling A-14)
  'item.crop_cabbage': '卷心菜',
  'item.crop_berry': '浆果',
  'item.material_wood': '木材',
  'item.material_stone': '石料',
  'item.forage_wildflower': '野花',

  // ---- crops (GDD §3.6, M1 six) ----
  'crop.radish_quick': '小萝卜',
  'crop.turnip': '芜菁',
  'crop.potato': '土豆',
  'crop.bean_vine': '豆藤',
  'crop.cabbage': '卷心菜',
  'crop.berry': '浆果',

  // ---- item categories (GDD §6.1) ----
  'category.tool': '工具',
  'category.seed': '种子',
  'category.crop': '作物',
  'category.material': '材料',
  'category.artisan_good': '加工品',
  'category.quest': '任务道具',

  // ---- shop entries (GDD §4.3 authoritative names) ----
  'shop.seed_radish_quick': '小萝卜种子',
  'shop.seed_turnip': '芜菁种子（省心，四天一收）',
  'shop.seed_potato': '土豆种子',
  'shop.seed_bean_vine': '豆藤种子',
  'shop.seed_cabbage': '卷心菜种子',
  'shop.seed_berry': '浆果种子',
  'shop.tool_hoe_copper': '铜锄头（直线 3 格）',
  'shop.tool_can_copper': '铜喷壶（直线 3 格）',
  'shop.tool_hoe_gold': '金锄头（3×3）',
  'shop.tool_can_gold': '金喷壶（3×3）',

  // ---- seasons / weather ----
  'season.spring': '春',
  'season.summer': '夏',
  'season.fall': '秋',
  'season.winter': '冬',
  'weather.sunny': '晴',
  'weather.rain': '雨',

  // ---- zones (GDD §1.2 legend) ----
  'zone.field_a': '起始田',
  'zone.field_b': '西田',
  'zone.field_c': '南田',

  // ---- HUD / common chrome ----
  'ui.gold': '金币',
  'ui.level_short': 'Lv',
  'ui.tilled_counter': '耕地',
  'ui.close': '关闭',
  'ui.back': '返回',
  'ui.confirm': '确认',
  'ui.cancel': '取消',

  // ---- toasts (blocked reasons only, GDD §6.7) ----
  'toast.inventory_full': '背包已满',
  'toast.tilled_cap': '农场 Lv {level} 后可打理更多田地', // §1.4 cap hint (US36, A-2)
  'toast.not_enough_gold': '金币不足',
  'toast.not_discardable': '这个不能丢弃',
  'toast.not_sellable': '这个不能出售',
  'toast.locked_entry': '尚未解锁',
  'toast.requires_copper': '需先购买铜档',
  'toast.already_owned': '已是最高档',
  'toast.overflow_summary': '还有 {n} 项新进展，详见日结算',
  'toast.save_failed': '存档写入失败——建议在设置中导出 JSON 备份',

  // ---- tool upgrade feedback (GDD §3.5 升级视觉反馈; PRD 02 US22, M1.5) ----
  'toast.tool_upgraded_hoe_copper': '铜锄头到手！长按预览直线 3 格，松开批量开垦',
  'toast.tool_upgraded_hoe_gold': '金锄头到手！长按预览 3×3，松开批量开垦',
  'toast.tool_upgraded_can_copper': '铜喷壶到手！一次浇直线 3 格',
  'toast.tool_upgraded_can_gold': '金喷壶到手！一次浇 3×3',

  // ---- gentle hints (GDD §3.2 old-vine 温和提示, verbatim) ----
  'hint.old_vine': '这茬藤老了，换新种吧',

  // ---- boot screens (GDD §10.4 RECOVERY / TOO_NEW, M1 minimal) ----
  'boot.recovery_title': '存档数据有问题',
  'boot.recovery_body':
    '现有数据已保留、不会被删除。可以导入之前导出的 JSON 存档，或开一个新农场。',
  'boot.recovery_import': '[ 导入存档 JSON ]',
  'boot.recovery_new': '[ 开新农场 ]',
  'boot.too_new_title': '存档版本过新',
  'boot.too_new_body':
    '这份存档（v{version}）来自更新版本的 Codestead。为保护数据，本版本不会写入，只提供导出。',
  'boot.too_new_export': '[ 导出存档 JSON ]',

  // ---- banners (GDD §5.8) ----
  'banner.level_up': '⬆ 农场等级 {level}！可打理田地 {prev}→{cap}',
  'banner.zone_unlocked': '{zone}已开放',

  // ---- in-place feedback floaters (GDD §6.4 「+1 芜菁」, §5.8 「+5 xp」) ----
  'fx.gain_item': '+{n} {name}',
  'fx.gain_xp': '+{xp} xp',
  'fx.gold_gain': '+{gold}g',
  'fx.gold_spend': '-{gold}g',

  // ---- inventory panel ----
  'inventory.title': '背包',
  'inventory.locked_slot': '农场升级后可扩容',
  'inventory.trash': '垃圾桶',
  'inventory.undo': '撤销', // single-step regret slot (GDD §6.3, M1.5)
  'inventory.undo_hint': '点击取回最近丢弃',
  'inventory.sort_hint': '[R] 整理储备格 · Shift+左键快速移动',
  'inventory.sell_price': '售价',

  // ---- shop panel (GDD §4.3) ----
  'shop.title': '杂货摊',
  'shop.tab_buy': '买入',
  'shop.tab_sell': '卖出',
  'shop.new_badge': 'NEW',
  'shop.locked_lv': 'Lv {level} 解锁',
  'shop.folded': '更高等级还有 {n} 项待解锁',
  'shop.owned': '已购',
  'shop.gold_gap': '差 {gap}g',
  'shop.consign_hint': '作物寄售 · 今晚结算 ✓',
  'shop.refund_hint': '种子即时 100% 退货',
  'shop.sell_keys': '左键×1 · 右键×5 · Shift+左键整堆',
  'shop.buy_keys': '左键×1 · 右键×5',
  'shop.empty_sell': '背包里没有可出售的物品',
  // M3 supplies (PRD 04 §E/§H): material buy-in floor + backpack expansion.
  'shop.supplies_header': '——补给——',
  'shop.buy_wood': '木材（建材兜底）',
  'shop.buy_stone': '石料（建材兜底）',
  'shop.expand_backpack': '背包扩容（12 → 24 格）',
  'shop.backpack_done': '背包已扩容',

  // ---- shipping bin (GDD §4.2 mock) ----
  'bin.title': '出货箱 · 今晚结算',
  'bin.bin_column': '箱内（点击取回 ↩）',
  'bin.inv_column': '背包（点击入箱 →）',
  'bin.estimate': '预计入账 {gold}g',
  'bin.ship_all': '[F] 全部入箱',
  'bin.close': '[Esc] 关闭',
  'bin.stack_hint': '[Shift+左键=整堆]',
  'bin.empty': '箱子还是空的',

  // ---- main menu (GDD §6.7 主菜单 / US84) ----
  'mainmenu.continue': '继续',
  'mainmenu.new_game': '新游戏',
  'mainmenu.import': '导入存档',
  'mainmenu.settings': '设置',
  'mainmenu.about': '关于与许可',
  'mainmenu.summary': '第 {day} 天 · {season} · {gold}g · Lv {level}',
  'mainmenu.no_save': '没有可继续的存档',
  'mainmenu.new_title': '开新农场？',
  'mainmenu.new_body': '当前存档会被新农场覆盖。建议先导出 JSON 备份。',
  'mainmenu.export_current': '[ 导出当前存档 ]',
  'mainmenu.new_confirm': '[ 确认开新农场 ]',
  'mainmenu.back': '[ 返回 ]',
  'mainmenu.new_failed': '开新农场失败，请重试',

  // ---- about & licenses (US84 关于与许可; red line 5 traceability) ----
  'about.title': '关于与许可',
  'about.licenses': '许可白名单：CC0-1.0 · OFL-1.1（仅字体）',
  'about.credits': 'Kenney（kenney.nl）CC0 · Fusion Pixel Font OFL-1.1 · 自绘/程序生成 CC0',
  'about.manifest_pointer': '逐文件溯源：ATTRIBUTION.md 与 assets/manifest.json（含 sha256）',
  'about.manifest_loading': '正在读取资产清单…',
  'about.manifest_failed': '无法读取 assets/manifest.json',
  'about.more_files': '…其余 {n} 项见 assets/manifest.json',

  // ---- pause menu (GDD §6.7; 成就 tab M1.5, PRD 02 US12) ----
  'menu.title': '暂停',
  'menu.resume': '继续',
  'menu.save': '保存',
  'menu.saved': '已保存 ✓',
  'menu.achievements': '成就',
  'menu.settings': '设置',
  'menu.keys': '键位说明',
  'menu.main_menu': '回主菜单',

  // ---- achievements (GDD §5.6 名称 verbatim; M1 page = #1~#14 only, §5.3 折叠纪律) ----
  'achievement.toast': '🏆 成就解锁 · {name}',
  'achievement.title': '成就（{n}/{total}）',
  'achievement.reward_xp': '+{xp} XP',
  'achievement.reward_gold': '+{gold}g',
  'achv.first_till.name': '破土',
  'achv.first_till.cond': '第一次锄地',
  'achv.first_seed.name': '第一粒种子',
  'achv.first_seed.cond': '第一次播种',
  'achv.first_harvest.name': '第一次收获',
  'achv.first_harvest.cond': '第一次收获作物',
  'achv.first_sale.name': '第一桶金',
  'achv.first_sale.cond': '第一次售出（夜结算）',
  'achv.rain_blessing.name': '雨天的馈赠',
  'achv.rain_blessing.cond': '经历一个雨天',
  'achv.first_sunrise.name': '过夜',
  'achv.first_sunrise.cond': '第一次过夜',
  'achv.nest_egg.name': '小有积蓄',
  'achv.nest_egg.cond': '累计入账 1,000g',
  'achv.moneybags.name': '千金',
  'achv.moneybags.cond': '累计入账 10,000g',
  'achv.hundred_harvests.name': '百次收获',
  'achv.hundred_harvests.cond': '累计收获 100 次',
  'achv.steady_hands.name': '如常浇灌',
  'achv.steady_hands.cond': '累计浇水 200 次',
  'achv.tooled_up.name': '装备升级',
  'achv.tooled_up.cond': '升级一件工具',
  'achv.gilded.name': '黄金装备',
  'achv.gilded.cond': '两件工具均达金档',
  'achv.six_crops.name': '初识六谷',
  'achv.six_crops.cond': '6 种起步作物各售出 1 次',
  'achv.regrow_expert.name': '再生行家',
  'achv.regrow_expert.cond': '再生作物连收 4 茬',

  // ---- settings (GDD §10.7) ----
  'settings.title': '设置',
  'settings.audio': '音频',
  'settings.master': '主音量',
  'settings.muted': '静音',
  'settings.bgm': 'BGM 音量',
  'settings.sfx': '音效音量',
  'settings.ui_volume': 'UI 音量',
  'settings.m3_badge': 'M3 可用',
  'settings.language': '语言',
  'settings.lang_zh': '简体中文',
  'settings.reduced_motion': '减弱动态效果',
  'settings.rm_system': '跟随系统',
  'settings.rm_on': '开',
  'settings.rm_off': '关',
  'settings.sessions_section': '会话面板',
  'settings.sessions_badge': 'M2 可用',
  'settings.quests_section': '村民任务',
  'settings.quests_badge': 'M4 可用', // legacy key (kept for compatibility; superseded by quests_open)
  'settings.quests_open': '设置 ▸',
  'settings.save_section': '存档',
  'settings.export': '导出存档 JSON',
  'settings.import': '导入存档 JSON',
  'settings.import_failed': '导入失败：文件无效，现有存档未改动',
  'settings.import_ok': '导入完成',
  'settings.storage_ok': '存储：正常 ✓',
  'settings.on': '开',
  'settings.off': '关',

  // ---- day summary (GDD §2.5) ----
  'summary.title': '第 {day} 天 · {season}',
  'summary.harvested': '今日收成',
  'summary.shipped': '出售入账',
  'summary.nothing_sold': '今天没有出售',
  'summary.nothing_harvested': '今天没有收成',
  'summary.gold_earned': '入账 +{gold}g',
  'summary.gold_balance': '金币余额 {gold}g',
  'summary.xp': '今日 XP +{xp}',
  // 新成就 row in the progress block (GDD §5.8; PRD 02 US11) — the toast-queue
  // overflow line 「还有 N 项新进展，详见日结算」 points here.
  'summary.achievement': '🏆 新成就 · {name}',
  'summary.level_up': '升到了 Lv {level}！',
  // Cap-raising level: the summary spells out the numbers (GDD §1.4/§5.8, A-14).
  'summary.level_up_cap': '升到了 Lv {level}！可打理田地 {prev}→{cap}',
  'summary.eta': '距 Lv {level} 还差 {xp} XP（约 {days} 天）',
  'summary.eta_keep_going': '继续耕作即可升级',
  'summary.tomorrow': '明天',
  'summary.tomorrow_rain': '☔ 明日有雨，自动浇水',
  // Next-morning zone unlock (GDD §1.4 「日结算屏明示数字」, A-14).
  'summary.tomorrow_zone': '🔓 明早{zone}开放 · 可打理田地 {prev}→{cap}',
  'summary.tomorrow_crop_ready': '🌱 {crop}明天成熟！',
  'summary.tomorrow_crop_in': '🌱 {crop}还需 {days} 天',
  // Construction promise (GDD §8.3 acceptance 「还差 N 天完工」; PRD 04 US11).
  'summary.tomorrow_construction': '🔨 {name}还差 {days} 天完工',
  'summary.tomorrow_fallback': '商店有新鲜种子等你',
  // One-shot certificate-desk line (GDD §5.3 「达成当日结算屏温和提示一次」, US39).
  'summary.profession_hint': '职业证书已可在农舍签署（Lv5）',
  'summary.weather_next_sunny': '明天天气：晴 ☀',
  'summary.weather_next_rain': '明天天气：雨 ☔',
  'summary.continue': '按任意键开始新的一天',

  // ---- sleep confirm (ruling A-20) ----
  'sleep.question': '现在睡觉吗？',
  'sleep.yes': '睡觉',
  'sleep.no': '再待一会',

  // ---- intro letter (GDD §1.9, verbatim) ----
  'letter.title': '前任农场主的信',
  'letter.body': '兜里有 100g。沿路往东，集市的杂货摊上有种子，投币自取。田就在门前。',

  // ---- bulletin board (GDD §1.9 stage hints) ----
  'board.title': '集市告示牌',
  'board.hint_buy_seeds': '去集市买种子',
  'board.hint_plant': '锄地播种',
  'board.hint_water': '每天清晨浇水',

  // ---- readable signs (US5 / backlog A-3; copy per GDD §1.9/§1.3) ----
  'sign.signpost_junction.title': '路口指路牌',
  'sign.signpost_junction.body': '→ 集市',
  'sign.gate_sign.title': '南门施工牌',
  'sign.gate_sign.body': '路还在修，不急。',
  'sign.unknown.title': '木牌',
  'sign.unknown.body': '字迹已经模糊了。',

  // ---- M3 items (GDD §8.1/§8.2; ids per ruling A-14, sim/data/items.ts) ----
  'item.axe': '斧头',
  'item.pickaxe': '镐',
  'item.animal_egg': '鸡蛋',
  'item.artisan_mayonnaise': '蛋黄酱',
  'item.artisan_jam_radish_quick': '小萝卜果酱',
  'item.artisan_jam_turnip': '芜菁果酱',
  'item.artisan_jam_potato': '土豆果酱',
  'item.artisan_jam_bean_vine': '豆荚果酱',
  'item.artisan_jam_cabbage': '卷心菜果酱',
  'item.artisan_jam_berry': '浆果果酱',
  'item.artisan_dried_radish_quick': '小萝卜干',
  'item.artisan_dried_turnip': '芜菁干',
  'item.artisan_dried_potato': '土豆干',
  'item.artisan_dried_bean_vine': '豆荚干',
  'item.artisan_dried_cabbage': '卷心菜干',
  'item.artisan_dried_berry': '浆果干',

  // ---- M3 blueprints (GDD §8.2 names; nameKey = `blueprint.<id>`) ----
  'blueprint.coop': '鸡舍',
  'blueprint.workshop': '加工棚',
  'blueprint.greenhouse': '温室',
  'blueprint.farmhouse_1': '农舍翻新',
  'blueprint.farmhouse_2': '农舍扩建',
  'blueprint.storage_chest': '仓库箱',
  'blueprint.drying_rack': '烘干架',
  'blueprint.fence': '木栅栏',
  'blueprint.stone_path': '石径',
  'blueprint.flower_bed': '花坛',
  'blueprint.bench': '长椅',
  'blueprint.lamp_post': '灯柱',
  'blueprint.sprinkler': '洒水器',
  'blueprint.sprinkler_advanced': '高级洒水器',
  'blueprint.memorial_statue': '纪念雕像',

  // ---- build mode (GDD §8.3; PRD 04 §A/§D) ----
  'build.title': '建造目录',
  'build.tab_blueprints': '图纸',
  'build.tab_move': '搬迁',
  'build.tab_demolish': '拆除',
  'build.locked_lv': 'Lv {level} 解锁',
  'build.requires_farmhouse1': '需先完成农舍翻新',
  'build.limit': '已建 {n}/{limit}',
  'build.done': '已完成',
  'build.in_progress': '施工中',
  'build.days': '工期 {days} 天',
  'build.holdings': '持有：{gold}g · 木×{wood} · 石×{stone}',
  'build.deficit': '差 {parts}',
  'build.keys': '↑↓ 选择 · ←→ 切页签 · E 确认 · Esc 关闭',
  'build.empty_move': '还没有可搬迁的设施',
  'build.empty_demolish': '还没有可拆除的设施',
  'build.refund_tag': '返还 {parts}',
  'build.move_free': '搬迁永久免费 · 保留全部内部状态',
  'build.confirm_order_title': '确认建造{name}？',
  'build.confirm_order_body':
    '费用 {parts} · 工期 {days} 天\n当前余额 {gold}g · 木×{wood} · 石×{stone}',
  'build.confirm_upgrade_body':
    '费用 {parts} · 工期 {days} 天 · 施工期间照常进出\n当前余额 {gold}g · 木×{wood} · 石×{stone}',
  'build.demolish_site_title': '取消施工订单？',
  'build.demolish_site_body': '订单取消后全额返还：{parts}。',
  'build.demolish_built_title': '拆除{name}？',
  'build.demolish_built_body': '拆除成品返还 50%：{parts}。此操作不可撤销。',
  'build.demolish_built_again': '再次确认：真的要拆除{name}吗？',
  'build.placing_hint': 'E / 左键 放置 · Esc / 右键 取消',
  'build.placing_move_hint': 'E / 左键 放到这里 · Esc / 右键 取消搬迁',
  'build.violation.out_of_bounds': '超出地图边界',
  'build.violation.not_buildable': '此处不可建造',
  'build.violation.farmland_conflict': '不能压住耕地或作物',
  'build.violation.overlap': '与已放置物重叠',
  'build.violation.occupant_inside': '有人站在范围内',
  'build.violation.door_unreachable': '门前需要留出 1 格通道',
  'structure.site_label': '施工中 还差 {days} 天',
  'toast.build_not_enough': '材料或金币不足',
  'toast.build_locked': '尚未解锁',
  'toast.build_limit': '数量已达上限',
  'toast.build_materials_exhausted': '材料用完了——已退回建造目录',
  'toast.build_demolished': '已拆除 · 全额返还',
  'toast.build_cancelled_order': '订单已取消 · 全额返还',
  'toast.build_demolished_building': '已拆除 · 返还 50%',
  'toast.build_moved': '搬迁完成',
  'toast.chest_not_empty': '仓库箱非空，不能拆除',
  'toast.demolish_inventory_full': '背包放不下在制品，不能拆除',
  'toast.bench_sit': '你在长椅上坐了一会儿，发了发呆…',
  'toast.chest_hint': '仓库箱仓储界面将随后续批次开放',
  'toast.greenhouse_hint': '温室已就绪——室内场景将随室内地图批次开放',
  'banner.construction_done': '🏗 {name}竣工！',

  // ---- coop (GDD §8.2 row 1; rulings A-6/A-7; PRD 04 US13~15) ----
  'coop.title': '鸡舍',
  'coop.hens': '鸡 {n}/{max}',
  'coop.eggs': '待捡鸡蛋 ×{n}',
  'coop.collect': '捡蛋',
  'coop.buy_hen': '买一只鸡（{gold}g）',
  'coop.sell_hen': '回收一只（+{gold}g）',
  'coop.hint': '每只鸡每天清晨产 1 蛋 · 免喂养、不会死',
  'toast.coop_full': '鸡舍已满（最多 {max} 只）',
  'toast.coop_no_hens': '没有鸡可回收',
  'toast.coop_no_eggs': '现在没有可捡的蛋',

  // ---- processing facilities (GDD §8.2; ruling A-12; PRD 04 US16/US19) ----
  'process.title_workshop': '加工棚',
  'process.title_rack': '烘干架',
  'process.slot_empty': '空槽',
  'process.slot_progress': '{name} → {out} · 还需 {days} 夜',
  'process.slot_done': '{out} 完成 · 点击取出',
  'process.inputs': '可用原料（点击装入空槽）',
  'process.no_inputs': '背包里没有可加工的原料',
  'process.recipe_tag': '→ {out} · {days} 夜 · {gold}g',
  'toast.process_no_slot': '没有空槽了',
  'toast.process_collected': '已取出 {name}',

  // ---- profession (GDD §5.3; ruling A-13; PRD 04 US38/US39) ----
  'profession.title': '职业证书',
  'profession.body': '达到农场 Lv5 后可签署职业证书——二选一，永久不可更改，不影响升级。',
  'profession.horticulturist': '园艺师',
  'profession.horticulturist_desc': '作物售价 +10%',
  'profession.artisan': '工匠',
  'profession.artisan_desc': '加工品售价 +25%',
  'profession.confirm_title': '签署「{name}」证书？',
  'profession.confirm_body': '此选择永久不可逆（不影响任何升级）。',
  'profession.locked': '农场 Lv5 后可签署',
  'profession.chosen': '已签署：{name}',
  'banner.profession': '📜 职业认定 · {name}',
  'sleep.profession': '职业证书…',
  // Retro-unlock quiet line for migrated M1 saves (GDD §8.2 解锁节奏; PRD 04 US37).
  'toast.carpenter_service': '木匠服务已开通',

  // ---- codex (GDD §4.8/§5.8; PRD 04 US49/US50) ----
  'codex.title': '图鉴（{n}/{total}）',
  'codex.page': '{category} {n}/{total}',
  'codex.unknown': '？？？',
  'codex.first_sold': '第 {day} 天首售',
  'codex.unsold': '尚未售出',
  'codex.hint': '←/→ 切换分页 · Esc 返回',
  'menu.codex': '图鉴',
  'menu.build': '建造',

  // ---- achievements M3 rows (GDD §5.6 names verbatim; PRD 04 §I) ----
  'achv.homestead.name': '安家',
  'achv.homestead.cond': '建成第一座建筑',
  'achv.tycoon.name': '建筑大亨',
  'achv.tycoon.cond': '鸡舍、加工棚、温室齐全',
  'achv.automation_dream.name': '自动化之梦',
  'achv.automation_dream.cond': '放置第一个洒水器',
  'achv.signed_papers.name': '职业认定',
  'achv.signed_papers.cond': '签署职业证书',
  'achv.farm_master.name': '农场大师',
  'achv.farm_master.cond': '达到农场 Lv10',
  'achv.mastery.name': '精通',
  'achv.mastery.cond': 'XP 达到 15,000',
  'achievement.page_hint': '第 {page}/{total} 页 · ↑↓ 翻页',

  // ---- villagers & AI quests (M4, ai-quests §6.4 settings / §6.2 dialogue / §3.5) ----
  'quest.settings.title': '村民与 AI 任务',
  'quest.settings.villagerTasks': '村民任务（关闭后村民只闲聊）',
  'quest.settings.aiGeneration': '允许 AI 根据我的工作出题',
  'quest.settings.aiGeneration.note':
    '说明：调用本机 claude CLI，消耗你的 Claude 额度；工作内容只在本机与你已有的 Claude 通道中处理。',
  'quest.settings.frequency': '出题间隔',
  'quest.settings.frequency.low': '偶尔（≥30 分钟，默认）',
  'quest.settings.frequency.normal': '常来（≥15 分钟）',
  'quest.settings.dailyBudget': '每日预算',
  'quest.settings.arrivalSound': '任务到达提示音',
  'quest.settings.notesLocation': '思考笔记位置',
  'quest.settings.aiHint': '想听新问题？允许 AI 根据你的工作出题',
  // dialogue chrome (§6.2)
  'quest.tag.decision': '任务 · 决策',
  'quest.tag.reflection': '任务 · 反思',
  'quest.footer.advance': 'E/点击 继续',
  'quest.footer.choose': '↑↓ 或 1~4 选择 · E 确认',
  'quest.footer.submit': 'Ctrl+Enter 提交',
  'quest.footer.skip': 'Tab 跳过',
  'quest.footer.dismiss': 'Esc 先不聊（任务保留）',
  'quest.footer.done': 'E 回去干活',
  'quest.reward.noteSaved': '✦ 思考笔记已存好',
  // settlement-screen 明日预告 line (§6.3) — {npc} 在 {place}，想听听你的想法
  'quest.settlement.pending': '🌾 {npc}在{place}，想听听你的想法',
  'quest.place.npc_carpenter': '木工台旁',
  'quest.place.npc_grocer': '杂货摊',
  'quest.place.npc_keeper': '水渠边',

  // ---- key help (GDD §6.8 condensed) ----
  'keys.title': '键位说明',
  'keys.body': [
    'WASD / 方向键 — 移动（Shift 奔跑）',
    'E / Enter / 鼠标左键 — 面朝格动作',
    'Tab / I — 背包    Esc — 暂停菜单',
    'B — 建造目录（M3）',
    '1~9 / 滚轮 — 选择快捷栏',
    'F — 出货箱内全部入箱',
    '背包：右键拿半堆/放 1 · Shift+左键快速移动',
    '商店：左键×1 · 右键×5 · Shift+左键整堆',
    '（M1 键位固定，暂不可改键）',
  ].join('\n'),
};

/** Look up a UI string; unknown keys echo back (visible in playtest, never throws). */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = STRINGS[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
