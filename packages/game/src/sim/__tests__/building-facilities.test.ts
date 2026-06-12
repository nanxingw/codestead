/**
 * Facility behaviours NOT pinned by the gated lifecycle suite (building-sim pass):
 * chest storage transfer, greenhouse interior plots (creation / cap exclusion /
 * crops travel on move / demolish guard / rain exemption), sprinkler removal,
 * carpenter-tool grant, and the M3 SimCommand facade routes (PRD 04 §N73).
 *
 * Sources: GDD §8.2 (chest 24 slots, contents travel; greenhouse 24 plots, 无视季节,
 * 室内无雨天豁免), §8.3 (move preserves state), §1.4 (cap counts open-field only),
 * §8.1 (axe/pickaxe), PRD 04 US17/18/30/40.
 */
import { describe, expect, it } from 'vitest';

import {
  demolishStructure,
  depositToChest,
  grantCarpenterTools,
  greenhousePlotTiles,
  moveStructure,
  placeSprinkler,
  placeStructure,
  progressConstructionInPlace,
  removeSprinkler,
  withdrawFromChest,
} from '../building.js';
import { runNight } from '../night-update.js';
import { createSim } from '../sim.js';
import { tilledCount } from '../tiles.js';
import type { ItemStack, PlacedStructure, WorldState } from '../types.js';
import { countItem, makeSave, makeWorldState, stack, TEST_MAP, xpForLevel } from './fixtures.js';

function richState(args: { level?: number; gold?: number } = {}): WorldState {
  const slots: (ItemStack | null)[] = [
    stack('hoe', 1),
    stack('watering_can', 1),
    stack('material_wood', 99),
    stack('material_wood', 99),
    stack('material_wood', 99),
    stack('material_wood', 30),
    stack('material_stone', 99),
    stack('material_stone', 99),
    stack('material_stone', 99),
    stack('material_stone', 30),
    null,
    null,
  ];
  return makeWorldState({
    economy: {
      gold: args.gold ?? 40_000,
      shippingBin: [],
      collectionLog: {},
      newEntriesSeenDay: {},
    },
    inventory: { slots, capacity: 12, selected: 0 },
    progress: {
      xp: xpForLevel(args.level ?? 10),
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    structures: [],
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    clearedResourceNodes: [],
  });
}

function mustOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok result');
  return result as Extract<T, { ok: true }>;
}

function builtGreenhouse(state: WorldState): { state: WorldState; instance: PlacedStructure } {
  const placed = mustOk(placeStructure(state, 'greenhouse', { x: 44, y: 37 })).state;
  progressConstructionInPlace(placed);
  progressConstructionInPlace(placed);
  const instance = placed.structures![0];
  expect(instance.state).toBe('built');
  return { state: placed, instance };
}

