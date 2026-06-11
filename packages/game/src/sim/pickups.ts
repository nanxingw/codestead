/**
 * pickups.ts — edge forage (6 wood + 4 stone) and daily pickup spots (3 wildflowers)
 * (GDD §1.3 rows "边缘采集带"/"每日拾取点", §2.5 #6 refreshPickups).
 *
 * Zero-loss semantics: unpicked items are simply overwritten by the next refresh —
 * no stacking, no reminders, no penalty. Pickup XP = 0 (GDD §5.2); value flows through
 * the shipping bin (wood 5g / stone 3g / wildflower 8g, no instant-sale channel).
 * Spot counts (6/4/3 = DAILY_PICKUPS) are a map-contract concern validated at build
 * time; this module simply mirrors map.pickupSpots.
 */
import type { ItemId } from './data/items.js';
import { addInPlace, canAdd } from './inventory.js';
import type { MapMeta, PickupKind, SimEvent, WorldState } from './types.js';

const PICKUP_ITEM: Record<PickupKind, ItemId> = {
  wood: 'material_wood',
  stone: 'material_stone',
  wildflower: 'forage_wildflower',
};

/** NightUpdate #6 (GDD §2.5): repopulate all pickup spots for the new morning. */
export function refreshPickups(state: WorldState, map: MapMeta): WorldState {
  const next = structuredClone(state);
  next.pickups = map.pickupSpots.map((spot) => ({
    spotId: spot.id,
    kind: spot.kind,
    available: true,
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
  if (!canAdd(state.inventory, itemId, 1)) return { state, events: [] }; // zero loss
  const next = structuredClone(state);
  const nextSpot = next.pickups.find((p) => p.spotId === spotId);
  if (!nextSpot) return { state, events: [] };
  nextSpot.available = false;
  addInPlace(next.inventory, itemId, 1);
  return { state: next, events: [{ type: 'ItemPicked', itemId, count: 1 }] };
}
