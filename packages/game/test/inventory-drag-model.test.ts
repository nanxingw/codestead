/**
 * Drag/undo/tidy store tests (GDD §6.7 hold machine, §6.3 undo slot, §6.9 invariants;
 * M1.5, PRD 02). The store is pure (zero Phaser): every test drives `applyOp` with an
 * op sequence — the exact injectable-sequence seam the heavy fuzz battery (PRD 02
 * test 6, ×1,000) plugs into; the seeded mini-fuzz at the bottom demonstrates it and
 * keeps the conservation + sim-convergence invariants pinned in regular CI.
 *
 * Sim convergence is asserted by replaying the emitted simOps onto a parallel slots
 * array with the REAL sim semantics — `move()` (sort-plan re-exports it) and the
 * additive `splitAt()` (§6.7 right-button ops, backlog B-11) — and comparing against
 * `expectedSimSlots`: the store provably needs nothing beyond the
 * `moveItem`/`splitItem`/`discardItem` SimCommands (InventoryApi six methods and the
 * save schema stay untouched, PRD 02 red line).
 */
import { describe, expect, it } from 'vitest';

import {
  applyOp,
  classifyTarget,
  createDragState,
  expectedSimSlots,
  heldStack,
  totalUnits,
  type ApplyResult,
  type DragOp,
  type DragSimOp,
  type DragState,
  type DropTarget,
} from '../src/ui/inventory/drag-model';
import { applyMoveToSlots, type Slots } from '../src/ui/inventory/sort-plan';
import { splitAt } from '../src/sim/inventory';
import type { ItemStack } from '../src/sim/types';

const s = (itemId: string, count: number): ItemStack => ({ itemId, count });
const slot = (index: number): DropTarget => ({ kind: 'slot', index });
const TRASH: DropTarget = { kind: 'trash' };
const UNDO: DropTarget = { kind: 'undo' };
const OUTSIDE: DropTarget = { kind: 'outside' };

function baseSlots(): Slots {
  const slots: Slots = Array.from({ length: 12 }, () => null);
  slots[0] = s('hoe', 1);
  slots[1] = s('watering_can', 1);
  slots[2] = s('seed_turnip', 10);
  slots[4] = s('crop_turnip', 60);
  slots[9] = s('crop_turnip', 60);
  slots[10] = s('material_wood', 5);
  return slots;
}

/** Replay emitted simOps on a parallel "sim" with real move/split semantics. */
function replaySim(sim: Slots, ops: DragSimOp[]): { sim: Slots; destroyed: number } {
  let destroyed = 0;
  let next = sim;
  for (const op of ops) {
    if (op.kind === 'move') {
      next = applyMoveToSlots(next, op.from, op.to);
    } else if (op.kind === 'split') {
      // The REAL sim splitItem semantics (sim/inventory.ts) — convergence proof.
      next = splitAt({ slots: next, capacity: 12, selected: 0 }, op.from, op.to, op.count).slots;
    } else {
      destroyed += next[op.slot]?.count ?? 0;
      next = next.map((x) => (x ? { ...x } : null));
      next[op.slot] = null;
    }
  }
  return { sim: next, destroyed };
}

/** Drive a sequence while checking convergence after every op. */
function run(slots: Slots, ops: DragOp[]): { state: DragState; sim: Slots; destroyed: number } {
  let state = createDragState(slots);
  let sim = slots.map((x) => (x ? { ...x } : null));
  let destroyed = 0;
  const initial = totalUnits(state);
  for (const op of ops) {
    const r: ApplyResult = applyOp(state, op);
    const replay = replaySim(sim, r.simOps);
    sim = replay.sim;
    destroyed += replay.destroyed;
    state = r.state;
    expect(sim).toEqual(expectedSimSlots(state)); // sim convergence (§6.9)
    expect(totalUnits(state) + destroyed).toBe(initial); // conservation (§6.9)
    for (const stack of state.slots) {
      if (stack) {
        expect(stack.count).toBeGreaterThan(0);
        expect(stack.count).toBeLessThanOrEqual(99);
      }
    }
  }
  return { state, sim, destroyed };
}

