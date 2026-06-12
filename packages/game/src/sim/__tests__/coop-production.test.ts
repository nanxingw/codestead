/**
 * Coop subsystem — hens & eggs (GDD §8.2 coop row; rulings A-6/A-7; PRD 04 US13~15).
 * Gated on the M3 contract stub (m3-probe.ts); arms when sim/coop.ts lands.
 *
 * Zero-anxiety contract: eggs accrue ONLY on settlement nights, accumulate with NO cap
 * and wait forever — the PRD acceptance is literally "满 4 鸡快进 N 天断言产蛋累计 = 4N".
 */
import { describe, expect, it } from 'vitest';

import { buyHen, collectEggs, produceAnimalsInPlace, sellHen } from '../coop.js';
import { COOP } from '../data/buildings.js';
import type { WorldState } from '../types.js';
import { countItem, makeWorldState, stack, xpForLevel } from './fixtures.js';
import { m3Implemented } from './m3-probe.js';

function coopState(args: { hens?: number; eggsReady?: number; gold?: number } = {}): WorldState {
  return makeWorldState({
    economy: {
      gold: args.gold ?? 1_000,
      shippingBin: [],
      collectionLog: {},
      newEntriesSeenDay: {},
    },
    progress: {
      xp: xpForLevel(6),
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    structures: [
      {
        instanceId: 'coop-1',
        defId: 'coop',
        origin: { x: 42, y: 32 },
        state: 'built',
        data: { kind: 'coop', hens: args.hens ?? 2, eggsReady: args.eggsReady ?? 0 },
      },
    ],
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    clearedResourceNodes: [],
  });
}

function coopData(state: WorldState): { hens: number; eggsReady: number } {
  const data = state.structures?.[0]?.data;
  if (data?.kind !== 'coop') throw new Error('coop data missing');
  return data;
}

const READY = m3Implemented(() => buyHen(coopState(), 'coop-1'));

it.skipIf(READY)('coop suite pending — arms when sim/coop.ts lands (contract stub)', () => {
  expect(READY).toBe(false);
});

describe.skipIf(!READY)('hen trading at the coop interior (ruling A-6; 待裁决 3 venue)', () => {
  it('buyHen: 200g per hen, capped at 4', () => {
    const result = buyHen(coopState({ hens: 2, gold: 500 }), 'coop-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coopData(result.state).hens).toBe(3);
    expect(result.state.economy.gold).toBe(500 - COOP.HEN_BUY_PRICE);
  });

  it('COOP_FULL at 4 hens; INSUFFICIENT_GOLD below 200g — state untouched', () => {
    expect(buyHen(coopState({ hens: 4 }), 'coop-1')).toEqual({ ok: false, error: 'COOP_FULL' });
    const broke = coopState({ hens: 2, gold: 150 });
    const snapshot = structuredClone(broke);
    expect(buyHen(broke, 'coop-1')).toEqual({ ok: false, error: 'INSUFFICIENT_GOLD' });
    expect(broke).toEqual(snapshot);
  });

  it('sellHen: 100g back, eggs already laid are unaffected; NO_HENS at zero', () => {
    const result = sellHen(coopState({ hens: 3, eggsReady: 5, gold: 0 }), 'coop-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coopData(result.state)).toEqual({ kind: 'coop', hens: 2, eggsReady: 5 });
    expect(result.state.economy.gold).toBe(COOP.HEN_SELL_PRICE);
    expect(sellHen(coopState({ hens: 0 }), 'coop-1')).toEqual({ ok: false, error: 'NO_HENS' });
  });

  it('hen buy/sell round trip is a 100g net sink (200 in, 100 back — never a faucet)', () => {
    const start = coopState({ hens: 2, gold: 1_000 });
    const bought = buyHen(start, 'coop-1');
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;
    const sold = sellHen(bought.state, 'coop-1');
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;
    expect(sold.state.economy.gold).toBe(1_000 - COOP.HEN_BUY_PRICE + COOP.HEN_SELL_PRICE);
  });

  it('UNKNOWN_INSTANCE for ids that are not a built coop', () => {
    expect(buyHen(coopState(), 'nope').ok).toBe(false);
  });
});

describe.skipIf(!READY)('egg production (NightUpdate #5; PRD 04 acceptance 4N)', () => {
  it('4 hens × N nights = exactly 4N eggs, accumulating with NO cap', () => {
    const state = coopState({ hens: 4 });
    for (let night = 1; night <= 30; night++) {
      const events = produceAnimalsInPlace(state);
      expect(coopData(state).eggsReady).toBe(4 * night);
      const produced = events.find((e) => e.type === 'EggsProduced');
      expect(produced).toMatchObject({ instanceId: 'coop-1', count: 4 });
    }
    expect(coopData(state).eggsReady).toBe(120); // 30 nights — far past any stack cap
  });

  it('a construction SITE produces nothing', () => {
    const state = coopState();
    state.structures = [
      {
        instanceId: 'site-1',
        defId: 'coop',
        origin: { x: 42, y: 32 },
        state: 'underConstruction',
        daysLeft: 2,
      },
    ];
    const events = produceAnimalsInPlace(state);
    expect(events.filter((e) => e.type === 'EggsProduced')).toEqual([]);
  });

  it('zero hens produce zero eggs (no phantom production)', () => {
    const state = coopState({ hens: 0 });
    produceAnimalsInPlace(state);
    expect(coopData(state).eggsReady).toBe(0);
  });
});

describe.skipIf(!READY)('egg collection is a deliberate pickup (PRD 04 US15)', () => {
  it('collectEggs moves all ready eggs into the bag and zeroes eggsReady', () => {
    const result = collectEggs(coopState({ eggsReady: 7 }), 'coop-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countItem(result.state.inventory, 'animal_egg')).toBe(7);
    expect(coopData(result.state).eggsReady).toBe(0);
  });

  it('a FULL bag blocks with zero loss; partial space collects min(eggs, space)', () => {
    const full = coopState({ eggsReady: 5 });
    full.inventory.slots = full.inventory.slots.map(
      (slot) => slot ?? { itemId: 'crop_berry', count: 99 },
    );
    expect(collectEggs(full, 'coop-1')).toEqual({ ok: false, error: 'INVENTORY_FULL' });
    expect(coopData(full).eggsReady).toBe(5); // nothing lost

    // exactly 3 units of space → 3 collected, 2 stay ready
    const partial = coopState({ eggsReady: 5 });
    partial.inventory.slots = partial.inventory.slots.map(
      (slot) => slot ?? { itemId: 'crop_berry', count: 99 },
    );
    partial.inventory.slots[11] = stack('animal_egg', 96);
    const result = collectEggs(partial, 'coop-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countItem(result.state.inventory, 'animal_egg')).toBe(99);
    expect(coopData(result.state).eggsReady).toBe(2);
  });

  it('NO_EGGS when the spot is empty', () => {
    expect(collectEggs(coopState({ eggsReady: 0 }), 'coop-1')).toEqual({
      ok: false,
      error: 'NO_EGGS',
    });
  });
});
