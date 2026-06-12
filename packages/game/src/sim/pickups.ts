/**
 * pickups.ts — edge forage, daily pickup spots, and (M3) the merged material system
 * (GDD §1.3 rows "边缘采集带"/"每日拾取点", §2.5 #6 refreshPickups, §8.1 materials).
 *
 * M3 (GDD §8.1 / PRD 04 US32~33): the M1 edge forage (6 wood + 4 stone) and the new
 * axe/pickaxe resource clearing merge into ONE material system —
 *   - daily edge regen rises to 10 wood + 6 stone (DAILY_MATERIAL_REGEN_M3), spread
 *     deterministically over the fixed map spots (spot COUNTS stay the §1.5 map
 *     contract: 6/4/3; per-spot unit counts make up the difference);
 *   - map trees/boulders (MapMeta.resourceNodes) clear permanently for 5 wood / 3
 *     stone (RESOURCE_YIELD) with the tierless axe/pickaxe in the backpack;
 *     `clearedResourceNodes` persists in SaveDoc v2 so a reload never respawns them.
 *
 * Zero-loss semantics: unpicked items are simply overwritten by the next refresh —
 * no stacking, no reminders, no penalty; a full backpack blocks any grant entirely.
 * Pickup/clearing XP = 0 (GDD §5.2); value flows through the shipping bin
 * (wood 5g / stone 3g / wildflower 8g, no instant-sale channel).
 */
import { DAILY_MATERIAL_REGEN_M3, RESOURCE_YIELD } from './data/buildings.js';
import type { ItemId } from './data/items.js';
import { addInPlace, canAdd } from './inventory.js';
import type { MapMeta, PickupKind, SimEvent, WorldState } from './types.js';

const PICKUP_ITEM: Record<PickupKind, ItemId> = {
  wood: 'material_wood',
  stone: 'material_stone',
  wildflower: 'forage_wildflower',
};

/**
 * Deterministic per-spot unit counts: `total` units over `spots` spots, the first
 * (total mod spots) spots carry one extra (map order = stable order).
 */
function spreadCounts(total: number, spots: number): number[] {
  if (spots <= 0) return [];
  const base = Math.floor(total / spots);
  const extra = total % spots;
  return Array.from({ length: spots }, (_, i) => base + (i < extra ? 1 : 0));
}

/** NightUpdate #6 (GDD §2.5): repopulate all pickup spots for the new morning. */
export function refreshPickups(state: WorldState, map: MapMeta): WorldState {
  const next = structuredClone(state);
  const dailyTotals: Record<PickupKind, number> = {
    wood: DAILY_MATERIAL_REGEN_M3.wood, // 10 (§8.1, M3 merged system)
    stone: DAILY_MATERIAL_REGEN_M3.stone, // 6
    wildflower: map.pickupSpots.filter((s) => s.kind === 'wildflower').length, // 1 each (§1.3)
  };
  const perKindCounts: Record<PickupKind, number[]> = {
    wood: spreadCounts(dailyTotals.wood, map.pickupSpots.filter((s) => s.kind === 'wood').length),
    stone: spreadCounts(
      dailyTotals.stone,
      map.pickupSpots.filter((s) => s.kind === 'stone').length,
    ),
    wildflower: spreadCounts(
      dailyTotals.wildflower,
      map.pickupSpots.filter((s) => s.kind === 'wildflower').length,
    ),
  };
  const cursor: Record<PickupKind, number> = { wood: 0, stone: 0, wildflower: 0 };
  next.pickups = map.pickupSpots.map((spot) => ({
    spotId: spot.id,
    kind: spot.kind,
    available: true,
    count: perKindCounts[spot.kind][cursor[spot.kind]++] ?? 1,
  }));
  return next;
}

/** Bare-hand E pickup into the backpack; full backpack blocks with zero loss (§1.3). */
export function pickup(
  state: WorldState,
  spotId: string,
): { state: WorldState; events: SimEvent[] } {
  const spot = state.pickups.find((p) => p.spotId === spotId);
  if (!spot || !spot.available) return { state, events: [] };
  const itemId = PICKUP_ITEM[spot.kind];
  const count = spot.count ?? 1; // absent = pre-M3 fixture semantics (types.ts note)
  if (!canAdd(state.inventory, itemId, count)) return { state, events: [] }; // zero loss
  const next = structuredClone(state);
  const nextSpot = next.pickups.find((p) => p.spotId === spotId);
  if (!nextSpot) return { state, events: [] };
  nextSpot.available = false;
  addInPlace(next.inventory, itemId, count);
  return { state: next, events: [{ type: 'ItemPicked', itemId, count }] };
}

// ---- resource nodes (M3, GDD §8.1: axe clears trees, pickaxe clears boulders) ----

export type ClearResourceError =
  | 'UNKNOWN_NODE' // not in MapMeta.resourceNodes
  | 'ALREADY_CLEARED' // permanence is the point (§8.1 initial stock)
  | 'MISSING_TOOL' // axe for trees / pickaxe for boulders must be in the backpack
  | 'INVENTORY_FULL'; // the full yield must fit — zero loss

export type ClearResourceResult =
  | { ok: true; state: WorldState; events: SimEvent[] }
  | { ok: false; error: ClearResourceError };

/**
 * Clear one map tree/boulder (E-interaction with the matching tool selected; routing
 * via queryAction/dispatch is the facade's wiring). Yield is all-or-nothing into the
 * backpack; the node id enters `clearedResourceNodes` (persisted in SaveDoc v2) so the
 * clearing is permanent across reloads. Grants ZERO XP (§5.2 采集纪律).
 */
export function clearResourceNode(
  state: WorldState,
  map: MapMeta,
  nodeId: string,
): ClearResourceResult {
  const node = map.resourceNodes?.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: 'UNKNOWN_NODE' };
  if (state.clearedResourceNodes?.includes(nodeId)) return { ok: false, error: 'ALREADY_CLEARED' };
  const tool: ItemId = node.kind === 'tree' ? 'axe' : 'pickaxe';
  if (!state.inventory.slots.some((s) => s !== null && s.itemId === tool)) {
    return { ok: false, error: 'MISSING_TOOL' };
  }
  const itemId: ItemId = node.kind === 'tree' ? 'material_wood' : 'material_stone';
  const count = node.kind === 'tree' ? RESOURCE_YIELD.treeWood : RESOURCE_YIELD.boulderStone;
  if (!canAdd(state.inventory, itemId, count)) return { ok: false, error: 'INVENTORY_FULL' };

  const next = structuredClone(state);
  next.clearedResourceNodes ??= [];
  next.clearedResourceNodes.push(nodeId);
  addInPlace(next.inventory, itemId, count);
  return { ok: true, state: next, events: [{ type: 'ItemPicked', itemId, count }] };
}
