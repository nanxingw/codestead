/**
 * building.ts — building subsystem (M3, GDD §8; PRD 04 §A~§D, §N73).
 *
 * Implements the M3 contract pass: canPlace six rules (§8.3), placement / demolish /
 * relocation reducers with the §8.3 refund table, the farmhouse upgrade chain (§8.2),
 * nightly construction & processing progression (NightUpdate #4, §8.4 order
 * 工地 → 烘干 → 加工), chest storage, greenhouse interior plots, sprinklers and the
 * import sanitiser (§8.5 / PRD 04 US70).
 *
 * Everything here is sim-pure: zero Phaser, zero wall clock, advancement only by
 * settlement nights (zero-anxiety red line — leaving never worsens anything).
 *
 * Module map (GDD §8.4 / PRD 04 implementation decisions):
 *   - blueprint constants ........ data/buildings.ts (12 facilities + extras)
 *   - canPlace (6 rules) ......... here, pure, per-tile violation reporting (§8.3)
 *   - place / demolish / move .... here, reducers over WorldState (§8.3 tables)
 *   - construction & processing .. here, called from NightUpdate #4 in the §8.4 order
 *                                  工地 → 烘干 → 加工 (→ 产蛋 in coop.ts, #5)
 *   - egg production / hens ...... coop.ts (NightUpdate #5; rulings A-6/A-7)
 *   - BuildModeState ............. here (UI-layer machine, NEVER saved — §8.4)
 *   - import sanitiser ........... here (illegal footprints reclaimed + 100% refund,
 *                                  never silently deleted — §8.5 / PRD 04 US70)
 *
 * Implementation notes recorded as apiDrift in the M3 workflow output:
 *   - CanPlaceOptions gained optional `map` + `isBuildable` — rule ② (buildable) needs
 *     the map/tilemap contract (same drift pattern as farming.ts applyAction's trailing
 *     MapMeta). The bundled farm-map-meta.json is the DEFAULT map (the sim "only
 *     imports the generated JSON", types.ts §1.5 note); `isBuildable` lets the render
 *     layer refine rule ② with real tilemap collision;
 *   - reducers gained a trailing optional `opts?: CanPlaceOptions` so the commit-time
 *     canPlace re-check sees the same context as the ghost preview.
 *
 * NOTE on import cycles: this module joins the documented benign cycle family
 * (tiles↔leveling, leveling↔profession): tiles.ts reads greenhousePlotKeys from here
 * at call time; we read tiles.tileKey / economy.credit/debit at call time. No value is
 * touched during module evaluation.
 */
import type { FarmhouseState, PlacedStructure, Sprinkler, StructureData } from '@codestead/shared';

import {
  BLUEPRINTS_BY_ID,
  CONSTRUCTION_XP,
  COOP,
  getBlueprint,
  LARGE_BUILDING_IDS,
  MATERIAL_SHOP_BUY_PRICE,
  PROCESSING,
} from './data/buildings.js';
import type { BlueprintDef } from './data/buildings.js';
import farmMapMeta from './data/farm-map-meta.json';
import { driedItemId, ITEMS_BY_ID, jamItemId } from './data/items.js';
import type { ItemId } from './data/items.js';
import { credit, debit } from './economy.js';
import { addInPlace, removeAtInPlace, removeItemInPlace } from './inventory.js';
import { bumpCounterInPlace, effectiveLevel, grantXpInPlace } from './leveling.js';
import { tileKey } from './tiles.js';
import type {
  InventoryState,
  ItemStack,
  MapMeta,
  Rect,
  SimEvent,
  TileKey,
  TilePos,
  WorldState,
} from './types.js';

export type { PlacedStructure, Sprinkler, StructureData };

// ---- build-mode state machine (UI-layer carrier; GDD §8.3 diagram, PRD 04 §A) ----
//
// CLOSED ─B/Esc菜单→建造─► CATALOG (menu, tick stopped)
// CATALOG ─pick blueprint / move target─► PLACING (world, time flows; ghost preview)
// PLACING ─E/click ∧ canPlace─► building/upgrade → CONFIRM (dialog, tick stopped)
//                               station/decoration → commit & STAY in PLACING (§8.3)
// CONFIRM ─confirm─► committed (charge gold+materials → site or instant entity)
// Any state: Esc/right-click backs out; 22:00 force-exits PLACING (uncommitted = free).
//
// INVARIANT: BuildModeState is transient UI state and never enters the SaveDoc (§8.4).

export type BuildModeState =
  | { mode: 'CLOSED' }
  | {
      mode: 'CATALOG';
      /** Catalog tabs: blueprints | move | demolish (§8.3 目录页). */
      tab: 'blueprints' | 'move' | 'demolish';
      cursorDefId: string | null;
    }
  | {
      mode: 'PLACING';
      /** Placing a new blueprint... */
      defId: string;
      /** ...or relocating an existing instance (move is free & instant, §8.3). */
      movingInstanceId: string | null;
      /** Ghost anchor under the cursor (origin tile of the footprint). */
      origin: TilePos;
    }
  | {
      mode: 'CONFIRM';
      /** Large buildings & farmhouse upgrades only (cost + build time + balance recheck). */
      defId: string;
      origin: TilePos | null; // null for farmhouse upgrades (fixed placement)
    };

// ---- shared geometry / lookup helpers ----

/** Map bounds (GDD §1.1, same constants as tiles.ts/save schema). */
const MAP_WIDTH = 64;
const MAP_HEIGHT = 48;

/**
 * Map-fixed farmhouse footprint (GDD §1.3: 农舍 (24..31, 4..9), 8×6). MapMeta carries
 * no farmhouse rect yet — recorded as an open question for the map-export contract.
 */
export const FARMHOUSE_RECT: Rect = { x: 24, y: 4, w: 8, h: 6 };

/** Pond bounding rect (GDD §1.3: 池塘 (6..16, 26..34), irregular — blocked whole). */
const POND_RECT: Rect = { x: 6, y: 26, w: 11, h: 9 };

/** Tree-wall border thickness (GDD §1.3: 四周 2 tiles 厚). */
const BORDER = 2;

function inBounds(t: TilePos): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < MAP_WIDTH && t.y < MAP_HEIGHT;
}

function rectContains(rect: Rect, t: TilePos): boolean {
  return t.x >= rect.x && t.x < rect.x + rect.w && t.y >= rect.y && t.y < rect.y + rect.h;
}

/** Footprint rect of a blueprint at an origin (shared by canPlace/render/sanitiser). */
export function footprintRect(def: BlueprintDef, origin: TilePos): Rect {
  return { x: origin.x, y: origin.y, w: def.size.w, h: def.size.h };
}

function* rectTiles(rect: Rect): Generator<TilePos> {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) yield { x, y };
  }
}

