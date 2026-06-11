/**
 * economy.ts — wallet, single pricing entry point, shipping bin, shop
 * (GDD §4.1 wallet, §4.2 overnight settlement, §4.3 shop, §4.5 pricing pipeline).
 *
 * Hard rules:
 * - Selling crops is overnight-only via the shippingBin (ruling A-1); seeds refund
 *   instantly at 100% (ruling A-11; property test: any buy→refund sequence is gold-neutral);
 * - rounding discipline: multiply everything first, floor ONCE (ruling A-12);
 * - catalog is a pure function of (effectiveLevel, purchases) — anti-FOMO clauses are
 *   constitutional (GDD §4.3); M1 "purchases" = the ToolTiers (the only oneTime entries);
 * - tools & quest items are unsellable at category level AND in the sell tab (GDD §4.2).
 */
import { ECONOMY, RELIEF, SHOP_CATALOG_M1 } from './data/constants.js';
import type { ShopEntryDef } from './data/constants.js';
import { ITEMS_BY_ID, seedItemId } from './data/items.js';
import type { ItemDef, ItemId } from './data/items.js';
import { addInPlace, maxAddable, removeAtInPlace } from './inventory.js';
import { bumpCounterInPlace, effectiveLevel } from './leveling.js';
import type { ItemStack, SimEvent, WorldState } from './types.js';

// ---- wallet (GDD §4.1; pure functions, events emitted by callers/facade) ----

export type GoldSource = 'shipping' | 'refund' | 'achievement' | 'quest' | 'salvage';
export type GoldSink =
  | 'seed'
  | 'tool_upgrade'
  | 'backpack'
  | 'material'
  | 'building'
  | 'decoration';

/** Add gold, clamped at GOLD_CAP. Returns the new balance. */
export function credit(gold: number, amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`credit: amount must be a non-negative integer, got ${amount}`);
  }
  return Math.min(gold + amount, ECONOMY.GOLD_CAP);
}

/** Spend gold; never negative — insufficient funds yields the error token (GDD §4.1). */
export function debit(gold: number, amount: number): number | 'INSUFFICIENT_GOLD' {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`debit: amount must be a non-negative integer, got ${amount}`);
  }
  return amount > gold ? 'INSUFFICIENT_GOLD' : gold - amount;
}

// ---- pricing (GDD §4.5; the ONLY sale-price calculation in the game) ----

export type Quality = 'normal'; // M1: quality multiplier is constant 1 (M3 adds silver/gold)

const QUALITY_MULT: Record<Quality, number> = { normal: 1 };

export interface PriceCtx {
  /** M1: always null (profession lands M3). */
  profession: 'horticulturist' | 'artisan' | null;
}

/** Multiply all multipliers first, floor once (ruling A-12). */
export function unitSalePrice(item: ItemDef, quality: Quality, ctx: PriceCtx): number {
  if (item.sellPrice === undefined) {
    throw new Error(`unitSalePrice: item "${item.id}" is not sellable (category ${item.category})`);
  }
  let p = item.sellPrice;
  p *= QUALITY_MULT[quality];
  if (ctx.profession === 'horticulturist' && item.category === 'crop') p *= 1.1;
  if (ctx.profession === 'artisan' && item.category === 'artisan_good') p *= 1.25; // M3
  return Math.floor(p); // single floor after all multipliers
}

// ---- shipping bin (GDD §4.2 state machine: EMPTY → HOLDING ↔ … → SETTLING → EMPTY) ----

/** Categories the bin accepts in M1: crops + forage materials (GDD §4.2/§6.1, B-10). */
function isBinSellable(def: ItemDef): boolean {
  return (
    def.sellPrice !== undefined &&
    (def.category === 'crop' || def.category === 'material' || def.category === 'artisan_good')
  );
}

/** Merge `count` of `itemId` into the bin, respecting the 99 stack cap (save schema). */
function addToBinInPlace(bin: ItemStack[], itemId: string, count: number): void {
  let remaining = count;
  for (const stack of bin) {
    if (remaining === 0) return;
    if (stack.itemId === itemId && stack.count < 99) {
      const take = Math.min(99 - stack.count, remaining);
      stack.count += take;
      remaining -= take;
    }
  }
  while (remaining > 0) {
    const take = Math.min(99, remaining);
    bin.push({ itemId, count: take });
    remaining -= take;
  }
}