describe('chest storage (GDD §8.2 storage_chest; PRD 04 US18)', () => {
  function withChest(): { state: WorldState; id: string } {
    const state = mustOk(placeStructure(richState(), 'storage_chest', { x: 43, y: 33 })).state;
    return { state, id: state.structures![0].instanceId };
  }

  it('deposit moves units in (same-id stacks first), withdraw moves them back', () => {
    const { state, id } = withChest();
    const woodBefore = countItem(state.inventory, 'material_wood');
    const deposited = mustOk(depositToChest(state, id, 2, 50)).state; // slot 2 = wood 99
    expect(countItem(deposited.inventory, 'material_wood')).toBe(woodBefore - 50);
    const chest = deposited.structures![0].data;
    expect(chest?.kind === 'chest' && chest.slots[0]).toEqual({
      itemId: 'material_wood',
      count: 50,
    });

    const back = mustOk(withdrawFromChest(deposited, id, 0, 50)).state;
    expect(countItem(back.inventory, 'material_wood')).toBe(woodBefore);
    const emptied = back.structures![0].data;
    expect(emptied?.kind === 'chest' && emptied.slots[0]).toBeNull();
  });

  it('deposit→withdraw round trip conserves every unit (zero loss)', () => {
    const { state, id } = withChest();
    const total =
      countItem(state.inventory, 'material_wood') + countItem(state.inventory, 'material_stone');
    let cur = mustOk(depositToChest(state, id, 3, 99)).state;
    cur = mustOk(depositToChest(cur, id, 6, 99)).state;
    let chest = cur.structures![0].data;
    const inChest =
      chest?.kind === 'chest' ? chest.slots.reduce((sum, s) => sum + (s ? s.count : 0), 0) : NaN;
    expect(
      countItem(cur.inventory, 'material_wood') +
        countItem(cur.inventory, 'material_stone') +
        inChest,
    ).toBe(total);
    cur = mustOk(withdrawFromChest(cur, id, 0, 99)).state;
    cur = mustOk(withdrawFromChest(cur, id, 1, 99)).state;
    chest = cur.structures![0].data;
    expect(chest?.kind === 'chest' && chest.slots.every((s) => s === null)).toBe(true);
    expect(
      countItem(cur.inventory, 'material_wood') + countItem(cur.inventory, 'material_stone'),
    ).toBe(total);
  });

  it('invalid slots / unknown instances are clean errors, never throws', () => {
    const { state, id } = withChest();
    expect(depositToChest(state, 'nope', 2, 1).ok).toBe(false);
    expect(depositToChest(state, id, 10, 1).ok).toBe(false); // empty inventory slot
    expect(withdrawFromChest(state, id, 0, 1).ok).toBe(false); // empty chest slot
  });
});

describe('greenhouse interior plots (GDD §8.2; PRD 04 US17/US30)', () => {
  it('completion creates exactly 24 pre-tilled plots that do NOT count toward the cap', () => {
    const before = richState();
    expect(tilledCount(before)).toBe(0);
    const { state, instance } = builtGreenhouse(before);
    const plots = greenhousePlotTiles(instance);
    expect(plots).toHaveLength(24);
    for (const t of plots) {
      expect(state.farm.tiles[`${t.x},${t.y}`]).toEqual({
        tilled: true,
        wateredToday: false,
        crop: null,
      });
    }
    expect(tilledCount(state)).toBe(0); // §1.4: 帽只约束已开垦农业格，建筑不计
  });

  it('crops travel with the building on move; key remap preserves growth state', () => {
    const { state, instance } = builtGreenhouse(richState());
    state.farm.tiles['44,37'].crop = {
      cropId: 'turnip',
      daysGrown: 2,
      mature: false,
      regrowDaysLeft: null,
      harvestsLeft: null,
      withered: false,
    };
    const moved = mustOk(moveStructure(state, instance.instanceId, { x: 45, y: 37 })).state;
    expect(moved.farm.tiles['44,37']).toBeUndefined();
    expect(moved.farm.tiles['45,37'].crop).toMatchObject({ cropId: 'turnip', daysGrown: 2 });
    expect(Object.keys(moved.farm.tiles)).toHaveLength(24); // still exactly the 24 plots
  });

  it('demolition is refused while any plot holds a living crop (zero loss)', () => {
    const { state, instance } = builtGreenhouse(richState());
    state.farm.tiles['44,37'].crop = {
      cropId: 'turnip',
      daysGrown: 0,
      mature: false,
      regrowDaysLeft: null,
      harvestsLeft: null,
      withered: false,
    };
    expect(demolishStructure(state, instance.instanceId)).toEqual({
      ok: false,
      error: 'GREENHOUSE_NOT_EMPTY',
    });
    state.farm.tiles['44,37'].crop = null;
    const back = mustOk(demolishStructure(state, instance.instanceId)).state;
    expect(Object.keys(back.farm.tiles)).toHaveLength(0); // plots leave with the building
  });

  it('rain wets the open field but NOT the greenhouse interior (§8.2 室内无雨天豁免)', () => {
    const { state } = builtGreenhouse(richState());
    state.time.minuteOfDay = 1_320;
    state.time.weatherTomorrow = 'rain';
    state.farm.tiles['23,15'] = { tilled: true, wateredToday: false, crop: null }; // open field
    const { state: morning } = runNight(state, TEST_MAP);
    expect(morning.time.weatherToday).toBe('rain');
    expect(morning.farm.tiles['23,15'].wateredToday).toBe(true); // T13 open-field wetting
    expect(morning.farm.tiles['44,37'].wateredToday).toBe(false); // interior stays dry
  });
});

