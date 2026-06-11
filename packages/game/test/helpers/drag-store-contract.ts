/**
 * Drag (cursor-hold) store CONTRACT for the M1.5 inventory polish
 * (GDD §6.7 state machine / §6.3 undo slot / §6.2 R-sort; PRD 02 Implementation
 * Decision 2 "背包 store" + 9/10, Testing Decision #6 fuzz ×1,000).
 *
 * This file is owned by the heavy-tests track. It carries three things:
 *
 *  1. `DragStoreApi` — the interface the inventory-polish pure store is expected to
 *     satisfy (directly or via a thin adapter). Pure UI state: held stack + undo slot
 *     never enter the save (GDD §6.3); the store renders to nothing and runs headless.
 *
 *  2. `createReferenceDragStore` — an executable reference model of the §6.7 contract.
 *     The fuzz harness self-validates against it, so the harness logic is proven
 *     before the real store lands; the scripted contract tests double as the
 *     implementer-readable spec.
 *
 *  3. `adaptDragModel` — the thin adapter over the LANDED inventory-polish pure store
 *     (src/ui/inventory/drag-model.ts reducer); the identical fuzz + contract suites
 *     run against it (see inventory-drag-fuzz.test.ts and the divergence notes on the
 *     adapter below).
 *
 * Contract points intentionally pinned (drift here must come back to this file):
 *  - leftClick  EMPTY: pick whole stack ｜ HOLD: place all / merge→stackMax leftover
 *    stays held / different id swaps (swap re-targets the held stack's origin);
 *  - rightClick EMPTY: pick ⌈n/2⌉ ｜ HOLD: place exactly 1 onto empty or same id;
 *  - shiftLeftClick: quick-move the CLICKED slot's stack to the other section
 *    (hotbar 0..8 ↔ reserve 9+), same-id merge first then first empty; leftover stays;
 *  - trashClick: held & discardable → destroy to undo slot (previous undo content is
 *    gone forever) ｜ not discardable → reject (UI head-shake) ｜ empty hand → no-op;
 *  - undoClick: empty hand → retrieve the undo stack to the cursor; occupied hand or
 *    empty undo → no-op (hence idempotent);
 *  - close: held returns to its origin slot, else same-id merge, else first empty —
 *    items NEVER vanish (§6.9); the undo slot clears (§6.3 关背包清空). Degenerate
 *    corner (found by the fuzzer, GDD silent): split-pick + swap chains can strand a
 *    held stack against a backpack with zero direct room at close. Resolution order:
 *    ① consolidate same-id partial stacks to free a slot (sufficient in every state
 *    reachable from a legal backpack), ② only then, as a never-expected last resort,
 *    spill the remainder into the (just-cleared) undo slot rather than vanish — §6.9
 *    anti-vanish outranks the §6.3 clear. A discardable:false item must NEVER end up
 *    in the undo slot (it would become destructible) — the fuzz pins this directly;
 *  - sortReserve: merge + category order `tool < seed < crop < material < quest` +
 *    same-category id lexicographic, slots 9+ only — hotbar untouched (§6.2);
 *  - out-of-range slot indices are no-ops (defensive contract).
 */
import type { ItemStack } from '@codestead/shared';

import { getItemDef } from '../../src/sim/data/items';
import {
  applyOp,
  createDragState,
  heldStack,
  type DragOp,
} from '../../src/ui/inventory/drag-model';

export interface DragStoreApi {
  /** Live view of the backpack slots (length stays fixed; null = empty). */
  readonly slots: readonly (Readonly<ItemStack> | null)[];
  /** Cursor-held stack (UI state only — never serialized; GDD §6.7). */
  readonly held: Readonly<ItemStack> | null;
  /** Most recently destroyed stack, single step (GDD §6.3 — never serialized). */
  readonly undoSlot: Readonly<ItemStack> | null;

  leftClick(slot: number): void;
  rightClick(slot: number): void;
  shiftLeftClick(slot: number): void;
  trashClick(): void;
  undoClick(): void;
  sortReserve(): void;
  close(): void;
}

