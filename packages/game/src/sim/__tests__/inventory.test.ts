/**
 * inventory.ts contract tests — stacking discipline, partial add, click-move,
 * hotbar selection, trash-can discard (GDD §6.1/§6.2/§6.3). Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import { add, canAdd, discardAt, move, removeAt, select, splitAt } from '../inventory.js';
import type { InventoryState, ItemStack } from '../types.js';
import { makeWorldState, moduleReady, stack } from './fixtures.js';

function inv(slots: (ItemStack | null)[], selected = 0): InventoryState {
  const filled = [...slots];
  while (filled.length < 12) filled.push(null);
  return { slots: filled, capacity: 12, selected };
}

const ADD_READY = moduleReady(() => add(inv([]), 'seed_radish_quick', 1));
const MOVE_READY = moduleReady(() => move(inv([stack('seed_radish_quick', 1)]), 0, 1));
const SELECT_READY = moduleReady(() => select(inv([]), 1));
const DISCARD_READY = moduleReady(() => discardAt(makeWorldState(), 2));

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(ADD_READY).toBe(true);
  expect(MOVE_READY).toBe(true);
  expect(SELECT_READY).toBe(true);
  expect(DISCARD_READY).toBe(true);
});

describe('add / canAdd / removeAt (GDD §6.2 stacking rules)', () => {
  it('fills the first empty slot left→right when no same-id stack exists', () => {
    const { inv: out, added, rejected } = add(inv([stack('hoe', 1)]), 'seed_turnip', 5);
    expect(added).toBe(5);
    expect(rejected).toBe(0);
    expect(out.slots[1]).toEqual(stack('seed_turnip', 5));
  });

  it('tops up an existing non-full stack before opening a new slot', () => {
    const start = inv([stack('hoe', 1), null, stack('seed_turnip', 10)]);
    const { inv: out } = add(start, 'seed_turnip', 5);
    expect(out.slots[2]).toEqual(stack('seed_turnip', 15));
    expect(out.slots[1]).toBeNull(); // the earlier empty slot stays empty
  });

  it('splits overflow beyond the 99 stack cap into a new stack', () => {
    const start = inv([stack('crop_radish_quick', 95)]);
    const { inv: out, added, rejected } = add(start, 'crop_radish_quick', 10);
    expect(added).toBe(10);
    expect(rejected).toBe(0);
    expect(out.slots[0]).toEqual(stack('crop_radish_quick', 99));
    expect(out.slots[1]).toEqual(stack('crop_radish_quick', 6));
  });

  it('partial add returns {added, rejected} when capacity runs out (§6.2)', () => {
    const full = inv(
      Array.from({ length: 11 }, (_, i) => stack('material_stone', 99 - (i % 3))).concat([
        stack('crop_turnip', 95),
      ]),
    );
    const { added, rejected } = add(full, 'crop_turnip', 10);
    expect(added).toBe(4); // only the room left in the 95-stack
    expect(rejected).toBe(6);
    expect(canAdd(full, 'crop_turnip', 4)).toBe(true);
    expect(canAdd(full, 'crop_turnip', 5)).toBe(false);
  });

  it('tools never stack (stackMax 1, §6.1)', () => {
    const start = inv([stack('hoe', 1)]);
    const { inv: out, added, rejected } = add(start, 'hoe', 1);
    expect(out.slots[0]).toEqual(stack('hoe', 1)); // existing tool stack untouched
    expect(added + rejected).toBe(1); // either its own slot or rejected — never count 2
    if (added === 1) expect(out.slots[1]).toEqual(stack('hoe', 1));
  });

  it('removeAt removes counts and clears emptied slots', () => {
    const start = inv([stack('seed_potato', 8)]);
    const partial = removeAt(start, 0, 3);
    expect(partial.removed).toBe(3);
    expect(partial.inv.slots[0]).toEqual(stack('seed_potato', 5));
    const all = removeAt(partial.inv, 0, 5);
    expect(all.removed).toBe(5);
    expect(all.inv.slots[0]).toBeNull();
  });
});

describe('move — click semantics: put down / merge / swap (§6.2)', () => {
  it('moves a stack into an empty slot', () => {
    const out = move(inv([stack('seed_turnip', 4)]), 0, 5);
    expect(out.slots[0]).toBeNull();
    expect(out.slots[5]).toEqual(stack('seed_turnip', 4));
  });

  it('merges same-id stacks up to 99, leaving the remainder behind', () => {
    const out = move(inv([stack('crop_potato', 60), stack('crop_potato', 60)]), 0, 1);
    expect(out.slots[1]).toEqual(stack('crop_potato', 99));
    expect(out.slots[0]).toEqual(stack('crop_potato', 21));
  });

  it('swaps different items', () => {
    const out = move(inv([stack('hoe', 1), stack('seed_turnip', 3)]), 0, 1);
    expect(out.slots[0]).toEqual(stack('seed_turnip', 3));
    expect(out.slots[1]).toEqual(stack('hoe', 1));
  });

  it('never loses items in any move (conservation)', () => {
    const start = inv([stack('crop_potato', 60), stack('crop_potato', 60), stack('hoe', 1)]);
    const total = (s: InventoryState) =>
      s.slots.reduce((sum, st) => sum + (st?.itemId === 'crop_potato' ? st.count : 0), 0);
    for (const [from, to] of [
      [0, 1],
      [1, 0],
      [0, 5],
      [2, 0],
    ] as const) {
      expect(total(move(start, from, to))).toBe(120);
    }
  });
});

describe('splitAt — partial-stack move (§6.7 right-button ops; M1.5, backlog B-11)', () => {
  it('moves exactly count units onto an empty slot', () => {
    const out = splitAt(inv([stack('seed_turnip', 10)]), 0, 3, 4);
    expect(out.slots[0]).toEqual(stack('seed_turnip', 6));
    expect(out.slots[3]).toEqual(stack('seed_turnip', 4));
  });

  it('merges into a same-id stack, clamping to the headroom (never destroys units)', () => {
    const out = splitAt(inv([stack('crop_turnip', 50), stack('crop_turnip', 97)]), 0, 1, 5);
    expect(out.slots[1]).toEqual(stack('crop_turnip', 99)); // +2 headroom only
    expect(out.slots[0]).toEqual(stack('crop_turnip', 48));
  });

  it('moving the whole stack empties the source slot', () => {
    const out = splitAt(inv([stack('seed_potato', 3)]), 0, 5, 3);
    expect(out.slots[0]).toBeNull();
    expect(out.slots[5]).toEqual(stack('seed_potato', 3));
  });

  it('clamps count to the source size', () => {
    const out = splitAt(inv([stack('seed_potato', 3)]), 0, 5, 99);
    expect(out.slots[0]).toBeNull();
    expect(out.slots[5]).toEqual(stack('seed_potato', 3));
  });

  it('different-id target / out-of-range / non-positive count are no-ops', () => {
    const start = inv([stack('seed_turnip', 10), stack('crop_turnip', 5)]);
    for (const out of [
      splitAt(start, 0, 1, 3), // different id
      splitAt(start, 0, 0, 3), // from === to
      splitAt(start, 0, 99, 3), // out of range
      splitAt(start, -1, 2, 3),
      splitAt(start, 0, 2, 0),
      splitAt(start, 0, 2, 1.5), // non-integer
      splitAt(start, 3, 2, 1), // empty source
    ]) {
      expect(out.slots).toEqual(start.slots);
    }
  });

  it('total units are conserved across any split', () => {
    const start = inv([stack('crop_turnip', 60), stack('crop_turnip', 80)]);
    const out = splitAt(start, 1, 0, 70);
    const total = (s: InventoryState): number =>
      s.slots.reduce((sum, x) => sum + (x?.count ?? 0), 0);
    expect(total(out)).toBe(total(start));
  });
});

describe('hotbar selection (slots 0..8, §6.2)', () => {
  it('selects valid hotbar slots', () => {
    expect(select(inv([], 0), 8).selected).toBe(8);
    expect(select(inv([], 5), 0).selected).toBe(0);
  });

  it('keeps selection inside 0..8 for out-of-range input', () => {
    for (const bad of [-1, 9, 11, 99]) {
      const out = select(inv([], 4), bad);
      expect(out.selected).toBeGreaterThanOrEqual(0);
      expect(out.selected).toBeLessThanOrEqual(8);
    }
  });
});

describe('discard — destroy via trash can (GDD §6.3)', () => {
  it('destroys a discardable stack (no world drop, no confirmation)', () => {
    const state = makeWorldState({
      inventory: inv([stack('hoe', 1), stack('watering_can', 1), stack('seed_turnip', 7)]),
    });
    const { state: out } = discardAt(state, 2);
    expect(out.inventory.slots[2]).toBeNull();
  });

  it('rejects undiscardable tools (discardable: false)', () => {
    const state = makeWorldState();
    const { state: out } = discardAt(state, 0); // slot0 = hoe
    expect(out.inventory.slots[0]).toEqual(stack('hoe', 1));
  });
});