/**
 * Day-time deposit; reversible until sleep locks the bin (GDD §4.2).
 * No bin SimEvent exists in the §12 vocabulary — the bin UI re-reads state.
 */
export function depositToBin(
  state: WorldState,
  slot: number,
  count: number,
): { state: WorldState; events: SimEvent[] } {
  const stack = state.inventory.slots[slot];
  if (!stack || count <= 0) return { state, events: [] };
  const def = ITEMS_BY_ID.get(stack.itemId);
  if (!def || !isBinSellable(def)) return { state, events: [] }; // tools/seeds/quest gated (§4.2)
  const next = structuredClone(state);
  const moved = removeAtInPlace(next.inventory, slot, count);
  addToBinInPlace(next.economy.shippingBin, stack.itemId, moved);
  return { state: next, events: [] };
}

export function withdrawFromBin(
  state: WorldState,
  index: number,
  count: number,
): { state: WorldState; events: SimEvent[] } {
  const stack = state.economy.shippingBin[index];
  if (!stack || count <= 0) return { state, events: [] };
  if (!ITEMS_BY_ID.has(stack.itemId)) return { state, events: [] };
  const next = structuredClone(state);
  const binStack = next.economy.shippingBin[index];
  const want = Math.min(count, binStack.count);
  const { added } = addInPlace(next.inventory, binStack.itemId as ItemId, want);
  if (added === 0) return { state, events: [] }; // inventory full — bin keeps everything
  binStack.count -= added;
  if (binStack.count === 0) next.economy.shippingBin.splice(index, 1);
  return { state: next, events: [] };
}

/** [F] ship-all: every sellable stack in the inventory → bin (≤4-key budget, GDD §4.2). */
export function depositAllToBin(state: WorldState): { state: WorldState; events: SimEvent[] } {
  const next = structuredClone(state);
  let movedAny = false;
  for (let slot = 0; slot < next.inventory.slots.length; slot++) {
    const stack = next.inventory.slots[slot];
    if (!stack) continue;
    const def = ITEMS_BY_ID.get(stack.itemId);
    if (!def || !isBinSellable(def)) continue;
    const moved = removeAtInPlace(next.inventory, slot, stack.count);
    addToBinInPlace(next.economy.shippingBin, stack.itemId, moved);
    movedAny = true;
  }
  return movedAny ? { state: next, events: [] } : { state, events: [] };
}

/**
 * NightUpdate #1 settleShipping (GDD §2.5): atomic — price → credit → clear bin →
 * collectionLog first-sale records → one ItemSold event per (aggregated) line; empty
 * bin settles as "nothing sold today" (not an error). sellCount / goldEarned /
 * soldCrops:<id> counters bump here.
 */
export function settleShipping(state: WorldState): {
  state: WorldState;
  events: SimEvent[];
  shipped: { itemId: string; count: number; gold: number }[];
} {
  const next = structuredClone(state);
  const events: SimEvent[] = [];
  const shipped: { itemId: string; count: number; gold: number }[] = [];
  const ctx: PriceCtx = { profession: next.progress.profession };

  const aggregated = new Map<string, { count: number; gold: number }>();
  for (const stack of next.economy.shippingBin) {
    const def = ITEMS_BY_ID.get(stack.itemId);
    if (!def || def.sellPrice === undefined) continue; // unknown ids were dropped at hydrate
    const gold = unitSalePrice(def, 'normal', ctx) * stack.count;
    const line = aggregated.get(stack.itemId) ?? { count: 0, gold: 0 };
    line.count += stack.count;
    line.gold += gold;
    aggregated.set(stack.itemId, line);
  }

  let total = 0;
  for (const [itemId, line] of aggregated) {
    total += line.gold;
    shipped.push({ itemId, count: line.count, gold: line.gold });
    if (!next.economy.collectionLog[itemId]) {
      next.economy.collectionLog[itemId] = { firstSoldDay: next.time.day };
    }
    bumpCounterInPlace(next, 'sellCount', line.count);
    const def = ITEMS_BY_ID.get(itemId);
    if (def?.category === 'crop' && def.cropId) {
      bumpCounterInPlace(next, `soldCrops:${def.cropId}`, line.count);
    }
    events.push({ type: 'ItemSold', itemId: itemId as ItemId, count: line.count, gold: line.gold });
  }

  next.economy.shippingBin = [];
  if (total > 0) {
    const before = next.economy.gold;
    next.economy.gold = credit(before, total);
    const delta = next.economy.gold - before; // GOLD_CAP clamp can shave the credited part
    bumpCounterInPlace(next, 'goldEarned', delta);
    events.push({ type: 'GoldChanged', gold: next.economy.gold, delta });
  }
  return { state: next, events, shipped };
}