function structures(state: WorldState): PlacedStructure[] {
  return state.structures ?? [];
}

function sprinklers(state: WorldState): Sprinkler[] {
  return state.sprinklers ?? [];
}

function farmhouseOf(state: WorldState): FarmhouseState {
  return state.farmhouse ?? { stage: 0, construction: null };
}

/** Farm level for unlock gates (M3 cap lift landed: effectiveLevel caps at Lv10). */
export function buildFarmLevel(state: WorldState): number {
  return effectiveLevel(state.progress.xp);
}

/** Bundled map contract — the default rule-② context (see header apiDrift note). */
const DEFAULT_MAP = farmMapMeta as unknown as MapMeta;

function countItemIn(inv: InventoryState, itemId: string): number {
  return inv.slots.reduce((sum, s) => (s !== null && s.itemId === itemId ? sum + s.count : sum), 0);
}

/** Deterministic instance ids: s1, s2, … (sim has no Math.random / wall clock). */
function nextInstanceId(existing: readonly PlacedStructure[]): string {
  let max = 0;
  for (const s of existing) {
    const m = /^s(\d+)$/.exec(s.instanceId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

// ---- greenhouse interior plots (GDD §8.2 室内 24 格耕地) ----
//
// Model (M3 implementation decision, recorded in the workflow openQuestions): the 24
// interior plots are real farm tiles keyed by WORLD coordinates inside the greenhouse
// footprint — rows 0..h-2 (the door row stays walkable), 6×4 = 24 tiles. This keeps
// the v2 schema untouched (farmTiles already persists them), lets growCrops / the
// watering can work unmodified, and "crops travel with the building" falls out of the
// key remap in moveStructure. They are excluded from the §1.4 tilled cap (tiles.ts)
// and from rain wetting (§8.2 室内无雨天豁免 — night-update.ts post-pass).

/** World tiles of a greenhouse instance's 24 interior plots, row-major. */
export function greenhousePlotTiles(s: Pick<PlacedStructure, 'defId' | 'origin'>): TilePos[] {
  const def = BLUEPRINTS_BY_ID.get(s.defId);
  if (!def || s.defId !== 'greenhouse') return [];
  const tiles: TilePos[] = [];
  for (let y = 0; y < def.size.h - 1; y++) {
    for (let x = 0; x < def.size.w; x++) {
      tiles.push({ x: s.origin.x + x, y: s.origin.y + y });
    }
  }
  return tiles;
}

/** Sparse keys of every BUILT greenhouse's interior plots (cap/rain exemptions). */
export function greenhousePlotKeys(list: readonly PlacedStructure[] | undefined): Set<TileKey> {
  const keys = new Set<TileKey>();
  for (const s of list ?? []) {
    if (s.defId !== 'greenhouse' || s.state !== 'built') continue;
    for (const t of greenhousePlotTiles(s)) keys.add(tileKey(t));
  }
  return keys;
}

// ---- canPlace (GDD §8.3 — exactly six rules, per-tile reporting; PRD 04 US6) ----

/** The six §8.3 violation kinds; hover on a red tile names the offended rule. */
export type CanPlaceViolation =
  | 'out_of_bounds' // ① inside map bounds
  | 'not_buildable' // ② buildable == true (water/banks/spawn guard/door apron = false)
  | 'farmland_conflict' // ③ no tilled tile / crop (stone path included)
  | 'overlap' // ④ no overlap with placed structures (move exempts itself)
  | 'occupant_inside' // ⑤ player & hens must not stand in the footprint
  | 'door_unreachable'; // ⑥ buildings: the tile in front of the door must be reachable

export interface CanPlaceTileReport {
  tile: TilePos;
  /** Empty = green; non-empty = red with the offended rules (hover text, US6). */
  violations: CanPlaceViolation[];
}

export interface CanPlaceResult {
  ok: boolean;
  /** One report per footprint tile (+ the door-front tile for buildings). */
  tiles: CanPlaceTileReport[];
}

export interface CanPlaceOptions {
  /** Relocation: this instance's own footprint is exempt from rule ④ (§8.3). */
  readonly movingInstanceId?: string;
  /** Hen tiles (rule ⑤) — supplied by the caller; sim does not pathfind hens. */
  readonly henTiles?: readonly TilePos[];
  /**
   * apiDrift: map contract for the rule-② heuristic (water/pond/spawn guard/farmhouse/
   * interactables + door apron). Without it (and without isBuildable) rule ② passes.
   */
  readonly map?: MapMeta;
  /**
   * apiDrift: precise tilemap collision truth injected by the render layer (overrides
   * the map heuristic). MUST be at least as permissive as the placement-time check the
   * sanitiser uses, or legal saves would be reclaimed on load.
   */
  readonly isBuildable?: (tile: TilePos) => boolean;
}

/** Conservative rule-② heuristic from MapMeta (see CanPlaceOptions.map note). */
function heuristicBuildable(map: MapMeta, t: TilePos): boolean {
  if (t.x < BORDER || t.y < BORDER || t.x >= MAP_WIDTH - BORDER || t.y >= MAP_HEIGHT - BORDER) {
    return false; // tree-wall border ring (§1.3)
  }
  if (rectContains(POND_RECT, t) || rectContains(FARMHOUSE_RECT, t)) return false;
  if (map.waterSources.some((w) => w.x === t.x && w.y === t.y)) return false;
  // Spawn guard: 3×3 around the spawn tile (§8.3 出生点保护区; radius is a sim choice).
  if (Math.abs(t.x - map.spawn.tile.x) <= 1 && Math.abs(t.y - map.spawn.tile.y) <= 1) return false;
  for (const it of map.interactables) {
    if (it.tiles.some((p) => p.x === t.x && p.y === t.y)) return false;
    if (it.kind === 'door') {
      // 农舍门前 2 格 = false (§8.3 rule ② door apron).
      if (it.tiles.some((p) => p.x === t.x && (t.y === p.y + 1 || t.y === p.y + 2))) return false;
    }
  }
  return true;
}

function buildableAt(t: TilePos, opts: CanPlaceOptions): boolean {
  if (opts.isBuildable) return opts.isBuildable(t);
  return heuristicBuildable(opts.map ?? DEFAULT_MAP, t);
}

/** Occupancy index over structures + sprinklers (rule ④). */
interface OccupancyEntry {
  key: TileKey;
  defId: string;
  instanceId: string;
}

function occupancyOf(state: WorldState, movingInstanceId?: string): Map<TileKey, OccupancyEntry> {
  const occ = new Map<TileKey, OccupancyEntry>();
  for (const s of structures(state)) {
    if (s.instanceId === movingInstanceId) continue; // move exempts itself (§8.3)
    const def = BLUEPRINTS_BY_ID.get(s.defId);
    if (!def) continue; // unknown defIds are the sanitiser's business
    for (const t of rectTiles(footprintRect(def, s.origin))) {
      occ.set(tileKey(t), { key: tileKey(t), defId: s.defId, instanceId: s.instanceId });
    }
  }
  for (const sp of sprinklers(state)) {
    const key = tileKey({ x: sp.x, y: sp.y });
    occ.set(key, {
      key,
      defId: sp.tier === 2 ? 'sprinkler_advanced' : 'sprinkler',
      instanceId: `sprinkler@${key}`,
    });
  }
  // The map-fixed farmhouse blocks placement like any other structure (§1.3/§8.3).
  for (const t of rectTiles(FARMHOUSE_RECT)) {
    const key = tileKey(t);
    if (!occ.has(key)) occ.set(key, { key, defId: 'farmhouse', instanceId: 'farmhouse' });
  }
  return occ;
}

function tileViolations(
  state: WorldState,
  def: BlueprintDef,
  t: TilePos,
  occ: Map<TileKey, OccupancyEntry>,
  ownPlotKeys: Set<TileKey>,
  opts: CanPlaceOptions,
): CanPlaceViolation[] {
  const v: CanPlaceViolation[] = [];
  if (!inBounds(t)) {
    v.push('out_of_bounds'); // ① — other rules are meaningless off-map
    return v;
  }
  if (!buildableAt(t, opts)) v.push('not_buildable'); // ②
  const key = tileKey(t);
  // ③ no tilled tile / crop (stone path included); a moving greenhouse's own interior
  // plots are part of the mover, not a conflict.
  if (state.farm.tiles[key] !== undefined && !ownPlotKeys.has(key)) v.push('farmland_conflict');
  // ④ no overlap (move exempts itself via occ construction); decorations may sit on a
  // stone path (§8.3 "decoration 可放石径上") — but never path-on-path.
  const occupant = occ.get(key);
  if (occupant) {
    const decorationOnPath =
      def.category === 'decoration' && def.id !== 'stone_path' && occupant.defId === 'stone_path';
    if (!decorationOnPath) v.push('overlap');
  }
  // ⑤ player & hens must not stand inside.
  if (state.player.tileX === t.x && state.player.tileY === t.y) v.push('occupant_inside');
  if (opts.henTiles?.some((h) => h.x === t.x && h.y === t.y)) v.push('occupant_inside');
  return v;
}

/**
 * Pure placement validation (§8.3 rules ①~⑥). Also used for sprinklers (which reuse
 * the placement pipeline, §3.8 — rules ①~⑤ apply; ⑥ is building-only).
 * Called every frame by the ghost cursor; must allocate minimally.
 */
export function canPlace(
  state: WorldState,
  def: BlueprintDef,
  origin: TilePos,
  opts: CanPlaceOptions = {},
): CanPlaceResult {
  const occ = occupancyOf(state, opts.movingInstanceId);
  // A relocating greenhouse carries its interior plots: exempt them from rule ③.
  const moving = opts.movingInstanceId
    ? structures(state).find((s) => s.instanceId === opts.movingInstanceId)
    : undefined;
  const ownPlotKeys =
    moving && moving.defId === 'greenhouse' && moving.state === 'built'
      ? new Set(greenhousePlotTiles(moving).map(tileKey))
      : new Set<TileKey>();

  const tiles: CanPlaceTileReport[] = [];
  let ok = true;
  for (const t of rectTiles(footprintRect(def, origin))) {
    const violations = tileViolations(state, def, t, occ, ownPlotKeys, opts);
    if (violations.length > 0) ok = false;
    tiles.push({ tile: t, violations });
  }

  // ⑥ buildings: the tile in front of the door must be reachable. The sim checks the
  // local conditions (in-bounds, buildable, no farmland, no structure) — full
  // pathfinding is a render-layer concern and out of sim scope (documented).
  if (def.category === 'building' && def.doorOffset) {
    const front = { x: origin.x + def.doorOffset.x, y: origin.y + def.doorOffset.y + 1 };
    const frontBad =
      !inBounds(front) ||
      !buildableAt(front, opts) ||
      state.farm.tiles[tileKey(front)] !== undefined ||
      occ.has(tileKey(front));
    if (frontBad) ok = false;
    tiles.push({ tile: front, violations: frontBad ? ['door_unreachable'] : [] });
  }

  return { ok, tiles };
}

// ---- placement / demolish / move reducers (GDD §8.3; PRD 04 §B/§D) ----
//
// All reducers are pure (clone-in/new-state-out at the facade, `*InPlace` composition
// inside, mirroring farming.ts conventions) and return §12-style events.

export type BuildError =
  | 'INSUFFICIENT_GOLD'
  | 'INSUFFICIENT_MATERIALS'
  | 'CANNOT_PLACE' // canPlace failed (re-check at commit time)
  | 'NOT_UNLOCKED' // farmLevel / requires gate (§8.2)
  | 'LIMIT_REACHED' // per-blueprint instance limit (§8.2)
  | 'CHEST_NOT_EMPTY' // §8.3: non-empty chest refuses demolition
  | 'GREENHOUSE_NOT_EMPTY' // zero-loss: living interior crops block demolition
  | 'INVENTORY_FULL' // §8.3: rack/workshop goods would not fit on demolish
  | 'NOT_DEMOLISHABLE' // farmhouse & upgrades (§8.3)
  | 'NOT_MOVABLE' // movable:false (farmhouse chain)
  | 'UNKNOWN_BLUEPRINT'
  | 'SLOT_OCCUPIED' // processing slot already holds a job
  | 'INVALID_INPUT' // item has no recipe at this station
  | 'NO_SPRINKLER' // removeSprinkler on an empty tile
  | 'UNKNOWN_INSTANCE';

export type BuildResult =
  | { ok: true; state: WorldState; events: SimEvent[] }
  | { ok: false; error: BuildError };

/** unlock.requires entries: farmhouse stages or built structure defIds (§8.2). */
function requirementMet(state: WorldState, req: string): boolean {
  if (req === 'farmhouse_1') return farmhouseOf(state).stage >= 1;
  if (req === 'farmhouse_2') return farmhouseOf(state).stage >= 2;
  return structures(state).some((s) => s.defId === req && s.state === 'built');
}

function unlockError(state: WorldState, def: BlueprintDef): BuildError | null {
  if (def.unlock.farmLevel > buildFarmLevel(state)) return 'NOT_UNLOCKED';
  for (const req of def.unlock.requires ?? []) {
    if (!requirementMet(state, req)) return 'NOT_UNLOCKED';
  }
  return null;
}

/** Charge gold + materials atomically on an already-cloned state (§8.1: materials are
 * consumed ONLY at commit). Returns the events or an error WITHOUT mutating. */
function chargeCostInPlace(state: WorldState, def: BlueprintDef): SimEvent[] | BuildError {
  const wood = def.cost.wood ?? 0;
  const stone = def.cost.stone ?? 0;
  const paid = debit(state.economy.gold, def.cost.gold);
  if (paid === 'INSUFFICIENT_GOLD') return 'INSUFFICIENT_GOLD';
  if (countItemIn(state.inventory, 'material_wood') < wood) return 'INSUFFICIENT_MATERIALS';
  if (countItemIn(state.inventory, 'material_stone') < stone) return 'INSUFFICIENT_MATERIALS';
  state.economy.gold = paid;
  if (wood > 0) removeItemInPlace(state.inventory, 'material_wood', wood);
  if (stone > 0) removeItemInPlace(state.inventory, 'material_stone', stone);
  return def.cost.gold > 0
    ? [{ type: 'GoldChanged', gold: state.economy.gold, delta: -def.cost.gold }]
    : [];
}

/** Initial per-kind data at the moment a structure becomes 'built' (GDD §8.2/§8.4). */
function initialDataFor(defId: string): StructureData | undefined {
  switch (defId) {
    case 'storage_chest':
      return { kind: 'chest', slots: Array.from({ length: 24 }, () => null) };
    case 'drying_rack':
      return { kind: 'dryingRack', jobs: [null, null] };
    case 'workshop':
      return { kind: 'workshop', jobs: Array.from({ length: 6 }, () => null) };
    case 'coop':
      // Completion grants STARTING_HENS free hens (§8.2 row 1, ruling A-7).
      return { kind: 'coop', hens: COOP.STARTING_HENS, eggsReady: 0 };
    default:
      return undefined;
  }
}

/** Create the 24 pre-tilled interior plots when a greenhouse completes (§8.2). */
function createGreenhousePlotsInPlace(state: WorldState, s: PlacedStructure): void {
  for (const t of greenhousePlotTiles(s)) {
    state.farm.tiles[tileKey(t)] ??= { tilled: true, wateredToday: false, crop: null };
  }
}

/**
 * Commit a placement order (the COMMITTED arrow in §8.3):
 * - charges gold + materials atomically (materials are consumed ONLY here, §8.1);
 * - buildings/farmhouse upgrades: creates an `underConstruction` site with
 *   daysLeft = def.buildDays (2 settlement nights);
 * - stations/decorations: instant `built` entity (placement grants ZERO XP, §5.2);
 * - sprinkler defs route to placeSprinkler (separate save block).
 */
export function placeStructure(
  state: WorldState,
  defId: string,
  origin: TilePos,
  opts: CanPlaceOptions = {},
): BuildResult {
  const def = BLUEPRINTS_BY_ID.get(defId);
  if (!def) return { ok: false, error: 'UNKNOWN_BLUEPRINT' };
  if (def.placement === 'farmhouse') {
    return orderFarmhouseUpgrade(state, defId as 'farmhouse_1' | 'farmhouse_2');
  }
  if (defId === 'sprinkler' || defId === 'sprinkler_advanced') {
    return placeSprinkler(state, defId, origin, opts);
  }
  const gate = unlockError(state, def);
  if (gate) return { ok: false, error: gate };
  if (
    def.limit !== undefined &&
    structures(state).filter((s) => s.defId === defId).length >= def.limit
  ) {
    return { ok: false, error: 'LIMIT_REACHED' };
  }
  if (!canPlace(state, def, origin, opts).ok) return { ok: false, error: 'CANNOT_PLACE' };

  const next = structuredClone(state);
  const charged = chargeCostInPlace(next, def);
  if (typeof charged === 'string') return { ok: false, error: charged };
  const events: SimEvent[] = [];

  next.structures ??= [];
  const instanceId = nextInstanceId(next.structures);
  const instant = def.buildDays === 0;
  const placed: PlacedStructure = instant
    ? { instanceId, defId, origin: { ...origin }, state: 'built', data: initialDataFor(defId) }
    : {
        instanceId,
        defId,
        origin: { ...origin },
        state: 'underConstruction',
        daysLeft: def.buildDays,
      };
  next.structures.push(placed);
  // Instant pieces are "completed" at placement: bump built:<id> (§5.6 counter
  // vocabulary); buildingsBuilt stays reserved for large-building completions (#15/#16
  // read coop/workshop/greenhouse — appendix B-6). Placement XP is ZERO either way (§5.2).
  if (instant) bumpCounterInPlace(next, `built:${defId}`, 1);
  events.push({ type: 'StructurePlaced', instanceId, defId, tile: { ...origin } });
  events.push(...charged);
  return { ok: true, state: next, events };
}

/** Sprinkler placement (reuses the pipeline; 0 XP, bumps `sprinklersPlaced` — §5.3). */
export function placeSprinkler(
  state: WorldState,
  defId: 'sprinkler' | 'sprinkler_advanced',
  tile: TilePos,
  opts: CanPlaceOptions = {},
): BuildResult {
  const def = getBlueprint(defId);
  const gate = unlockError(state, def);
  if (gate) return { ok: false, error: gate };
  if (!canPlace(state, def, tile, opts).ok) return { ok: false, error: 'CANNOT_PLACE' };

  const next = structuredClone(state);
  const charged = chargeCostInPlace(next, def);
  if (typeof charged === 'string') return { ok: false, error: charged };
  next.sprinklers ??= [];
  const tier = defId === 'sprinkler_advanced' ? 2 : 1;
  next.sprinklers.push({ x: tile.x, y: tile.y, tier });
  bumpCounterInPlace(next, 'sprinklersPlaced', 1); // 0 XP; achievement #17 reads this (§5.3)
  const events: SimEvent[] = [{ type: 'SprinklerPlaced', tile: { ...tile }, tier }, ...charged];
  return { ok: true, state: next, events };
}

/** Sprinkler coverage at 6:00 (§3.8/§5.3): tier 1 = 4-neighbour cross, tier 2 = 3×3. */
export function sprinklerCoverage(sp: Sprinkler): TilePos[] {
  if (sp.tier === 1) {
    return [
      { x: sp.x, y: sp.y - 1 },
      { x: sp.x - 1, y: sp.y },
      { x: sp.x + 1, y: sp.y },
      { x: sp.x, y: sp.y + 1 },
    ];
  }
  const tiles: TilePos[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) tiles.push({ x: sp.x + dx, y: sp.y + dy });
  }
  return tiles;
}

/**
 * Sprinkler removal (additive beside demolishStructure: sprinklers live in their own
 * save block without instance ids). 100% refund as gold + material items; everything
 * must fit or the removal is refused (zero loss).
 */
export function removeSprinkler(state: WorldState, tile: TilePos): BuildResult {
  const list = sprinklers(state);
  const index = list.findIndex((sp) => sp.x === tile.x && sp.y === tile.y);
  if (index < 0) return { ok: false, error: 'NO_SPRINKLER' };
  const def = getBlueprint(list[index].tier === 2 ? 'sprinkler_advanced' : 'sprinkler');
  const goods: ItemStack[] = materialStacks(def, 1.0);
  if (!stacksFit(state.inventory, goods)) return { ok: false, error: 'INVENTORY_FULL' };

  const next = structuredClone(state);
  next.sprinklers = (next.sprinklers ?? []).filter((_, i) => i !== index);
  for (const g of goods) addInPlace(next.inventory, g.itemId as ItemId, g.count);
  const events: SimEvent[] = [];
  const refundGold = def.cost.gold; // rate 1.0 (§8.3 station row)
  if (refundGold > 0) {
    next.economy.gold = credit(next.economy.gold, refundGold);
    events.push({ type: 'GoldChanged', gold: next.economy.gold, delta: refundGold });
  }
  events.unshift({
    type: 'StructureRemoved',
    instanceId: `sprinkler@${tileKey(tile)}`,
    defId: def.id,
    refundGold,
  });
  return { ok: true, state: next, events };
}

/** Refunded material item stacks for a blueprint at `rate` (floor per component, §8.3). */
function materialStacks(def: BlueprintDef, rate: number): ItemStack[] {
  const stacks: ItemStack[] = [];
  const wood = Math.floor((def.cost.wood ?? 0) * rate);
  const stone = Math.floor((def.cost.stone ?? 0) * rate);
  if (wood > 0) stacks.push({ itemId: 'material_wood', count: wood });
  if (stone > 0) stacks.push({ itemId: 'material_stone', count: stone });
  return stacks;
}

/** Would all stacks fit, together, into this inventory? (simulated on a clone) */
function stacksFit(inv: InventoryState, stacks: readonly ItemStack[]): boolean {
  if (stacks.length === 0) return true;
  const probe = structuredClone(inv);
  for (const s of stacks) {
    if (addInPlace(probe, s.itemId as ItemId, s.count).rejected > 0) return false;
  }
  return true;
}

/** In-progress goods that demolishing this structure must hand back (§8.3 station row):
 * unfinished jobs return their INPUT, finished jobs their OUTPUT — zero loss. */
function demolitionGoods(s: PlacedStructure): ItemStack[] {
  const goods: ItemStack[] = [];
  if (s.data?.kind === 'dryingRack' || s.data?.kind === 'workshop') {
    for (const job of s.data.jobs) {
      if (!job) continue;
      goods.push({ itemId: job.daysLeft === 0 ? job.outputItemId : job.inputItemId, count: 1 });
    }
  }
  if (s.data?.kind === 'coop' && s.data.eggsReady > 0) {
    goods.push({ itemId: 'animal_egg', count: s.data.eggsReady });
  }
  return goods;
}

interface RefundPlan {
  goldRefund: number;
  items: ItemStack[];
}

function refundPlanFor(s: PlacedStructure, def: BlueprintDef): RefundPlan {
  // §8.3 table: a site (= cancelled order) refunds 100% regardless of category.
  const rate = s.state === 'underConstruction' ? 1.0 : def.refundRate;
  let goldRefund = Math.floor(def.cost.gold * rate);
  // Hens are bought capital, not building substance: demolishing an occupied coop
  // auto-sells them back at the A-6 100g price, and ready eggs come home as items —
  // the zero-loss reading of the GDD-silent "demolish an occupied coop" case
  // (recorded as an M3 open question; pinned by building-lifecycle.test.ts).
  if (s.data?.kind === 'coop') goldRefund += s.data.hens * COOP.HEN_SELL_PRICE;
  return { goldRefund, items: [...demolitionGoods(s), ...materialStacks(def, rate)] };
}

/**
 * Demolish (§8.3 table):
 * - decoration/station: instant, 100% gold+materials back (chest must be empty;
 *   rack/workshop in-progress goods return to inventory or the demolition is refused);
 * - building site (= cancel order): single confirm upstream, 100% refund;
 * - built building: double confirm upstream, floor(50%) gold + floor(50%) materials;
 * - farmhouse & upgrades: NOT_DEMOLISHABLE (never listed, §8.3).
 */
export function demolishStructure(state: WorldState, instanceId: string): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  const def = BLUEPRINTS_BY_ID.get(s.defId);
  if (!def) return { ok: false, error: 'UNKNOWN_INSTANCE' }; // sanitiser's territory
  if (!def.demolishable) return { ok: false, error: 'NOT_DEMOLISHABLE' };
  if (s.data?.kind === 'chest' && s.data.slots.some((slot) => slot !== null)) {
    return { ok: false, error: 'CHEST_NOT_EMPTY' }; // never auto-dump (§8.5)
  }
  if (s.defId === 'greenhouse' && s.state === 'built') {
    const hasCrop = greenhousePlotTiles(s).some((t) => {
      const tile = state.farm.tiles[tileKey(t)];
      return tile !== undefined && tile.crop !== null;
    });
    if (hasCrop) return { ok: false, error: 'GREENHOUSE_NOT_EMPTY' };
  }
  const plan = refundPlanFor(s, def);
  if (!stacksFit(state.inventory, plan.items)) return { ok: false, error: 'INVENTORY_FULL' };

  const next = structuredClone(state);
  next.structures = (next.structures ?? []).filter((x) => x.instanceId !== instanceId);
  if (s.defId === 'greenhouse' && s.state === 'built') {
    for (const t of greenhousePlotTiles(s)) delete next.farm.tiles[tileKey(t)];
  }
  for (const item of plan.items) addInPlace(next.inventory, item.itemId as ItemId, item.count);
  const events: SimEvent[] = [
    { type: 'StructureRemoved', instanceId, defId: s.defId, refundGold: plan.goldRefund },
  ];
  if (plan.goldRefund > 0) {
    next.economy.gold = credit(next.economy.gold, plan.goldRefund);
    events.push({ type: 'GoldChanged', gold: next.economy.gold, delta: plan.goldRefund });
  }
  return { ok: true, state: next, events };
}

/**
 * Relocate (§8.3): permanently free, instant, preserves ALL internal state (chest
 * contents, in-progress jobs & their remaining nights, hens, greenhouse crops travel
 * with the building; a site moves WITHOUT resetting its countdown).
 */
export function moveStructure(
  state: WorldState,
  instanceId: string,
  newOrigin: TilePos,
  opts: CanPlaceOptions = {},
): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  const def = BLUEPRINTS_BY_ID.get(s.defId);
  if (!def) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  if (!def.movable) return { ok: false, error: 'NOT_MOVABLE' };
  if (!canPlace(state, def, newOrigin, { ...opts, movingInstanceId: instanceId }).ok) {
    return { ok: false, error: 'CANNOT_PLACE' };
  }

  const next = structuredClone(state);
  const moved = (next.structures ?? []).find((x) => x.instanceId === instanceId);
  if (!moved) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  // Greenhouse interior plots (and their crops) travel with the building (§8.3/US30).
  if (moved.defId === 'greenhouse' && moved.state === 'built') {
    const oldTiles = greenhousePlotTiles(moved);
    const dx = newOrigin.x - moved.origin.x;
    const dy = newOrigin.y - moved.origin.y;
    const carried = oldTiles.map((t) => {
      const tile = next.farm.tiles[tileKey(t)];
      delete next.farm.tiles[tileKey(t)];
      return { t, tile };
    });
    for (const { t, tile } of carried) {
      next.farm.tiles[tileKey({ x: t.x + dx, y: t.y + dy })] = tile ?? {
        tilled: true,
        wateredToday: false,
        crop: null,
      };
    }
  }
  moved.origin = { x: newOrigin.x, y: newOrigin.y };
  return {
    ok: true,
    state: next,
    events: [{ type: 'StructureMoved', instanceId, defId: moved.defId, tile: { ...newOrigin } }],
  };
}

