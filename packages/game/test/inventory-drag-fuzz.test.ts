/**
 * Drag-store fuzz ×1,000 + scripted §6.7 contract suite (PRD 02 Testing Decision #6;
 * GDD §6.9 验收要点 "拖拽 fuzz 1,000 次物品总数守恒" / §6.3 撤销槽 / §6.2 R 整理).
 *
 * Targets (both run the identical fuzz + universal contract suite, including the
 * §6.7 right-button split ops 拿半堆/放 1):
 *  1. the REFERENCE model (helpers/drag-store-contract.ts) — self-validates the fuzz
 *     harness and doubles as the executable §6.7 spec;
 *  2. the REAL inventory-polish pure store (src/ui/inventory/drag-model.ts) through
 *     the thin adapter in the helper — virtual hold, deferred-destroy undo, splits
 *     via the additive `splitItem` SimCommand (backlog B-11).
 *
 * Invariants asserted after EVERY random operation (all headless, zero Phaser):
 *  - per-item conservation: units in slots+held+undo never change; the ONLY
 *    destroyable unit is the stack sitting in the undo slot (§6.3 destruction
 *    channels: re-discard, panel close, and the real model's documented early
 *    eviction), and destroying it always leaves the undo slot empty;
 *  - bounds: no zero/negative stacks, no stack above its stackMax, slot count fixed;
 *  - no dangling references: no stack object is reachable twice (slot/held/undo);
 *  - undo: single-step and idempotent; retrieval conserves the stack and clears the
 *    slot (destination — cursor vs origin slot — is implementation choice);
 *  - the undo slot never holds a discardable:false item (it would become destructible);
 *  - tools (discardable:false) are indestructible across the whole run;
 *  - close: hand always empties, undo always clears, nothing vanishes (§6.9);
 *  - sortReserve: hotbar 0..8 byte-identical; reserve merged + ordered whenever no
 *    hold/undo exclusion is in play (§6.2).
 *
 * Randomized-test discipline (PRD 02): seeded LCG; a failure reports the sequence
 * seed, op index and full op trace as the minimal reproduction.
 */
import { describe, expect, it } from 'vitest';

import type { ItemStack } from '@codestead/shared';

import { getItemDef } from '../src/sim/data/items';
import {
  CATEGORY_SORT_ORDER,
  HOTBAR_SIZE,
  adaptDragModel,
  createReferenceDragStore,
  type DragStoreApi,
  type DragStoreFactory,
} from './helpers/drag-store-contract';

// ---------------------------------------------------------------------------
// Seeded fuzz harness
// ---------------------------------------------------------------------------

const SEQUENCES = 1_000;
const OPS_PER_SEQUENCE = 60;
const CAPACITY = 12;