// ---- shop (GDD §4.3; pure catalog, granted = min(requested, affordable, fits)) ----

export type ShopAvailability = 'hidden' | 'locked' | 'available' | 'owned';

export interface ShopEntryView {
  entry: ShopEntryDef;
  availability: ShopAvailability;
  /** NEW badge for the first game day after unlock (GDD §4.3). */
  isNew: boolean;
}

/** M1 "purchases" are encoded in ToolTiers (the only oneTime entries are tool upgrades). */
function toolUpgradeOwned(state: WorldState, entryId: string): boolean {
  switch (entryId) {
    case 'tool_hoe_copper':
      return state.tools.hoe >= 2;
    case 'tool_hoe_gold':
      return state.tools.hoe >= 3;
    case 'tool_can_copper':
      return state.tools.wateringCan >= 2;
    case 'tool_can_gold':
      return state.tools.wateringCan >= 3;
    default:
      return false;
  }
}

function entryAvailability(state: WorldState, entry: ShopEntryDef, lvl: number): ShopAvailability {
  if (entry.oneTime && toolUpgradeOwned(state, entry.entryId)) return 'owned';
  if (entry.unlockLevel > lvl) {
    // Next 1–2 levels show as silhouettes ("Lv N 解锁"); farther entries fold (§4.3).
    return entry.unlockLevel <= lvl + 2 ? 'locked' : 'hidden';
  }
  if (entry.requires && !toolUpgradeOwned(state, entry.requires)) return 'locked';
  return 'available';
}

/** Pure function of (effectiveLevel, purchases) — property-tested (GDD §4.3). */
export function catalog(state: WorldState): ShopEntryView[] {
  const lvl = effectiveLevel(state.progress.xp);
  return SHOP_CATALOG_M1.map((entry) => {
    const availability = entryAvailability(state, entry, lvl);
    const isNew =
      availability === 'available' &&
      state.economy.newEntriesSeenDay[entry.entryId] === state.time.day;
    return { entry, availability, isNew };
  });
}

function applyToolUpgradeInPlace(state: WorldState, entryId: string): void {
  switch (entryId) {
    case 'tool_hoe_copper':
      state.tools.hoe = 2;
      break;
    case 'tool_hoe_gold':
      state.tools.hoe = 3;
      break;
    case 'tool_can_copper':
      state.tools.wateringCan = 2;
      break;
    case 'tool_can_gold':
      state.tools.wateringCan = 3;
      break;
    default:
      throw new Error(`Unknown tool upgrade entry: ${entryId}`);
  }
}

/**
 * Purchase per the §4.3 state machine. Blocked results carry the SINGLE reason for the
 * toast ('LOCKED' | 'ALREADY_OWNED' | 'REQUIRES_PREREQUISITE' | 'INSUFFICIENT_GOLD' |
 * 'INVENTORY_FULL' | 'UNKNOWN_ENTRY'). Upgrades take effect instantly (§3.5).
 */
