/**
 * build-model.ts — pure view-model layer for the M3 build mode (GDD §8.2/§8.3;
 * PRD 04 §A/§B/§D). Phaser-free and unit-tested (test/build-model.test.ts).
 *
 * Everything here derives from the SimApi snapshot + the blueprint authority table
 * (sim/data/buildings.ts); mutations leave ONLY as SimCommands through the single
 * `asSimCommand` seam below. The §8.3 build-mode machine is realised across layers
 * (CATALOG/CONFIRM = UI panels with the menu/dialog pause sources; PLACING = the
 * world-side controller, time flowing) — this module holds the pure rules they share.
 *
 * Command surface: `BuildSimCommand` is the M3 subset of SimCommand this UI
 * dispatches (placeStructure / placeSprinkler / demolishStructure / moveStructure /
 * orderFarmhouseUpgrade / startProcessingJob / collectProcessedGood / buyHen /
 * sellHen / collectEggs / chooseProfession). The sim facade routes them onto the
 * contract reducers (building.ts / coop.ts / profession.ts); blocked attempts return
 * [] and the UI derives the single reason from state (buyShopEntry convention).
 */
import type { FarmhouseState, PlacedStructure, ProcessingJob } from '@codestead/shared';

import {
  BLUEPRINTS,
  BLUEPRINTS_BY_ID,
  PROCESSING,
  type BlueprintDef,
} from '../../sim/data/buildings';
import { driedItemId, getItemDef, jamItemId, type ItemId } from '../../sim/data/items';
import { addInPlace } from '../../sim/inventory';
import { effectiveLevel } from '../../sim/leveling';
import type { SimCommand, TilePos, WorldState } from '../../sim/types';
import { safe } from '../safe';

// ---- the M3 SimCommand subset this UI dispatches (sim/types.ts owns the union) ----

export type BuildSimCommand = Extract<
  SimCommand,
  {
    type:
      | 'placeStructure'
      | 'placeSprinkler'
      | 'demolishStructure'
      | 'moveStructure'
      | 'orderFarmhouseUpgrade'
      | 'startProcessingJob'
      | 'collectProcessedGood'
      | 'buyHen'
      | 'sellHen'
      | 'collectEggs'
      | 'chooseProfession';
  }
>;

/** Plain widening — kept as the single audited seam between build UI and facade. */
export function asSimCommand(command: BuildSimCommand): SimCommand {
  return command;
}

// ---- snapshot accessors (M3 carriers are optional during the contract pass) ----

export function structuresOf(state: Readonly<WorldState>): readonly PlacedStructure[] {
  return state.structures ?? [];
}

export function farmhouseOf(state: Readonly<WorldState>): FarmhouseState {
  return state.farmhouse ?? { stage: 0, construction: null };
}

export function sprinklersOf(
  state: Readonly<WorldState>,
): readonly { x: number; y: number; tier: 1 | 2 }[] {
  return state.sprinklers ?? [];
}

/** Count one material across all inventory slots (materials live in the bag, §8.1). */
export function materialCount(state: Readonly<WorldState>, kind: 'wood' | 'stone'): number {
  const itemId = kind === 'wood' ? 'material_wood' : 'material_stone';
  return state.inventory.slots.reduce(
    (sum, stack) => sum + (stack?.itemId === itemId ? stack.count : 0),
    0,
  );
}

export function instancesOf(state: Readonly<WorldState>, defId: string): number {
  return structuresOf(state).filter((s) => s.defId === defId).length;
}

/** Structure whose footprint contains `tile` (built or site), if any. */
export function structureAt(state: Readonly<WorldState>, tile: TilePos): PlacedStructure | null {
  for (const s of structuresOf(state)) {
    const def = BLUEPRINTS_BY_ID.get(s.defId);
    if (!def) continue;
    if (
      tile.x >= s.origin.x &&
      tile.x < s.origin.x + def.size.w &&
      tile.y >= s.origin.y &&
      tile.y < s.origin.y + def.size.h
    ) {
      return s;
    }
  }
  return null;
}

// ---- cost & affordability (GDD §8.2 columns; materials consumed at commit, §8.1) ----

export interface CostDeficit {
  gold: number;
  wood: number;
  stone: number;
}

export function costDeficit(state: Readonly<WorldState>, def: BlueprintDef): CostDeficit {
  return {
    gold: Math.max(0, def.cost.gold - state.economy.gold),
    wood: Math.max(0, (def.cost.wood ?? 0) - materialCount(state, 'wood')),
    stone: Math.max(0, (def.cost.stone ?? 0) - materialCount(state, 'stone')),
  };
}

export function canAfford(state: Readonly<WorldState>, def: BlueprintDef): boolean {
  const d = costDeficit(state, def);
  return d.gold === 0 && d.wood === 0 && d.stone === 0;
}

// ---- catalog rows (GDD §8.2 解锁节奏; PRD 04 US3/US4 — list ALL, grey the future) ----

