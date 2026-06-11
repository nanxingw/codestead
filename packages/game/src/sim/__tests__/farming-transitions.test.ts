/**
 * Tile/crop state machine — the §3.3 transition table T1~T13, row by row, plus the
 * "deliberately impossible" transitions (GDD §3.2/§3.3/§3.5). Facade-driven where the
 * game can reach the state; module-level applyAction for sickle paths (the sickle has
 * no M1 itemId — open question). Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import type { CropState as SaveCropState, TileState as SaveTileState } from '@codestead/shared';

import { createSim } from '../sim.js';
import { applyAction, visualStage } from '../farming.js';
import { XP_PLANT } from '../data/constants.js';
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
  type SaveOverrides,
} from './fixtures.js';

const A: TilePos = { x: 22, y: 14 }; // inside field A (GDD §1.3)
const KEY_A = '22,14';

const crop = (over: Partial<SaveCropState> = {}): SaveCropState => ({
  cropId: 'radish_quick',
  daysGrown: 0,
  mature: false,
  regrowDaysLeft: null,
  harvestsLeft: null,
  withered: false,
  ...over,
});

const tile = (over: Partial<SaveTileState> = {}): SaveTileState => ({
  tilled: true,
  wateredToday: false,
  crop: null,
  ...over,
});

function simWith(overrides: SaveOverrides = {}) {
  return createSim(makeSave(overrides), TEST_MAP);
}

const FACADE_READY = moduleReady(() => {
  const sim = simWith();
  sim.queryAction(A, 'hoe');
  sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
  sim.sleep();
});
const CLEAR_READY = moduleReady(() => applyAction(makeWorldState(), { kind: 'clear', tile: A }));
const STAGE_READY = moduleReady(() => visualStage(0, 4));

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(FACADE_READY).toBe(true);
  expect(CLEAR_READY).toBe(true);
  expect(STAGE_READY).toBe(true);
});

describe('T1 till: grass → tilled·dry (GDD §3.3 T1)', () => {
  it('tills a free field-A tile with the hoe (XP 0) and emits TileTilled', () => {
    const sim = simWith();
    expect(sim.queryAction(A, 'hoe')).toEqual({ valid: true, verb: 'till' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]).toEqual({ tilled: true, wateredToday: false, crop: null });
    expect(events.some((e) => e.type === 'TileTilled')).toBe(true);
    expect(sim.state.progress.xp).toBe(0); // tilling grants no XP (§5.2)
  });

  it('refuses tiles outside tillable rects and inside locked zones', () => {
    const sim = simWith();
    for (const pos of [
      { x: 5, y: 5 }, // open grass, not a field
      { x: 10, y: 14 }, // field B, locked until Lv3
      { x: 18, y: 23 }, // field C, locked until Lv5
    ]) {
      expect(sim.queryAction(pos, 'hoe').valid).toBe(false);
      sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
      expect(sim.state.farm.tiles[`${pos.x},${pos.y}`]).toBeUndefined();
    }
  });

  it('enforces the global tilled cap: 13th till at Lv1 is a no-op (§1.4)', () => {
    const sim = simWith();
    for (let i = 0; i < 13; i++) {
      sim.dispatch({
        type: 'interact',
        tile: { x: 22 + (i % 8), y: 14 + Math.floor(i / 8) },
        itemId: 'hoe',
      });
    }
    expect(Object.keys(sim.state.farm.tiles)).toHaveLength(12);
    expect(sim.queryAction({ x: 27, y: 15 }, 'hoe').valid).toBe(false); // grey cursor at cap
  });

  it('hoe on already-tilled or cropped tiles is a no-op (deliberate non-transition)', () => {
    const sim = simWith({
      world: {
        farmTiles: { [KEY_A]: tile(), '23,14': tile({ crop: crop({ daysGrown: 1 }) }) },
        shippingBin: [],
      },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    sim.dispatch({ type: 'interact', tile: { x: 23, y: 14 }, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]).toEqual(tile());
    expect(sim.state.farm.tiles['23,14']?.crop).toEqual(crop({ daysGrown: 1 })); // crop protected
  });
});

describe('T2 water: tilled·dry → tilled·wet (§3.3 T2, §3.4)', () => {
  it('wets a dry tilled tile (XP 0; M1 can is infinite)', () => {
    const sim = simWith({ world: { farmTiles: { [KEY_A]: tile() }, shippingBin: [] } });
    expect(sim.queryAction(A, 'watering_can')).toEqual({ valid: true, verb: 'water' });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(true);
    expect(sim.state.progress.xp).toBe(0); // watering grants no XP (§5.2)
  });

  it('watering an already-wet tile or grass is a no-op (§3.9 #2)', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile({ wateredToday: true }) }, shippingBin: [] },
    });
    expect(sim.queryAction(A, 'watering_can').valid).toBe(false);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
    expect(sim.state.farm.tiles[KEY_A]).toEqual(tile({ wateredToday: true }));
    expect(sim.queryAction({ x: 5, y: 5 }, 'watering_can').valid).toBe(false);
  });
});

describe('T3 plant: tilled → growing (§3.3 T3)', () => {
  it('consumes one seed, creates stage-0 crop, grants +5 XP', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile() }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_radish_quick', 3)]) },
    });
    expect(sim.queryAction(A, 'seed_radish_quick')).toEqual({ valid: true, verb: 'sow' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_radish_quick' });
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({
      cropId: 'radish_quick',
      daysGrown: 0,
      mature: false,
    });
    expect(countItem(sim.state.inventory, 'seed_radish_quick')).toBe(2);
    expect(sim.state.progress.xp).toBe(XP_PLANT);
    expect(events.some((e) => e.type === 'CropPlanted')).toBe(true);
  });

  it('regrow crops initialize harvestsLeft from regrowLimit (bean 8, §3.1)', () => {
    const sim = simWith({
      progress: {
        xp: xpForLevel(3),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
        collectionLog: {},
        stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
      },
      world: { farmTiles: { [KEY_A]: tile() }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_bean_vine', 1)]) },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_bean_vine' });
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({
      cropId: 'bean_vine',
      harvestsLeft: 8,
    });
  });

  it('blocks planting on an occupied tile (seed retained, §3.9 #7)', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile({ crop: crop() }) }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_radish_quick', 3)]) },
    });
    expect(sim.queryAction(A, 'seed_radish_quick').valid).toBe(false);
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_radish_quick' });
    expect(countItem(sim.state.inventory, 'seed_radish_quick')).toBe(3);
  });

  it('blocks level-locked crops (bean_vine needs farm Lv3, §3.3 T3)', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile() }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_bean_vine', 1)]) },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_bean_vine' });
    expect(sim.state.farm.tiles[KEY_A]?.crop).toBeNull();
    expect(countItem(sim.state.inventory, 'seed_bean_vine')).toBe(1);
  });

  it('planting into a wet tile counts as watered today (§3.3 T3 tail)', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile({ wateredToday: true }) }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_radish_quick', 1)]) },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_radish_quick' });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop?.daysGrown).toBe(1); // grew on night 1
  });

  it('planting during rain wets the tile immediately (§2.9)', () => {
    const sim = simWith({
      time: { day: 3, weatherToday: 'rain' },
      world: { farmTiles: { [KEY_A]: tile({ wateredToday: false }) }, shippingBin: [] },
      inventory: { capacity: 12, slots: defaultSlots([stack('seed_radish_quick', 1)]) },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'seed_radish_quick' });
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(true);
  });
});

describe('T4/T5 nightly growth & stall (§3.3, §3.4)', () => {
  it('a watered crop advances exactly +1 day per settled night, then matures', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile({ crop: crop() }) }, shippingBin: [] },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ daysGrown: 1, mature: false });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'watering_can' });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ daysGrown: 2, mature: true });
  });

  it('an unwatered crop stalls — no growth, no death, no penalty (T5)', () => {
    const sim = simWith({
      world: { farmTiles: { [KEY_A]: tile({ crop: crop({ daysGrown: 1 }) }) }, shippingBin: [] },
    });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({
      daysGrown: 1,
      mature: false,
      withered: false,
    });
  });
});

describe('T6 harvest single-crop (§3.3 T6, §3.9 #1)', () => {
  const matureSave = (): SaveOverrides => ({
    world: {
      farmTiles: { [KEY_A]: tile({ crop: crop({ daysGrown: 2, mature: true }) }) },
      shippingBin: [],
    },
  });

  it('harvest beats every per-item verb (§3.5 priority) and keeps the tile tilled', () => {
    const sim = simWith(matureSave());
    // any selected item resolves to harvest on a mature crop
    expect(sim.queryAction(A, 'hoe')).toEqual({ valid: true, verb: 'harvest' });
    expect(sim.queryAction(A, 'watering_can')).toEqual({ valid: true, verb: 'harvest' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]).toMatchObject({ tilled: true, crop: null });
    expect(countItem(sim.state.inventory, 'crop_radish_quick')).toBe(1);
    expect(sim.state.progress.xp).toBe(6); // radish xpHarvest (§3.6)
    expect(events.some((e) => e.type === 'CropHarvested')).toBe(true);
  });

  it('a full backpack blocks the WHOLE harvest with zero loss (§3.9 #1)', () => {
    const fullSlots = [
      stack('hoe', 1),
      stack('watering_can', 1),
      ...Array.from({ length: 10 }, () => stack('material_stone', 99)),
    ];
    const sim = simWith({
      ...matureSave(),
      inventory: { capacity: 12, slots: fullSlots },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ mature: true }); // crop intact
    expect(countItem(sim.state.inventory, 'crop_radish_quick')).toBe(0);
    expect(sim.state.progress.xp).toBe(0);
  });

  it('mature single crops never expire — they wait indefinitely (§3.2)', () => {
    const sim = simWith(matureSave());
    for (let n = 0; n < 10; n++) sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ mature: true, withered: false });
  });
});

describe('bare-hand interact (§3.5 空手 row — mature-crop harvest only)', () => {
  it('null itemId harvests a mature healthy crop (queryAction + dispatch)', () => {
    const sim = simWith({
      world: {
        farmTiles: { [KEY_A]: tile({ crop: crop({ daysGrown: 2, mature: true }) }) },
        shippingBin: [],
      },
    });
    expect(sim.queryAction(A, null)).toEqual({ valid: true, verb: 'harvest' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: null });
    expect(events.some((e) => e.type === 'CropHarvested')).toBe(true);
    expect(sim.state.farm.tiles[KEY_A]).toMatchObject({ tilled: true, crop: null });
    expect(countItem(sim.state.inventory, 'crop_radish_quick')).toBe(1);
  });

  it('null itemId on an immature crop is invalid and a no-op', () => {
    const sim = simWith({
      world: {
        farmTiles: { [KEY_A]: tile({ crop: crop({ daysGrown: 1 }) }) },
        shippingBin: [],
      },
    });
    expect(sim.queryAction(A, null)).toEqual({ valid: false, verb: 'none' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: null });
    expect(events).toEqual([]);
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ daysGrown: 1, mature: false });
  });

  it('null itemId on an old vine is invalid — clearing needs the hoe/sickle (§3.2)', () => {
    const sim = simWith({
      world: {
        farmTiles: {
          [KEY_A]: tile({
            crop: crop({ cropId: 'bean_vine', daysGrown: 8, harvestsLeft: 0 }),
          }),
        },
        shippingBin: [],
      },
    });
    expect(sim.queryAction(A, null)).toEqual({ valid: false, verb: 'none' });
    const events = sim.dispatch({ type: 'interact', tile: A, itemId: null });
    expect(events).toEqual([]);
    expect(sim.state.farm.tiles[KEY_A]?.crop).toMatchObject({ harvestsLeft: 0 });
  });

  it('null itemId on grass or empty tilled soil is invalid', () => {
    const sim = simWith();
    expect(sim.queryAction(A, null).valid).toBe(false); // grass
    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.queryAction(A, null).valid).toBe(false); // empty tilled soil
  });
});

describe('T9/T11 sickle clear & withered clear (§3.3)', () => {
  it('T9: clearing a growing crop removes it, keeps tilled soil, refunds nothing', () => {
    const state = makeWorldState({
      farm: {
        tiles: {
          [KEY_A]: {
            tilled: true,
            wateredToday: false,
            crop: { ...crop({ daysGrown: 1 }), cropId: 'radish_quick' },
          },
        },
        unlockedZones: ['field_a'],
      },
    });
    const seedsBefore = countItem(state.inventory, 'seed_radish_quick');
    const { state: out } = applyAction(state, { kind: 'clear', tile: A });
    expect(out.farm.tiles[KEY_A]).toMatchObject({ tilled: true, crop: null });
    expect(countItem(out.inventory, 'seed_radish_quick')).toBe(seedsBefore); // no refund
  });

  it('clear on an empty or untilled tile is a skip, never a throw (§3.9 #3)', () => {
    const state = makeWorldState({
      farm: {
        tiles: { [KEY_A]: { tilled: true, wateredToday: false, crop: null } },
        unlockedZones: ['field_a'],
      },
    });
    expect(() => applyAction(state, { kind: 'clear', tile: A })).not.toThrow();
    expect(() => applyAction(state, { kind: 'clear', tile: { x: 5, y: 5 } })).not.toThrow();
  });
});

describe('T11 withered → tilled·dry via hoe (M1-unreachable state, US48)', () => {
  it('restores a withered crop from a save and clears it with the hoe', () => {
    const sim = simWith({
      world: {
        farmTiles: { [KEY_A]: tile({ crop: crop({ daysGrown: 1, withered: true }) }) },
        shippingBin: [],
      },
    });
    sim.dispatch({ type: 'interact', tile: A, itemId: 'hoe' });
    expect(sim.state.farm.tiles[KEY_A]).toMatchObject({ tilled: true, crop: null });
  });
});

describe('T12/T13 overnight moisture (§3.3, §3.4)', () => {
  it('T12: wet soil dries overnight when tomorrow is not rain', () => {
    const sim = simWith({
      time: { weatherTomorrow: 'sunny' },
      world: { farmTiles: { [KEY_A]: tile({ wateredToday: true }) }, shippingBin: [] },
    });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(false);
  });

  it('T13: a rainy morning wets ALL open-field tilled tiles (假日惊喜)', () => {
    const sim = simWith({
      time: { weatherTomorrow: 'rain' },
      world: {
        farmTiles: { [KEY_A]: tile(), '23,14': tile({ crop: crop() }) },
        shippingBin: [],
      },
    });
    sim.sleep();
    expect(sim.state.time.weatherToday).toBe('rain');
    expect(sim.state.farm.tiles[KEY_A]?.wateredToday).toBe(true);
    expect(sim.state.farm.tiles['23,14']?.wateredToday).toBe(true);
  });

  it('rain exemption: an unwatered crop still grows on a rain day (§2.5 #2)', () => {
    const sim = simWith({
      time: { day: 4, weatherToday: 'rain' },
      world: {
        farmTiles: { [KEY_A]: tile({ wateredToday: false, crop: crop() }) },
        shippingBin: [],
      },
    });
    sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]?.crop?.daysGrown).toBe(1);
  });

  it('tilled soil NEVER reverts to grass, however long it sits (§3.3 non-transition)', () => {
    const sim = simWith({ world: { farmTiles: { [KEY_A]: tile() }, shippingBin: [] } });
    for (let n = 0; n < 10; n++) sim.sleep();
    expect(sim.state.farm.tiles[KEY_A]).toMatchObject({ tilled: true });
  });
});

describe('visual stage bucketing (GDD §3.7 — 3-stage M1 art)', () => {
  it('maps growth progress onto stages 0..2 monotonically with fixed endpoints', () => {
    expect(visualStage(0, 10)).toBe(0);
    expect(visualStage(10, 10)).toBe(2);
    let prev = 0;
    for (let d = 0; d <= 10; d++) {
      const s = visualStage(d, 10);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(2);
      prev = s;
    }
  });
});