/** Refund preview for the demolish confirm dialog (floor at each component, §8.3).
 * Unknown instances preview as zero. */
export function refundFor(
  state: WorldState,
  instanceId: string,
): { gold: number; wood: number; stone: number } {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  const def = s ? BLUEPRINTS_BY_ID.get(s.defId) : undefined;
  if (!s || !def) return { gold: 0, wood: 0, stone: 0 };
  const rate = s.state === 'underConstruction' ? 1.0 : def.refundRate;
  return {
    gold: refundPlanFor(s, def).goldRefund,
    wood: Math.floor((def.cost.wood ?? 0) * rate),
    stone: Math.floor((def.cost.stone ?? 0) * rate),
  };
}

/** Farmhouse upgrade order (placement 'farmhouse': CONFIRM-only path, §8.2 chain). */
export function orderFarmhouseUpgrade(
  state: WorldState,
  defId: 'farmhouse_1' | 'farmhouse_2',
): BuildResult {
  const def = BLUEPRINTS_BY_ID.get(defId);
  if (!def) return { ok: false, error: 'UNKNOWN_BLUEPRINT' };
  const fh = farmhouseOf(state);
  const targetStage = defId === 'farmhouse_2' ? 2 : 1;
  if (fh.construction !== null) return { ok: false, error: 'LIMIT_REACHED' }; // one order at a time
  if (fh.stage >= targetStage) return { ok: false, error: 'LIMIT_REACHED' }; // already owned
  if (targetStage === 2 && fh.stage < 1) return { ok: false, error: 'NOT_UNLOCKED' }; // 顺序解锁
  const gate = unlockError(state, def);
  if (gate) return { ok: false, error: gate };

  const next = structuredClone(state);
  const charged = chargeCostInPlace(next, def);
  if (typeof charged === 'string') return { ok: false, error: charged };
  next.farmhouse = {
    stage: fh.stage,
    construction: { targetStage, nightsLeft: def.buildDays },
  };
  // The farmhouse is map-fixed; renderers key its site state off the synthetic
  // 'farmhouse' instance id (documented §12 extension).
  const events: SimEvent[] = [
    {
      type: 'StructurePlaced',
      instanceId: 'farmhouse',
      defId,
      tile: { x: FARMHOUSE_RECT.x, y: FARMHOUSE_RECT.y },
    },
    ...charged,
  ];
  return { ok: true, state: next, events };
}

