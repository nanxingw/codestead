/**
 * sim/types.ts — core state & event shapes of the headless simulation layer.
 *
 * Sources of truth: game-design.md §1.5 (MapMeta), §1.6 (Facing), §2.2 (TimeState),
 * §2.4 (pause sources), §2.5 (DaySummary), §3.1 (TileState/CropState), §3.8 (FarmAction),
 * §4.8 (EconomyState), §5.5 (ProgressionState), §6.1 (InventoryState/ToolTiers),
 * §12 (sim → render event list).
 *
 * Layer rules (README.md in this directory): zero Phaser, zero wall clock, deterministic.
 * Save-aligned shapes (TileState/CropState/ItemStack/...) come from @codestead/shared so
 * the runtime state and SaveDoc v1 can never drift apart.
 */
import type {
  CropState as SaveCropState,
  Facing,
  ItemStack,
  Profession,
  Season,
  TileState as SaveTileState,
  Weather,
} from '@codestead/shared';

import type { CropId } from './data/crops.js';
import type { ItemId } from './data/items.js';

export type { Facing, ItemStack, Profession, Season, Weather };

// ---- geometry ----

/** Tile coordinates: x right, y down, 0-based; tile = floor(worldPx / 16) (GDD §1.1). */
export interface TilePos {
  x: number;
  y: number;
}

/** Closed-interval tile rectangle (GDD §1.1 coordinate conventions). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sparse farm-tile key, `"x,y"` (GDD §3.1/§10.2). Build via tiles.ts tileKey(). */
export type TileKey = string;

// ---- farm tiles (GDD §3.1; shapes are save-aligned by construction) ----

/** Runtime CropState: identical to the save shape but with the narrowed CropId. */
export type CropState = Omit<SaveCropState, 'cropId'> & { cropId: CropId };
export type TileState = Omit<SaveTileState, 'crop'> & { crop: CropState | null };

type Extends<A, B> = A extends B ? true : never;
/* Compile-time contract checks: runtime shapes must stay assignable to SaveDoc shapes. */
type _CropStateIsSaveCompatible = Extends<CropState, SaveCropState>;
type _TileStateIsSaveCompatible = Extends<TileState, SaveTileState>;

// ---- time (GDD §2.2) ----

export interface TimeState {
  /** Absolute day, 1-based, never wraps. */
  day: number;
  /** Integer, 360..1320 (6:00..22:00). */
  minuteOfDay: number;
  /** 'sunny' on a new save (day 1 forced sunny). */
  weatherToday: Weather;
  /** Pre-rolled at night settlement; forecast is 100% accurate. */
  weatherTomorrow: Weather;
  /** Serialized sfc32 PRNG (32 hex chars); weather is the only consumer, at night (§2.2). */
  rngState: string;
}

/** Derived view, never saved (GDD §2.2): season/dayOfSeason/year/clock/phase. */
export interface TimeView {
  season: Season; // M1: always 'spring'
  dayOfSeason: number; // ((day - 1) % 28) + 1
  year: number;
  hh: number;
  mm: number; // floored to CLOCK_DISPLAY_STEP
  phase: 'dawn' | 'day' | 'golden' | 'dusk';
}

/**
 * Pause sources (GDD §2.4 table) — maintained by the DRIVER (render layer) as a Set;
 * non-empty set ⇒ timeScale = 0 and the sim is simply not ticked. Listed here because
 * both UIScene and the driver must share the exact vocabulary.
 */
export type PauseSource =
  | 'tab_hidden'
  | 'window_blur'
  | 'afk'
  | 'menu'
  | 'dialog'
  | 'day_summary'
  | 'boot_gate';

// ---- player / inventory / tools (GDD §1.6, §6.1) ----

/** Saved as tile coords + facing; restore snaps to tile center (GDD §1.6). */
export interface PlayerState {
  tileX: number;
  tileY: number;
  facing: Facing;
}

export interface InventoryState {
  /** Fixed length === capacity; null = empty slot. */
  slots: (ItemStack | null)[];
  capacity: 12 | 24;
  /** Hotbar selection, 0..8. */
  selected: number;
}

/** 1 wood / 2 copper / 3 gold; upgrades change tier only, itemId stays (GDD §3.5/§6.1). */
export interface ToolTiers {
  hoe: 1 | 2 | 3;
  wateringCan: 1 | 2 | 3;
}