/** Deterministic LCG (same recipe as sim/__tests__/fixtures.ts makeTestRng). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const FUZZ_POOL = [
  'seed_radish_quick',
  'seed_turnip',
  'seed_potato',
  'crop_radish_quick',
  'crop_turnip',
  'crop_bean_vine',
  'material_wood',
  'material_stone',
  'forage_wildflower',
] as const;

function randomSlots(rnd: () => number): (ItemStack | null)[] {
  const slots: (ItemStack | null)[] = Array.from({ length: CAPACITY }, () => null);
  slots[0] = { itemId: 'hoe', count: 1 }; // discardable:false coverage
  slots[1] = { itemId: 'watering_can', count: 1 };
  for (let i = 2; i < CAPACITY; i++) {
    if (rnd() < 0.7) {
      const itemId = FUZZ_POOL[Math.floor(rnd() * FUZZ_POOL.length)];
      slots[i] = { itemId, count: 1 + Math.floor(rnd() * 99) };
    }
  }
  return slots;
}

type FuzzOp =
  | { kind: 'left' | 'right' | 'shiftLeft'; slot: number }
  | { kind: 'trash' | 'undo' | 'sort' | 'close' };

function randomOp(rnd: () => number): FuzzOp {
  const r = rnd();
  // clicks dominate; slot range −1..12 also exercises the out-of-range no-op contract
  const slot = Math.floor(rnd() * (CAPACITY + 2)) - 1;
  if (r < 0.35) return { kind: 'left', slot };
  if (r < 0.55) return { kind: 'right', slot };
  if (r < 0.65) return { kind: 'shiftLeft', slot };
  if (r < 0.78) return { kind: 'trash' };
  if (r < 0.88) return { kind: 'undo' };
  if (r < 0.95) return { kind: 'sort' };
  return { kind: 'close' };
}

function applyOp(store: DragStoreApi, op: FuzzOp): void {
  switch (op.kind) {
    case 'left':
      store.leftClick(op.slot);
      break;
    case 'right':
      store.rightClick(op.slot);
      break;
    case 'shiftLeft':
      store.shiftLeftClick(op.slot);
      break;
    case 'trash':
      store.trashClick();
      break;
    case 'undo':
      store.undoClick();
      break;
    case 'sort':
      store.sortReserve();
      break;
    case 'close':
      store.close();
      break;
  }
}

interface Snapshot {
  slots: (ItemStack | null)[];
  held: ItemStack | null;
  undo: ItemStack | null;
}

function snapshot(store: DragStoreApi): Snapshot {
  return {
    slots: store.slots.map((s) => (s ? { ...s } : null)),
    held: store.held ? { ...store.held } : null,
    undo: store.undoSlot ? { ...store.undoSlot } : null,
  };
}

function totals(snap: Snapshot): Map<string, number> {
  const map = new Map<string, number>();
  const bump = (s: ItemStack | null): void => {
    if (s) map.set(s.itemId, (map.get(s.itemId) ?? 0) + s.count);
  };
  for (const s of snap.slots) bump(s);
  bump(snap.held);
  bump(snap.undo);
  return map;
}

/** Returns a violation description, or null when every invariant holds. */
function checkStep(store: DragStoreApi, before: Snapshot, op: FuzzOp): string | null {
  const after = snapshot(store);

  // structure & bounds
  if (after.slots.length !== before.slots.length) return 'slot count changed';
  for (const stack of [...after.slots, after.held, after.undo]) {
    if (stack === null) continue;
    if (!Number.isInteger(stack.count)) return `non-integer count on ${stack.itemId}`;
    if (stack.count <= 0) return `empty stack object left behind for ${stack.itemId}`;
    if (stack.count > getItemDef(stack.itemId).stackMax) {
      return `${stack.itemId} above stackMax: ${stack.count}`;
    }
  }

  // no dangling/duplicated references: each live stack object reachable exactly once
  const refs = [...store.slots, store.held, store.undoSlot].filter((s) => s !== null);
  if (new Set(refs).size !== refs.length) return 'stack object aliased in two places';

  // the undo slot is destructible (§6.3) — a discardable:false item must never enter it
  if (after.undo && !getItemDef(after.undo.itemId).discardable) {
    return `undo slot holds the indestructible ${after.undo.itemId}`;
  }

  // conservation: the ONLY destroyable unit is the OLD undo-slot stack (§6.3
  // channels: re-discard, close, and the real model's documented early eviction
  // when a drop needs the parked slot) — and destroying it must leave the undo slot
  // either empty or freshly re-armed by this very trash (never a partial leak).
  const beforeTotals = totals(before);
  const afterTotals = totals(after);
  const ids = new Set([...beforeTotals.keys(), ...afterTotals.keys()]);
  for (const id of ids) {
    const delta = (afterTotals.get(id) ?? 0) - (beforeTotals.get(id) ?? 0);
    if (delta === 0) continue;
    if (delta > 0) return `${id} duplicated (+${delta})`;
    if (before.undo?.itemId !== id || -delta !== before.undo.count) {
      return `${id} vanished (${delta}, op ${op.kind})`;
    }
    const undoCleared = after.undo === null;
    const undoRearmedByTrash =
      op.kind === 'trash' &&
      before.held !== null &&
      after.undo !== null &&
      after.undo.itemId === before.held.itemId &&
      after.undo.count === before.held.count;
    if (!undoCleared && !undoRearmedByTrash) {
      return `undo slot leaked while its stack was destroyed (op ${op.kind})`;
    }
  }

  // op-specific postconditions
  if (op.kind === 'close') {
    if (after.held !== null) return 'close left a held stack';
    if (after.undo !== null) {
      // Only the documented degenerate spill may survive a close: an undo-retrieved
      // stack with ZERO backpack room (no empty slot, no same-id headroom) re-enters
      // the undo slot — §6.9 anti-vanish outranks the §6.3 clear (see contract notes).
      const id = after.undo.itemId;
      const max = getItemDef(id).stackMax;
      const hasRoom = after.slots.some((s) => s === null || (s.itemId === id && s.count < max));
      if (hasRoom) return 'close left the undo slot populated despite available room (§6.3)';
    }
  }
  if (op.kind === 'trash' && before.held) {
    if (getItemDef(before.held.itemId).discardable) {
      if (after.held !== null) return 'trash did not empty the hand';
      if (
        after.undo === null ||
        after.undo.itemId !== before.held.itemId ||
        after.undo.count !== before.held.count
      ) {
        return 'trash did not move the held stack into the undo slot';
      }
    } else if (JSON.stringify(after) !== JSON.stringify(before)) {
      return 'trash on a discardable:false stack must be a pure reject';
    }
  }
  if (op.kind === 'undo') {
    // Destination (cursor vs origin/first-empty slot) is implementation choice; the
    // universal contract: a retrieval that does anything must clear the undo slot,
    // and conservation (checked above) guarantees the stack landed somewhere. A full
    // backpack may legitimately block retrieval (state unchanged).
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    if (!unchanged) {
      if (before.undo === null) return 'undo with an empty undo slot must be a no-op';
      if (after.undo !== null) return 'undo retrieval did not clear the undo slot';
    }
  }
  if (op.kind === 'sort') {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (JSON.stringify(after.slots[i]) !== JSON.stringify(before.slots[i])) {
        return `sortReserve touched hotbar slot ${i} (§6.2)`;
      }
    }
    // Full ordering is only owed when nothing excludes slots from the plan: a hold
    // anchor or an armed undo (its parked slot is excluded, GDD §6.3) may leave the
    // reserve partially arranged — both are documented model behaviors.
    if (after.held === null && after.undo === null) {
      const violation = reserveOrderViolation(after.slots);
      if (violation) return violation;
    }
  }
  return null;
}