// ---- nightly progression (NightUpdate #4; order fixed by §8.4: 工地 → 烘干 → 加工) ----

/**
 * NightUpdate #4 progressConstruction: every `underConstruction` site (and the
 * farmhouse order) ticks daysLeft−1; at zero it completes at 6:00 — emitting
 * ConstructionCompleted with the ONE-TIME completion XP (coop 150 / workshop 300 /
 * greenhouse 500, §5.2) and bumping `buildingsBuilt` / `built:<id>` counters (§5.6).
 * Pure per-night step; "fast-forward N nights" tests iterate it.
 */
export function progressConstructionInPlace(state: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  for (const s of structures(state)) {
    if (s.state !== 'underConstruction') continue;
    const left = (s.daysLeft ?? 1) - 1;
    if (left > 0) {
      s.daysLeft = left;
      continue;
    }
    delete s.daysLeft;
    s.state = 'built';
    const data = initialDataFor(s.defId);
    if (data !== undefined) s.data = data;
    else delete s.data;
    if (s.defId === 'greenhouse') createGreenhousePlotsInPlace(state, s);
    const xp = (CONSTRUCTION_XP as Record<string, number>)[s.defId] ?? 0;
    if ((LARGE_BUILDING_IDS as readonly string[]).includes(s.defId)) {
      bumpCounterInPlace(state, 'buildingsBuilt', 1);
    }
    bumpCounterInPlace(state, `built:${s.defId}`, 1);
    events.push({ type: 'ConstructionCompleted', instanceId: s.instanceId, defId: s.defId, xp });
    if (xp > 0) events.push(...grantXpInPlace(state, xp)); // one-time, unified pipeline (§5.2)
  }
  // Farmhouse upgrade chain (§8.2): same per-night tick; completion XP is 0 (§5.2
  // lists only coop/workshop/greenhouse).
  const fh = state.farmhouse;
  if (fh?.construction) {
    if (fh.construction.nightsLeft > 1) {
      fh.construction = { ...fh.construction, nightsLeft: fh.construction.nightsLeft - 1 };
    } else {
      const defId = `farmhouse_${fh.construction.targetStage}`;
      fh.stage = fh.construction.targetStage;
      fh.construction = null;
      bumpCounterInPlace(state, `built:${defId}`, 1);
      events.push({ type: 'ConstructionCompleted', instanceId: 'farmhouse', defId, xp: 0 });
    }
  }
  return events;
}

