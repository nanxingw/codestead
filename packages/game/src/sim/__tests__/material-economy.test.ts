/**
 * M3 material economy (GDD §8.1 / §6.2; PRD 04 US32~35, US47) — the merged material
 * system: daily edge regen 10 wood + 6 stone over the fixed map spots, axe/pickaxe
 * resource-node clearing (5 wood / 3 stone, permanent), the 5g/个 shop buy-in floor,
 * and the 1,000g backpack expansion (12 → 24, indexes preserved).
 */
import { describe, expect, it } from 'vitest';

import { DAILY_MATERIAL_REGEN_M3, RESOURCE_YIELD } from '../data/buildings.js';
import { buyMaterial, expandInventory } from '../economy.js';
import { clearResourceNode, refreshPickups } from '../pickups.js';
import type { MapMeta, WorldState } from '../types.js';
import { countItem, makeWorldState, stack, TEST_MAP, xpForLevel } from './fixtures.js';

describe('daily regen distribution (§8.1: 10 wood + 6 stone over the §1.5 spots)', () => {
  it('per-kind spot counts sum exactly to DAILY_MATERIAL_REGEN_M3 (10/6) + 3 flowers', () => {
    const state = refreshPickups(makeWorldState(), TEST_MAP);
    const totalOf = (kind: string) =>
      state.pickups.filter((p) => p.kind === kind).reduce((sum, p) => sum + (p.count ?? 1), 0);
    expect(totalOf('wood')).toBe(DAILY_MATERIAL_REGEN_M3.wood);
    expect(totalOf('stone')).toBe(DAILY_MATERIAL_REGEN_M3.stone);
    expect(totalOf('wildflower')).toBe(3); // §1.3 wildflowers stay 1/spot
    expect(state.pickups).toHaveLength(TEST_MAP.pickupSpots.length); // spot set untouched
  });

  it('distribution is deterministic (map order — replay discipline)', () => {
    const a = refreshPickups(makeWorldState(), TEST_MAP);
    const b = refreshPickups(makeWorldState(), TEST_MAP);
    expect(a.pickups).toEqual(b.pickups);
  });
});

describe('resource nodes (§8.1: axe clears trees 5 wood; pickaxe boulders 3 stone)', () => {
  const NODE_MAP: MapMeta = {
    ...TEST_MAP,
    resourceNodes: [
      { id: 'tree_1', kind: 'tree', tile: { x: 3, y: 3 } },
      { id: 'boulder_1', kind: 'boulder', tile: { x: 4, y: 3 } },
    ],
  };

  function withTools(): WorldState {
    const state = makeWorldState();
    state.inventory.slots[2] = stack('axe', 1);
    state.inventory.slots[3] = stack('pickaxe', 1);
    return state;
  }

  it('clearing yields the §8.1 amounts, marks the node permanently, grants 0 XP', () => {
    const result = clearResourceNode(withTools(), NODE_MAP, 'tree_1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countItem(result.state.inventory, 'material_wood')).toBe(RESOURCE_YIELD.treeWood);
    expect(result.state.clearedResourceNodes).toEqual(['tree_1']);
    expect(result.state.progress.xp).toBe(0); // §5.2 采集纪律
    // permanence: the same node never yields twice
    expect(clearResourceNode(result.state, NODE_MAP, 'tree_1')).toEqual({
      ok: false,
      error: 'ALREADY_CLEARED',
    });
  });

  it('boulders need the pickaxe; missing tool / unknown node are clean errors', () => {
    const bare = makeWorldState(); // no axe/pickaxe in a fresh bag
    expect(clearResourceNode(bare, NODE_MAP, 'boulder_1')).toEqual({
      ok: false,
      error: 'MISSING_TOOL',
    });
    expect(clearResourceNode(withTools(), NODE_MAP, 'nope')).toEqual({
      ok: false,
      error: 'UNKNOWN_NODE',
    });
    expect(clearResourceNode(withTools(), TEST_MAP, 'tree_1')).toEqual({
      ok: false,
      error: 'UNKNOWN_NODE', // map without resourceNodes (export pending) degrades cleanly
    });
  });

  it('the full yield must fit — full bag blocks with zero loss', () => {
    const state = withTools();
    state.inventory.slots = state.inventory.slots.map(
      (slot) => slot ?? { itemId: 'crop_berry', count: 99 },
    );
    expect(clearResourceNode(state, NODE_MAP, 'tree_1')).toEqual({
      ok: false,
      error: 'INVENTORY_FULL',
    });
    expect(state.clearedResourceNodes ?? []).toEqual([]); // carrier untouched (optional pre-hydrate)
  });
});

describe('material shop floor (§8.1/§4.4: wood/stone 5g each, clamp discipline)', () => {
  it('buys granted = min(requested, affordable, fits) at 5g', () => {
    const state = makeWorldState();
    state.economy.gold = 23;
    const result = buyMaterial(state, 'wood', 10);
    expect('blocked' in result).toBe(false);
    if ('blocked' in result) return;
    expect(result.granted).toBe(4); // affordable = floor(23 / 5)
    expect(result.cost).toBe(20);
    expect(result.state.economy.gold).toBe(3);
    expect(countItem(result.state.inventory, 'material_wood')).toBe(4);
  });

  it('zero affordability / zero fit produce the single blocked reason', () => {
    const broke = makeWorldState();
    broke.economy.gold = 4;
    expect(buyMaterial(broke, 'stone', 1)).toEqual({ blocked: 'INSUFFICIENT_GOLD' });
    const full = makeWorldState();
    full.economy.gold = 1_000;
    full.inventory.slots = full.inventory.slots.map(
      (slot) => slot ?? { itemId: 'crop_berry', count: 99 },
    );
    expect(buyMaterial(full, 'stone', 1)).toEqual({ blocked: 'INVENTORY_FULL' });
  });
});

describe('backpack expansion (§6.2/§6.9: 1,000g, 12 → 24, instant; PRD 04 US47)', () => {
  it('charges 1,000g, doubles capacity, preserves the original 12 indexes verbatim', () => {
    const state = makeWorldState({
      progress: {
        xp: xpForLevel(2), // level-independent — works far below Lv5 (§5.3 不挂等级)
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    state.economy.gold = 1_500;
    const slotsBefore = structuredClone(state.inventory.slots);
    const result = expandInventory(state);
    expect('blocked' in result).toBe(false);
    if ('blocked' in result) return;
    expect(result.state.economy.gold).toBe(500);
    expect(result.state.inventory.capacity).toBe(24);
    expect(result.state.inventory.slots).toHaveLength(24);
    expect(result.state.inventory.slots.slice(0, 12)).toEqual(slotsBefore);
    expect(result.state.inventory.slots.slice(12).every((s) => s === null)).toBe(true);
    // one-time: the second purchase is blocked
    expect(expandInventory(result.state)).toEqual({ blocked: 'ALREADY_OWNED' });
  });

  it('INSUFFICIENT_GOLD below 1,000g', () => {
    const state = makeWorldState();
    state.economy.gold = 999;
    expect(expandInventory(state)).toEqual({ blocked: 'INSUFFICIENT_GOLD' });
  });
});
