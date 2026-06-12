/**
 * coop.ts — chicken coop subsystem (M3, GDD §8.2 coop row; PRD 04 §B13~15).
 *
 * Settled numbers (data/buildings.ts COOP, rulings A-6/A-7): Lv6 building, completion
 * grants 2 hens; ≤4 hens; buy 200g / sell-back 100g; 1 egg/hen per settlement night;
 * hens are feed-free and never die (动物玩法深化 is explicitly out of scope, PRD 04).
 *
 * Zero-anxiety: eggs only accrue on settlement nights (NightUpdate #5), accumulate
 * without cap and wait forever; fast-forward N nights with 4 hens ⇒ exactly 4N eggs
 * (PRD 04 test contract). Collection is a deliberate E-interaction at the egg spot
 * inside the coop interior (产出是「去拿」, PRD 04 US15) — eggs never auto-enter the bag.
 *
 * ⚙ Hen trading entry (PRD 04 待裁决 3 — GDD never names the venue): settled by the
 * contract pass as an INTERACTION INSIDE THE COOP INTERIOR (not a shop catalog row).
 * Rationale: keeps SHOP_CATALOG untouched (its M1 table is a frozen GDD §4.3 contract),
 * matches the §8.3 interior interaction model (roosts + egg spot already live there),
 * and scales naturally to the buy/sell pair. Recorded in openQuestions for backfill.
 */
import { COOP } from './data/buildings.js';
import { credit, debit } from './economy.js';
import { addInPlace, maxAddable } from './inventory.js';
import type { SimEvent, WorldState } from './types.js';

export { COOP };

/** A built coop instance and its typed data, or null. */
function coopDataOf(
  state: WorldState,
  instanceId: string,
): { hens: number; eggsReady: number } | null {
  const s = (state.structures ?? []).find((x) => x.instanceId === instanceId);
  if (!s || s.state !== 'built' || s.data?.kind !== 'coop') return null;
  return s.data;
}

export type CoopError =
  | 'UNKNOWN_INSTANCE' // not a built coop instance
  | 'COOP_FULL' // hens === MAX_HENS
  | 'NO_HENS' // sell-back with zero hens
  | 'NO_EGGS' // collect with eggsReady === 0
  | 'INSUFFICIENT_GOLD'
  | 'INVENTORY_FULL'; // egg collection blocks at full bag, zero loss (§6.9 pattern)

export type CoopResult =
  | { ok: true; state: WorldState; events: SimEvent[] }
  | { ok: false; error: CoopError };

/** Buy one hen (200g, ruling A-6) at the coop interior trade interaction. */
export function buyHen(state: WorldState, instanceId: string): CoopResult {
  const data = coopDataOf(state, instanceId);
  if (!data) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  if (data.hens >= COOP.MAX_HENS) return { ok: false, error: 'COOP_FULL' };
  const paid = debit(state.economy.gold, COOP.HEN_BUY_PRICE);
  if (paid === 'INSUFFICIENT_GOLD') return { ok: false, error: 'INSUFFICIENT_GOLD' };

  const next = structuredClone(state);
  const nextData = coopDataOf(next, instanceId);
  if (!nextData) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  next.economy.gold = paid;
  nextData.hens += 1;
  return {
    ok: true,
    state: next,
    events: [{ type: 'GoldChanged', gold: next.economy.gold, delta: -COOP.HEN_BUY_PRICE }],
  };
}

/** Sell one hen back (100g, ruling A-6). Eggs already laid are unaffected. */
export function sellHen(state: WorldState, instanceId: string): CoopResult {
  const data = coopDataOf(state, instanceId);
  if (!data) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  if (data.hens <= 0) return { ok: false, error: 'NO_HENS' };

  const next = structuredClone(state);
  const nextData = coopDataOf(next, instanceId);
  if (!nextData) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  nextData.hens -= 1;
  next.economy.gold = credit(next.economy.gold, COOP.HEN_SELL_PRICE);
  return {
    ok: true,
    state: next,
    events: [{ type: 'GoldChanged', gold: next.economy.gold, delta: COOP.HEN_SELL_PRICE }],
  };
}

/**
 * Collect ALL ready eggs at the egg spot (E-interaction): moves min(eggsReady, bag
 * space) `animal_egg` items into the inventory; the remainder stays ready (zero loss).
 */
export function collectEggs(state: WorldState, instanceId: string): CoopResult {
  const data = coopDataOf(state, instanceId);
  if (!data) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  if (data.eggsReady <= 0) return { ok: false, error: 'NO_EGGS' };
  const take = Math.min(data.eggsReady, maxAddable(state.inventory, 'animal_egg'));
  if (take <= 0) return { ok: false, error: 'INVENTORY_FULL' }; // eggs wait forever

  const next = structuredClone(state);
  const nextData = coopDataOf(next, instanceId);
  if (!nextData) return { ok: false, error: 'UNKNOWN_INSTANCE' };
  addInPlace(next.inventory, 'animal_egg', take);
  nextData.eggsReady -= take;
  return {
    ok: true,
    state: next,
    events: [{ type: 'ItemPicked', itemId: 'animal_egg', count: take }],
  };
}

/**
 * NightUpdate #5 produceAnimals (§2.5; runs AFTER construction & processing, §8.4):
 * every BUILT coop gains hens × EGGS_PER_HEN_PER_NIGHT eggs. Sites produce nothing.
 * Pure per-night step — the fast-forward seam iterates it. eggsReady accumulates
 * WITHOUT cap (PRD 04 acceptance: 满 4 鸡快进 N 天 ⇒ 恰 4N 蛋).
 */
export function produceAnimalsInPlace(state: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  for (const s of state.structures ?? []) {
    if (s.state !== 'built' || s.data?.kind !== 'coop') continue;
    const laid = s.data.hens * COOP.EGGS_PER_HEN_PER_NIGHT;
    if (laid <= 0) continue;
    s.data.eggsReady += laid;
    events.push({ type: 'EggsProduced', instanceId: s.instanceId, count: laid });
  }
  return events;
}