export type CatalogRowStatus =
  | 'available'
  | 'locked' // farmLevel / requires not met — silhouette + 「Lv N 解锁」 (US3)
  | 'unaffordable' // unlocked, cost not covered — greyed with the deficit (US4)
  | 'limit' // per-blueprint instance cap reached (§8.2 上限)
  | 'in_progress' // farmhouse upgrade under construction (§8.2 升级链)
  | 'done'; // farmhouse stage already reached

export interface BuildCatalogRow {
  def: BlueprintDef;
  status: CatalogRowStatus;
  deficit: CostDeficit;
  /** Existing instances (for the 「已建 n/limit」 tag). */
  count: number;
}

const CATALOG_CATEGORY_ORDER: readonly BlueprintDef['category'][] = [
  'building',
  'station',
  'decoration',
];

function requirementMet(state: Readonly<WorldState>, def: BlueprintDef): boolean {
  for (const req of def.unlock.requires ?? []) {
    // farmhouse_<n> requirements resolve against the upgrade-chain stage (§8.2);
    // any other id resolves against a BUILT structure instance.
    const m = /^farmhouse_(\d)$/.exec(req);
    if (m) {
      if (farmhouseOf(state).stage < Number(m[1])) return false;
    } else if (!structuresOf(state).some((s) => s.defId === req && s.state === 'built')) {
      return false;
    }
  }
  return true;
}

function rowStatus(state: Readonly<WorldState>, def: BlueprintDef): CatalogRowStatus {
  const level = safe('build.effectiveLevel', () => effectiveLevel(state.progress.xp), 1);
  if (level < def.unlock.farmLevel || !requirementMet(state, def)) return 'locked';
  if (def.placement === 'farmhouse') {
    const fh = farmhouseOf(state);
    const target = def.id === 'farmhouse_1' ? 1 : 2;
    if (fh.stage >= target) return 'done';
    if (fh.construction !== null) return 'in_progress';
  } else if (def.limit !== undefined && instancesOf(state, def.id) >= def.limit) {
    return 'limit';
  }
  if (!canAfford(state, def)) return 'unaffordable';
  return 'available';
}

/** Full catalog in §8.2 table order: buildings → upgrades → stations → decorations. */
export function catalogRows(state: Readonly<WorldState>): BuildCatalogRow[] {
  const ordered = [...BLUEPRINTS].sort(
    (a, b) =>
      CATALOG_CATEGORY_ORDER.indexOf(a.category) - CATALOG_CATEGORY_ORDER.indexOf(b.category),
  );
  return ordered.map((def) => ({
    def,
    status: rowStatus(state, def),
    deficit: costDeficit(state, def),
    count: def.placement === 'farmhouse' ? farmhouseOf(state).stage : instancesOf(state, def.id),
  }));
}

// ---- demolish & move (GDD §8.3 拆除与搬迁 table; PRD 04 US28~31) ----

export type DemolishFlow =
  | 'instant' // decoration/station: 即拆即返 100%, no dialog
  | 'confirm_site' // building site = cancel order: single confirm, 100%
  | 'confirm_built'; // built building: double confirm, floor(50%)

export interface RefundPreview {
  gold: number;
  wood: number;
  stone: number;
}

export type DemolishBlock = 'CHEST_NOT_EMPTY' | 'INVENTORY_FULL' | 'NOT_DEMOLISHABLE';

export interface DemolishPlan {
  flow: DemolishFlow;
  refund: RefundPreview;
  /** Present when the §8.3 preconditions refuse the demolition (zero-loss rules). */
  blocked?: DemolishBlock;
}

/** §8.3 refund rates: any site 1.0; built items use the blueprint refundRate. */
export function refundPreview(
  def: BlueprintDef,
  structState: PlacedStructure['state'],
): RefundPreview {
  const rate = structState === 'underConstruction' ? 1.0 : def.refundRate;
  return {
    gold: Math.floor(def.cost.gold * rate),
    wood: Math.floor((def.cost.wood ?? 0) * rate),
    stone: Math.floor((def.cost.stone ?? 0) * rate),
  };
}

/** Items a rack/workshop demolition must hand back (in-progress inputs / done outputs). */
function jobReturnItems(jobs: readonly (ProcessingJob | null)[]): ItemId[] {
  const items: ItemId[] = [];
  for (const job of jobs) {
    if (!job) continue;
    items.push((job.daysLeft > 0 ? job.inputItemId : job.outputItemId) as ItemId);
  }
  return items;
}

/** Can the bag absorb every returned item? Simulated adds on a throwaway clone. */
function inventoryFits(state: Readonly<WorldState>, items: readonly ItemId[]): boolean {
  if (items.length === 0) return true;
  const inv = structuredClone(state.inventory);
  return items.every((itemId) => addInPlace(inv, itemId, 1).rejected === 0);
}

