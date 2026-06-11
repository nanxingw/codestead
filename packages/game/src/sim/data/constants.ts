/**
 * sim constants — every load-bearing number, transcribed from game-design.md with the
 * owning section cited. Other modules MUST reference these, never re-declare values
 * (PRD 01 US111). Doc-first rule: amend the GDD before changing anything here.
 *
 * Note: GDD §2.1 names `sim/time/constants.ts` as the home of the time table; this
 * project keeps a single constants module at sim/data/constants.ts (M1 contract ruling) —
 * the values and names below are verbatim from the §2.1 table.
 */
import type { CropId } from './crops.js';

// ---- time (GDD §2.1 core table) ----

export const TIME = {
  /** 1 game minute = 187.5ms real (10 game minutes = 1.875s). */
  REAL_MS_PER_GAME_MINUTE: 187.5,
  /** Day runs 6:00 → 22:00 auto-sleep. */
  DAY_START_MINUTE: 360,
  DAY_END_MINUTE: 1320,
  /** 16 game hours = 180 real seconds. */
  GAME_MINUTES_PER_DAY: 960,
  /** Clock display ticks every 10 game minutes (1.875s real). */
  CLOCK_DISPLAY_STEP: 10,
  DAYS_PER_SEASON: 28,
  DAYS_PER_YEAR: 112,
  /** Rolled once per night at settlement (ruling A-4). Summer/fall are M3 proposals. */
  RAIN_PROBABILITY: { spring: 0.2 },
  /** Only day 1 is forced sunny (watering tutorial guard). */
  RAIN_FORCED_SUNNY_DAYS: [1],
  /** ≤2 consecutive rain days; the 3rd is forced sunny. */
  RAIN_MAX_CONSECUTIVE: 2,
  /** 90s without input → soft pause (driver layer). */
  AFK_PAUSE_AFTER_MS: 90_000,
  /** Max ms consumed per frame; larger deltas are dropped. */
  ACCUMULATOR_CLAMP_MS: 250,
  /** Debounce for blur/hidden-triggered autosave. */
  AUTOSAVE_DEBOUNCE_MS: 5_000,
  /** Sleep / wake fades (presentation only; ruling A-18). */
  NIGHT_FADE_OUT_MS: 600,
  NIGHT_FADE_IN_MS: 400,
  /** 21:30 — clock turns amber (no popup, no countdown). */
  CLOCK_AMBER_FROM_MINUTE: 1290,
} as const;

// ---- world / tilling (GDD §1.4) ----

/**
 * Global tilled-tile cap by farm level (sim-side track of the dual-track unlock).
 * Intermediate levels inherit the previous bracket. Decorations/buildings don't count.
 */
export const TILLED_CAP_BY_LEVEL: readonly { level: number; cap: number }[] = [
  { level: 1, cap: 12 },
  { level: 3, cap: 18 },
  { level: 5, cap: 24 },
  { level: 7, cap: 32 }, // M3
  { level: 9, cap: 42 }, // M3
];

/** Fallback spawn (27,11) facing down (GDD §1.1); farm-map-meta.json is the authority (§1.5). */
export const DEFAULT_SPAWN = { tile: { x: 27, y: 11 }, facing: 'down' } as const;

// ---- player movement & action timing (GDD §1.6, ruling A-16; consumed by scene layer) ----

export const MOVEMENT = {
  WALK_SPEED_PX_PER_S: 72, // 4.5 tiles/s
  RUN_SPEED_PX_PER_S: 120, // 7.5 tiles/s, hold Shift
  COLLIDER: { width: 12, height: 8, offsetX: 2, offsetY: 8 }, // foot-aligned AABB
  CORNER_FORGIVENESS_PX: 3,
} as const;

export const ACTION_TIMING = {
  TOOL_LOCK_MS: 250, // 0ms windup → 120ms effect → 250ms recovery
  HARVEST_LOCK_MS: 200, // bare-hand harvest
  EFFECT_AT_MS: 120,
  INPUT_BUFFER_MS: 150, // queue exactly 1 follow-up action
  HOLD_THRESHOLD_MS: 400,
  HOLD_REPEAT_MS: 280, // wood-tier hold-to-repeat; invalid targets skip without resetting beat
} as const;

// ---- economy (GDD §4.1 / §4.7 / §3.5) ----

export const ECONOMY = {
  STARTING_GOLD: 100,
  GOLD_CAP: 9_999_999, // clamp, never overflow
  /** Tool upgrade prices (GDD §3.5/§4.3): copper @Lv2, gold @Lv4; instant effect. */
  TOOL_UPGRADE_PRICE: { copper: 350, gold: 2_650 },
} as const;