describe('press / release gesture (按下拾起 / 释放落下 / 无效位回弹)', () => {
  it('press picks up virtually: hand set, slot content untouched, no simOps', () => {
    const r = applyOp(createDragState(baseSlots()), { op: 'press', target: slot(2) });
    expect(r.state.held).toEqual({ from: 2, pickupPress: true });
    expect(heldStack(r.state)).toEqual(s('seed_turnip', 10));
    expect(r.state.slots[2]).toEqual(s('seed_turnip', 10)); // virtual hold
    expect(r.simOps).toEqual([]);
    expect(r.fx).toEqual([{ fx: 'pickup', slot: 2 }]);
  });

  it('press on an empty or locked slot does nothing', () => {
    const st = createDragState(baseSlots());
    expect(applyOp(st, { op: 'press', target: slot(3) }).state.held).toBeNull();
    expect(applyOp(st, { op: 'press', target: slot(15) }).state.held).toBeNull();
  });

  it('release on the origin slot completes a click-pickup (stays in hand)', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: slot(2) },
    ]);
    expect(state.held).toEqual({ from: 2, pickupPress: false });
  });

  it('drag-release onto an empty slot moves the stack (one moveItem)', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(2) }).state;
    const r = applyOp(state, { op: 'release', target: slot(5) });
    expect(r.simOps).toEqual([{ kind: 'move', from: 2, to: 5 }]);
    expect(r.state.held).toBeNull();
    expect(r.state.slots[5]).toEqual(s('seed_turnip', 10));
    expect(r.state.slots[2]).toBeNull();
  });

  it('release on an invalid target bounces back: hand empties, nothing moves', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(2) }).state;
    const r = applyOp(state, { op: 'release', target: OUTSIDE });
    expect(r.state.held).toBeNull();
    expect(r.state.slots).toEqual(createDragState(baseSlots()).slots);
    expect(r.simOps).toEqual([]);
    expect(r.fx).toEqual([{ fx: 'bounce', toSlot: 2 }]);
  });

  it('release on a locked slot index also bounces', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(2) }).state;
    const r = applyOp(state, { op: 'release', target: slot(15) });
    expect(r.state.held).toBeNull();
    expect(r.fx).toEqual([{ fx: 'bounce', toSlot: 2 }]);
  });

  it('while holding, a press on a locked slot keeps holding (misclick-safe)', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(2) }).state;
    state = applyOp(state, { op: 'release', target: slot(2) }).state;
    const r = applyOp(state, { op: 'press', target: slot(15) });
    expect(r.state.held).toEqual({ from: 2, pickupPress: false });
    expect(r.fx).toEqual([{ fx: 'reject-locked' }]);
  });

  it('click-place onto the origin puts the stack back (hand empties)', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: slot(2) },
      { op: 'press', target: slot(2) },
    ]);
    expect(state.held).toBeNull();
    expect(state.slots[2]).toEqual(s('seed_turnip', 10));
  });

  it('same-id merge overflow stays in hand (§6.7 溢出留手)', () => {
    const slots = baseSlots(); // slot4 & slot9 both crop_turnip 60
    const { state } = run(slots, [
      { op: 'press', target: slot(9) },
      { op: 'release', target: slot(4) },
    ]);
    expect(state.slots[4]).toEqual(s('crop_turnip', 99));
    expect(state.slots[9]).toEqual(s('crop_turnip', 21));
    expect(state.held).toEqual({ from: 9, pickupPress: false }); // leftover in hand
  });

  it('different-id drop swaps and keeps the other stack in hand (§6.7 交换)', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: slot(10) },
    ]);
    expect(state.slots[10]).toEqual(s('seed_turnip', 10));
    expect(state.slots[2]).toEqual(s('material_wood', 5));
    expect(state.held).toEqual({ from: 2, pickupPress: false });
    expect(heldStack(state)).toEqual(s('material_wood', 5));
  });

  it('close returns the hand to its origin — items never vanish (§6.9)', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: slot(2) },
      { op: 'close' },
    ]);
    expect(state.held).toBeNull();
    expect(state.slots[2]).toEqual(s('seed_turnip', 10));
  });
});