// ---- economy (GDD §4.8) ----

export interface EconomyState {
  /** Non-negative int; new save 100; clamp at GOLD_CAP (GDD §4.1). */
  gold: number;
  /** Reversible during the day; settled & cleared at night; HOLDING may be saved. */
  shippingBin: ItemStack[];
  /** itemId → first-sold day; recorded from M1, collection UI in M3. */
  collectionLog: Record<string, { firstSoldDay: number }>;
  /** NEW badge bookkeeping: shop entryId → game day it was first shown (cleared next day). */
  newEntriesSeenDay: Record<string, number>;
}

// ---- progression (GDD §5.5/§5.6) ----

/**
 * Counter vocabulary (GDD §5.6). Dynamic ids use the documented `<prefix>:<id>` form.
 * `harvestedCrops:<cropId>` is a sim-internal extension beyond the §5.6 list: it is the
 * persistence source for SaveProgress.stats.harvestsByCrop (GDD §10.2), which has no
 * other runtime carrier (recorded as apiDrift in the M1 workflow).
 */
export type CounterId =
  | 'tillCount'
  | 'plantCount'
  | 'harvestCount'
  | 'waterCount'
  | 'sellCount'
  | 'goldEarned'
  | `soldCrops:${string}`
  | `harvestedCrops:${string}`
  | 'sleepCount'
  | 'rainDaysSeen'
  | 'toolUpgrades'
  | 'regrowChainMax'
  | 'buildingsBuilt'
  | `built:${string}`
  | 'sprinklersPlaced'
  | 'questsCompleted'
  | 'notesWritten';

export interface ProgressionState {
  /** 0..XP_CAP, monotonic. Level is ALWAYS derived (levelForXp), never stored. */
  xp: number;
  profession: Profession | null;
  counters: Partial<Record<CounterId, number>>;
  achievements: string[]; // append-only; M1-core: counters only, no unlock logic
  /** Daily XP for the last ≤3 days (ETA on the day-summary screen). */
  xpHistory: number[];
}

// ---- pickups (GDD §1.3 / §2.5 #6) ----

export type PickupKind = 'wood' | 'stone' | 'wildflower';

/** Daily forage spot; refreshed (overwritten) every night, zero-loss semantics. */
export interface PickupState {
  spotId: string;
  kind: PickupKind;
  /** Whether the spot still holds today's pickup. */
  available: boolean;
}

// ---- world / root state ----

export interface FarmState {
  /** Sparse: only tilled tiles exist (GDD §3.1). */
  tiles: Record<TileKey, TileState>;
  /** Zone ids of unlocked fields (field_a always; field_b @Lv3; field_c @Lv5; §1.4). */
  unlockedZones: string[];
}

/** Root sim state — everything that is simulated and (modulo derivation) saved. */
export interface WorldState {
  time: TimeState;
  player: PlayerState;
  farm: FarmState;
  inventory: InventoryState;
  tools: ToolTiers;
  economy: EconomyState;
  progress: ProgressionState;
  pickups: PickupState[];
  /** Per-day log consumed by NightUpdate #10 buildSummary, cleared nightly (GDD §2.5). */
  dayLog: DayLogEntry[];
}

/** TODO(M1 time implementer): refine the day-log vocabulary as buildSummary needs it. */
export type DayLogEntry =
  | { kind: 'harvested'; cropId: CropId; count: number }
  | { kind: 'xpGained'; amount: number }
  | { kind: 'levelUp'; level: number };

// ---- map meta (GDD §1.5 build-time contract; sim only imports the generated JSON) ----

export interface MapMeta {
  width: 64;
  height: 48;
  /** Field A/B/C rects, 180 tiles total. */
  tillable: Rect[];
  unlockGroups: { zoneId: string; farmLevel: number; rects: Rect[] }[];
  waterSources: TilePos[];
  spawn: { tile: TilePos; facing: Facing };
  interactables: { id: string; kind: string; tiles: TilePos[] }[];
  pickupSpots: { id: string; kind: PickupKind; tile: TilePos }[];
  buildPlots: { id: string; rect: Rect }[]; // M3
  npcAnchors: { id: string; tile: TilePos }[]; // M4
}

// ---- actions & queries (GDD §1.7, §3.8) ----

