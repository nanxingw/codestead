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
  'toast.not_enough_gold': '金币不足',
  'toast.not_discardable': '这个不能丢弃',
  'toast.not_sellable': '这个不能出售',
  'toast.locked_entry': '尚未解锁',
  'toast.requires_copper': '需先购买铜档',
  'toast.already_owned': '已是最高档',
  'toast.overflow_summary': '还有 {n} 项新进展，详见日结算',
  'toast.save_failed': '存档写入失败——建议在设置中导出 JSON 备份',

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

  // ---- pause menu (GDD §6.7) ----
  'menu.title': '暂停',
  'menu.resume': '继续',
  'menu.save': '保存',
  'menu.saved': '已保存 ✓',
  'menu.settings': '设置',
  'menu.keys': '键位说明',
  'menu.main_menu': '回主菜单',

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
  'settings.quests_badge': 'M4 可用',
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
  'summary.level_up': '升到了 Lv {level}！',
  'summary.eta': '距 Lv {level} 还差 {xp} XP（约 {days} 天）',
  'summary.eta_keep_going': '继续耕作即可升级',
  'summary.tomorrow': '明天',
  'summary.tomorrow_rain': '☔ 明日有雨，自动浇水',
  'summary.tomorrow_crop_ready': '🌱 {crop}明天成熟！',
  'summary.tomorrow_crop_in': '🌱 {crop}还需 {days} 天',
  'summary.tomorrow_fallback': '商店有新鲜种子等你',
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

  // ---- key help (GDD §6.8 condensed) ----
  'keys.title': '键位说明',
  'keys.body': [
    'WASD / 方向键 — 移动（Shift 奔跑）',
    'E / Enter / 鼠标左键 — 面朝格动作',
    'Tab / I — 背包    Esc — 暂停菜单',
    '1~9 / 滚轮 — 选择快捷栏',
    'F — 出货箱内全部入箱',
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