describe('sprinkler removal (station row: 100% refund; separate save block)', () => {
  it('place → remove restores gold and stone exactly; empty tile errors', () => {
    const before = richState({ level: 6 });
    const placed = mustOk(placeSprinkler(before, 'sprinkler', { x: 43, y: 33 })).state;
    const removed = mustOk(removeSprinkler(placed, { x: 43, y: 33 })).state;
    expect(removed.sprinklers).toHaveLength(0);
    expect(removed.economy.gold).toBe(before.economy.gold);
    expect(countItem(removed.inventory, 'material_stone')).toBe(
      countItem(before.inventory, 'material_stone'),
    );
    expect(removeSprinkler(removed, { x: 43, y: 33 })).toEqual({
      ok: false,
      error: 'NO_SPRINKLER',
    });
  });
});

describe('carpenter tools grant (§8.1 axe/pickaxe; PRD 04 open question 8)', () => {
  it('grants axe + pickaxe once; repeat calls and stored tools never duplicate', () => {
    const first = grantCarpenterTools(richState());
    expect(countItem(first.state.inventory, 'axe')).toBe(1);
    expect(countItem(first.state.inventory, 'pickaxe')).toBe(1);
    const again = grantCarpenterTools(first.state);
    expect(again.state).toBe(first.state); // idempotent fast path
    expect(again.events).toEqual([]);
  });
});

describe('M3 SimCommand facade routes (PRD 04 §N73; task #55 contract)', () => {
  function facadeSim() {
    const slots: (ItemStack | null)[] = [
      stack('hoe', 1),
      stack('watering_can', 1),
      stack('material_wood', 99),
      stack('crop_turnip', 5),
      ...Array.from({ length: 8 }, () => null),
    ];
    return createSim(
      makeSave({
        player: { gold: 10_000 },
        inventory: { capacity: 12, slots },
        progress: {
          xp: xpForLevel(6),
          profession: null,
          counters: {},
          achievements: [],
          xpHistory: [],
          collectionLog: {},
          stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
        },
      }),
      TEST_MAP,
    );
  }

  it('placeStructure routes through dispatch and emits StructurePlaced', () => {
    const sim = facadeSim();
    const events = sim.dispatch({
      type: 'placeStructure',
      defId: 'storage_chest',
      origin: { x: 43, y: 33 },
    });
    expect(events.some((e) => e.type === 'StructurePlaced')).toBe(true);
    expect(sim.state.structures).toHaveLength(1);
    expect(sim.state.economy.gold).toBe(10_000 - 200);
  });

  it('blocked commands return [] and leave state untouched (buyShopEntry convention)', () => {
    const sim = facadeSim();
    const before = structuredClone(sim.state);
    expect(sim.dispatch({ type: 'buyHen', instanceId: 'nope' })).toEqual([]);
    expect(sim.dispatch({ type: 'demolishStructure', instanceId: 'nope' })).toEqual([]);
    expect(sim.dispatch({ type: 'chooseProfession', profession: 'artisan' })).not.toContainEqual(
      expect.objectContaining({ type: 'GoldChanged' }),
    );
    expect(sim.state.economy.gold).toBe(before.economy.gold);
    expect(sim.state.structures ?? []).toEqual(before.structures ?? []);
  });

  it('chooseProfession routes to the certificate-desk reducer (Lv6 sim may sign)', () => {
    const sim = facadeSim();
    const events = sim.dispatch({ type: 'chooseProfession', profession: 'horticulturist' });
    expect(events.some((e) => e.type === 'ProfessionChosen')).toBe(true);
    expect(sim.state.progress.profession).toBe('horticulturist');
    // irreversible: the second signing is a no-op
    expect(sim.dispatch({ type: 'chooseProfession', profession: 'artisan' })).toEqual([]);
    expect(sim.state.progress.profession).toBe('horticulturist');
  });
});
