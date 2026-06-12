/**
 * build-model.test.ts — pure view-model rules of the build UI (M3, GDD §8.2/§8.3;
 * PRD 04 §A/§D). External behaviour only: row statuses, refund amounts, demolish
 * flows, recipe outputs — no Phaser, no sim facade.
 */
import { describe, expect, it } from 'vitest';

import type { PlacedStructure } from '@codestead/shared';
import { getBlueprint } from '../src/sim/data/buildings';
import type { ItemStack, WorldState } from '../src/sim/types';
import {
  catalogRows,
  costDeficit,
  demolishPlan,
  eligibleInputs,
  materialCount,
  originForCursor,
  processingRecipeFor,
  refundPreview,
  sprinklerCoverage,
  structureAt,
} from '../src/ui/panels/build-model';

const LV6_XP = 2_150; // GDD §5.1 thresholds
const LV10_XP = 10_000;

function makeState(overrides: Partial<WorldState> = {}): WorldState {
  const slots: (ItemStack | null)[] = Array.from({ length: 12 }, () => null);
  return {
    time: {
      day: 1,
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: '0'.repeat(32),
    },
    player: { tileX: 5, tileY: 5, facing: 'down' },
    farm: { tiles: {}, unlockedZones: ['field_a'] },
    inventory: { slots, capacity: 12, selected: 0 },
    tools: { hoe: 1, wateringCan: 1 },
    economy: { gold: 100, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    progress: { xp: 0, profession: null, counters: {}, achievements: [], xpHistory: [] },
    pickups: [],
    dayLog: [],
    structures: [],
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    ...overrides,
  };
}

function withMaterials(state: WorldState, gold: number, wood = 0, stone = 0): WorldState {
  state.economy.gold = gold;
  if (wood > 0) state.inventory.slots[0] = { itemId: 'material_wood', count: wood };
  if (stone > 0) state.inventory.slots[1] = { itemId: 'material_stone', count: stone };
  return state;
}

function placed(
  defId: string,
  x: number,
  y: number,
  partial?: Partial<PlacedStructure>,
): PlacedStructure {
  return {
    instanceId: `${defId}@${x},${y}`,
    defId,
    origin: { x, y },
    state: 'built',
    ...partial,
  };
}

function rowFor(state: WorldState, defId: string) {
  const row = catalogRows(state).find((r) => r.def.id === defId);
  if (!row) throw new Error(`no catalog row for ${defId}`);
  return row;
}

describe('materials & affordability (GDD §8.1/§8.2)', () => {
  it('counts materials across inventory stacks', () => {
    const state = makeState();
    state.inventory.slots[0] = { itemId: 'material_wood', count: 99 };
    state.inventory.slots[3] = { itemId: 'material_wood', count: 51 };
    state.inventory.slots[4] = { itemId: 'material_stone', count: 7 };
    expect(materialCount(state, 'wood')).toBe(150);
    expect(materialCount(state, 'stone')).toBe(7);
  });

  it('reports the exact deficit for the coop (2,000g + 木×150)', () => {
    const state = withMaterials(makeState(), 1_500, 100);
    const deficit = costDeficit(state, getBlueprint('coop'));
    expect(deficit).toEqual({ gold: 500, wood: 50, stone: 0 });
  });
});

describe('catalog rows (GDD §8.2 解锁节奏; PRD 04 US3/US4)', () => {
  it('locks the coop below Lv6 and lists the whole catalog', () => {
    const rows = catalogRows(makeState());
    expect(rowFor(makeState(), 'coop').status).toBe('locked');
    // every §8.2 facility appears even when locked (可预期的「明日之诺」, US3)
    for (const id of ['coop', 'workshop', 'greenhouse', 'farmhouse_1', 'farmhouse_2']) {
      expect(rows.some((r) => r.def.id === id)).toBe(true);
    }
  });

  it('Lv6 + full cost ⇒ coop available; missing cost ⇒ unaffordable', () => {
    const rich = withMaterials(makeState(), 2_000, 150);
    rich.progress.xp = LV6_XP;
    expect(rowFor(rich, 'coop').status).toBe('available');

    const poor = withMaterials(makeState(), 2_000, 149);
    poor.progress.xp = LV6_XP;
    expect(rowFor(poor, 'coop').status).toBe('unaffordable');
  });

  it('limit 1 buildings report limit once an instance exists (site counts too)', () => {
    const state = withMaterials(makeState(), 99_999, 999, 999);
    state.progress.xp = LV6_XP;
    state.structures = [placed('coop', 1, 1, { state: 'underConstruction', daysLeft: 2 })];
    expect(rowFor(state, 'coop').status).toBe('limit');
  });

  it('farmhouse chain: Lv10 gate + requires farmhouse_1 + in-progress/done states', () => {
    const state = withMaterials(makeState(), 99_999, 999, 999);
    state.progress.xp = LV10_XP;
    expect(rowFor(state, 'farmhouse_2').status).toBe('locked'); // requires stage 1 (§8.2)

    state.farmhouse = { stage: 1, construction: null };
    expect(rowFor(state, 'farmhouse_1').status).toBe('done');
    expect(rowFor(state, 'farmhouse_2').status).toBe('available');

    state.farmhouse = { stage: 1, construction: { targetStage: 2, nightsLeft: 2 } };
    expect(rowFor(state, 'farmhouse_2').status).toBe('in_progress');
  });
});

describe('refund & demolish (GDD §8.3 拆除与搬迁 table; PRD 04 US28/US29)', () => {
  it('built building refunds floor(50%) of gold AND materials', () => {
    expect(refundPreview(getBlueprint('coop'), 'built')).toEqual({
      gold: 1_000,
      wood: 75,
      stone: 0,
    });
    expect(refundPreview(getBlueprint('workshop'), 'built')).toEqual({
      gold: 3_000,
      wood: 100,
      stone: 50,
    });
  });

  it('a site (cancel order) refunds 100% regardless of category', () => {
    expect(refundPreview(getBlueprint('coop'), 'underConstruction')).toEqual({
      gold: 2_000,
      wood: 150,
      stone: 0,
    });
  });

  it('decoration/station demolish instantly at 100%; buildings double-confirm', () => {
    const state = makeState();
    expect(demolishPlan(state, placed('fence', 1, 1)).flow).toBe('instant');
    expect(demolishPlan(state, placed('coop', 1, 1)).flow).toBe('confirm_built');
    expect(
      demolishPlan(state, placed('coop', 1, 1, { state: 'underConstruction', daysLeft: 1 })).flow,
    ).toBe('confirm_site');
  });

  it('non-empty chest refuses demolition (零损失, §8.3)', () => {
    const state = makeState();
    const slots = Array.from({ length: 24 }, () => null) as (ItemStack | null)[];
    slots[3] = { itemId: 'crop_turnip', count: 2 };
    const chest = placed('storage_chest', 2, 2, {
      data: { kind: 'chest', slots } as PlacedStructure['data'],
    });
    expect(demolishPlan(state, chest).blocked).toBe('CHEST_NOT_EMPTY');
  });

  it('rack with goods that fit demolishes; with a full bag it refuses', () => {
    const rack = placed('drying_rack', 2, 2, {
      data: {
        kind: 'dryingRack',
        jobs: [
          { inputItemId: 'crop_turnip', outputItemId: 'artisan_dried_turnip', daysLeft: 1 },
          null,
        ],
      } as PlacedStructure['data'],
    });
    const roomy = makeState();
    expect(demolishPlan(roomy, rack).blocked).toBeUndefined();
    expect(demolishPlan(roomy, rack).flow).toBe('instant');

    const full = makeState();
    full.inventory.slots = full.inventory.slots.map(() => ({ itemId: 'animal_egg', count: 99 }));
    expect(demolishPlan(full, rack).blocked).toBe('INVENTORY_FULL');
  });

  it('unknown/non-demolishable defIds are NOT_DEMOLISHABLE, never a crash', () => {
    const state = makeState();
    expect(demolishPlan(state, placed('mystery_future_thing', 0, 0)).blocked).toBe(
      'NOT_DEMOLISHABLE',
    );
  });
});

describe('processing recipes (GDD §8.2; ruling A-12)', () => {
  it('workshop: crop → jam floor(2×sell+25) in 2 nights; egg → mayo 95 in 1', () => {
    const jam = processingRecipeFor('workshop', 'crop_turnip');
    expect(jam).toEqual({ outputItemId: 'artisan_jam_turnip', days: 2, outputPrice: 101 });
    const mayo = processingRecipeFor('workshop', 'animal_egg');
    expect(mayo).toEqual({ outputItemId: 'artisan_mayonnaise', days: 1, outputPrice: 95 });
  });

  it('rack: crop → dried floor(1.4×sell) in 1 night; eggs/seeds are ineligible', () => {
    expect(processingRecipeFor('dryingRack', 'crop_turnip')).toEqual({
      outputItemId: 'artisan_dried_turnip',
      days: 1,
      outputPrice: 53,
    });
    expect(processingRecipeFor('dryingRack', 'animal_egg')).toBeNull();
    expect(processingRecipeFor('workshop', 'seed_turnip')).toBeNull();
    expect(processingRecipeFor('workshop', 'unknown_item')).toBeNull();
  });

  it('eligibleInputs lists only loadable inventory slots', () => {
    const state = makeState();
    state.inventory.slots[0] = { itemId: 'crop_cabbage', count: 3 };
    state.inventory.slots[1] = { itemId: 'seed_turnip', count: 5 };
    state.inventory.slots[2] = { itemId: 'animal_egg', count: 2 };
    const workshop = eligibleInputs(state, 'workshop');
    expect(workshop.map((r) => r.itemId)).toEqual(['crop_cabbage', 'animal_egg']);
    const rack = eligibleInputs(state, 'dryingRack');
    expect(rack.map((r) => r.itemId)).toEqual(['crop_cabbage']);
  });
});

describe('geometry helpers', () => {
  it('originForCursor centres the footprint on the cursor', () => {
    expect(originForCursor(getBlueprint('coop'), { x: 10, y: 10 })).toEqual({ x: 9, y: 9 }); // 4×3
    expect(originForCursor(getBlueprint('fence'), { x: 10, y: 10 })).toEqual({ x: 10, y: 10 }); // 1×1
  });

  it('structureAt finds the instance covering a tile', () => {
    const state = makeState();
    state.structures = [placed('coop', 4, 4)]; // 4×3 ⇒ tiles (4..7, 4..6)
    expect(structureAt(state, { x: 7, y: 6 })?.defId).toBe('coop');
    expect(structureAt(state, { x: 8, y: 6 })).toBeNull();
  });

  it('sprinkler coverage: tier 1 = 4 neighbours, tier 2 = 3×3 ring (§3.8/§5.3)', () => {
    expect(sprinklerCoverage('sprinkler', { x: 5, y: 5 })).toHaveLength(4);
    const ring = sprinklerCoverage('sprinkler_advanced', { x: 5, y: 5 });
    expect(ring).toHaveLength(8);
    expect(ring).not.toContainEqual({ x: 5, y: 5 });
  });
});
