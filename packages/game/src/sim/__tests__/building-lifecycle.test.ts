/**
 * Building reducers — lifecycle & economy conservation (GDD §8.2/§8.3/§8.5;
 * PRD 04 §A~§D, US70). Table-driven over the blueprint authority table; every
 * assertion is an externally observable fact (wallet, materials, structures array,
 * §12 events) — never an implementation detail.
 *
 * Gated on the M3 contract stub (m3-probe.ts): skipped until sim/building.ts lands,
 * then arms automatically.
 *
 * Conservation contract under test (§8.3 table; "建造是 sink 不是 faucet"):
 *   decoration/station  place → demolish ≡ identity (100% gold AND materials back)
 *   building site       cancel = 100% refund
 *   built building      floor(50%) gold + floor(50%) materials — a strict net sink
 *   farmhouse chain     never demolishable
 */
import { describe, expect, it } from 'vitest';

import {
  demolishStructure,
  moveStructure,
  orderFarmhouseUpgrade,
  placeSprinkler,
  placeStructure,
  progressConstructionInPlace,
  progressProcessingInPlace,
  refundFor,
  sanitizeStructuresInPlace,
  startProcessingJob,
  collectProcessedGood,
} from '../building.js';
import { CONSTRUCTION_XP, MATERIAL_SHOP_BUY_PRICE } from '../data/buildings.js';
import type { ItemStack, SimEvent, WorldState } from '../types.js';
import { countItem, makeWorldState, stack, TEST_MAP, xpForLevel } from './fixtures.js';
import { m3Implemented } from './m3-probe.js';

/** Material stacks (≤99 each) for the 12-slot bag. */
function materialSlots(wood: number, stone: number): (ItemStack | null)[] {
  const slots: (ItemStack | null)[] = [stack('hoe', 1), stack('watering_can', 1)];
  for (let left = wood; left > 0; left -= 99)
    slots.push(stack('material_wood', Math.min(99, left)));
  for (let left = stone; left > 0; left -= 99) {
    slots.push(stack('material_stone', Math.min(99, left)));
  }
  while (slots.length < 12) slots.push(null);
  return slots;
}