describe('right-button ops (§6.7 拿半堆 / 放 1 个; US26, sim channel = splitItem)', () => {
  it('right press picks ⌈n/2⌉: split into an anchor slot, remainder stays put', () => {
    const r = applyOp(createDragState(baseSlots()), {
      op: 'press',
      target: slot(4), // crop_turnip 60
      button: 'right',
    });
    expect(r.simOps).toEqual([{ kind: 'split', from: 4, to: 11, count: 30 }]); // last empty
    expect(r.state.slots[4]).toEqual(s('crop_turnip', 30)); // remainder visible at source
    expect(heldStack(r.state)).toEqual(s('crop_turnip', 30)); // ⌈60/2⌉ in hand
    expect(r.state.held).toEqual({ from: 11, pickupPress: true, pressSlot: 4 });
    expect(r.fx).toEqual([{ fx: 'pickup', slot: 4 }]);
  });

  it('right pick of an odd stack takes the larger half (⌈7/2⌉ = 4)', () => {
    const slots = baseSlots();
    slots[2] = s('seed_turnip', 7);
    const { state } = run(slots, [{ op: 'press', target: slot(2), button: 'right' }]);
    expect(state.slots[2]).toEqual(s('seed_turnip', 3));
    expect(heldStack(state)).toEqual(s('seed_turnip', 4));
  });

  it('releasing the right pick over the clicked slot completes the pickup', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(4), button: 'right' },
      { op: 'release', target: slot(4), button: 'right' }, // same physical click
    ]);
    expect(heldStack(state)).toEqual(s('crop_turnip', 30)); // still in hand
    expect(state.held?.pickupPress).toBe(false);
  });

  it('right pick of a single unit degenerates to a whole pick (no split op)', () => {
    const r = applyOp(createDragState(baseSlots()), {
      op: 'press',
      target: slot(0), // hoe ×1
      button: 'right',
    });
    expect(r.simOps).toEqual([]);
    expect(r.state.held).toEqual({ from: 0, pickupPress: true });
  });

  it('right pick on a full backpack is refused with a hint (bounded divergence)', () => {
    const slots: Slots = Array.from({ length: 12 }, (_, i) => s('crop_turnip', 10 + i));
    const r = applyOp(createDragState(slots), { op: 'press', target: slot(3), button: 'right' });
    expect(r.state.held).toBeNull();
    expect(r.simOps).toEqual([]);
    expect(r.fx).toEqual([{ fx: 'reject-full' }]);
  });

  it('right place puts exactly 1 onto an empty slot; the rest stays in hand', () => {
    const { state, sim } = run(baseSlots(), [
      { op: 'press', target: slot(2) }, // seed_turnip 10, whole hold
      { op: 'release', target: slot(2) },
      { op: 'press', target: slot(3), button: 'right' },
    ]);
    expect(state.slots[3]).toEqual(s('seed_turnip', 1));
    expect(heldStack(state)).toEqual(s('seed_turnip', 9));
    expect(sim[3]).toEqual(s('seed_turnip', 1)); // sim converged via splitItem
  });

  it('right place merges exactly 1 into a same-id stack (§6.7 右键@同id)', () => {
    const slots = baseSlots();
    slots[3] = s('seed_turnip', 5);
    const { state } = run(slots, [
      { op: 'press', target: slot(2) }, // seed_turnip 10
      { op: 'release', target: slot(2) },
      { op: 'press', target: slot(3), button: 'right' },
    ]);
    expect(state.slots[3]).toEqual(s('seed_turnip', 6));
    expect(heldStack(state)).toEqual(s('seed_turnip', 9));
  });

  it('right place onto a different id or a full stack keeps holding (no-op)', () => {
    const slots = baseSlots();
    slots[3] = s('crop_turnip', 99);
    const { state } = run(slots, [
      { op: 'press', target: slot(2) }, // seed_turnip 10
      { op: 'release', target: slot(2) },
      { op: 'press', target: slot(10), button: 'right' }, // material_wood → no-op
      { op: 'press', target: slot(3), button: 'right' }, // full same... different id too
    ]);
    expect(heldStack(state)).toEqual(s('seed_turnip', 10));
    expect(state.slots[10]).toEqual(s('material_wood', 5));
    expect(state.slots[3]).toEqual(s('crop_turnip', 99));
  });

  it('right-placing the last unit empties the hand via a plain move', () => {
    const slots = baseSlots();
    slots[2] = s('seed_turnip', 1);
    const r1 = applyOp(createDragState(slots), { op: 'press', target: slot(2) });
    const r2 = applyOp(r1.state, { op: 'press', target: slot(5), button: 'right' });
    expect(r2.simOps).toEqual([{ kind: 'move', from: 2, to: 5 }]);
    expect(r2.state.held).toBeNull();
    expect(r2.state.slots[5]).toEqual(s('seed_turnip', 1));
  });

  it('a split hold can still swap with a different id (anchor whole-hold path)', () => {
    const { state } = run(baseSlots(), [
      { op: 'press', target: slot(4), button: 'right' }, // hold 30 turnips @anchor 11
      { op: 'release', target: slot(4), button: 'right' },
      { op: 'press', target: slot(10) }, // left place onto material_wood → swap
    ]);
    expect(state.slots[10]).toEqual(s('crop_turnip', 30));
    expect(heldStack(state)).toEqual(s('material_wood', 5));
  });

  it('closing with a split hold keeps the half at its anchor slot — nothing vanishes', () => {
    const { state, destroyed } = run(baseSlots(), [
      { op: 'press', target: slot(4), button: 'right' },
      { op: 'release', target: slot(4), button: 'right' },
      { op: 'close' },
    ]);
    expect(destroyed).toBe(0);
    expect(state.held).toBeNull();
    expect(state.slots[4]).toEqual(s('crop_turnip', 30));
    expect(state.slots[11]).toEqual(s('crop_turnip', 30)); // anchored half stays put
  });

  it('right pick prefers an anchor that does not park a pending discard', () => {
    const slots = baseSlots();
    slots[11] = s('seed_potato', 3); // leave empties at 3, 5..8 only
    const { state, destroyed } = run(slots, [
      { op: 'press', target: slot(11), shift: false },
      { op: 'release', target: TRASH }, // potato parked at sim slot 11
      { op: 'press', target: slot(4), button: 'right' }, // anchor must avoid slot 11
    ]);
    expect(destroyed).toBe(0);
    expect(state.undo?.stack).toEqual(s('seed_potato', 3)); // undo still retrievable
    expect(heldStack(state)).toEqual(s('crop_turnip', 30));
    expect(state.held?.from).not.toBe(11);
  });
});