/**
 * NightUpdate #4 (second half): drying racks first, then workshop jobs — daysLeft−1,
 * 0 = ready for pickup (goods rest in the slot indefinitely; zero-loss). Selling
 * processed goods grants 0 XP (§5.2/§8.5).
 */
export function progressProcessingInPlace(state: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  for (const kind of ['dryingRack', 'workshop'] as const) {
    for (const s of structures(state)) {
      if (s.state !== 'built' || s.data?.kind !== kind) continue;
      s.data.jobs.forEach((job, slot) => {
        if (!job || job.daysLeft === 0) return; // 0 = waiting for pickup, forever (zero loss)
        job.daysLeft -= 1;
        if (job.daysLeft === 0) {
          events.push({
            type: 'ProcessingDone',
            instanceId: s.instanceId,
            slot,
            outputItemId: job.outputItemId,
          });
        }
      });
    }
  }
  return events;
}

// ---- player interaction with processing slots (interior scenes, PRD 04 §B) ----

/** Recipe lookup (§8.2): rack dries crops; workshop jams crops & mayonnaises eggs. */
function recipeFor(
  stationKind: 'dryingRack' | 'workshop',
  inputItemId: string,
): { outputItemId: string; days: number } | null {
  const input = ITEMS_BY_ID.get(inputItemId);
  if (!input) return null;
  if (stationKind === 'dryingRack') {
    if (input.category === 'crop' && input.cropId) {
      return { outputItemId: driedItemId(input.cropId), days: PROCESSING.DRIED.days };
    }
    return null;
  }
  if (input.category === 'crop' && input.cropId) {
    return { outputItemId: jamItemId(input.cropId), days: PROCESSING.JAM.days };
  }
  if (inputItemId === 'animal_egg') {
    return { outputItemId: 'artisan_mayonnaise', days: PROCESSING.MAYONNAISE.days };
  }
  return null;
}