function m3State(args: { level?: number; gold?: number; wood?: number; stone?: number } = {}) {
  return makeWorldState({
    player: { tileX: 27, tileY: 11, facing: 'down' },
    economy: {
      gold: args.gold ?? 30_000,
      shippingBin: [],
      collectionLog: {},
      newEntriesSeenDay: {},
    },
    inventory: {
      // 350+350 = 4 stacks each → 10 of 12 slots used, 2 free for processing inputs.
      slots: materialSlots(args.wood ?? 350, args.stone ?? 350),
      capacity: 12,
      selected: 0,
    },
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

function mustOk(result: ReturnType<typeof placeStructure>): {
  state: WorldState;
  events: SimEvent[];
} {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result;
}

/** Wallet + materials valued at the shop floor (§8.1) — the conservation metric. */
function netWorth(state: WorldState): number {
  return (
    state.economy.gold +
    countItem(state.inventory, 'material_wood') * MATERIAL_SHOP_BUY_PRICE.wood +
    countItem(state.inventory, 'material_stone') * MATERIAL_SHOP_BUY_PRICE.stone
  );
}

const READY = m3Implemented(() => placeStructure(m3State(), 'storage_chest', { x: 43, y: 33 }));

it.skipIf(READY)(
  'building lifecycle suite pending — arms when sim/building.ts lands (contract stub)',
  () => {
    expect(READY).toBe(false);
  },
);

describe.skipIf(!READY)('placement (§8.3 COMMITTED arrow)', () => {
  it('station is instant: chest charges 200g + 30 wood, appears built, grants 0 XP', () => {
    const before = m3State();
    const { state, events } = mustOk(placeStructure(before, 'storage_chest', { x: 43, y: 33 }));
    expect(state.economy.gold).toBe(before.economy.gold - 200);
    expect(countItem(state.inventory, 'material_wood')).toBe(
      countItem(before.inventory, 'material_wood') - 30,
    );
    expect(state.structures).toHaveLength(1);
    expect(state.structures?.[0]).toMatchObject({
      defId: 'storage_chest',
      origin: { x: 43, y: 33 },
      state: 'built',
    });
    expect(state.progress.xp).toBe(before.progress.xp); // placement gives ZERO XP (§5.2)
    expect(events.some((e) => e.type === 'StructurePlaced')).toBe(true);
  });

  it('building creates an underConstruction site with daysLeft = 2 (§8.2)', () => {
    const before = m3State();
    const { state } = mustOk(placeStructure(before, 'coop', { x: 42, y: 32 }));
    expect(state.structures?.[0]).toMatchObject({
      defId: 'coop',
      state: 'underConstruction',
      daysLeft: 2,
    });
    expect(state.economy.gold).toBe(before.economy.gold - 2_000);
    expect(countItem(state.inventory, 'material_wood')).toBe(
      countItem(before.inventory, 'material_wood') - 150,
    );
  });

  it('reducers are pure: the input state is never mutated', () => {
    const before = m3State();
    const snapshot = structuredClone(before);
    placeStructure(before, 'coop', { x: 42, y: 32 });
    expect(before).toEqual(snapshot);
  });

  it.each([
    ['INSUFFICIENT_GOLD', { gold: 100 }],
    ['INSUFFICIENT_MATERIALS', { wood: 10 }],
  ] as const)('%s blocks the order atomically (no partial charge)', (error, args) => {
    const before = m3State({ ...args });
    const snapshot = structuredClone(before);
    const result = placeStructure(before, 'coop', { x: 42, y: 32 });
    expect(result).toEqual({ ok: false, error });
    expect(before).toEqual(snapshot);
  });

  it('NOT_UNLOCKED below the blueprint farmLevel (§8.2 gate)', () => {
    const result = placeStructure(m3State({ level: 5 }), 'coop', { x: 42, y: 32 });
    expect(result).toEqual({ ok: false, error: 'NOT_UNLOCKED' });
  });

  it('LIMIT_REACHED on the second coop (limit 1, §8.2)', () => {
    const { state } = mustOk(placeStructure(m3State(), 'coop', { x: 42, y: 32 }));
    const second = placeStructure(state, 'coop', { x: 50, y: 32 });
    expect(second).toEqual({ ok: false, error: 'LIMIT_REACHED' });
  });

  it('CANNOT_PLACE re-checks canPlace at commit time (water tile)', () => {
    // apiDrift (recorded by the building implementer): rule ② needs the map injected
    // through CanPlaceOptions — without it the water heuristic cannot fire.
    const result = placeStructure(m3State(), 'storage_chest', { x: 21, y: 8 }, { map: TEST_MAP });
    expect(result).toEqual({ ok: false, error: 'CANNOT_PLACE' });
  });
});

describe.skipIf(!READY)('construction nights (NightUpdate #4 step; §8.2/§5.2)', () => {
  it('coop completes after exactly 2 night steps with ONE-TIME 150 XP + counters', () => {
    const placed = mustOk(placeStructure(m3State(), 'coop', { x: 42, y: 32 })).state;
    const xp0 = placed.progress.xp;

    const night1 = structuredClone(placed);
    const events1 = progressConstructionInPlace(night1);
    expect(night1.structures?.[0]).toMatchObject({ state: 'underConstruction', daysLeft: 1 });
    expect(events1.some((e) => e.type === 'ConstructionCompleted')).toBe(false);

    const events2 = progressConstructionInPlace(night1);
    expect(night1.structures?.[0].state).toBe('built');
    const done = events2.filter((e) => e.type === 'ConstructionCompleted');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ defId: 'coop', xp: CONSTRUCTION_XP.coop });
    expect(night1.progress.xp).toBe(xp0 + CONSTRUCTION_XP.coop); // 竣工 XP 一次性入账
    expect(night1.progress.counters.buildingsBuilt).toBe(1);
    expect(night1.progress.counters['built:coop']).toBe(1);

    // a third night must NOT re-complete or re-pay
    const events3 = progressConstructionInPlace(night1);
    expect(events3.some((e) => e.type === 'ConstructionCompleted')).toBe(false);
    expect(night1.progress.xp).toBe(xp0 + CONSTRUCTION_XP.coop);
  });

  it('coop completion grants the 2 starting hens (§8.2/A-6)', () => {
    const placed = mustOk(placeStructure(m3State(), 'coop', { x: 42, y: 32 })).state;
    const s = structuredClone(placed);
    progressConstructionInPlace(s);
    progressConstructionInPlace(s);
    expect(s.structures?.[0].data).toEqual({ kind: 'coop', hens: 2, eggsReady: 0 });
  });
});

describe.skipIf(!READY)('demolish & move conservation (§8.3 table)', () => {
  it('decoration: place → demolish is the exact identity (gold AND materials)', () => {
    const before = m3State();
    const worth0 = netWorth(before);
    const placed = mustOk(placeStructure(before, 'bench', { x: 43, y: 33 })).state;
    expect(netWorth(placed)).toBe(worth0 - 250 - 20 * MATERIAL_SHOP_BUY_PRICE.wood);
    const id = placed.structures![0].instanceId;
    const back = mustOk(demolishStructure(placed, id)).state;
    expect(back.economy.gold).toBe(before.economy.gold);
    expect(countItem(back.inventory, 'material_wood')).toBe(
      countItem(before.inventory, 'material_wood'),
    );
    expect(back.structures).toHaveLength(0);
  });

  it('building SITE cancel refunds 100% (coop: 2,000g + 150 wood)', () => {
    const before = m3State();
    const placed = mustOk(placeStructure(before, 'coop', { x: 42, y: 32 })).state;
    const id = placed.structures![0].instanceId;
    expect(refundFor(placed, id)).toEqual({ gold: 2_000, wood: 150, stone: 0 });
    const back = mustOk(demolishStructure(placed, id)).state;
    expect(back.economy.gold).toBe(before.economy.gold);
    expect(countItem(back.inventory, 'material_wood')).toBe(
      countItem(before.inventory, 'material_wood'),
    );
  });

  it('BUILT building refunds floor(50%) — a strict net sink, never a faucet', () => {
    const before = m3State();
    const placed = mustOk(placeStructure(before, 'coop', { x: 42, y: 32 })).state;
    progressConstructionInPlace(placed);
    progressConstructionInPlace(placed);
    const id = placed.structures![0].instanceId;
    // floor(50%) of the blueprint (1,000g + 75 wood) PLUS the 2 starting hens
    // auto-sold back at the A-6 100g price (implementer's zero-loss reading of the
    // GDD-silent "demolish an occupied coop" case — recorded as an open question).
    expect(refundFor(placed, id)).toEqual({ gold: 1_200, wood: 75, stone: 0 });
    const back = mustOk(demolishStructure(placed, id)).state;
    expect(back.economy.gold).toBe(before.economy.gold - 2_000 + 1_200);
    expect(countItem(back.inventory, 'material_wood')).toBe(
      countItem(before.inventory, 'material_wood') - 150 + 75,
    );
    expect(netWorth(back)).toBeLessThan(netWorth(before)); // sink-not-faucet ledger
    const removed = mustOk(demolishStructure(placed, id)).events.find(
      (e) => e.type === 'StructureRemoved',
    );
    expect(removed).toMatchObject({ defId: 'coop', refundGold: 1_200 });
  });

  it('non-empty chest refuses demolition; emptied chest demolishes (§8.3/§8.5)', () => {
    const placed = mustOk(placeStructure(m3State(), 'storage_chest', { x: 43, y: 33 })).state;
    const id = placed.structures![0].instanceId;
    const chest = placed.structures![0];
    if (chest.data?.kind === 'chest') chest.data.slots[0] = { itemId: 'crop_turnip', count: 3 };
    expect(demolishStructure(placed, id)).toEqual({ ok: false, error: 'CHEST_NOT_EMPTY' });
    if (chest.data?.kind === 'chest') chest.data.slots[0] = null;
    expect(demolishStructure(placed, id).ok).toBe(true);
  });

  it('farmhouse & upgrades are never demolishable; unknown ids report UNKNOWN_INSTANCE', () => {
    const result = demolishStructure(m3State(), 'no-such-instance');
    expect(result).toEqual({ ok: false, error: 'UNKNOWN_INSTANCE' });
  });

  it('move is free, instant, and preserves ALL internal state (deep-equal data)', () => {
    const placed = mustOk(placeStructure(m3State(), 'storage_chest', { x: 43, y: 33 })).state;
    const chest = placed.structures![0];
    if (chest.data?.kind === 'chest') chest.data.slots[0] = { itemId: 'crop_turnip', count: 7 };
    const dataBefore = structuredClone(chest.data);
    const goldBefore = placed.economy.gold;
    const moved = mustOk(moveStructure(placed, chest.instanceId, { x: 51, y: 33 }));
    expect(moved.state.economy.gold).toBe(goldBefore); // permanently free (§8.3)
    expect(moved.state.structures?.[0].origin).toEqual({ x: 51, y: 33 });
    expect(moved.state.structures?.[0].data).toEqual(dataBefore);
    expect(moved.events.some((e) => e.type === 'StructureMoved')).toBe(true);
  });

  it('a SITE moves without resetting its countdown (§8.3)', () => {
    const placed = mustOk(placeStructure(m3State(), 'coop', { x: 42, y: 32 })).state;
    progressConstructionInPlace(placed);
    expect(placed.structures?.[0].daysLeft).toBe(1);
    const moved = mustOk(moveStructure(placed, placed.structures![0].instanceId, { x: 50, y: 32 }));
    expect(moved.state.structures?.[0]).toMatchObject({
      state: 'underConstruction',
      daysLeft: 1,
      origin: { x: 50, y: 32 },
    });
  });

  it('move onto an illegal target is refused without state change', () => {
    const placed = mustOk(placeStructure(m3State(), 'storage_chest', { x: 43, y: 33 })).state;
    const snapshot = structuredClone(placed);
    const result = moveStructure(
      placed,
      placed.structures![0].instanceId,
      { x: 21, y: 8 },
      {
        map: TEST_MAP, // apiDrift: rule ② fires only with the injected map (see above)
      },
    );
    expect(result.ok).toBe(false);
    expect(placed).toEqual(snapshot);
  });
});

describe.skipIf(!READY)('farmhouse upgrade chain (§8.2; placement = CONFIRM-only)', () => {
  it('farmhouse_1 at Lv6: charges 4,000g + 200 wood, 2 nights, stage 0 → 1', () => {
    const before = m3State({ level: 6 });
    const { state } = mustOk(orderFarmhouseUpgrade(before, 'farmhouse_1'));
    expect(state.economy.gold).toBe(before.economy.gold - 4_000);
    expect(state.farmhouse).toEqual({
      stage: 0,
      construction: { targetStage: 1, nightsLeft: 2 },
    });
    const s = structuredClone(state);
    progressConstructionInPlace(s);
    expect(s.farmhouse?.stage).toBe(0);
    progressConstructionInPlace(s);
    expect(s.farmhouse).toEqual({ stage: 1, construction: null });
  });

  it('farmhouse_2 requires Lv10 AND completed stage 1 (§8.2 顺序解锁)', () => {
    // stage 0 at Lv10 → blocked
    expect(orderFarmhouseUpgrade(m3State({ level: 10 }), 'farmhouse_2')).toEqual({
      ok: false,
      error: 'NOT_UNLOCKED',
    });
    // stage 1 at Lv6 → blocked by level
    const stage1 = m3State({ level: 6 });
    stage1.farmhouse = { stage: 1, construction: null };
    expect(orderFarmhouseUpgrade(stage1, 'farmhouse_2').ok).toBe(false);
    // stage 1 at Lv10 → ok
    const eligible = m3State({ level: 10 });
    eligible.farmhouse = { stage: 1, construction: null };
    expect(orderFarmhouseUpgrade(eligible, 'farmhouse_2').ok).toBe(true);
  });
});

describe.skipIf(!READY)('processing queues (§8.2; rack 2 slots / workshop 6; A-12)', () => {
  function withBuilt(defId: 'drying_rack' | 'workshop', input: ItemStack): WorldState {
    const origin = defId === 'workshop' ? { x: 50, y: 32 } : { x: 51, y: 33 };
    let state = mustOk(placeStructure(m3State(), defId, origin)).state;
    if (defId === 'workshop') {
      progressConstructionInPlace(state);
      progressConstructionInPlace(state);
    }
    state = structuredClone(state);
    const free = state.inventory.slots.findIndex((s) => s === null);
    state.inventory.slots[free] = input;
    return state;
  }

  it('drying rack: crop → 1 night → dried good, floor(1.4×sell), waits forever at 0', () => {
    const state = withBuilt('drying_rack', stack('crop_cabbage', 1));
    const id = state.structures![0].instanceId;
    const started = mustOk(startProcessingJob(state, id, 0, 'crop_cabbage')).state;
    expect(countItem(started.inventory, 'crop_cabbage')).toBe(0); // input consumed at load
    const rack = started.structures![0];
    expect(rack.data?.kind === 'dryingRack' && rack.data.jobs[0]).toMatchObject({
      inputItemId: 'crop_cabbage',
      outputItemId: 'artisan_dried_cabbage',
      daysLeft: 1,
    });
    const s = structuredClone(started);
    const events = progressProcessingInPlace(s);
    expect(events.filter((e) => e.type === 'ProcessingDone')).toHaveLength(1);
    const jobAfter = s.structures![0].data;
    expect(jobAfter?.kind === 'dryingRack' && jobAfter.jobs[0]?.daysLeft).toBe(0);
    // zero-loss: more nights never destroy the finished good
    progressProcessingInPlace(s);
    progressProcessingInPlace(s);
    const stillThere = s.structures![0].data;
    expect(stillThere?.kind === 'dryingRack' && stillThere.jobs[0]?.daysLeft).toBe(0);
    // collection moves the good into the bag
    const collected = mustOk(collectProcessedGood(s, id, 0)).state;
    expect(countItem(collected.inventory, 'artisan_dried_cabbage')).toBe(1);
    const emptied = collected.structures![0].data;
    expect(emptied?.kind === 'dryingRack' && emptied.jobs[0]).toBeNull();
  });

  it('workshop: jam takes 2 nights; mayonnaise (egg) takes 1 (§8.2/A-12)', () => {
    const state = withBuilt('workshop', stack('crop_turnip', 1));
    const free = state.inventory.slots.findIndex((s) => s === null);
    state.inventory.slots[free] = stack('animal_egg', 1);
    const id = state.structures![0].instanceId;
    let cur = mustOk(startProcessingJob(state, id, 0, 'crop_turnip')).state;
    cur = mustOk(startProcessingJob(cur, id, 1, 'animal_egg')).state;
    const shop = cur.structures![0].data;
    expect(shop?.kind === 'workshop' && shop.jobs[0]).toMatchObject({
      outputItemId: 'artisan_jam_turnip',
      daysLeft: 2,
    });
    expect(shop?.kind === 'workshop' && shop.jobs[1]).toMatchObject({
      outputItemId: 'artisan_mayonnaise',
      daysLeft: 1,
    });
    const s = structuredClone(cur);
    progressProcessingInPlace(s);
    const after1 = s.structures![0].data;
    expect(after1?.kind === 'workshop' && after1.jobs[0]?.daysLeft).toBe(1);
    expect(after1?.kind === 'workshop' && after1.jobs[1]?.daysLeft).toBe(0); // mayo ready
  });

  it('collection into a FULL bag is refused — the good stays in the slot (zero loss)', () => {
    const state = withBuilt('drying_rack', stack('crop_cabbage', 1));
    const id = state.structures![0].instanceId;
    const s = structuredClone(mustOk(startProcessingJob(state, id, 0, 'crop_cabbage')).state);
    progressProcessingInPlace(s);
    s.inventory.slots = s.inventory.slots.map(
      (slot, i) => slot ?? { itemId: 'crop_berry', count: 99 - i }, // fill every hole
    );
    const result = collectProcessedGood(s, id, 0);
    expect(result).toEqual({ ok: false, error: 'INVENTORY_FULL' });
    const data = s.structures![0].data;
    expect(data?.kind === 'dryingRack' && data.jobs[0]?.daysLeft).toBe(0); // untouched
  });

  it('demolishing a rack with an in-progress job returns the input; full bag refuses', () => {
    const state = withBuilt('drying_rack', stack('crop_cabbage', 1));
    const id = state.structures![0].instanceId;
    const started = mustOk(startProcessingJob(state, id, 0, 'crop_cabbage')).state;
    // with space: the in-progress crop comes home with the 100% station refund
    const back = mustOk(demolishStructure(started, id)).state;
    expect(countItem(back.inventory, 'crop_cabbage')).toBe(1);
    // with a stuffed bag: refuse, zero loss
    const full = structuredClone(started);
    full.inventory.slots = full.inventory.slots.map(
      (slot) => slot ?? { itemId: 'crop_berry', count: 99 },
    );
    expect(demolishStructure(full, id)).toEqual({ ok: false, error: 'INVENTORY_FULL' });
  });
});

describe.skipIf(!READY)('sprinklers reuse the placement pipeline (§3.8/§5.3)', () => {
  it('placing a sprinkler charges its cost, bumps sprinklersPlaced, grants 0 XP', () => {
    const before = m3State({ level: 6 });
    const result = mustOk(placeSprinkler(before, 'sprinkler', { x: 43, y: 33 }));
    expect(result.state.economy.gold).toBe(before.economy.gold - 500);
    expect(countItem(result.state.inventory, 'material_stone')).toBe(
      countItem(before.inventory, 'material_stone') - 20,
    );
    expect(result.state.sprinklers).toContainEqual({ x: 43, y: 33, tier: 1 });
    expect(result.state.progress.counters.sprinklersPlaced).toBe(1);
    expect(result.state.progress.xp).toBe(before.progress.xp); // 0 XP (§5.2)
    expect(result.events.some((e) => e.type === 'SprinklerPlaced')).toBe(true);
  });

  it('advanced sprinkler is tier 2 and Lv8-gated', () => {
    expect(placeSprinkler(m3State({ level: 6 }), 'sprinkler_advanced', { x: 43, y: 33 })).toEqual({
      ok: false,
      error: 'NOT_UNLOCKED',
    });
    const ok = mustOk(
      placeSprinkler(m3State({ level: 8 }), 'sprinkler_advanced', { x: 43, y: 33 }),
    );
    expect(ok.state.sprinklers).toContainEqual({ x: 43, y: 33, tier: 2 });
  });
});

describe.skipIf(!READY)('import sanitiser (GDD §8.5; PRD 04 US70)', () => {
  it('reclaims overlapping footprints at 100% — credited, never silently deleted', () => {
    const state = m3State();
    const chest = (instanceId: string, x: number) => ({
      instanceId,
      defId: 'storage_chest',
      origin: { x, y: 33 },
      state: 'built' as const,
      data: { kind: 'chest' as const, slots: Array.from({ length: 24 }, () => null) },
    });
    state.structures = [chest('keep', 43), chest('clash', 43)]; // same tile — illegal
    const goldBefore = state.economy.gold;
    const report = sanitizeStructuresInPlace(state);
    expect(report.reclaimed).toHaveLength(1);
    // 100% of gold + materials at shop value: 200 + 30×5 = 350 (§8.5 reclaim channel)
    expect(report.reclaimed[0]).toMatchObject({ defId: 'storage_chest', refundGold: 350 });
    expect(state.structures).toHaveLength(1);
    expect(state.economy.gold).toBe(goldBefore + 350);
  });

  it('reclaims unknown defIds without throwing (forward tolerance + zero silent delete)', () => {
    const state = m3State();
    state.structures = [
      {
        instanceId: 'future-1',
        defId: 'hovercraft_pad', // future-version blueprint
        origin: { x: 43, y: 33 },
        state: 'built',
      },
    ];
    const report = sanitizeStructuresInPlace(state);
    expect(report.reclaimed.some((r) => r.instanceId === 'future-1')).toBe(true);
    expect(state.structures).toHaveLength(0);
  });

  it('leaves a fully legal layout untouched', () => {
    const placed = mustOk(placeStructure(m3State(), 'storage_chest', { x: 43, y: 33 })).state;
    const snapshot = structuredClone(placed.structures);
    const report = sanitizeStructuresInPlace(placed);
    expect(report.reclaimed).toEqual([]);
    expect(placed.structures).toEqual(snapshot);
  });
});