describe('hover classification (悬停高亮)', () => {
  it('classifies place / merge / swap / origin / invalid while holding', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(4) }).state; // crop_turnip 60
    expect(classifyTarget(state, slot(3))).toBe('place');
    expect(classifyTarget(state, slot(9))).toBe('merge');
    expect(classifyTarget(state, slot(10))).toBe('swap');
    expect(classifyTarget(state, slot(4))).toBe('origin');
    expect(classifyTarget(state, slot(15))).toBe('invalid');
    expect(classifyTarget(state, TRASH)).toBe('trash-ok');
  });

  it('flags non-discardable held stacks over the trash', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(0) }).state; // hoe
    expect(classifyTarget(state, TRASH)).toBe('trash-reject');
  });
});

describe('trash + undo slot (§6.3 deferred destroy, 无确认+有撤销)', () => {
  it('trashing arms the undo slot with NO sim op (deferred destroy)', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(2) }).state;
    const r = applyOp(state, { op: 'release', target: TRASH });
    expect(r.simOps).toEqual([]); // the real discardItem is deferred
    expect(r.state.slots[2]).toBeNull();
    expect(r.state.undo).toEqual({ stack: s('seed_turnip', 10), originSlot: 2, simSlot: 2 });
    expect(r.state.held).toBeNull();
  });

  it('non-discardable stacks are double-blocked with a head-shake (tools)', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(0) }).state; // hoe
    const r = applyOp(state, { op: 'release', target: TRASH });
    expect(r.fx).toEqual([{ fx: 'reject-not-discardable' }]);
    expect(r.state.held).toEqual({ from: 0, pickupPress: false }); // still in hand
    expect(r.state.undo).toBeNull();
    expect(r.state.slots[0]).toEqual(s('hoe', 1));
  });

  it('undo click takes the stack back to its origin slot with zero sim ops', () => {
    const { state, destroyed } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: TRASH },
      { op: 'press', target: UNDO },
    ]);
    expect(state.slots[2]).toEqual(s('seed_turnip', 10));
    expect(state.undo).toBeNull();
    expect(destroyed).toBe(0);
  });

  it('undo retrieval survives the origin slot being reoccupied (first empty slot)', () => {
    const { state, destroyed } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: TRASH }, // seed_turnip 10 parked, slot 2 empty
      { op: 'press', target: slot(10) },
      { op: 'release', target: slot(2) }, // wood dropped onto the freed origin
      { op: 'press', target: UNDO },
    ]);
    expect(state.slots[2]).toEqual(s('material_wood', 5));
    const idx = state.slots.findIndex((x) => x?.itemId === 'seed_turnip' && x.count === 10);
    expect(idx).toBe(3); // first empty slot at retrieval time
    expect(state.undo).toBeNull();
    expect(destroyed).toBe(0); // relocation, not destruction
  });

  it('re-discard finalizes the previous pending stack (only then is it destroyed)', () => {
    const { state, destroyed } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: TRASH }, // seed_turnip 10 pending
      { op: 'press', target: slot(10) },
      { op: 'release', target: TRASH }, // wood replaces it -> turnip destroyed
    ]);
    expect(destroyed).toBe(10);
    expect(state.undo?.stack).toEqual(s('material_wood', 5));
  });

  it('closing the panel finalizes the pending discard (undo never enters the save)', () => {
    const { state, destroyed } = run(baseSlots(), [
      { op: 'press', target: slot(2) },
      { op: 'release', target: TRASH },
      { op: 'close' },
    ]);
    expect(destroyed).toBe(10);
    expect(state.undo).toBeNull();
    expect(state.held).toBeNull();
  });

  it('R-tidy with an armed undo keeps it retrievable (park slot excluded)', () => {
    const slots = baseSlots();
    const { state, destroyed } = run(slots, [
      { op: 'press', target: slot(9) }, // crop_turnip 60 in reserve
      { op: 'release', target: TRASH }, // parked at sim slot 9
      { op: 'sort' },
      { op: 'press', target: UNDO },
    ]);
    expect(destroyed).toBe(0);
    expect(state.undo).toBeNull();
    expect(state.slots[9]).toEqual(s('crop_turnip', 60)); // back at its origin
  });
});