/** Load one crop/egg into a free slot; output & duration come from PROCESSING recipes.
 * Any-quality input yields a normal-quality product (PRD 04 conservative reading). */
export function startProcessingJob(
  state: WorldState,
  instanceId: string,
  slot: number,
  inputItemId: string,
): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s || s.state !== 'built' || (s.data?.kind !== 'dryingRack' && s.data?.kind !== 'workshop')) {
    return { ok: false, error: 'UNKNOWN_INSTANCE' };
  }
  if (slot < 0 || slot >= s.data.jobs.length) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  if (s.data.jobs[slot] !== null) return { ok: false, error: 'SLOT_OCCUPIED' };
  const recipe = recipeFor(s.data.kind, inputItemId);
  if (!recipe) return { ok: false, error: 'INVALID_INPUT' };
  if (countItemIn(state.inventory, inputItemId) < 1) {
    return { ok: false, error: 'INSUFFICIENT_MATERIALS' };
  }

  const next = structuredClone(state);
  removeItemInPlace(next.inventory, inputItemId as ItemId, 1);
  const data = (next.structures ?? []).find((x) => x.instanceId === instanceId)?.data;
  if (data?.kind !== 'dryingRack' && data?.kind !== 'workshop') {
    return { ok: false, error: 'UNKNOWN_INSTANCE' }; // unreachable; type narrowing
  }
  data.jobs[slot] = { inputItemId, outputItemId: recipe.outputItemId, daysLeft: recipe.days };
  return { ok: true, state: next, events: [] }; // slot UIs re-read state (bin precedent)
}

