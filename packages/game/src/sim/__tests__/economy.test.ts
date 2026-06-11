/**
 * economy.ts contract tests — wallet, single pricing entry point, shipping-bin
 * settlement reconciliation, shop buy/refund (zero-arbitrage property), relief check
 * (GDD §4.1 / §4.2 / §4.3 / §4.5 / §4.8). Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import {
  buy,
  catalog,
  credit,
  debit,
  morningReliefCheck,
  refundSeeds,
  unitSalePrice,
} from '../economy.js';
import { createSim } from '../sim.js';
import { getItemDef } from '../data/items.js';
import { ECONOMY, RELIEF } from '../data/constants.js';
import type { TileState, WorldState } from '../types.js';
import {
  TEST_MAP,
  countItem,
  defaultSlots,
  makeSave,
  makeTestRng,
  makeWorldState,
  moduleReady,
  stack,
  xpForLevel,
} from './fixtures.js';

const WALLET_READY = moduleReady(() => debit(credit(0, 1), 1));
const PRICE_READY = moduleReady(() =>
  unitSalePrice(getItemDef('crop_turnip'), 'normal', { profession: null }),
);
const SHOP_READY = moduleReady(() => {
  const r = buy(makeWorldState(), 'seed_radish_quick', 1);
  if ('state' in r) refundSeeds(r.state, 2, 1);
  catalog(makeWorldState());
});
const RELIEF_READY = moduleReady(() => morningReliefCheck(makeWorldState()));
const FACADE_READY = moduleReady(() => {
  const sim = createSim(makeSave(), TEST_MAP);
  sim.sleep();
});

function progressAt(xp: number): WorldState['progress'] {
  return { xp, profession: null, counters: {}, achievements: [], xpHistory: [] };
}

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(WALLET_READY).toBe(true);
  expect(PRICE_READY).toBe(true);
  expect(SHOP_READY).toBe(true);
  expect(RELIEF_READY).toBe(true);
  expect(FACADE_READY).toBe(true);
});

describe('wallet (GDD §4.1 — non-negative int, clamp at cap)', () => {
  it('credit adds and clamps at GOLD_CAP without overflow', () => {
    expect(credit(100, 50)).toBe(150);
    expect(credit(ECONOMY.GOLD_CAP - 5, 100)).toBe(ECONOMY.GOLD_CAP);
    expect(credit(ECONOMY.GOLD_CAP, 1)).toBe(ECONOMY.GOLD_CAP);
  });

  it('debit spends within balance and returns the error token when short', () => {
    expect(debit(100, 100)).toBe(0);
    expect(debit(100, 40)).toBe(60);
    expect(debit(100, 101)).toBe('INSUFFICIENT_GOLD'); // never a negative balance
    expect(debit(0, 1)).toBe('INSUFFICIENT_GOLD');
  });
});

describe('unitSalePrice — the ONLY pricing entry (GDD §4.5)', () => {
  it('M1 base path: quality 1 × no profession = base sellPrice', () => {
    expect(unitSalePrice(getItemDef('crop_radish_quick'), 'normal', { profession: null })).toBe(18);
    expect(unitSalePrice(getItemDef('crop_cabbage'), 'normal', { profession: null })).toBe(178);
    expect(unitSalePrice(getItemDef('material_wood'), 'normal', { profession: null })).toBe(5);
  });

  it('horticulturist multiplies crops ×1.10 with a single final floor (ruling A-12)', () => {
    const ctx = { profession: 'horticulturist' as const };
    expect(unitSalePrice(getItemDef('crop_turnip'), 'normal', ctx)).toBe(41); // floor(38×1.1)
    expect(unitSalePrice(getItemDef('crop_cabbage'), 'normal', ctx)).toBe(195); // floor(195.8)
    expect(unitSalePrice(getItemDef('crop_potato'), 'normal', ctx)).toBe(97); // floor(97.9)
    // category gate: materials are NOT crops — no bonus
    expect(unitSalePrice(getItemDef('material_wood'), 'normal', ctx)).toBe(5);
  });
});

describe('shop (GDD §4.3 — granted clamp, oneTime, prerequisites)', () => {
  it('granted = min(requested, affordable, fits): 999 radish on 100g grants 10', () => {
    const result = buy(makeWorldState(), 'seed_radish_quick', 999);
    expect('blocked' in result).toBe(false);
    if ('blocked' in result) return;
    expect(result.granted).toBe(10);
    expect(result.cost).toBe(100);
    expect(result.state.economy.gold).toBe(0);
    expect(countItem(result.state.inventory, 'seed_radish_quick')).toBe(10);
  });

  it('level-locked entries cannot be bought (potato needs Lv2)', () => {
    const result = buy(makeWorldState(), 'seed_potato', 1);
    // either a blocked token or granted 0 — never a grant
    if ('blocked' in result) {
      expect(result.blocked).toBeTruthy();
    } else {
      expect(result.granted).toBe(0);
    }
  });

  it('oneTime tool upgrade applies instantly and cannot be bought twice (§4.3/§3.5)', () => {
    const state = makeWorldState({
      progress: progressAt(xpForLevel(2)),
      economy: { gold: 800, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    const first = buy(state, 'tool_hoe_copper', 1);
    expect('blocked' in first).toBe(false);
    if ('blocked' in first) return;
    expect(first.state.tools.hoe).toBe(2); // instant effect, itemId unchanged
    expect(first.state.economy.gold).toBe(800 - ECONOMY.TOOL_UPGRADE_PRICE.copper);
    const second = buy(first.state, 'tool_hoe_copper', 1);
    if ('blocked' in second) {
      expect(second.blocked).toBeTruthy();
    } else {
      expect(second.granted).toBe(0);
    }
  });

  it('gold tier requires the copper tier first (§4.3 校验链)', () => {
    const state = makeWorldState({
      progress: progressAt(xpForLevel(4)),
      economy: { gold: 5000, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    const blockedResult = buy(state, 'tool_can_gold', 1);
    if ('blocked' in blockedResult) {
      expect(blockedResult.blocked).toBeTruthy();
    } else {
      expect(blockedResult.granted).toBe(0);
    }
    const withCopper = makeWorldState({
      progress: progressAt(xpForLevel(4)),
      tools: { hoe: 1, wateringCan: 2 },
      economy: { gold: 5000, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    const ok = buy(withCopper, 'tool_can_gold', 1);
    expect('blocked' in ok).toBe(false);
    if (!('blocked' in ok)) expect(ok.state.tools.wateringCan).toBe(3);
  });

  it('catalog is a pure function of (effectiveLevel, purchases) (§4.3 property)', () => {
    const state = makeWorldState({ progress: progressAt(xpForLevel(3)) });
    expect(catalog(state)).toEqual(catalog(state));
    const views = new Map(catalog(state).map((v) => [v.entry.entryId, v]));
    expect(views.get('seed_radish_quick')?.availability).toBe('available');
    expect(views.get('seed_bean_vine')?.availability).toBe('available'); // Lv3
    expect(views.get('seed_cabbage')?.availability).not.toBe('available'); // Lv4
    expect(views.get('seed_berry')?.availability).not.toBe('available'); // Lv5
  });

  it('owned oneTime entries surface as owned (§4.3 「已是最高档」)', () => {
    const state = makeWorldState({
      progress: progressAt(xpForLevel(2)),
      tools: { hoe: 2, wateringCan: 1 },
    });
    const views = new Map(catalog(state).map((v) => [v.entry.entryId, v]));
    expect(views.get('tool_hoe_copper')?.availability).toBe('owned');
  });

  it('property: ANY buy→refund-all sequence is gold-neutral (ruling A-11, no arbitrage)', () => {
    const rng = makeTestRng(0xc0de);
    const seedEntries = ['seed_radish_quick', 'seed_turnip', 'seed_potato', 'seed_bean_vine'];
    let state = makeWorldState({
      progress: progressAt(xpForLevel(5)),
      economy: { gold: 5000, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    for (let i = 0; i < 40; i++) {
      const entryId = seedEntries[Math.floor(rng() * seedEntries.length)];
      const result = buy(state, entryId, 1 + Math.floor(rng() * 5));
      if (!('blocked' in result)) state = result.state;
    }
    // refund every seed stack at 100% of purchase price
    for (let slot = 0; slot < state.inventory.capacity; slot++) {
      const s = state.inventory.slots[slot];
      if (!s || !s.itemId.startsWith('seed_')) continue;
      const refunded = refundSeeds(state, slot, s.count);
      state = refunded.state;
    }
    expect(state.economy.gold).toBe(5000);
    expect(state.inventory.slots.some((s) => s?.itemId.startsWith('seed_'))).toBe(false);
  });
});

describe('soft-lock relief — 邻居的救济 (GDD §4.8)', () => {
  const broke = () =>
    makeWorldState({
      economy: { gold: 5, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });

  it('grants 4 radish_quick seeds when gold<10 ∧ no seeds ∧ no crops ∧ empty bin', () => {
    const { state } = morningReliefCheck(broke());
    expect(countItem(state.inventory, 'seed_radish_quick')).toBe(RELIEF.GRANT_SEEDS);
  });

  it.each([
    [
      'gold ≥ 10',
      () =>
        makeWorldState({
          economy: { gold: 10, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
        }),
    ],
    [
      'has seeds',
      () => {
        const s = broke();
        return {
          ...s,
          inventory: { ...s.inventory, slots: defaultSlots([stack('seed_turnip', 1)]) },
        };
      },
    ],
    [
      'has a planted crop',
      () => {
        const tile: TileState = {
          tilled: true,
          wateredToday: false,
          crop: {
            cropId: 'radish_quick',
            daysGrown: 0,
            mature: false,
            regrowDaysLeft: null,
            harvestsLeft: null,
            withered: false,
          },
        };
        const s = broke();
        return { ...s, farm: { tiles: { '22,14': tile }, unlockedZones: ['field_a'] } };
      },
    ],
    [
      'bin holds items',
      () =>
        makeWorldState({
          economy: {
            gold: 5,
            shippingBin: [stack('crop_radish_quick', 1)],
            collectionLog: {},
            newEntriesSeenDay: {},
          },
        }),
    ],
  ])('does NOT trigger when %s', (_name, build) => {
    const { state } = morningReliefCheck(build());
    expect(countItem(state.inventory, 'seed_radish_quick')).toBe(0);
  });
});

describe('shipping bin settlement reconciliation (GDD §4.2/§2.5 #1)', () => {
  it('settles a mixed HOLDING bin atomically: price → credit → clear → first-sale log', () => {
    const sim = createSim(
      makeSave({
        time: { day: 5, minuteOfDay: 1000 },
        world: {
          farmTiles: {},
          shippingBin: [
            stack('crop_radish_quick', 10),
            stack('material_wood', 3),
            stack('forage_wildflower', 2),
          ],
        },
      }),
      TEST_MAP,
    );
    const goldBefore = sim.state.economy.gold;
    const summary = sim.sleep();
    const expected = 10 * 18 + 3 * 5 + 2 * 8; // 211g (§3.6 / §6.1 prices)
    expect(summary.goldEarned).toBe(expected);
    expect(sim.state.economy.gold).toBe(goldBefore + expected);
    expect(summary.goldBalance).toBe(sim.state.economy.gold); // settlement before autosave (§2.5)
    expect(sim.state.economy.shippingBin).toEqual([]); // SETTLING → EMPTY
    // collection log records the first-sale day (= the settled day, before advanceDay)
    expect(sim.state.economy.collectionLog['crop_radish_quick']).toEqual({ firstSoldDay: 5 });
    // the radish line appears in the summary's shipped breakdown
    const radishLine = summary.shipped.find((s) => s.cropId === 'radish_quick');
    expect(radishLine).toMatchObject({ count: 10, gold: 180 });
  });

  it('an empty bin settles as "nothing sold today", not an error (§4.2)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    const summary = sim.sleep();
    expect(summary.goldEarned).toBe(0);
    expect(summary.shipped).toEqual([]);
    expect(sim.state.economy.gold).toBe(100);
  });

  it('deposit is reversible during the day: deposit → withdraw restores both sides', () => {
    const sim = createSim(
      makeSave({
        inventory: { capacity: 12, slots: defaultSlots([stack('crop_turnip', 6)]) },
      }),
      TEST_MAP,
    );
    sim.dispatch({ type: 'depositToBin', slot: 2, count: 6 });
    expect(countItem(sim.state.inventory, 'crop_turnip')).toBe(0);
    expect(sim.state.economy.shippingBin).toEqual([stack('crop_turnip', 6)]);
    sim.dispatch({ type: 'withdrawFromBin', index: 0, count: 6 });
    expect(countItem(sim.state.inventory, 'crop_turnip')).toBe(6);
    expect(sim.state.economy.shippingBin).toEqual([]);
    expect(sim.state.economy.gold).toBe(100); // no money moved while HOLDING
  });

  it('[F] ship-all moves every sellable stack but never tools or seeds (§4.2)', () => {
    const sim = createSim(
      makeSave({
        inventory: {
          capacity: 12,
          slots: defaultSlots([
            stack('crop_radish_quick', 3),
            stack('seed_turnip', 4),
            stack('material_stone', 2),
          ]),
        },
      }),
      TEST_MAP,
    );
    sim.dispatch({ type: 'depositAllToBin' });
    const binIds = sim.state.economy.shippingBin.map((s) => s.itemId).sort();
    expect(binIds).toEqual(['crop_radish_quick', 'material_stone']);
    expect(countItem(sim.state.inventory, 'seed_turnip')).toBe(4); // seeds are refund-only
    expect(countItem(sim.state.inventory, 'hoe')).toBe(1); // tools unsellable (§4.2)
  });
});