describe('R-key tidy via the store (§6.2)', () => {
  it('sorts reserve only and emits plain move simOps', () => {
    const slots = baseSlots();
    slots[11] = s('seed_potato', 7);
    let state = createDragState(slots);
    const r = applyOp(state, { op: 'sort' });
    for (const op of r.simOps) {
      expect(op.kind).toBe('move');
      if (op.kind === 'move') {
        expect(op.from).toBeGreaterThanOrEqual(9);
        expect(op.to).toBeGreaterThanOrEqual(9);
      }
    }
    state = r.state;
    expect(state.slots.slice(0, 9)).toEqual(slots.slice(0, 9));
    expect(state.slots.slice(9)).toEqual([
      s('seed_potato', 7),
      s('crop_turnip', 60),
      s('material_wood', 5),
    ]);
  });

  it('is ignored while a stack is in hand (hold anchor must not shuffle)', () => {
    let state = createDragState(baseSlots());
    state = applyOp(state, { op: 'press', target: slot(9) }).state;
    const r = applyOp(state, { op: 'sort' });
    expect(r.simOps).toEqual([]);
    expect(r.state.held).toEqual({ from: 9, pickupPress: true });
  });
});

describe('Shift quick-move (§6.7)', () => {
  it('moves a hotbar stack into reserve: merge first, then first empty', () => {
    const { state } = run(baseSlots(), [{ op: 'press', target: slot(4), shift: true }]);
    expect(state.slots[4]).toBeNull();
    expect(state.slots[9]).toEqual(s('crop_turnip', 99)); // 60 + 39 merged
    expect(state.slots[11]).toEqual(s('crop_turnip', 21)); // remainder to first empty
  });

  it('moves a reserve stack to the hotbar', () => {
    const { state } = run(baseSlots(), [{ op: 'press', target: slot(10), shift: true }]);
    expect(state.slots[10]).toBeNull();
    expect(state.slots[3]).toEqual(s('material_wood', 5)); // first empty hotbar slot
  });
});

describe('seeded mini-fuzz (heavy-tests interface demo; PRD 02 test 6 runs ×1,000)', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomTarget(rng: () => number): DropTarget {
    const roll = rng();
    if (roll < 0.7) return slot(Math.floor(rng() * 16) - 2); // includes invalid indices
    if (roll < 0.82) return TRASH;
    if (roll < 0.92) return UNDO;
    return OUTSIDE;
  }

  function randomOp(rng: () => number): DragOp {
    const roll = rng();
    const button = (): 'left' | 'right' => (rng() < 0.3 ? 'right' : 'left'); // §6.7 right ops
    if (roll < 0.38) {
      return { op: 'press', target: randomTarget(rng), shift: rng() < 0.15, button: button() };
    }
    if (roll < 0.76) return { op: 'release', target: randomTarget(rng), button: button() };
    if (roll < 0.86) return { op: 'hover', target: randomTarget(rng) };
    if (roll < 0.96) return { op: 'sort' };
    return { op: 'close' };
  }

  it('400 random ops × 5 seeds: conservation, convergence, bounded stacks', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const rng = mulberry32(seed * 7919);
      const ops: DragOp[] = Array.from({ length: 400 }, () => randomOp(rng));
      ops.push({ op: 'close' }); // every session ends by closing the panel
      const { state } = run(baseSlots(), ops); // run() asserts invariants per op
      expect(state.held).toBeNull(); // after close the hand is always empty (§6.9)
      expect(state.undo).toBeNull();
    }
  });
});
