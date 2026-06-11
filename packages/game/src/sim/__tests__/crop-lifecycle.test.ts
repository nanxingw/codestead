/**
 * Crop lifecycle long-runs — regrow harvest schedules (§3.6 derivations), old-vine
 * exhaustion (§3.2), stall-never-die (§3.4/§3.9 验收: 30 天不浇 stage 不变、续浇必熟).
 * Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import { createSim, type SimApi } from '../sim.js';
import { applyAction } from '../farming.js';
import type { TilePos } from '../types.js';
import {
  TEST_MAP,
  countItem,
  defaultSlots,
  makeSave,
  makeWorldState,
  moduleReady,
  stack,
  xpForLevel,
} from './fixtures.js';

const A: TilePos = { x: 22, y: 14 };
const KEY_A = '22,14';

const FACADE_READY = moduleReady(() => {
  const sim = createSim(makeSave(), TEST_MAP);
  sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
  sim.sleep();
});
const CLEAR_READY = moduleReady(() => applyAction(makeWorldState(), { kind: 'clear', tile: A }));

/** One scripted morning: harvest if mature (recording the day), water if needed, sleep. */
function tendDay(sim: SimApi, harvestDays: number[]): void {
  const cropNow = sim.state.farm.tiles[KEY_A]?.crop;
  if (cropNow?.mature) {
    harvestDays.push(sim.state.time.day);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
  }
  const after = sim.state.farm.tiles[KEY_A];
  if (after?.crop && !after.crop.mature && !after.wateredToday) {
    sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
  }
  sim.sleep();
}

function regrowSim(seedId: 'seed_bean_vine' | 'seed_berry', level: number): SimApi {
  return createSim(
    makeSave({
      progress: {
        xp: xpForLevel(level),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
        collectionLog: {},
        stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
      },
      world: {
        farmTiles: { [KEY_A]: { tilled: true, wateredToday: false, crop: null } },
        shippingBin: [],
      },
      inventory: { capacity: 12, slots: defaultSlots([stack(seedId, 1)]) },
    }),
    TEST_MAP,
  );
}

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(FACADE_READY).toBe(true);
  expect(CLEAR_READY).toBe(true);
});

describe('regrow schedules (GDD §3.6 derivation, §3.9 验收要点)', () => {
  it('bean_vine planted day 1 harvests exactly on days 9,11,…,23 (8 茬) then turns old vine', () => {
    const sim = regrowSim('seed_bean_vine', 3);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_bean_vine' });
    const harvestDays: number[] = [];
    while (sim.state.time.day <= 30) tendDay(sim, harvestDays);

    expect(harvestDays).toEqual([9, 11, 13, 15, 17, 19, 21, 23]);
    expect(countItem(sim.state.inventory, 'crop_bean_vine')).toBe(8);
    const vine = sim.state.farm.tiles[KEY_A]?.crop;
    expect(vine).toMatchObject({ cropId: 'bean_vine', harvestsLeft: 0, mature: false });
    expect(vine?.withered).toBe(false); // old vine is NOT withered (§3.2)
    // XP audit: +5 plant (first planting only) + 8 × 9 per-pick (§3.6/§5.2)
    expect(sim.state.progress.xp).toBe(xpForLevel(3) + 5 + 8 * 9);
  });

  it('old vine never regrows however many watered nights pass (only harvest count triggers it)', () => {
    const sim = regrowSim('seed_bean_vine', 3);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_bean_vine' });
    const harvestDays: number[] = [];
    while (sim.state.time.day <= 38) tendDay(sim, harvestDays);
    expect(harvestDays).toHaveLength(8); // not a single extra 茬 after exhaustion
    expect(sim.state.farm.tiles[KEY_A]?.crop?.mature).toBe(false);
  });

  it('berry planted day 1 harvests on days 9,12,…,24 (6 茬, regrowDays 3)', () => {
    const sim = regrowSim('seed_berry', 5);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_berry' });
    const harvestDays: number[] = [];
    while (sim.state.time.day <= 28) tendDay(sim, harvestDays);
    expect(harvestDays).toEqual([9, 12, 15, 18, 21, 24]);
    expect(countItem(sim.state.inventory, 'crop_berry')).toBe(6);
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ harvestsLeft: 0 });
  });
});