/** Reserve (9+) must be compacted, merged (≤1 partial stack per id) and ordered. */
function reserveOrderViolation(slots: (ItemStack | null)[]): string | null {
  const reserve = slots.slice(HOTBAR_SIZE);
  const stacks = reserve.filter((s): s is ItemStack => s !== null);
  const firstNull = reserve.findIndex((s) => s === null);
  if (firstNull !== -1 && reserve.slice(firstNull).some((s) => s !== null)) {
    return 'sorted reserve is not compacted (stack after a gap)';
  }
  const rank = (id: string): number => {
    const idx = (CATEGORY_SORT_ORDER as readonly string[]).indexOf(getItemDef(id).category);
    return idx === -1 ? CATEGORY_SORT_ORDER.length : idx;
  };
  for (let i = 1; i < stacks.length; i++) {
    const a = stacks[i - 1];
    const b = stacks[i];
    if (rank(a.itemId) > rank(b.itemId)) return 'reserve category order violated';
    if (rank(a.itemId) === rank(b.itemId) && a.itemId > b.itemId) {
      return 'reserve id lexicographic order violated';
    }
  }
  const partials = new Map<string, number>();
  for (const s of stacks) {
    if (s.count < getItemDef(s.itemId).stackMax) {
      partials.set(s.itemId, (partials.get(s.itemId) ?? 0) + 1);
    }
  }
  for (const [id, n] of partials) {
    if (n > 1) return `reserve not fully merged: ${n} partial stacks of ${id}`;
  }
  return null;
}

interface FuzzFailure {
  seed: number;
  opIndex: number;
  violation: string;
  trace: string;
}

