/**
 * data/buildings.ts — blueprint authority table, transcribed line-by-line from
 * game-design.md §8.2 (12 facilities) with §8.3 (refund/demolish/move rules) and
 * §5.2/§5.3 (completion XP, unlock levels) baked into the fields.
 *
 * The 12 facilities (§8.2 = 3 buildings + 2 farmhouse upgrades + 2 stations +
 * 5 decorations; "建筑 3 种" counts coop/workshop/greenhouse only — appendix B-6):
 *   buildings   coop · workshop · greenhouse           (2 build nights, limit 1 each)
 *   upgrades    farmhouse_1 · farmhouse_2              (2 build nights, fixed placement)
 *   stations    storage_chest · drying_rack            (instant, limit 4 each)
 *   decorations fence · stone_path · flower_bed · bench · lamp_post (instant, no limit)
 *
 * Extra blueprints OUTSIDE the 12 (each annotated at its entry):
 *   sprinkler · sprinkler_advanced  — farming devices reusing the placement pipeline
 *     (GDD §3.8/§5.3). ⚠ Costs are NOT in the §8.2 table (PRD 04 待裁决 2): the values
 *     here are PROVISIONAL-CONSERVATIVE placeholders chosen by the M3 contract pass
 *     (priced against Lv6+ daily net 350~600g so automation is an investment, not a
 *     freebie) and MUST be backfilled into GDD §8.2 before ship.
 *   memorial_statue — the Lv10 unlock / achievement #21 reward given physical form
 *     (PRD 02 deferred "item form to M3"); free, limit 1. PROVISIONAL pending GDD entry.
 *
 * Naming: building/station ids are verbatim from §8.2; decorations have no ids in the
 * GDD (Chinese names only) — the snake_case ids here are coined by this contract pass
 * and recorded as an open question for GDD backfill. `built:<id>` counters (§5.6) use
 * these ids; achievement #16 expects exactly coop/workshop/greenhouse.
 *
 * Layer rules: pure data, zero Phaser, no wall clock. Doc-first: amend the GDD before
 * changing any number here (single-source discipline, PRD 01 US111).
 */

export type BlueprintCategory = 'building' | 'station' | 'decoration';

/** GDD §8.4 BlueprintDef, zod-free sim-side shape (save carries instances, not defs). */
export interface BlueprintDef {
  readonly id: string;
  /** i18n key, `blueprint.<id>`. */
  readonly nameKey: string;
  readonly category: BlueprintCategory;
  /** Footprint in tiles. */
  readonly size: { readonly w: number; readonly h: number };
  /** Door tile relative to origin — buildings only (canPlace rule ⑥ needs it). */
  readonly doorOffset?: { readonly x: number; readonly y: number };
  readonly cost: { readonly gold: number; readonly wood?: number; readonly stone?: number };
  /** Settlement nights to complete; buildings/upgrades = 2, everything else 0 (§8.2). */
  readonly buildDays: number;
  readonly unlock: { readonly farmLevel: number; readonly requires?: readonly string[] };
  /** Max simultaneous instances; undefined = unlimited (§8.2). */
  readonly limit?: number;
  readonly movable: boolean;
  readonly demolishable: boolean;
  /** §8.3 demolish table: deco/station/site 1.0; building (built) 0.5; farmhouse n/a 0. */
  readonly refundRate: number;
  readonly interiorMapId?: string;
  /**
   * Contract extension over §8.4 (documented deviation): 'plot' = world placement via
   * PLACING; 'farmhouse' = upgrade applied to the fixed farmhouse, skips PLACING and
   * goes straight to CONFIRM (§8.2 升级链 — the farmhouse is map-fixed, §8.3).
   */
  readonly placement: 'plot' | 'farmhouse';
  /** ⚠ true ⇒ cost/values are provisional placeholders awaiting GDD backfill. */
  readonly provisional?: true;
}