export function buy(
  state: WorldState,
  entryId: string,
  requested: number,
): { state: WorldState; events: SimEvent[]; granted: number; cost: number } | { blocked: string } {
  const entry = SHOP_CATALOG_M1.find((e) => e.entryId === entryId);
  if (!entry) return { blocked: 'UNKNOWN_ENTRY' };
  const lvl = effectiveLevel(state.progress.xp);
  const availability = entryAvailability(state, entry, lvl);
  if (availability === 'owned') return { blocked: 'ALREADY_OWNED' };
  if (availability !== 'available') {
    return entry.unlockLevel <= lvl && entry.requires
      ? { blocked: 'REQUIRES_PREREQUISITE' }
      : { blocked: 'LOCKED' };
  }

  if (entry.kind === 'tool_upgrade') {
    const paid = debit(state.economy.gold, entry.price);
    if (paid === 'INSUFFICIENT_GOLD') return { blocked: 'INSUFFICIENT_GOLD' };
    const next = structuredClone(state);
    next.economy.gold = paid;
    applyToolUpgradeInPlace(next, entry.entryId);
    bumpCounterInPlace(next, 'toolUpgrades', 1);
    const events: SimEvent[] = [
      { type: 'GoldChanged', gold: next.economy.gold, delta: -entry.price },
    ];
    return { state: next, events, granted: 1, cost: entry.price };
  }

  // Seed entry: granted = min(requested, affordable, fits) (§4.3).
  if (!entry.cropId) return { blocked: 'UNKNOWN_ENTRY' }; // data error guard
  const itemId = seedItemId(entry.cropId);
  const want = Math.max(0, Math.trunc(requested));
  const affordable = Math.floor(state.economy.gold / entry.price);
  const fits = maxAddable(state.inventory, itemId);
  const granted = Math.min(want, affordable, fits);
  if (granted <= 0) {
    return { blocked: affordable === 0 ? 'INSUFFICIENT_GOLD' : 'INVENTORY_FULL' };
  }
  const cost = granted * entry.price;
  const next = structuredClone(state);
  next.economy.gold -= cost;
  addInPlace(next.inventory, itemId, granted);
  const events: SimEvent[] = [
    { type: 'GoldChanged', gold: next.economy.gold, delta: -cost },
    { type: 'ItemPicked', itemId, count: granted }, // straight into the backpack (§6.4)
  ];
  return { state: next, events, granted, cost };
}

/** Seeds only, 100% of purchase price, instant (ruling A-11; no arbitrage by design). */
export function refundSeeds(
  state: WorldState,
  slot: number,
  count: number,
): { state: WorldState; events: SimEvent[]; gold: number } {
  const stack = state.inventory.slots[slot];
  if (!stack || count <= 0) return { state, events: [], gold: 0 };
  const def = ITEMS_BY_ID.get(stack.itemId);
  if (!def || def.category !== 'seed' || def.sellPrice === undefined) {
    return { state, events: [], gold: 0 }; // refund channel is seeds-only (A-11)
  }
  const next = structuredClone(state);
  const removed = removeAtInPlace(next.inventory, slot, count);
  const gold = removed * def.sellPrice; // seedPrice, profession multipliers never apply (§4.5)
  next.economy.gold = credit(next.economy.gold, gold);
  // A refund is a refund, not a trade: no sellCount, no collectionLog (A-11).
  const events: SimEvent[] = [{ type: 'GoldChanged', gold: next.economy.gold, delta: gold }];
  return { state: next, events, gold };
}

/**
 * Morning soft-lock relief check (GDD §4.8): gold < 10 ∧ no seeds ∧ no planted crops ∧
 * empty bin → grant 4 radish_quick seeds ("邻居的救济"). Sim tests assert script R
 * never triggers it. Called by runNight on the new-morning state.
 */
export function morningReliefCheck(state: WorldState): { state: WorldState; events: SimEvent[] } {
  const hasSeeds = state.inventory.slots.some(
    (s) => s !== null && ITEMS_BY_ID.get(s.itemId)?.category === 'seed',
  );
  const hasPlantedCrops = Object.values(state.farm.tiles).some((t) => t.crop !== null);
  if (
    state.economy.gold >= RELIEF.GOLD_BELOW ||
    hasSeeds ||
    hasPlantedCrops ||
    state.economy.shippingBin.length > 0
  ) {
    return { state, events: [] };
  }
  const next = structuredClone(state);
  const itemId = seedItemId(RELIEF.GRANT_CROP);
  const { added } = addInPlace(next.inventory, itemId, RELIEF.GRANT_SEEDS);
  if (added === 0) return { state, events: [] };
  return { state: next, events: [{ type: 'ItemPicked', itemId, count: added }] };
}

// re-export for convenience of the economy implementer
export type { ItemStack };