function fuzzSequence(factory: DragStoreFactory, seed: number): FuzzFailure | null {
  const rnd = makeRng(seed);
  const store = factory(randomSlots(rnd));
  const trace: string[] = [];
  const startTools =
    (totals(snapshot(store)).get('hoe') ?? 0) + (totals(snapshot(store)).get('watering_can') ?? 0);

  for (let k = 0; k < OPS_PER_SEQUENCE; k++) {
    const op = randomOp(rnd);
    trace.push('slot' in op ? `${op.kind}(${op.slot})` : op.kind);
    const before = snapshot(store);
    applyOp(store, op);
    const violation = checkStep(store, before, op);
    if (violation) return { seed, opIndex: k, violation, trace: trace.join(' ') };
  }

  // terminal close: hand must empty and conservation must hold one last time
  const before = snapshot(store);
  store.close();
  const violation = checkStep(store, before, { kind: 'close' });
  if (violation) {
    return { seed, opIndex: OPS_PER_SEQUENCE, violation, trace: `${trace.join(' ')} close` };
  }

  // tools are indestructible across the whole run (discardable:false, §6.3)
  const endSnap = snapshot(store);
  const endTools = (totals(endSnap).get('hoe') ?? 0) + (totals(endSnap).get('watering_can') ?? 0);
  if (endTools !== startTools) {
    return {
      seed,
      opIndex: OPS_PER_SEQUENCE,
      violation: `tools destroyed: ${startTools} → ${endTools}`,
      trace: trace.join(' '),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The suite (runs verbatim against reference now, real store at integration)
// ---------------------------------------------------------------------------

interface SuiteCapabilities {
  /** §6.7 right-button split ops (拿半堆/放 1). Both stores implement them; kept as a
   * capability flag so a future degraded store surfaces as explicit skips, not green. */
  splitStacks: boolean;
}

function dragStoreSuite(factory: DragStoreFactory, caps: SuiteCapabilities): void {
  const empty = (): (ItemStack | null)[] => Array.from({ length: CAPACITY }, () => null);
  const countOf = (store: DragStoreApi, itemId: string): number => {
    const snap = snapshot(store);
    return totals(snap).get(itemId) ?? 0;
  };

  it(`fuzz: ${SEQUENCES} seeded sequences × ${OPS_PER_SEQUENCE} ops hold every invariant`, () => {
    const failures: FuzzFailure[] = [];
    for (let seq = 0; seq < SEQUENCES; seq++) {
      const failure = fuzzSequence(factory, 0x517cc1b7 ^ seq);
      if (failure) failures.push(failure); // failure carries the minimal repro
    }
    expect(failures).toEqual([]);
  });

  it('left pick takes the whole stack', () => {
    const slots = empty();
    slots[3] = { itemId: 'crop_turnip', count: 7 };
    const store = factory(slots);
    store.leftClick(3);
    expect(store.held).toEqual({ itemId: 'crop_turnip', count: 7 });
    expect(store.slots[3]).toBeNull();
  });

  it.runIf(caps.splitStacks)('right pick takes ⌈n/2⌉ (§6.7)', () => {
    const slots = empty();
    slots[3] = { itemId: 'crop_turnip', count: 7 };
    const store = factory(slots);
    store.rightClick(3);
    expect(store.held).toEqual({ itemId: 'crop_turnip', count: 4 }); // ⌈7/2⌉
    expect(store.slots[3]).toEqual({ itemId: 'crop_turnip', count: 3 });
  });

  it('same-id merge fills to stackMax and the overflow stays held (§6.7)', () => {
    const slots = empty();
    slots[2] = { itemId: 'material_wood', count: 95 };
    slots[4] = { itemId: 'material_wood', count: 10 };
    const store = factory(slots);
    store.leftClick(4); // hold 10
    store.leftClick(2); // merge into 95
    expect(store.slots[2]).toEqual({ itemId: 'material_wood', count: 99 });
    expect(store.held).toEqual({ itemId: 'material_wood', count: 6 });
  });

  it('different-id placement swaps (§6.7 异 id 交换)', () => {
    const slots = empty();
    slots[0] = { itemId: 'seed_turnip', count: 5 };
    slots[1] = { itemId: 'crop_potato', count: 9 };
    const store = factory(slots);
    store.leftClick(0); // hold 5 turnip seeds
    store.leftClick(1); // swap with potatoes
    expect(store.slots[1]).toEqual({ itemId: 'seed_turnip', count: 5 });
    expect(store.held).toEqual({ itemId: 'crop_potato', count: 9 });
  });

  it.runIf(caps.splitStacks)('right-click places exactly 1 (§6.7)', () => {
    const slots = empty();
    slots[1] = { itemId: 'crop_potato', count: 9 };
    const store = factory(slots);
    store.leftClick(1);
    store.rightClick(5); // empty slot ← exactly 1
    expect(store.slots[5]).toEqual({ itemId: 'crop_potato', count: 1 });
    expect(store.held).toEqual({ itemId: 'crop_potato', count: 8 });
  });

  it('closing with a held stack returns it to its origin slot (§6.7/§6.9)', () => {
    const slots = empty();
    slots[6] = { itemId: 'crop_radish_quick', count: 12 };
    const store = factory(slots);
    store.leftClick(6);
    store.close();
    expect(store.held).toBeNull();
    expect(store.slots[6]).toEqual({ itemId: 'crop_radish_quick', count: 12 }); // back home
  });

  it('closing after a swap chain loses nothing and empties the hand (§6.9)', () => {
    const slots = empty();
    slots[6] = { itemId: 'crop_radish_quick', count: 12 };
    slots[7] = { itemId: 'material_stone', count: 9 };
    const store = factory(slots);
    store.leftClick(6); // hold radishes
    store.leftClick(7); // swap — now holding stones, radishes at 7
    store.close();
    expect(store.held).toBeNull();
    expect(countOf(store, 'crop_radish_quick')).toBe(12);
    expect(countOf(store, 'material_stone')).toBe(9);
  });

  it('trash → undo slot; retrieval is conserving and idempotent (§6.3)', () => {
    const slots = empty();
    slots[2] = { itemId: 'forage_wildflower', count: 30 };
    const store = factory(slots);
    store.leftClick(2);
    store.trashClick();
    expect(store.held).toBeNull();
    expect(store.undoSlot).toEqual({ itemId: 'forage_wildflower', count: 30 });
    store.undoClick(); // single-step regret — destination (cursor/slot) is impl choice
    expect(store.undoSlot).toBeNull();
    expect(countOf(store, 'forage_wildflower')).toBe(30); // 取回守恒
    const settled = JSON.stringify(snapshot(store));
    store.undoClick(); // idempotent: second click is a no-op
    expect(JSON.stringify(snapshot(store))).toBe(settled);
  });

  it('a second discard replaces the undo slot (single step only, §6.3)', () => {
    const slots = empty();
    slots[2] = { itemId: 'material_stone', count: 4 };
    slots[3] = { itemId: 'crop_turnip', count: 6 };
    const store = factory(slots);
    store.leftClick(2);
    store.trashClick();
    store.leftClick(3);
    store.trashClick(); // stone is now gone forever
    expect(store.undoSlot).toEqual({ itemId: 'crop_turnip', count: 6 });
  });

  it('discardable:false is rejected outright — tools cannot be destroyed (§6.3)', () => {
    const slots = empty();
    slots[0] = { itemId: 'hoe', count: 1 };
    const store = factory(slots);
    store.leftClick(0);
    store.trashClick(); // double interception: nothing happens
    expect(store.held).toEqual({ itemId: 'hoe', count: 1 });
    expect(store.undoSlot).toBeNull();
  });

  it('closing the panel clears the undo slot (§6.3 关背包清空)', () => {
    const slots = empty();
    slots[2] = { itemId: 'material_wood', count: 8 };
    const store = factory(slots);
    store.leftClick(2);
    store.trashClick();
    store.close();
    expect(store.undoSlot).toBeNull();
  });

  it('R-sort merges and orders the reserve only; the hotbar never moves (§6.2)', () => {
    const slots = empty();
    slots[0] = { itemId: 'crop_turnip', count: 50 }; // hotbar stays exactly as-is
    slots[8] = { itemId: 'material_wood', count: 1 };
    slots[9] = { itemId: 'material_wood', count: 40 };
    slots[10] = { itemId: 'seed_radish_quick', count: 5 };
    slots[11] = { itemId: 'material_wood', count: 30 };
    const store = factory(slots);
    store.sortReserve();
    expect(store.slots[0]).toEqual({ itemId: 'crop_turnip', count: 50 });
    expect(store.slots[8]).toEqual({ itemId: 'material_wood', count: 1 });
    // seed < material (GDD §6.2), wood merged 40+30
    expect(store.slots[9]).toEqual({ itemId: 'seed_radish_quick', count: 5 });
    expect(store.slots[10]).toEqual({ itemId: 'material_wood', count: 70 });
    expect(store.slots[11]).toBeNull();
  });

  it('out-of-range slots are no-ops (defensive contract)', () => {
    const slots = empty();
    slots[2] = { itemId: 'crop_potato', count: 3 };
    const store = factory(slots);
    const before = JSON.stringify(snapshot(store));
    store.leftClick(-1);
    store.rightClick(CAPACITY);
    store.shiftLeftClick(99);
    expect(JSON.stringify(snapshot(store))).toBe(before);
  });
}

describe('reference model — executable §6.7 contract + harness self-validation', () => {
  dragStoreSuite(createReferenceDragStore, { splitStacks: true });
});

describe('real inventory-polish store (src/ui/inventory/drag-model.ts via adapter)', () => {
  // §6.7 right-button ops land via the additive splitItem SimCommand (US26; backlog
  // B-11) — the real store now runs the full split-op spec, fuzz included.
  dragStoreSuite(adaptDragModel, { splitStacks: true });
});