// ---- large buildings (§8.2 table 1: 2 build nights, limit 1 each) ----

const BUILDINGS: readonly BlueprintDef[] = [
  {
    id: 'coop',
    nameKey: 'blueprint.coop',
    category: 'building',
    size: { w: 4, h: 3 },
    doorOffset: { x: 1, y: 2 }, // door on the south face; exact tile is render-checked
    cost: { gold: 2_000, wood: 150 }, // equivalent 2,750g
    buildDays: 2,
    unlock: { farmLevel: 6 }, // ruling A-7
    limit: 1,
    movable: true,
    demolishable: true,
    refundRate: 0.5,
    interiorMapId: 'coop_interior', // 8×6, 4 roosts + egg spot (§8.3)
    placement: 'plot',
  },
  {
    id: 'workshop',
    nameKey: 'blueprint.workshop',
    category: 'building',
    size: { w: 5, h: 3 },
    doorOffset: { x: 2, y: 2 },
    cost: { gold: 6_000, wood: 200, stone: 100 }, // equivalent 7,500g (ruling A-12 note)
    buildDays: 2,
    unlock: { farmLevel: 7 },
    limit: 1,
    movable: true,
    demolishable: true,
    refundRate: 0.5,
    interiorMapId: 'workshop_interior', // 10×6, 6 processing slots
    placement: 'plot',
  },
  {
    id: 'greenhouse',
    nameKey: 'blueprint.greenhouse',
    category: 'building',
    size: { w: 6, h: 5 },
    doorOffset: { x: 2, y: 4 },
    cost: { gold: 15_000, wood: 300, stone: 300 }, // equivalent 18,000g
    buildDays: 2,
    unlock: { farmLevel: 9 },
    limit: 1,
    movable: true,
    demolishable: true,
    refundRate: 0.5,
    interiorMapId: 'greenhouse_interior', // 12×10, central 24 plots, season-免疫 (§8.2)
    placement: 'plot',
  },
];

// ---- farmhouse upgrade chain (§8.2 table 2: fixed placement, not demolishable §8.3) ----

const FARMHOUSE_UPGRADES: readonly BlueprintDef[] = [
  {
    id: 'farmhouse_1',
    nameKey: 'blueprint.farmhouse_1',
    category: 'building',
    size: { w: 8, h: 6 }, // the map-fixed farmhouse footprint (§1.3)
    cost: { gold: 4_000, wood: 200 },
    buildDays: 2,
    unlock: { farmLevel: 6 },
    limit: 1,
    movable: false,
    demolishable: false, // 不可拆不可降级 — never listed in the demolish catalog (§8.3)
    refundRate: 0,
    interiorMapId: 'farmhouse_1', // 12×10 (§8.3 interior list)
    placement: 'farmhouse',
  },
  {
    id: 'farmhouse_2',
    nameKey: 'blueprint.farmhouse_2',
    category: 'building',
    size: { w: 8, h: 6 },
    cost: { gold: 20_000, stone: 300, wood: 100 },
    buildDays: 2,
    unlock: { farmLevel: 10, requires: ['farmhouse_1'] }, // Lv10 且已完成 I (§8.2)
    limit: 1,
    movable: false,
    demolishable: false,
    refundRate: 0,
    interiorMapId: 'farmhouse_2', // 16×12 incl. study = M4 note-display interface (§8.2)
    placement: 'farmhouse',
  },
];

// ---- stations (§8.2 table 3: instant, limit 4, refund 100% §8.3) ----