/** Farm actions; range tools are expanded to tile lists BEFORE entering the sim (§3.8). */
export type FarmAction =
  | { kind: 'till'; tiles: TilePos[] }
  | { kind: 'water'; tiles: TilePos[] }
  | { kind: 'plant'; tile: TilePos; cropId: CropId }
  | { kind: 'harvest'; tile: TilePos }
  | { kind: 'clear'; tile: TilePos }; // sickle

export type ActionVerb = 'till' | 'sow' | 'water' | 'harvest' | 'sell' | 'talk' | 'none';

/** Result of queryAction — pure, called every frame by the tile cursor (GDD §1.7). */
export interface ActionQuery {
  valid: boolean;
  verb: ActionVerb;
}

/**
 * Commands accepted by the SimApi facade. Keyboard E and mouse click MUST converge into
 * the same 'interact' command (GDD §1.7 key/mouse equivalence — unit-tested as command
 * sequence equality). Fixed interactables (door/shop/bin) are routed by the scene layer
 * via their `kind`, then arrive here as the explicit commands below.
 */
export type SimCommand =
  /** itemId === null = bare hand (empty hotbar slot): mature-crop harvest only (§3.5). */
  | { type: 'interact'; tile: TilePos; itemId: ItemId | null }
  | { type: 'selectSlot'; slot: number } // 0..8
  | { type: 'moveItem'; from: number; to: number }
  | { type: 'discardItem'; slot: number } // trash can; destroy (GDD §6.3)
  | { type: 'depositToBin'; slot: number; count: number }
  | { type: 'withdrawFromBin'; index: number; count: number }
  | { type: 'depositAllToBin' } // [F] ship-all (GDD §4.2)
  | { type: 'buyShopEntry'; entryId: string; requested: number }
  | { type: 'refundSeeds'; slot: number; count: number } // 100% refund (ruling A-11)
  | { type: 'pickup'; spotId: string }
  | { type: 'sleep' }; // house-door manual sleep (ruling A-20); same NightUpdate as 22:00

// ---- sim → render events (GDD §12 contract; render/audio subscribe, never call back) ----

export type SimEvent =
  | { type: 'TileTilled'; tile: TilePos }
  | { type: 'CropPlanted'; tile: TilePos; cropId: CropId }
  | { type: 'CropWatered'; tiles: TilePos[] }
  | { type: 'CropHarvested'; tile: TilePos; cropId: CropId; count: number; xp: number }
  | { type: 'ItemPicked'; itemId: ItemId; count: number }
  | { type: 'ItemSold'; itemId: ItemId; count: number; gold: number }
  | { type: 'GoldChanged'; gold: number; delta: number }
  | { type: 'FarmLevelUp'; level: number; tilledCap: number }
  | { type: 'DayStarted'; day: number; weather: Weather }
  | { type: 'DayEnded'; summary: DaySummary }
  | { type: 'WeatherChanged'; weather: Weather }
  | { type: 'SimPaused' }
  | { type: 'SimResumed' }
  | { type: 'tileChanged'; tile: TilePos; state: TileState | null }
  | { type: 'zoneUnlocked'; zoneId: string };

// ---- night settlement summary (GDD §2.5) ----

export type TomorrowItem =
  | { kind: 'rain' }
  | { kind: 'cropReady'; cropId: CropId; inDays: number }
  | { kind: 'construction'; buildingId: string; inDays: number } // M3
  | { kind: 'seasonEnd'; inDays: number } // M3
  /** Fixed fallback so the promise list is NEVER empty (§2.5 「商店有新鲜种子等你」).
   * Additive extension beyond the GDD §2.5 union — recorded as apiDrift. */
  | { kind: 'shopTeaser' };

export interface DaySummary {
  day: number;
  season: Season;
  dayOfSeason: number;
  year: number;
  harvested: { cropId: CropId; count: number }[];
  shipped: { cropId: CropId; count: number; gold: number }[];
  goldEarned: number;
  /** MUST equal the gold persisted by autosave (settlement before autosave, GDD §2.5). */
  goldBalance: number;
  xpGained: number;
  levelUps: number[];
  /** ≤3 items, ascending by inDays; NEVER empty — fall back to the shop teaser (§2.5). */
  tomorrow: TomorrowItem[];
  weatherNext: Weather;
}
