/**
 * NightUpdate contract — fixed 11-phase order observables, atomicity/purity,
 * bed-sleep ≡ 22:00 isomorphism, day-boundary accounting (GDD §2.5 / §2.9 验收要点).
 * Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import { createSim } from '../sim.js';
import { runNight } from '../night-update.js';
import type { TilePos } from '../types.js';
import {
  TEST_MAP,
  deepFreeze,
  defaultSlots,
  makeSave,
  makeWorldState,
  moduleReady,
  pickupSpotId,
  stack,
  xpForLevel,
} from './fixtures.js';

const A: TilePos = { x: 22, y: 14 };
const KEY_A = '22,14';

const FACADE_READY = moduleReady(() => createSim(makeSave(), TEST_MAP).sleep());
const MODULE_READY = moduleReady(() => runNight(makeWorldState(), TEST_MAP));

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(FACADE_READY).toBe(true);
  expect(MODULE_READY).toBe(true);
});

describe('phase-order observables (GDD §2.5 — order is a contract)', () => {
  it('one settlement reflects #1→#9 causality on a composite state', () => {
    const sim = createSim(
      makeSave({
        time: { day: 5, minuteOfDay: 1000, weatherToday: 'sunny', weatherTomorrow: 'rain' },
        world: {
          farmTiles: {
            // watered growing crop → must advance (#2 before #3 resetWatered)
            [KEY_A]: {
              tilled: true,
              wateredToday: true,
              crop: {
                cropId: 'turnip',
                daysGrown: 1,
                mature: false,
                regrowDaysLeft: null,
                harvestsLeft: null,
                withered: false,
              },
            },
            // dry empty tile → must be wet at 6:00 because tomorrow shifts to rain (#9)
            '23,14': { tilled: true, wateredToday: false, crop: null },
          },
          shippingBin: [stack('crop_radish_quick', 4)],
        },
      }),
      TEST_MAP,
    );
    const summary = sim.sleep();

    // #1 settleShipping happens on the SETTLED day (before #7 advanceDay):
    expect(sim.state.economy.gold).toBe(100 + 4 * 18);
    expect(sim.state.economy.shippingBin).toEqual([]);
    expect(sim.state.economy.collectionLog['crop_radish_quick']).toEqual({ firstSoldDay: 5 });
    // #2 growCrops before #3 resetWatered — the watered turnip advanced one day:
    expect(sim.state.farm.tiles[KEY_A]?.crop?.daysGrown).toBe(2);
    // #7 advanceDay:
    expect(sim.state.time.day).toBe(6);
    expect(sim.state.time.minuteOfDay).toBe(360);
    // #9 rollWeather AFTER #7: today is the pre-rolled rain, and the summary's
    // "tomorrow" weather equals the shifted weatherToday (§2.5 note):
    expect(sim.state.time.weatherToday).toBe('rain');
    expect(summary.weatherNext).toBe('rain');
    // #9 tail: rain morning wets every open-field tile (after #3 reset):
    expect(sim.state.farm.tiles['23,14']?.wateredToday).toBe(true);
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(true);
    // #10 buildSummary reconciliation:
    expect(summary.day).toBe(5); // the settled day's report
    expect(summary.goldEarned).toBe(72);
    expect(summary.goldBalance).toBe(sim.state.economy.gold);
    expect(summary.tomorrow.length).toBeGreaterThanOrEqual(1);
    expect(summary.tomorrow.length).toBeLessThanOrEqual(3);
    expect(summary.tomorrow.some((t) => t.kind === 'rain')).toBe(true); // ☔ forecast
  });

  it('#6 refreshPickups repopulates spots every night (zero-loss overwrite)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    const woodSpot = pickupSpotId('wood');
    sim.dispatch({ type: 'pickup', spotId: woodSpot });
    expect(sim.state.pickups.find((p) => p.spotId === woodSpot)?.available).toBe(false);
    sim.sleep();
    expect(sim.state.pickups.every((p) => p.available)).toBe(true);
  });

  it('"明日之诺" is never empty, even on a fully idle farm (§2.5)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    for (let n = 0; n < 3; n++) {
      const summary = sim.sleep();
      expect(summary.tomorrow.length).toBeGreaterThanOrEqual(1); // shop-teaser fallback
      expect(summary.tomorrow.length).toBeLessThanOrEqual(3);
    }
  });

  it('a zone earned by a mid-day level-up unlocks at the NEXT 6:00 (§1.4)', () => {
    // Restore derives unlockedZones from the effective level (SaveDoc has no zone
    // field), so the next-morning rule is observable only via an in-day level-up:
    // start 5 XP short of Lv3 and cross the threshold by planting (+5, §5.2).
    const sim = createSim(
      makeSave({
        progress: {
          xp: xpForLevel(3) - 5,
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
        inventory: { capacity: 12, slots: defaultSlots([stack('seed_radish_quick', 1)]) },
      }),
      TEST_MAP,
    );
    expect(sim.state.farm.unlockedZones).not.toContain('field_b'); // Lv2 at restore
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_radish_quick' }); // → Lv3
    expect(sim.state.progress.xp).toBe(xpForLevel(3));
    expect(sim.state.farm.unlockedZones).not.toContain('field_b'); // announced, not yet open
    sim.sleep();
    expect(sim.state.farm.unlockedZones).toContain('field_b'); // 次日 6:00 解锁
    // unlocking only ever ADDS walkable zones — monotone non-decreasing (US10)
    const count = sim.state.farm.unlockedZones.length;
    sim.sleep();
    expect(sim.state.farm.unlockedZones.length).toBeGreaterThanOrEqual(count);
  });
});

describe('day boundary accounting (GDD §2.9 验收: 960 advances, 1 DAY_END)', () => {
  it('960 one-minute advances from 6:00 produce exactly one DayEnded', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    let dayEnds = 0;
    for (let i = 0; i < 960; i++) {
      for (const e of sim.advanceMinutes(1)) {
        if (e.type === 'DayEnded') dayEnds++;
      }
    }
    expect(dayEnds).toBe(1);
    expect(sim.state.time.day).toBe(2);
    expect(sim.state.time.minuteOfDay).toBe(360);
  });

  it('bed sleep at 6:10 is isomorphic to the 22:00 auto-sleep (ruling A-20)', () => {
    const save = makeSave();
    const bed = createSim(save, TEST_MAP);
    bed.advanceMinutes(10);
    bed.sleep();

    const auto = createSim(makeSave(), TEST_MAP);
    for (let i = 0; i < 960; i++) auto.advanceMinutes(1);

    expect(JSON.stringify(bed.serialize())).toBe(JSON.stringify(auto.serialize()));
  });
});

describe('atomicity & purity (GDD §2.5 — single synchronous pure fn)', () => {
  it('runNight never mutates its input state (deep-frozen input)', () => {
    const state = deepFreeze(
      makeWorldState({
        time: {
          day: 3,
          minuteOfDay: 1320,
          weatherToday: 'sunny',
          weatherTomorrow: 'sunny',
          rngState: '0123456789abcdef0123456789abcdef',
        },
        economy: {
          gold: 100,
          shippingBin: [stack('crop_radish_quick', 2)],
          collectionLog: {},
          newEntriesSeenDay: {},
        },
      }),
    );
    const result = runNight(state, TEST_MAP);
    expect(result.state.time.day).toBe(4);
    expect(state.time.day).toBe(3); // input untouched — frozen mutation would have thrown
    expect(state.economy.shippingBin).toHaveLength(1);
  });

  it('a throwing event listener cannot leave the settlement half-applied (crash injection)', () => {
    const sim = createSim(
      makeSave({
        time: { day: 2, minuteOfDay: 1000 },
        world: { farmTiles: {}, shippingBin: [stack('crop_radish_quick', 3)] },
      }),
      TEST_MAP,
    );
    sim.on(() => {
      throw new Error('listener crash');
    });
    try {
      sim.sleep();
    } catch {
      // a propagated listener error is tolerable; intermediate sim state is not
    }
    // state must be fully post-night: settled AND advanced AND cleared — no middle ground
    expect(sim.state.time.day).toBe(3);
    expect(sim.state.time.minuteOfDay).toBe(360);
    expect(sim.state.economy.gold).toBe(100 + 3 * 18);
    expect(sim.state.economy.shippingBin).toEqual([]);
  });
});