/** Collect a finished job (daysLeft 0) into the inventory; full inventory blocks. */
export function collectProcessedGood(
  state: WorldState,
  instanceId: string,
  slot: number,
): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s || (s.data?.kind !== 'dryingRack' && s.data?.kind !== 'workshop')) {
    return { ok: false, error: 'UNKNOWN_INSTANCE' };
  }
  const job = s.data.jobs[slot];
  if (!job || job.daysLeft !== 0) return { ok: false, error: 'INVALID_INPUT' };
  if (!stacksFit(state.inventory, [{ itemId: job.outputItemId, count: 1 }])) {
    return { ok: false, error: 'INVENTORY_FULL' }; // goods wait in the slot, zero loss
  }

  const next = structuredClone(state);
  const data = (next.structures ?? []).find((x) => x.instanceId === instanceId)?.data;
  if (data?.kind !== 'dryingRack' && data?.kind !== 'workshop') {
    return { ok: false, error: 'UNKNOWN_INSTANCE' }; // unreachable; type narrowing
  }
  data.jobs[slot] = null;
  addInPlace(next.inventory, job.outputItemId as ItemId, 1);
  return {
    ok: true,
    state: next,
    events: [{ type: 'ItemPicked', itemId: job.outputItemId as ItemId, count: 1 }],
  };
}

// ---- chest storage (GDD §8.2 storage_chest: 24 slots, contents travel on move) ----

/**
 * Move `count` units from inventory slot `invSlot` into a chest (same-id stacks top up
 * first, then the first empty chest slot). Quality-tagged stacks are carried verbatim;
 * same-id merging across DIFFERENT qualities is left to the M3 quality pass (§4.5 seam).
 */
export function depositToChest(
  state: WorldState,
  instanceId: string,
  invSlot: number,
  count: number,
): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s || s.state !== 'built' || s.data?.kind !== 'chest') {
    return { ok: false, error: 'UNKNOWN_INSTANCE' };
  }
  const stack = state.inventory.slots[invSlot];
  if (!stack || count <= 0) return { ok: false, error: 'INVALID_INPUT' };
  const def = ITEMS_BY_ID.get(stack.itemId);
  const stackMax = def?.stackMax ?? 99;

  const next = structuredClone(state);
  const data = (next.structures ?? []).find((x) => x.instanceId === instanceId)?.data;
  if (data?.kind !== 'chest') return { ok: false, error: 'UNKNOWN_INSTANCE' };
  let remaining = Math.min(count, stack.count);
  let moved = 0;
  for (const slot of data.slots) {
    if (remaining === 0) break;
    if (slot !== null && slot.itemId === stack.itemId && slot.count < stackMax) {
      const take = Math.min(stackMax - slot.count, remaining);
      slot.count += take;
      remaining -= take;
      moved += take;
    }
  }
  for (let i = 0; i < data.slots.length && remaining > 0; i++) {
    if (data.slots[i] === null) {
      const take = Math.min(stackMax, remaining);
      data.slots[i] = { itemId: stack.itemId, count: take };
      remaining -= take;
      moved += take;
    }
  }
  if (moved === 0) return { ok: false, error: 'INVENTORY_FULL' }; // chest full
  removeAtInPlace(next.inventory, invSlot, moved);
  return { ok: true, state: next, events: [] };
}

/** Move `count` units from chest slot `chestSlot` back into the inventory (zero loss:
 * moves what fits; the rest stays in the chest). */
export function withdrawFromChest(
  state: WorldState,
  instanceId: string,
  chestSlot: number,
  count: number,
): BuildResult {
  const s = structures(state).find((x) => x.instanceId === instanceId);
  if (!s || s.data?.kind !== 'chest') return { ok: false, error: 'UNKNOWN_INSTANCE' };
  const stack = s.data.slots[chestSlot];
  if (!stack || count <= 0) return { ok: false, error: 'INVALID_INPUT' };

  const next = structuredClone(state);
  const data = (next.structures ?? []).find((x) => x.instanceId === instanceId)?.data;
  if (data?.kind !== 'chest') return { ok: false, error: 'UNKNOWN_INSTANCE' };
  const chestStack = data.slots[chestSlot];
  if (!chestStack) return { ok: false, error: 'INVALID_INPUT' };
  const want = Math.min(count, chestStack.count);
  const { added } = addInPlace(next.inventory, chestStack.itemId as ItemId, want);
  if (added === 0) return { ok: false, error: 'INVENTORY_FULL' };
  chestStack.count -= added;
  if (chestStack.count === 0) data.slots[chestSlot] = null;
  return { ok: true, state: next, events: [] };
}