export type DragStoreFactory = (slots: (ItemStack | null)[]) => DragStoreApi;

export const HOTBAR_SIZE = 9; // slots 0..8 (GDD §6.2)

/** GDD §6.2 sort order. M1 has no quest items yet; unknown categories sort last. */
export const CATEGORY_SORT_ORDER = ['tool', 'seed', 'crop', 'material', 'quest'] as const;

function categoryRank(itemId: string): number {
  const idx = (CATEGORY_SORT_ORDER as readonly string[]).indexOf(getItemDef(itemId).category);
  return idx === -1 ? CATEGORY_SORT_ORDER.length : idx;
}

function stackMaxOf(itemId: string): number {
  return getItemDef(itemId).stackMax;
}

// ---------------------------------------------------------------------------
// Reference model (executable §6.7 contract)
// ---------------------------------------------------------------------------

export function createReferenceDragStore(initial: (ItemStack | null)[]): DragStoreApi {
  const slots: (ItemStack | null)[] = initial.map((s) => (s ? { ...s } : null));
  let held: ItemStack | null = null;
  let heldOrigin = -1; // -1 = no origin slot (e.g. retrieved from undo)
  let undoSlot: ItemStack | null = null;

  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < slots.length;

  function clearHeld(): void {
    held = null;
    heldOrigin = -1;
  }

  /**
   * §6.7/§6.9 return rule: origin slot → same-id merge → first empty. Returns the
   * remainder that found no room — only reachable when the held stack was retrieved
   * from the undo slot into a full backpack (the caller spills it back to undo).
   */
  function placeBack(stack: ItemStack, origin: number): number {
    if (origin >= 0 && origin < slots.length && slots[origin] === null) {
      slots[origin] = { ...stack };
      return 0;
    }
    let rest = stack.count;
    const max = stackMaxOf(stack.itemId);
    for (const s of slots) {
      if (rest === 0) return 0;
      if (s && s.itemId === stack.itemId && s.count < max) {
        const take = Math.min(max - s.count, rest);
        s.count += take;
        rest -= take;
      }
    }
    for (let i = 0; i < slots.length && rest > 0; i++) {
      if (slots[i] === null) {
        const take = Math.min(max, rest);
        slots[i] = { itemId: stack.itemId, count: take };
        rest -= take;
      }
    }
    return rest;
  }

  function leftClick(i: number): void {
    if (!inRange(i)) return;
    const target = slots[i];
    if (held === null) {
      if (target === null) return;
      held = target; // pick the whole stack
      heldOrigin = i;
      slots[i] = null;
      return;
    }
    if (target === null) {
      slots[i] = held; // place all
      clearHeld();
      return;
    }
    if (target.itemId === held.itemId) {
      // merge into the clicked stack up to stackMax; overflow STAYS HELD (§6.7)
      const take = Math.min(stackMaxOf(held.itemId) - target.count, held.count);
      target.count += take;
      held.count -= take;
      if (held.count === 0) clearHeld();
      return;
    }
    // different id: swap — the clicked slot becomes the new origin of the new held stack
    slots[i] = held;
    held = target;
    heldOrigin = i;
  }

  function rightClick(i: number): void {
    if (!inRange(i)) return;
    const target = slots[i];
    if (held === null) {
      if (target === null) return;
      const take = Math.ceil(target.count / 2); // pick ⌈n/2⌉ (§6.7)
      held = { itemId: target.itemId, count: take };
      heldOrigin = i;
      target.count -= take;
      if (target.count === 0) slots[i] = null;
      return;
    }
    if (target === null) {
      slots[i] = { itemId: held.itemId, count: 1 }; // place exactly 1
      held.count -= 1;
      if (held.count === 0) clearHeld();
      return;
    }
    if (target.itemId === held.itemId && target.count < stackMaxOf(held.itemId)) {
      target.count += 1;
      held.count -= 1;
      if (held.count === 0) clearHeld();
    }
    // different id or full same-id stack: no-op
  }

  function shiftLeftClick(i: number): void {
    if (!inRange(i)) return;
    const src = slots[i];
    if (src === null) return;
    const [start, end] = i < HOTBAR_SIZE ? [HOTBAR_SIZE, slots.length] : [0, HOTBAR_SIZE];
    let rest = src.count;
    const max = stackMaxOf(src.itemId);
    for (let j = start; j < end && rest > 0; j++) {
      const dst = slots[j];
      if (dst && dst.itemId === src.itemId && dst.count < max) {
        const take = Math.min(max - dst.count, rest);
        dst.count += take;
        rest -= take;
      }
    }
    for (let j = start; j < end && rest > 0; j++) {
      if (slots[j] === null) {
        slots[j] = { itemId: src.itemId, count: rest };
        rest = 0;
      }
    }
    if (rest === 0) slots[i] = null;
    else src.count = rest; // no room: leftover stays where it was (quick-move is partial)
  }

  function trashClick(): void {
    if (held === null) return;
    if (!getItemDef(held.itemId).discardable) return; // reject — UI plays the head-shake
    undoSlot = held; // previous undo content (if any) is destroyed forever (§6.3)
    clearHeld();
  }

  function undoClick(): void {
    if (undoSlot === null || held !== null) return;
    held = undoSlot; // retrieve to the cursor; conserves the stack
    heldOrigin = -1;
    undoSlot = null; // second click is a no-op → idempotent
  }

  function sortReserve(): void {
    // merge + sort RESERVE slots only (index 9+); hotbar 0..8 is muscle memory (§6.2)
    const totals = new Map<string, number>();
    for (let i = HOTBAR_SIZE; i < slots.length; i++) {
      const s = slots[i];
      if (s) totals.set(s.itemId, (totals.get(s.itemId) ?? 0) + s.count);
    }
    const ids = [...totals.keys()].sort(
      (a, b) => categoryRank(a) - categoryRank(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const rebuilt: ItemStack[] = [];
    for (const id of ids) {
      let rest = totals.get(id) ?? 0;
      const max = stackMaxOf(id);
      while (rest > 0) {
        const take = Math.min(max, rest);
        rebuilt.push({ itemId: id, count: take });
        rest -= take;
      }
    }
    for (let i = HOTBAR_SIZE; i < slots.length; i++) {
      slots[i] = rebuilt[i - HOTBAR_SIZE] ?? null;
    }
  }

  /** Degenerate-close fallback: merge same-id partial stacks to free slots (rare). */
  function consolidateSlots(): void {
    for (let i = 0; i < slots.length; i++) {
      const dst = slots[i];
      if (!dst) continue;
      const max = stackMaxOf(dst.itemId);
      if (dst.count >= max) continue;
      for (let j = i + 1; j < slots.length && dst.count < max; j++) {
        const src = slots[j];
        if (!src || src.itemId !== dst.itemId) continue;
        const take = Math.min(max - dst.count, src.count);
        dst.count += take;
        src.count -= take;
        if (src.count === 0) slots[j] = null;
      }
    }
  }

  function close(): void {
    undoSlot = null; // 关背包清空撤销槽 (§6.3) — its content is destroyed forever
    if (held !== null) {
      let spill = placeBack(held, heldOrigin); // any path: items never vanish (§6.9)
      if (spill > 0) {
        // Degenerate corner (see header): free a slot by consolidating same-id
        // partials, then retry — this resolves every state reachable from a legal
        // backpack (and keeps tools out of the destructible undo slot).
        consolidateSlots();
        spill = placeBack({ itemId: held.itemId, count: spill }, -1);
      }
      // Never-expected last resort, pinned by the fuzz invariants: better a visible
      // regret-slot stack than a vanished item.
      if (spill > 0) undoSlot = { itemId: held.itemId, count: spill };
      clearHeld();
    }
  }

  return {
    get slots(): readonly (Readonly<ItemStack> | null)[] {
      return slots;
    },
    get held(): Readonly<ItemStack> | null {
      return held;
    },
    get undoSlot(): Readonly<ItemStack> | null {
      return undoSlot;
    },
    leftClick,
    rightClick,
    shiftLeftClick,
    trashClick,
    undoClick,
    sortReserve,
    close,
  };
}

// ---------------------------------------------------------------------------
// Real-store adapter (integration seam — wired to src/ui/inventory/drag-model.ts)
// ---------------------------------------------------------------------------

/**
 * Adapter over the landed inventory-polish pure store (drag-model.ts reducer). The
 * adapter is intentionally thin: it owns the DragState, translates the click verbs of
 * this contract into the model's press/release/sort/close op vocabulary, and presents
 * the harness view (virtual-hold stacks are shown in `held`, not double-counted in
 * `slots`; the deferred-destroy undo stack is shown in `undoSlot`).
 *
 * Documented divergences between the reference contract and the real model (the fuzz
 * invariants are written to cover BOTH; the deltas are recorded as open questions):
 *  - right-button split ops (拿半堆/放 1, §6.7) ride the additive `splitItem`
 *    SimCommand (sim/inventory.ts splitAt; backlog B-11). The model anchors a right
 *    pick by splitting the half into a store-empty slot it then whole-holds, so with
 *    a COMPLETELY FULL backpack a right pick (n > 1) is refused (reference: a real
 *    hand can always split) — bounded divergence, see the model header;
 *  - undo retrieval returns the stack to its origin/first-empty SLOT (model) rather
 *    than to the cursor (reference) — the harness asserts the universal part only:
 *    retrieval conserves the stack, clears the undo slot, and is idempotent;
 *  - the model may destroy a pending undo stack EARLY when an op needs its parked
 *    sim slot and no other slot is free (its deferred-destroy design) — the fuzz
 *    conservation rule therefore admits the undo stack as the only destroyable unit
 *    on any op, always leaving the undo slot empty afterwards.
 */
export function adaptDragModel(initial: (ItemStack | null)[]): DragStoreApi {
  let state = createDragState(initial.map((s) => (s ? { ...s } : null)));
  const dispatch = (op: DragOp): void => {
    state = applyOp(state, op).state;
  };
  return {
    get slots(): readonly (Readonly<ItemStack> | null)[] {
      const view = state.slots.map((s) => (s ? { ...s } : null));
      if (state.held) view[state.held.from] = null; // virtual hold: counted via `held`
      return view;
    },
    get held(): Readonly<ItemStack> | null {
      const h = heldStack(state);
      return h ? { ...h } : null;
    },
    get undoSlot(): Readonly<ItemStack> | null {
      return state.undo ? { ...state.undo.stack } : null;
    },
    leftClick(slot: number): void {
      if (state.held === null) {
        // click-pickup = press + release on the same slot (drag-model click path)
        dispatch({ op: 'press', target: { kind: 'slot', index: slot } });
        dispatch({ op: 'release', target: { kind: 'slot', index: slot } });
      } else {
        dispatch({ op: 'press', target: { kind: 'slot', index: slot } }); // click-place
      }
    },
    rightClick(slot: number): void {
      if (state.held === null) {
        // right click-pickup = press + release on the same slot (拿 ⌈n/2⌉)
        dispatch({ op: 'press', target: { kind: 'slot', index: slot }, button: 'right' });
        dispatch({ op: 'release', target: { kind: 'slot', index: slot }, button: 'right' });
      } else {
        dispatch({ op: 'press', target: { kind: 'slot', index: slot }, button: 'right' }); // 放 1
      }
    },
    shiftLeftClick(slot: number): void {
      dispatch({ op: 'press', target: { kind: 'slot', index: slot }, shift: true });
    },
    trashClick(): void {
      dispatch({ op: 'press', target: { kind: 'trash' } });
    },
    undoClick(): void {
      dispatch({ op: 'press', target: { kind: 'undo' } });
    },
    sortReserve(): void {
      dispatch({ op: 'sort' });
    },
    close(): void {
      dispatch({ op: 'close' });
    },
  };
}