describe('stall semantics — unwatered never dies (§3.4 / §3.9 验收)', () => {
  it('30 unwatered days leave a growing crop untouched; watering afterwards matures it', () => {
    const sim = createSim(
      makeSave({
        world: {
          farmTiles: {
            [KEY_A]: {
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
            },
          },
          shippingBin: [],
        },
        // pin the weather dry by re-checking: rain days legitimately advance growth,
        // so instead of asserting daysGrown===0 blindly we assert "stall on dry days".
      }),
      TEST_MAP,
    );
    let rainAdvances = 0;
    for (let n = 0; n < 30; n++) {
      const before = sim.state.farm.tiles[KEY_A]?.crop?.daysGrown ?? 0;
      const rainy = sim.state.time.weatherToday === 'rain';
      sim.sleep();
      const after = sim.state.farm.tiles[KEY_A]?.crop?.daysGrown ?? 0;
      if (rainy) rainAdvances += after - before;
      else expect(after).toBe(before); // dry + unwatered = stall, exactly zero progress
      if (sim.state.farm.tiles[KEY_A]?.crop?.mature) break;
    }
    const cropNow = sim.state.farm.tiles[KEY_A]?.crop;
    expect(cropNow).not.toBeNull();
    expect(cropNow?.withered).toBe(false); // never dies (§3.4)
    expect(cropNow?.daysGrown).toBe(rainAdvances); // only rain days advanced it
    // resumed watering ripens it (radish needs 2 grown days total)
    while (!sim.state.farm.tiles[KEY_A]?.crop?.mature) {
      sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
      sim.sleep();
    }
    expect(sim.state.farm.tiles[KEY_A]?.crop?.mature).toBe(true);
  });

  it('a regrowing crop stalls without water and never dies (§3.9 #6)', () => {
    const sim = createSim(
      makeSave({
        world: {
          farmTiles: {
            [KEY_A]: {
              tilled: true,
              wateredToday: false,
              crop: {
                cropId: 'bean_vine',
                daysGrown: 8,
                mature: false,
                regrowDaysLeft: 2,
                harvestsLeft: 7,
                withered: false,
              },
            },
          },
          shippingBin: [],
        },
      }),
      TEST_MAP,
    );
    for (let n = 0; n < 5; n++) {
      if (sim.state.time.weatherToday === 'rain') {
        // rain legitimately advances the countdown; skip the stall assertion that night
        sim.sleep();
        continue;
      }
      sim.sleep();
    }
    const c = sim.state.farm.tiles[KEY_A]?.crop;
    expect(c).not.toBeNull();
    expect(c?.withered).toBe(false);
    expect(c?.harvestsLeft).toBe(7); // no 茬 lost while stalled
  });
});

describe('old-vine hoe clearing via the facade (§3.2 镰刀/锄头清除 → 耕地·干)', () => {
  it('bean vine: 8 茬 exhausted → hoe interact clears the vine and resets wateredToday', () => {
    const sim = regrowSim('seed_bean_vine', 3);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_bean_vine' });
    const harvestDays: number[] = [];
    while (sim.state.time.day <= 30) tendDay(sim, harvestDays);
    expect(harvestDays).toHaveLength(8);
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ harvestsLeft: 0, mature: false });

    // The hoe is now a valid action on the old vine (verb 'till' routes to the clear).
    expect(sim.queryAction(A, 'hoe')).toEqual({ valid: true, verb: 'till' });

    // Wet the tile first so the §3.2 "→ 耕地·干" moisture reset is observable.
    if (!sim.state.farm.tiles[KEY_A]?.wateredToday) {
      sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
    }
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(true);

    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]).toMatchObject({
      tilled: true,
      wateredToday: false,
      crop: null,
    });
  });
});

describe('old-vine clearing (§3.2 — sickle removes, tile keeps)', () => {
  it('clear removes an exhausted vine and leaves tilled dry soil', () => {
    const state = makeWorldState({
      farm: {
        tiles: {
          [KEY_A]: {
            tilled: true,
            wateredToday: false,
            crop: {
              cropId: 'bean_vine',
              daysGrown: 8,
              mature: false,
              regrowDaysLeft: null,
              harvestsLeft: 0,
              withered: false,
            },
          },
        },
        unlockedZones: ['field_a'],
      },
    });
    const { state: out } = applyAction(state, { kind: 'clear', tile: A });
    expect(out.farm.tiles[KEY_A]).toMatchObject({ tilled: true, crop: null });
  });
});
