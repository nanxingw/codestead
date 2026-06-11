/**
 * R-key tidy planner tests (GDD §6.2; M1.5, PRD 02 test 8): merge + category → id →
 * count-desc order, reserve-only (hotbar 0..8 untouched), excluded-slot support
 * (the drag store parks a pending-discard there), idempotence, conservation. The plan
 * is realized through sim `move()` semantics only — asserting the final layout here
 * proves the whole sort needs nothing beyond existing `moveItem` commands.
 */
import { describe, expect, it } from 'vitest';

import {
  applyMoveToSlots,
  compareStacks,
  planSortMoves,
  type Slots,
} from '../src/ui/inventory/sort-plan';
import type { ItemStack } from '../src/sim/types';

const s = (itemId: string, count: number): ItemStack => ({ itemId, count });

function makeSlots(length: number, reserve: Record<number, ItemStack>): Slots {
  const slots: Slots = Array.from({ length }, () => null);
  for (const [i, stack] of Object.entries(reserve)) slots[Number(i)] = stack;
  return slots;
}

function applyPlan(slots: Slots, opts: { hotbarSize: number; excluded?: Set<number> }): Slots {
  let work = slots.map((x) => (x ? { ...x } : null));
  for (const m of planSortMoves(work, opts)) work = applyMoveToSlots(work, m.from, m.to);
  return work;
}

function totalUnits(slots: Slots): number {
  return slots.reduce((acc, x) => acc + (x?.count ?? 0), 0);
}

describe('compareStacks (category → id → count desc)', () => {
  it('orders tool < seed < crop < material', () => {
    const sorted = [
      s('material_wood', 5),
      s('crop_turnip', 3),
      s('hoe', 1),
      s('seed_turnip', 2),
    ].sort(compareStacks);
    expect(sorted.map((x) => x.itemId)).toEqual([
      'hoe',
      'seed_turnip',
      'crop_turnip',
      'material_wood',
    ]);
  });

  it('breaks ties by id lexicographic, then count descending', () => {
    const sorted = [s('seed_turnip', 4), s('seed_potato', 1), s('seed_turnip', 99)].sort(
      compareStacks,
    );
    expect(sorted).toEqual([s('seed_potato', 1), s('seed_turnip', 99), s('seed_turnip', 4)]);
  });
});

describe('planSortMoves', () => {
  it('never touches hotbar slots 0..8 (muscle memory, GDD §6.2)', () => {
    const slots = makeSlots(18, {
      0: s('hoe', 1),
      3: s('crop_turnip', 7),
      8: s('seed_berry', 2),
      9: s('material_wood', 5),
      11: s('seed_potato', 3),
      14: s('crop_berry', 1),
    });
    const moves = planSortMoves(slots, { hotbarSize: 9 });
    for (const m of moves) {
      expect(m.from).toBeGreaterThanOrEqual(9);
      expect(m.to).toBeGreaterThanOrEqual(9);
    }
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(after.slice(0, 9)).toEqual(slots.slice(0, 9));
  });

  it('merges same-id partial stacks and packs sorted from the first reserve slot', () => {
    const slots = makeSlots(18, {
      9: s('crop_turnip', 60),
      10: s('seed_potato', 40),
      12: s('crop_turnip', 60),
      13: s('seed_potato', 30),
      16: s('material_stone', 2),
    });
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(after.slice(9)).toEqual([
      s('seed_potato', 70),
      s('crop_turnip', 99),
      s('crop_turnip', 21),
      s('material_stone', 2),
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(totalUnits(after)).toBe(totalUnits(slots));
  });

  it('puts full stacks before the partial of the same id (count desc)', () => {
    const slots = makeSlots(18, {
      9: s('crop_berry', 10),
      10: s('crop_berry', 99),
      11: s('crop_berry', 99),
    });
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(after.slice(9, 12)).toEqual([
      s('crop_berry', 99),
      s('crop_berry', 99),
      s('crop_berry', 10),
    ]);
  });

  it('is idempotent: planning a tidied reserve returns []', () => {
    const slots = makeSlots(18, {
      9: s('seed_turnip', 50),
      11: s('crop_potato', 20),
      12: s('crop_potato', 8),
      15: s('forage_wildflower', 3),
    });
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(planSortMoves(after, { hotbarSize: 9 })).toEqual([]);
  });

  it('skips an excluded slot entirely (pending-discard park, GDD §6.3)', () => {
    const slots = makeSlots(18, {
      10: s('crop_turnip', 5),
      12: s('seed_berry', 9),
      14: s('material_wood', 4),
    });
    const excluded = new Set([9]); // park slot: store-empty, sim still holds the stack
    const moves = planSortMoves(slots, { hotbarSize: 9, excluded });
    for (const m of moves) {
      expect(m.from).not.toBe(9);
      expect(m.to).not.toBe(9);
    }
    const after = applyPlan(slots, { hotbarSize: 9, excluded });
    expect(after[9]).toBeNull(); // hole preserved for the parked stack
    expect(after.slice(10, 13)).toEqual([
      s('seed_berry', 9),
      s('crop_turnip', 5),
      s('material_wood', 4),
    ]);
  });

  it('works on the M1 12-capacity backpack (3 reserve slots)', () => {
    const slots = makeSlots(12, {
      9: s('material_wood', 2),
      10: s('seed_turnip', 10),
      11: s('seed_turnip', 95),
    });
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(after.slice(9)).toEqual([
      s('seed_turnip', 99),
      s('seed_turnip', 6),
      s('material_wood', 2),
    ]);
  });

  it('handles a tool parked in reserve (stackMax 1, sorts first)', () => {
    const slots = makeSlots(18, {
      9: s('crop_turnip', 3),
      11: s('hoe', 1),
    });
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(after.slice(9, 11)).toEqual([s('hoe', 1), s('crop_turnip', 3)]);
  });

  it('conserves items across heavier random-ish layouts', () => {
    const slots = makeSlots(18, {
      9: s('crop_cabbage', 98),
      10: s('crop_cabbage', 98),
      11: s('crop_cabbage', 98),
      12: s('seed_radish_quick', 1),
      13: s('crop_bean_vine', 50),
      14: s('crop_bean_vine', 51),
      15: s('material_stone', 99),
      16: s('seed_radish_quick', 99),
      17: s('crop_cabbage', 9),
    });
    const before = totalUnits(slots);
    const after = applyPlan(slots, { hotbarSize: 9 });
    expect(totalUnits(after)).toBe(before);
    expect(planSortMoves(after, { hotbarSize: 9 })).toEqual([]);
    // No overfull or empty-but-present stacks.
    for (const stack of after) {
      if (stack) {
        expect(stack.count).toBeGreaterThan(0);
        expect(stack.count).toBeLessThanOrEqual(99);
      }
    }
  });
});