/** Daily pickup refresh quantities (GDD §1.3 / §2.5 #6). */
export const DAILY_PICKUPS = { wood: 6, stone: 4, wildflower: 3 } as const;

/** Soft-lock relief ("邻居的救济", GDD §4.8): morning check threshold & grant. */
export const RELIEF = { GOLD_BELOW: 10, GRANT_SEEDS: 4, GRANT_CROP: 'radish_quick' } as const;

// ---- progression (GDD §5.1 / §5.2) ----

/** Cumulative XP needed to REACH Lv(index+1); new save = Lv1 / 0 XP (ruling B-1). */
export const XP_THRESHOLDS = [0, 100, 380, 770, 1_300, 2_150, 3_300, 4_800, 6_900, 10_000] as const;
export const XP_CAP = 15_000; // mastery bar hard cap
export const M1_LEVEL_CAP = 5; // effectiveLevel = min(levelForXp(xp), 5); XP keeps accruing

/** Planting XP per plant; regrow crops grant it on first planting only (GDD §5.2). */
export const XP_PLANT = 5;

// ---- shop catalog, M1 authoritative table (GDD §4.3) ----

export interface ShopEntryDef {
  readonly entryId: string; // seeds: identical to itemId (prefix discipline, A-14)
  readonly kind: 'seed' | 'tool_upgrade';
  readonly nameKey: string;
  readonly price: number;
  readonly unlockLevel: number;
  readonly oneTime: boolean;
  /** Prerequisite entryId (gold tools require copper first). */
  readonly requires?: string;
  /** For seed entries: the crop granted. For tool upgrades: which tool/tier (see ids). */
  readonly cropId?: CropId;
}

export const SHOP_CATALOG_M1: readonly ShopEntryDef[] = [
  {
    entryId: 'seed_radish_quick',
    kind: 'seed',
    nameKey: 'shop.seed_radish_quick',
    price: 10,
    unlockLevel: 1,
    oneTime: false,
    cropId: 'radish_quick',
  },
  {
    entryId: 'seed_turnip',
    kind: 'seed',
    nameKey: 'shop.seed_turnip',
    price: 20,
    unlockLevel: 1,
    oneTime: false,
    cropId: 'turnip',
  },
  {
    entryId: 'seed_potato',
    kind: 'seed',
    nameKey: 'shop.seed_potato',
    price: 50,
    unlockLevel: 2,
    oneTime: false,
    cropId: 'potato',
  },
  {
    entryId: 'seed_bean_vine',
    kind: 'seed',
    nameKey: 'shop.seed_bean_vine',
    price: 60,
    unlockLevel: 3,
    oneTime: false,
    cropId: 'bean_vine',
  },
  {
    entryId: 'seed_cabbage',
    kind: 'seed',
    nameKey: 'shop.seed_cabbage',
    price: 80,
    unlockLevel: 4,
    oneTime: false,
    cropId: 'cabbage',
  },
  {
    entryId: 'seed_berry',
    kind: 'seed',
    nameKey: 'shop.seed_berry',
    price: 100,
    unlockLevel: 5,
    oneTime: false,
    cropId: 'berry',
  },
  {
    entryId: 'tool_hoe_copper',
    kind: 'tool_upgrade',
    nameKey: 'shop.tool_hoe_copper',
    price: 350,
    unlockLevel: 2,
    oneTime: true,
  },
  {
    entryId: 'tool_can_copper',
    kind: 'tool_upgrade',
    nameKey: 'shop.tool_can_copper',
    price: 350,
    unlockLevel: 2,
    oneTime: true,
  },
  {
    entryId: 'tool_hoe_gold',
    kind: 'tool_upgrade',
    nameKey: 'shop.tool_hoe_gold',
    price: 2_650,
    unlockLevel: 4,
    oneTime: true,
    requires: 'tool_hoe_copper',
  },
  {
    entryId: 'tool_can_gold',
    kind: 'tool_upgrade',
    nameKey: 'shop.tool_can_gold',
    price: 2_650,
    unlockLevel: 4,
    oneTime: true,
    requires: 'tool_can_copper',
  },
];
// M3 additions (backpack 1,000g / wood 5g / stone 5g / chicken 200g / blueprints) are
// frozen in GDD §4.3 but intentionally NOT in this M1 table.

// ---- inventory (GDD §6.2) ----

export const INVENTORY = {
  M1_CAPACITY: 12,
  HOTBAR_SIZE: 9, // slots 0..8
} as const;