const STATIONS: readonly BlueprintDef[] = [
  {
    id: 'storage_chest',
    nameKey: 'blueprint.storage_chest',
    category: 'station',
    size: { w: 1, h: 1 },
    cost: { gold: 200, wood: 30 },
    buildDays: 0,
    unlock: { farmLevel: 3 },
    limit: 4,
    movable: true, // contents travel with the chest (§8.2)
    demolishable: true, // only when empty (§8.3 — enforced by the demolish reducer)
    refundRate: 1.0,
    placement: 'plot',
  },
  {
    id: 'drying_rack',
    nameKey: 'blueprint.drying_rack',
    category: 'station',
    size: { w: 2, h: 1 },
    cost: { gold: 500, wood: 40 },
    buildDays: 0,
    unlock: { farmLevel: 4 },
    limit: 4,
    movable: true,
    demolishable: true, // in-progress goods return to inventory; reject if full (§8.3)
    refundRate: 1.0,
    placement: 'plot',
  },
];

// ---- decorations (§8.2 table 4: instant, unlimited, refund 100% no dialog §8.3) ----
// ids coined here (GDD names them in Chinese only) — open question for backfill.

const DECORATIONS: readonly BlueprintDef[] = [
  {
    id: 'fence',
    nameKey: 'blueprint.fence', // 木栅栏: auto-tile, never decays (§8.2)
    category: 'decoration',
    size: { w: 1, h: 1 },
    cost: { gold: 0, wood: 1 },
    buildDays: 0,
    unlock: { farmLevel: 3 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
  },
  {
    id: 'stone_path',
    nameKey: 'blueprint.stone_path', // 石径: +10% move speed; never on farmland (§8.2/§8.3)
    category: 'decoration',
    size: { w: 1, h: 1 },
    cost: { gold: 0, stone: 1 },
    buildDays: 0,
    unlock: { farmLevel: 3 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
  },
  {
    id: 'flower_bed',
    nameKey: 'blueprint.flower_bed',
    category: 'decoration',
    size: { w: 1, h: 1 },
    cost: { gold: 150, wood: 10 },
    buildDays: 0,
    unlock: { farmLevel: 4 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
  },
  {
    id: 'bench',
    nameKey: 'blueprint.bench', // E to sit & idle — the "waiting room" easter egg (§8.2)
    category: 'decoration',
    size: { w: 2, h: 1 },
    cost: { gold: 250, wood: 20 },
    buildDays: 0,
    unlock: { farmLevel: 4 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
  },
  {
    id: 'lamp_post',
    nameKey: 'blueprint.lamp_post', // auto-lit 18:00~22:00 (§8.2)
    category: 'decoration',
    size: { w: 1, h: 1 },
    cost: { gold: 300, wood: 10 },
    buildDays: 0,
    unlock: { farmLevel: 4 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
  },
];

// ---- outside the 12: sprinklers (§3.8/§5.3) & memorial statue (#21 reward) ----

const EXTRAS: readonly BlueprintDef[] = [
  {
    id: 'sprinkler',
    nameKey: 'blueprint.sprinkler', // wets the 4 orthogonal neighbours at 6:00 (§3.8)
    category: 'station',
    size: { w: 1, h: 1 },
    // ⚠ PROVISIONAL (PRD 04 待裁决 2): no cost in GDD §8.2 — conservative placeholder,
    // backfill the GDD then update here + buildings-data.test.ts in the same commit.
    cost: { gold: 500, stone: 20 },
    buildDays: 0,
    unlock: { farmLevel: 6 }, // §5.3 Lv6 洒水器配方
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
    provisional: true,
  },
  {
    id: 'sprinkler_advanced',
    nameKey: 'blueprint.sprinkler_advanced', // 3×3 coverage (§5.3 Lv8)
    category: 'station',
    size: { w: 1, h: 1 },
    // ⚠ PROVISIONAL — same note as `sprinkler`.
    cost: { gold: 2_000, stone: 60 },
    buildDays: 0,
    unlock: { farmLevel: 8 },
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
    provisional: true,
  },
  {
    id: 'memorial_statue',
    nameKey: 'blueprint.memorial_statue', // Lv10 / achievement #21 (§5.3/§5.6)
    category: 'decoration',
    size: { w: 1, h: 1 },
    cost: { gold: 0 },
    buildDays: 0,
    unlock: { farmLevel: 10 },
    limit: 1,
    movable: true,
    demolishable: true,
    refundRate: 1.0,
    placement: 'plot',
    provisional: true, // physical form deferred from PRD 02; GDD entry pending
  },
];

// ---- exports ----

/** Every placeable/orderable blueprint this build knows (12 facilities + extras). */
export const BLUEPRINTS: readonly BlueprintDef[] = [
  ...BUILDINGS,
  ...FARMHOUSE_UPGRADES,
  ...STATIONS,
  ...DECORATIONS,
  ...EXTRAS,
];

export const BLUEPRINTS_BY_ID: ReadonlyMap<string, BlueprintDef> = new Map(
  BLUEPRINTS.map((b) => [b.id, b]),
);

export function getBlueprint(defId: string): BlueprintDef {
  const def = BLUEPRINTS_BY_ID.get(defId);
  if (!def) throw new Error(`Unknown blueprint defId: ${defId}`);
  return def;
}

/** The §8.2 "12 种设施" roster, in table order (asserted by buildings-data.test.ts). */
export const CORE_FACILITY_IDS = [
  'coop',
  'workshop',
  'greenhouse',
  'farmhouse_1',
  'farmhouse_2',
  'storage_chest',
  'drying_rack',
  'fence',
  'stone_path',
  'flower_bed',
  'bench',
  'lamp_post',
] as const;

/** "建筑 3 种" in the constitution counts exactly these (appendix B-6; achievement #16). */
export const LARGE_BUILDING_IDS = ['coop', 'workshop', 'greenhouse'] as const;

/** Completion XP, paid ONCE at the finish event; ordering/placement give 0 XP (§5.2/§8.5). */
export const CONSTRUCTION_XP: Readonly<Record<(typeof LARGE_BUILDING_IDS)[number], number>> = {
  coop: 150,
  workshop: 300,
  greenhouse: 500,
};

// ---- coop economics (§8.2 row 1; rulings A-6/A-7) ----

export const COOP = {
  /** Hens granted free at completion. */
  STARTING_HENS: 2,
  MAX_HENS: 4,
  HEN_BUY_PRICE: 200, // ruling A-6
  HEN_SELL_PRICE: 100, // ruling A-6
  /** Eggs per hen per settlement night (NightUpdate #5). */
  EGGS_PER_HEN_PER_NIGHT: 1,
} as const;

// ---- processing recipes (§8.2 workshop/drying rack; ruling A-12 floor discipline) ----

export const PROCESSING = {
  /** Jam: any crop ×1 → 2 settlement nights → floor(2 × crop sellPrice + 25). */
  JAM: { days: 2, price: (cropSellPrice: number) => Math.floor(2 * cropSellPrice + 25) },
  /** Mayonnaise: 1 egg → 1 settlement night → flat 95g. */
  MAYONNAISE: { days: 1, price: 95 },
  /** Dried goods: any crop ×1 → 1 settlement night → floor(1.4 × sellPrice) (A-12). */
  DRIED: { days: 1, price: (cropSellPrice: number) => Math.floor(1.4 * cropSellPrice) },
} as const;

// ---- materials (§8.1) ----

/** Shop buy-in floor so "missing a few materials" can never soft-lock progress (§8.1). */
export const MATERIAL_SHOP_BUY_PRICE = { wood: 5, stone: 5 } as const;

/** Axe/pickaxe yields from map resource nodes (§8.1). */
export const RESOURCE_YIELD = { treeWood: 5, boulderStone: 3 } as const;

/** M3 daily edge regrowth (per settlement night, never wall clock — §8.1/§2.5 #6). */
export const DAILY_MATERIAL_REGEN_M3 = { wood: 10, stone: 6 } as const;

// ---- QoL (§6.2) ----

/** Backpack 12 → 24 slots; instant, level-independent, indexes preserved (§6.2/§6.9). */
export const INVENTORY_EXPANSION_PRICE = 1_000;