// ---- carpenter tools (§8.1 axe/pickaxe; granting path = PRD 04 open question 8) ----

/**
 * Idempotent axe + pickaxe grant ("木匠服务已开通" mail/settlement hand-out — the
 * WHEN is the facade implementer's wiring decision, recorded openQuestions). Looks
 * through the inventory AND chests so a stored tool is never duplicated; grants what
 * fits (a full inventory simply postpones the grant — re-callable, zero loss).
 */
export function grantCarpenterTools(state: WorldState): { state: WorldState; events: SimEvent[] } {
  const owned = new Set<string>();
  for (const slot of state.inventory.slots) if (slot) owned.add(slot.itemId);
  for (const s of structures(state)) {
    if (s.data?.kind === 'chest') {
      for (const slot of s.data.slots) if (slot) owned.add(slot.itemId);
    }
  }
  const missing = (['axe', 'pickaxe'] as const).filter((id) => !owned.has(id));
  if (missing.length === 0) return { state, events: [] };
  const next = structuredClone(state);
  const events: SimEvent[] = [];
  for (const id of missing) {
    if (addInPlace(next.inventory, id, 1).added === 1) {
      events.push({ type: 'ItemPicked', itemId: id, count: 1 });
    }
  }
  return events.length > 0 ? { state: next, events } : { state, events: [] };
}

// ---- import sanitiser (GDD §8.5; PRD 04 US70 — migration leaves legality to the sim) ----

export interface SanitizeStructuresReport {
  /** Reclaimed instances (unknown defId / out-of-bounds / overlapping footprints). */
  reclaimed: { instanceId: string; defId: string; refundGold: number }[];
}

/** 100% reclaim value in GOLD: gold + materials at the §8.1 shop floor (full inventory
 * can never block a load — gold always fits). Unknown blueprints have no cost table
 * and reclaim at 0g, but are still REPORTED (never silent, §8.5). */
function reclaimValue(def: BlueprintDef | undefined): number {
  if (!def) return 0;
  return (
    def.cost.gold +
    (def.cost.wood ?? 0) * MATERIAL_SHOP_BUY_PRICE.wood +
    (def.cost.stone ?? 0) * MATERIAL_SHOP_BUY_PRICE.stone
  );
}

/**
 * Validates structures of a loaded/imported v2 save against the blueprint table and
 * the §8.3 rules; illegal entities are RECLAIMED at 100% of gold+materials (credited
 * to the wallet at material shop value) — never silently deleted (§8.5).
 * Runs after shared-side migration, before the sim starts.
 *
 * Reclaim reasons: unknown defId; farmhouse-chain defIds smuggled into structures[];
 * out-of-bounds footprints; overlap with an earlier-kept structure; per-blueprint
 * limit overflow; farmland conflicts (a structure standing on tilled soil that is not
 * its own greenhouse interior). Rule ② re-checks use the conservative map heuristic
 * only when a map is supplied — it is strictly more permissive than placement-time
 * checks, so legally placed saves are never reclaimed on load.
 */
export function sanitizeStructuresInPlace(
  state: WorldState,
  opts: CanPlaceOptions = {},
): SanitizeStructuresReport {
  state.structures ??= [];
  state.sprinklers ??= [];
  state.farmhouse ??= { stage: 0, construction: null };
  state.clearedResourceNodes ??= [];

  const report: SanitizeStructuresReport = { reclaimed: [] };
  const kept: PlacedStructure[] = [];
  const occupied = new Set<TileKey>(
    [...rectTiles(FARMHOUSE_RECT)].map(tileKey), // the map-fixed farmhouse
  );
  const counts = new Map<string, number>();
  let refundTotal = 0;

  const reclaim = (s: PlacedStructure, def: BlueprintDef | undefined): void => {
    const refundGold = reclaimValue(def);
    refundTotal += refundGold;
    report.reclaimed.push({ instanceId: s.instanceId, defId: s.defId, refundGold });
  };

  for (const s of state.structures) {
    const def = BLUEPRINTS_BY_ID.get(s.defId);
    if (!def || def.placement === 'farmhouse') {
      reclaim(s, def);
      continue;
    }
    const tiles = [...rectTiles(footprintRect(def, s.origin))];
    const ownPlots =
      s.defId === 'greenhouse' && s.state === 'built'
        ? new Set(greenhousePlotTiles(s).map(tileKey))
        : new Set<TileKey>();
    const illegal =
      tiles.some((t) => !inBounds(t)) ||
      tiles.some((t) => occupied.has(tileKey(t))) ||
      tiles.some((t) => state.farm.tiles[tileKey(t)] !== undefined && !ownPlots.has(tileKey(t))) ||
      tiles.some((t) => !buildableAt(t, opts)) ||
      (def.limit !== undefined && (counts.get(s.defId) ?? 0) >= def.limit);
    if (illegal) {
      reclaim(s, def);
      continue;
    }
    counts.set(s.defId, (counts.get(s.defId) ?? 0) + 1);
    for (const t of tiles) occupied.add(tileKey(t));
    // Normalise per-kind data on kept BUILT structures (hand-edited/lossy saves).
    if (s.state === 'built') {
      const expected = initialDataFor(s.defId);
      if (expected !== undefined && s.data?.kind !== expected.kind) s.data = expected;
      if (expected === undefined && s.data !== undefined) delete s.data;
      if (s.defId === 'greenhouse') createGreenhousePlotsInPlace(state, s);
    }
    kept.push(s);
  }
  state.structures = kept;

  // Sprinklers: drop duplicates and entries colliding with kept structures (full
  // equivalent refund — same never-silent rule).
  const seen = new Set<TileKey>();
  const keptSprinklers: Sprinkler[] = [];
  for (const sp of state.sprinklers) {
    const key = tileKey({ x: sp.x, y: sp.y });
    const defId = sp.tier === 2 ? 'sprinkler_advanced' : 'sprinkler';
    if (seen.has(key) || occupied.has(key) || state.farm.tiles[key] !== undefined) {
      const refundGold = reclaimValue(BLUEPRINTS_BY_ID.get(defId));
      refundTotal += refundGold;
      report.reclaimed.push({ instanceId: `sprinkler@${key}`, defId, refundGold });
      continue;
    }
    seen.add(key);
    keptSprinklers.push(sp);
  }
  state.sprinklers = keptSprinklers;

  if (refundTotal > 0) state.economy.gold = credit(state.economy.gold, refundTotal);
  return report;
}
