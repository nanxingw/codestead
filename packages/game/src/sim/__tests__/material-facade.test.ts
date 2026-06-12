/**
 * Facade wiring for the M3 material economy (PRD 04 §E/§H; review findings high US32/US34/
 * US47). The reducers (clearResourceNode / buyMaterial / expandInventory) and the carpenter
 * tool grant were unit-tested in isolation but had NO route to the player — these tests pin
 * the end-to-end SimApi path: a command in, the observable state change out.
 *
 * External behaviour only: tools in the bag after creation, materials in the bag after a
 * clear/buy, capacity flipping 12 → 24 with the original slots preserved.
 */
import { describe, expect, it } from 'vitest';

import { createSim, newGameSim } from '../sim.js';
import {
  RESOURCE_YIELD,
  MATERIAL_SHOP_BUY_PRICE,
  INVENTORY_EXPANSION_PRICE,
} from '../data/buildings.js';
import type { MapMeta } from '../types.js';
import { countItem, makeSave, TEST_MAP } from './fixtures.js';

/** TEST_MAP plus a tree and a boulder (the real export has no resource_nodes layer yet). */
const NODE_MAP: MapMeta = {
  ...TEST_MAP,
  resourceNodes: [
    { id: 'tree_1', kind: 'tree', tile: { x: 3, y: 3 } },
    { id: 'boulder_1', kind: 'boulder', tile: { x: 5, y: 3 } },
  ],
};

describe('carpenter tools are granted on the load/new-game path (PRD 04 US32)', () => {
  it('a fresh game boots with the axe and pickaxe in the bag', () => {
    const sim = newGameSim('mat-facade-new', TEST_MAP);
    expect(countItem(sim.state.inventory, 'axe')).toBe(1);
    expect(countItem(sim.state.inventory, 'pickaxe')).toBe(1);
  });

  it('loading an old save without the tools grants them (idempotent, zero-loss)', () => {
    const sim = createSim(makeSave(), TEST_MAP); // makeSave = §10.2 hoe/watering_can only
    expect(countItem(sim.state.inventory, 'axe')).toBe(1);
    expect(countItem(sim.state.inventory, 'pickaxe')).toBe(1);
  });
});

describe('clearResourceNode routes through dispatch (PRD 04 US32 labor path)', () => {
  it('clears a tree end-to-end: 5 wood into the bag, node marked permanently', () => {
    const sim = createSim(makeSave(), NODE_MAP); // carpenter tools granted on load
    const woodBefore = countItem(sim.state.inventory, 'material_wood');
    const events = sim.dispatch({ type: 'clearResourceNode', nodeId: 'tree_1' });
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(
      woodBefore + RESOURCE_YIELD.treeWood,
    );
    expect(sim.state.clearedResourceNodes).toContain('tree_1');
    expect(events).toContainEqual({
      type: 'ItemPicked',
      itemId: 'material_wood',
      count: RESOURCE_YIELD.treeWood,
    });
    // Permanence: a second dispatch is a no-op ([] from the blocked-result convention).
    expect(sim.dispatch({ type: 'clearResourceNode', nodeId: 'tree_1' })).toEqual([]);
  });

  it('a boulder clear yields stone via the pickaxe; unknown node is a clean no-op', () => {
    const sim = createSim(makeSave(), NODE_MAP);
    const stoneBefore = countItem(sim.state.inventory, 'material_stone');
    sim.dispatch({ type: 'clearResourceNode', nodeId: 'boulder_1' });
    expect(countItem(sim.state.inventory, 'material_stone')).toBe(
      stoneBefore + RESOURCE_YIELD.boulderStone,
    );
    expect(sim.dispatch({ type: 'clearResourceNode', nodeId: 'nope' })).toEqual([]);
  });
});

describe('buyMaterial routes through dispatch (PRD 04 US34 shop floor)', () => {
  it('buys wood at 5g and lands it in the bag', () => {
    const sim = createSim(makeSave({ player: { gold: 100 } }), TEST_MAP);
    const before = countItem(sim.state.inventory, 'material_wood');
    sim.dispatch({ type: 'buyMaterial', material: 'wood', requested: 3 });
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(before + 3);
    expect(sim.state.economy.gold).toBe(100 - 3 * MATERIAL_SHOP_BUY_PRICE.wood);
  });

  it('an unaffordable buy is a clean no-op (single blocked reason derived UI-side)', () => {
    const sim = createSim(makeSave({ player: { gold: 4 } }), TEST_MAP);
    expect(sim.dispatch({ type: 'buyMaterial', material: 'stone', requested: 1 })).toEqual([]);
    expect(sim.state.economy.gold).toBe(4);
  });
});

describe('expandInventory routes through dispatch (PRD 04 US47 backpack)', () => {
  it('flips capacity 12 → 24 for 1,000g, preserving the original 12 slot indices', () => {
    const sim = createSim(makeSave({ player: { gold: 1_500 } }), TEST_MAP);
    const before = sim.state.inventory.slots.slice(0, 12).map((s) => (s ? { ...s } : null));
    expect(sim.state.inventory.capacity).toBe(12);
    sim.dispatch({ type: 'expandInventory' });
    expect(sim.state.inventory.capacity).toBe(24);
    expect(sim.state.inventory.slots).toHaveLength(24);
    expect(sim.state.inventory.slots.slice(0, 12)).toEqual(before);
    expect(sim.state.economy.gold).toBe(1_500 - INVENTORY_EXPANSION_PRICE);
    // One-time: a second expand is a no-op.
    expect(sim.dispatch({ type: 'expandInventory' })).toEqual([]);
    expect(sim.state.inventory.capacity).toBe(24);
  });
});