export function demolishPlan(
  state: Readonly<WorldState>,
  structure: PlacedStructure,
): DemolishPlan {
  const def = BLUEPRINTS_BY_ID.get(structure.defId);
  if (!def || !def.demolishable) {
    return { flow: 'instant', refund: { gold: 0, wood: 0, stone: 0 }, blocked: 'NOT_DEMOLISHABLE' };
  }
  const refund = refundPreview(def, structure.state);
  if (structure.state === 'underConstruction') {
    return { flow: 'confirm_site', refund };
  }
  if (structure.data?.kind === 'chest' && structure.data.slots.some((s) => s !== null)) {
    return { flow: 'instant', refund, blocked: 'CHEST_NOT_EMPTY' }; // 非空不可拆 (§8.3)
  }
  if (structure.data?.kind === 'dryingRack' || structure.data?.kind === 'workshop') {
    if (!inventoryFits(state, jobReturnItems(structure.data.jobs))) {
      return { flow: 'instant', refund, blocked: 'INVENTORY_FULL' }; // 放不下拒绝拆 (§8.3)
    }
  }
  return def.category === 'building'
    ? { flow: 'confirm_built', refund }
    : { flow: 'instant', refund };
}

export function movablesOf(state: Readonly<WorldState>): PlacedStructure[] {
  return structuresOf(state).filter((s) => BLUEPRINTS_BY_ID.get(s.defId)?.movable === true);
}

export function demolishablesOf(state: Readonly<WorldState>): PlacedStructure[] {
  return structuresOf(state).filter((s) => BLUEPRINTS_BY_ID.get(s.defId)?.demolishable === true);
}

// ---- sprinkler coverage preview (GDD §3.8/§5.3: tier 1 = 4邻格, tier 2 = 3×3) ----

export function sprinklerCoverage(
  defId: 'sprinkler' | 'sprinkler_advanced',
  tile: TilePos,
): TilePos[] {
  if (defId === 'sprinkler') {
    return [
      { x: tile.x, y: tile.y - 1 },
      { x: tile.x - 1, y: tile.y },
      { x: tile.x + 1, y: tile.y },
      { x: tile.x, y: tile.y + 1 },
    ];
  }
  const tiles: TilePos[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx !== 0 || dy !== 0) tiles.push({ x: tile.x + dx, y: tile.y + dy });
    }
  }
  return tiles;
}

// ---- processing recipes for the facility panels (GDD §8.2; ruling A-12) ----

export interface ProcessingRecipeView {
  outputItemId: ItemId;
  days: number;
  /** Base sale price of the output (display; final pricing stays in unitSalePrice). */
  outputPrice: number;
}

/**
 * What would loading `inputItemId` into this facility produce?
 * workshop: crop → jam (2 nights) / egg → mayonnaise (1 night); rack: crop → dried (1).
 */
export function processingRecipeFor(
  kind: 'workshop' | 'dryingRack',
  inputItemId: string,
): ProcessingRecipeView | null {
  const def = safe('build.itemDef', () => getItemDef(inputItemId), null);
  if (!def) return null;
  if (kind === 'workshop' && def.id === 'animal_egg') {
    return {
      outputItemId: 'artisan_mayonnaise',
      days: PROCESSING.MAYONNAISE.days,
      outputPrice: PROCESSING.MAYONNAISE.price,
    };
  }
  if (def.category !== 'crop' || def.cropId === undefined || def.sellPrice === undefined) {
    return null;
  }
  return kind === 'workshop'
    ? {
        outputItemId: jamItemId(def.cropId),
        days: PROCESSING.JAM.days,
        outputPrice: PROCESSING.JAM.price(def.sellPrice),
      }
    : {
        outputItemId: driedItemId(def.cropId),
        days: PROCESSING.DRIED.days,
        outputPrice: PROCESSING.DRIED.price(def.sellPrice),
      };
}

/** Inventory slots eligible as processing inputs for this facility kind. */
export function eligibleInputs(
  state: Readonly<WorldState>,
  kind: 'workshop' | 'dryingRack',
): { slot: number; itemId: ItemId; count: number; recipe: ProcessingRecipeView }[] {
  const rows: { slot: number; itemId: ItemId; count: number; recipe: ProcessingRecipeView }[] = [];
  state.inventory.slots.forEach((stack, slot) => {
    if (!stack) return;
    const recipe = processingRecipeFor(kind, stack.itemId);
    if (recipe) rows.push({ slot, itemId: stack.itemId as ItemId, count: stack.count, recipe });
  });
  return rows;
}

// ---- confirm-dialog payloads (CONFIRM = dialog pause source, §8.3) ----

export type BuildConfirmRequest =
  | { kind: 'placeBuilding'; defId: string; origin: TilePos }
  | { kind: 'farmhouseUpgrade'; defId: 'farmhouse_1' | 'farmhouse_2' }
  | { kind: 'demolish'; instanceId: string; flow: 'confirm_site' | 'confirm_built' };

/** Ghost footprint origin so the cursor sits at the visual centre of w×h. */
export function originForCursor(def: BlueprintDef, cursor: TilePos): TilePos {
  return {
    x: cursor.x - Math.floor((def.size.w - 1) / 2),
    y: cursor.y - Math.floor((def.size.h - 1) / 2),
  };
}
