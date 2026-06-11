/**
 * drag-model.ts — pure drag / undo / tidy state machine behind the backpack panel
 * (GDD §6.7 hold state machine, §6.3 undo slot, §6.2 R-tidy; M1.5, PRD 02).
 *
 * Pure store, zero Phaser (tech-stack §1): `applyOp(state, op)` is a reducer that the
 * panel (and the heavy-tests fuzz harness, PRD 02 test 6) drives with an injectable
 * op sequence. Every result carries:
 *   - the next DragState (the panel's render truth while it is open),
 *   - `simOps`: the `moveItem`/`discardItem` SimCommands that keep the sim convergent
 *     (the ONLY mutation channel — InventoryApi & SimCommand stay untouched, PRD 02
 *     red line; `expectedSimSlots()` states the convergence invariant),
 *   - `fx`: view-only effect descriptors (shake / bounce / toast cues).
 *
 * Hold is VIRTUAL: a held stack physically stays in its source slot until an op lands,
 * so no code path can ever lose items (GDD §6.7/§6.9 “任何路径不消失物品”).
 *
 * Undo slot is DEFERRED-DESTROY: trashing emits NO sim op — the stack leaves the
 * visible slots, parks in `undo`, and still physically sits in the sim slot
 * (`undo.simSlot`). The real `discardItem` is emitted only when the undo slot clears
 * (re-discard / panel close; night settlement cannot happen while the panel pauses the
 * sim, so close covers it — GDD §6.3). If a later drop needs the parked slot, the
 * pending stack is first relocated (`move`) to another store-empty slot; only when no
 * slot exists (backpack effectively full — retrieval would be impossible anyway) is it
 * destroyed early. Undo never touches the save: a save while pending simply keeps the
 * stack in its slot (fail-safe toward NOT losing items).
 *
 * §6.7 right-button ops (拿半堆 / 放 1 个): expressed through the additive `splitItem`
 * SimCommand (sim/inventory.ts splitAt — InventoryApi six methods untouched, PRD 02
 * red line; channel ratification pending, m1-review-backlog.md B-11). Right pick keeps
 * the virtual-hold design by SPLITTING the ⌈n/2⌉ half into a store-empty ANCHOR slot
 * and then whole-holding that slot — every downstream op (drop/merge/swap/trash/close)
 * reuses the whole-stack paths unchanged. Bounded divergence: with a completely full
 * backpack there is no anchor slot, so right pick (n > 1) is refused with a hint —
 * a real-hand UI could split anyway, but no expressible sim state can hold the half.
 */
import { getItemDef } from '../../sim/data/items';
import type { ItemStack } from '../../sim/types';

import { applyMoveToSlots, planSortMoves, type Slots } from './sort-plan';

export type DropTarget =
  | { kind: 'slot'; index: number }
  | { kind: 'trash' }
  | { kind: 'undo' }
  | { kind: 'outside' };

/** Mouse button dimension of press/release (GDD §6.7/§6.8); omitted = 'left'. */
export type DragButton = 'left' | 'right';

export type DragOp =
  | { op: 'press'; target: DropTarget; shift?: boolean; button?: DragButton }
  | { op: 'release'; target: DropTarget; button?: DragButton }
  | { op: 'hover'; target: DropTarget | null }
  | { op: 'sort' }
  | { op: 'close' };

export type DragSimOp =
  | { kind: 'move'; from: number; to: number }
  | { kind: 'split'; from: number; to: number; count: number }
  | { kind: 'discard'; slot: number };

export type DragFx =
  | { fx: 'pickup'; slot: number }
  | { fx: 'drop'; slot: number }
  | { fx: 'putback'; slot: number }
  /** Invalid release target — the ghost flies back to the origin slot (task: 回弹). */
  | { fx: 'bounce'; toSlot: number }
  /** Swap kept the other stack in hand (§6.7 异id→交换). */
  | { fx: 'swap-hold'; slot: number }
  /** Merge overflow stayed in hand (§6.7 合并至99溢出留手). */
  | { fx: 'overflow-hold'; slot: number }
  /** Right place put exactly 1 unit down; the rest stays in hand (§6.7 放 1 个). */
  | { fx: 'place-one'; slot: number }
  | { fx: 'reject-not-discardable' }
  | { fx: 'reject-locked' }
  /** Right pick refused: full backpack leaves no anchor slot for the split half. */
  | { fx: 'reject-full' }
  | { fx: 'trash' }
  | { fx: 'undo-take'; slot: number }
  | { fx: 'undo-blocked' }
  | { fx: 'sorted'; moves: number }
  | { fx: 'quick-move'; from: number; moved: number };

export interface DragState {
  /** Render truth while the panel is open (length === capacity). */
  readonly slots: Slots;
  /** Virtual hold: the stack stays at slots[from] until an op lands. `pressSlot`
   * (right pick only) remembers the slot the pickup CLICK happened on — the anchor
   * `from` differs from it, and the release of that same physical click must complete
   * the pickup instead of dropping back onto the clicked slot. */
  readonly held: { from: number; pickupPress: boolean; pressSlot?: number } | null;
  /** Armed undo: last trashed stack; simSlot = where it still sits in the sim. */
  readonly undo: { stack: ItemStack; originSlot: number; simSlot: number } | null;
  readonly hover: DropTarget | null;
}

export interface ApplyResult {
  state: DragState;
  simOps: DragSimOp[];
  fx: DragFx[];
}

export const HOTBAR_SIZE = 9; // slots 0..8 (GDD §6.2)

export function createDragState(slots: Slots): DragState {
  return { slots: slots.map((s) => (s ? { ...s } : null)), held: null, undo: null, hover: null };
}

export function heldStack(state: DragState): ItemStack | null {
  return state.held ? state.slots[state.held.from] : null;
}

/** Conserved quantity for fuzz: visible units + the parked undo stack. */
export function totalUnits(state: DragState): number {
  let total = state.undo?.stack.count ?? 0;
  for (const s of state.slots) total += s?.count ?? 0;
  return total;
}

/**
 * Convergence invariant: after the panel dispatches the returned simOps, the sim's
 * inventory slots must equal this view — the store slots plus the pending-discard
 * stack still parked at its sim slot.
 */
export function expectedSimSlots(state: DragState): Slots {
  const view = state.slots.map((s) => (s ? { ...s } : null));
  if (state.undo) view[state.undo.simSlot] = { ...state.undo.stack };
  return view;
}

/** Hover classification for the view highlight (悬停高亮); pure derivation. */
export type HoverKind =
  | 'none'
  | 'pickable'
  | 'origin'
  | 'place'
  | 'merge'
  | 'swap'
  | 'invalid'
  | 'trash-ok'
  | 'trash-reject'
  | 'undo-ready';

export function classifyTarget(state: DragState, target: DropTarget | null): HoverKind {
  if (target === null || target.kind === 'outside') return 'none';
  const held = heldStack(state);
  if (target.kind === 'trash') {
    if (!held) return 'none';
    return getItemDef(held.itemId).discardable ? 'trash-ok' : 'trash-reject';
  }
  if (target.kind === 'undo') {
    return !held && state.undo ? 'undo-ready' : 'none';
  }
  const { index } = target;
  if (index < 0 || index >= state.slots.length) return held ? 'invalid' : 'none';
  if (!held) return state.slots[index] ? 'pickable' : 'none';
  if (state.held !== null && index === state.held.from) return 'origin';
  const dst = state.slots[index];
  if (!dst) return 'place';
  return dst.itemId === held.itemId ? 'merge' : 'swap';
}

// ---- reducer ----

interface Ctx {
  slots: Slots;
  held: DragState['held'];
  undo: DragState['undo'];
  hover: DragState['hover'];
  simOps: DragSimOp[];
  fx: DragFx[];
}

function ctxOf(state: DragState): Ctx {
  return {
    slots: state.slots.map((s) => (s ? { ...s } : null)),
    held: state.held ? { ...state.held } : null,
    undo: state.undo
      ? {
          stack: { ...state.undo.stack },
          originSlot: state.undo.originSlot,
          simSlot: state.undo.simSlot,
        }
      : null,
    hover: state.hover,
    simOps: [],
    fx: [],
  };
}

function result(c: Ctx): ApplyResult {
  return {
    state: { slots: c.slots, held: c.held, undo: c.undo, hover: c.hover },
    simOps: c.simOps,
    fx: c.fx,
  };
}

function emitMove(c: Ctx, from: number, to: number): void {
  c.simOps.push({ kind: 'move', from, to });
  c.slots = applyMoveToSlots(c.slots, from, to);
}

/** Emit a splitItem sim op and mirror it on the store slots. The caller has already
 * validated: src exists, dst is empty or same-id with headroom ≥ count (the sim's
 * splitAt clamps identically, so store and sim can never diverge). */
function emitSplit(c: Ctx, from: number, to: number, count: number): void {
  const src = c.slots[from];
  if (!src || count <= 0) return;
  c.simOps.push({ kind: 'split', from, to, count });
  const dst = c.slots[to];
  if (dst === null) c.slots[to] = { itemId: src.itemId, count };
  else dst.count += count;
  src.count -= count;
  if (src.count === 0) c.slots[from] = null;
}

/** Destroy the pending stack for real (sim still holds it at simSlot). */
function finalizePending(c: Ctx): void {
  if (!c.undo) return;
  c.simOps.push({ kind: 'discard', slot: c.undo.simSlot });
  c.undo = null;
}

/**
 * Make sure the sim slot parking the pending-discard stack is safe to write to:
 * relocate the parked stack to a slot that is empty in the store AND not in `avoid`;
 * destroy it early only when no such slot exists (≈ full backpack — see header).
 * Store slots are untouched: the parked stack stays invisible either way.
 */
function evictPending(c: Ctx, avoid: ReadonlySet<number>): void {
  if (!c.undo) return;
  const from = c.undo.simSlot;
  for (let i = 0; i < c.slots.length; i++) {
    if (i === from || avoid.has(i) || c.slots[i] !== null) continue;
    c.simOps.push({ kind: 'move', from, to: i }); // sim-only: store stays empty at both
    c.undo.simSlot = i;
    return;
  }
  finalizePending(c);
}

function pendingConflicts(c: Ctx, index: number): boolean {
  return c.undo !== null && c.undo.simSlot === index;
}

/** Drop the (virtually) held stack onto slot `to`; §6.7 outcome table. */
function drop(c: Ctx, to: number, viaRelease: boolean): void {
  if (c.held === null) return;
  const from = c.held.from;
  if (to === from) {
    c.held = null;
    c.fx.push({ fx: 'putback', slot: to });
    return;
  }
  if (to < 0 || to >= c.slots.length) {
    rejectDrop(c, viaRelease);
    return;
  }
  if (pendingConflicts(c, to)) evictPending(c, new Set([to, from]));
  const src = c.slots[from];
  const dstBefore = c.slots[to];
  if (!src) {
    c.held = null; // defensive: virtual hold lost its stack
    return;
  }
  emitMove(c, from, to);
  const leftover = c.slots[from];
  if (leftover === null) {
    c.held = null;
    c.fx.push({ fx: 'drop', slot: to });
  } else if (dstBefore !== null && dstBefore.itemId !== src.itemId) {
    // Swap — the other stack is now (virtually) in hand at `from` (§6.7 交换).
    c.held = { from, pickupPress: false };
    c.fx.push({ fx: 'swap-hold', slot: to });
  } else {
    // Same-id merge overflow (or full-target degenerate swap) — leftover stays in hand.
    c.held = { from, pickupPress: false };
    c.fx.push({ fx: 'overflow-hold', slot: to });
  }
}

/**
 * §6.7 right pick: ⌈n/2⌉ into the hand. The virtual hold needs a sim slot to anchor
 * the half, so it is split into a store-empty ANCHOR slot (reserve side preferred)
 * which the hand then whole-holds — all downstream ops reuse the whole-stack paths.
 * n === 1 degenerates to a plain whole pick; a full backpack (no anchor) refuses.
 */
function pickHalf(c: Ctx, index: number): void {
  const stack = c.slots[index];
  if (!stack) return;
  const take = Math.ceil(stack.count / 2);
  if (take === stack.count) {
    c.held = { from: index, pickupPress: true };
    c.fx.push({ fx: 'pickup', slot: index });
    return;
  }
  // Anchor = a store-empty slot ≠ index, scanned from the reserve end so half stacks
  // do not pollute the hotbar; prefer one that is not parking a pending discard.
  let anchor = -1;
  for (let i = c.slots.length - 1; i >= 0; i--) {
    if (i === index || c.slots[i] !== null) continue;
    if (anchor === -1) anchor = i;
    if (!pendingConflicts(c, i)) {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) {
    c.fx.push({ fx: 'reject-full' }); // bounded divergence — see header note
    return;
  }
  if (pendingConflicts(c, anchor)) evictPending(c, new Set([index, anchor]));
  emitSplit(c, index, anchor, take);
  c.held = { from: anchor, pickupPress: true, pressSlot: index };
  c.fx.push({ fx: 'pickup', slot: index });
}

/**
 * §6.7 right place: exactly 1 unit onto an EMPTY or SAME-ID slot (放 1 个); a
 * different id or a full same-id stack keeps holding (reference-model no-op).
 */
function placeOne(c: Ctx, to: number, viaRelease: boolean): void {
  if (c.held === null) return;
  const from = c.held.from;
  if (to === from) return; // the hand's own anchor: nothing to split onto
  if (to < 0 || to >= c.slots.length) {
    rejectDrop(c, viaRelease);
    return;
  }
  const src = c.slots[from];
  if (!src) {
    c.held = null; // defensive: virtual hold lost its stack
    return;
  }
  const dst = c.slots[to];
  if (dst !== null && (dst.itemId !== src.itemId || dst.count >= getItemDef(src.itemId).stackMax)) {
    return; // §6.7 right place targets 空格/同 id only — keep holding
  }
  if (pendingConflicts(c, to)) evictPending(c, new Set([to, from]));
  if (pendingConflicts(c, to)) return; // eviction failed (full) — never overwrite
  if (src.count === 1) {
    emitMove(c, from, to); // last unit: a plain move empties the hand
    c.held = null;
    c.fx.push({ fx: 'drop', slot: to });
    return;
  }
  emitSplit(c, from, to, 1);
  c.fx.push({ fx: 'place-one', slot: to });
}

/** Invalid target: on release the hand bounces back to origin; on press it keeps holding. */
function rejectDrop(c: Ctx, viaRelease: boolean): void {
  if (c.held === null) return;
  if (viaRelease) {
    c.fx.push({ fx: 'bounce', toSlot: c.held.from });
    c.held = null; // virtual hold — the stack never left the origin slot
  } else {
    c.fx.push({ fx: 'reject-locked' });
  }
}

/** Trash the held stack: deferred destroy into the undo slot (GDD §6.3). */
function trash(c: Ctx): void {
  if (c.held === null) return;
  const from = c.held.from;
  const stack = c.slots[from];
  if (!stack) {
    c.held = null;
    return;
  }
  if (!getItemDef(stack.itemId).discardable) {
    c.fx.push({ fx: 'reject-not-discardable' }); // double-block + head-shake (GDD §6.3)
    return; // keep holding
  }
  finalizePending(c); // re-discard clears (= destroys) the previous undo stack
  c.undo = { stack: { ...stack }, originSlot: from, simSlot: from };
  c.slots[from] = null; // visible slots only — NO sim op yet (deferred destroy)
  c.held = null;
  c.fx.push({ fx: 'trash' });
}

/** Click the undo slot: the parked stack returns to its origin slot or the first empty. */
function undoTake(c: Ctx): void {
  if (!c.undo || c.held !== null) return;
  const { stack, originSlot, simSlot } = c.undo;
  let target = c.slots[originSlot] === null ? originSlot : -1;
  if (target === -1) {
    // 原格被占则进第一空格 (GDD §6.7 return rule, reused for undo retrieval).
    for (let i = 0; i < c.slots.length; i++) {
      if (c.slots[i] === null) {
        target = i;
        break;
      }
    }
  }
  if (target === -1) {
    c.fx.push({ fx: 'undo-blocked' });
    return;
  }
  c.slots[target] = { ...stack };
  if (target !== simSlot) c.simOps.push({ kind: 'move', from: simSlot, to: target });
  c.undo = null;
  c.fx.push({ fx: 'undo-take', slot: target });
}

/** Shift+click quick move: hotbar ↔ reserve, merge-first then first empty (§6.7). */
function quickMove(c: Ctx, from: number): void {
  if (c.held !== null || from < 0 || from >= c.slots.length) return;
  const source = c.slots[from];
  if (source === null) return;
  const [lo, hi] = from < HOTBAR_SIZE ? [HOTBAR_SIZE, c.slots.length] : [0, HOTBAR_SIZE];
  const stackMax = getItemDef(source.itemId).stackMax;
  const targets: number[] = [];
  for (let i = lo; i < hi; i++) {
    const s = c.slots[i];
    if (s !== null && s.itemId === source.itemId && s.count < stackMax) targets.push(i);
  }
  for (let i = lo; i < hi; i++) {
    if (c.slots[i] === null) targets.push(i);
  }
  let moved = 0;
  for (const to of targets) {
    const remaining = c.slots[from];
    if (remaining === null) break;
    if (pendingConflicts(c, to)) evictPending(c, new Set([to, from]));
    if (pendingConflicts(c, to)) continue; // eviction failed (full) — never overwrite
    const before = remaining.count;
    emitMove(c, from, to);
    moved += before - (c.slots[from]?.count ?? 0);
  }
  if (moved > 0) c.fx.push({ fx: 'quick-move', from, moved });
}

/** R-key tidy: reserve slots only; the pending-discard slot is excluded (GDD §6.2/§6.3). */
function sortReserve(c: Ctx): void {
  if (c.held !== null) return; // tidy with a stack in hand would shuffle the hold anchor
  const excluded = new Set<number>();
  if (c.undo) excluded.add(c.undo.simSlot);
  const moves = planSortMoves(c.slots, { hotbarSize: HOTBAR_SIZE, excluded });
  for (const m of moves) emitMove(c, m.from, m.to);
  if (moves.length > 0) c.fx.push({ fx: 'sorted', moves: moves.length });
}

function press(c: Ctx, target: DropTarget, shift: boolean, button: DragButton): void {
  if (c.held === null) {
    if (target.kind === 'undo') {
      undoTake(c);
      return;
    }
    if (target.kind !== 'slot') return;
    const { index } = target;
    if (index < 0 || index >= c.slots.length || c.slots[index] === null) return;
    if (shift) {
      quickMove(c, index);
      return;
    }
    if (button === 'right') {
      pickHalf(c, index); // §6.7 右键@有物格→拿 ⌈n/2⌉
      return;
    }
    c.held = { from: index, pickupPress: true };
    c.fx.push({ fx: 'pickup', slot: index });
    return;
  }
  // Holding: a press is an immediate drop attempt (click-place path).
  switch (target.kind) {
    case 'slot':
      if (button === 'right')
        placeOne(c, target.index, false); // §6.7 右键→放 1 个
      else drop(c, target.index, false);
      return;
    case 'trash':
      trash(c);
      return;
    default:
      return; // undo/outside while holding: keep holding (misclick-safe)
  }
}

function release(c: Ctx, target: DropTarget, button: DragButton): void {
  if (c.held === null || !c.held.pickupPress) return; // only the picking press's release acts
  c.held = { ...c.held, pickupPress: false };
  switch (target.kind) {
    case 'slot':
      // Click-pickup completed: releasing over the anchor OR (right pick) over the
      // clicked slot stays in hand.
      if (target.index === c.held.from || target.index === c.held.pressSlot) return;
      if (target.index < 0 || target.index >= c.slots.length) {
        rejectDrop(c, true);
        return;
      }
      if (button === 'right') placeOne(c, target.index, true);
      else drop(c, target.index, true);
      return;
    case 'trash':
      trash(c);
      return;
    default:
      rejectDrop(c, true); // outside / undo: bounce back to the origin slot
      return;
  }
}

/** Panel closing: hand returns to origin (virtual = free), pending discard finalizes. */
function close(c: Ctx): void {
  if (c.held !== null) {
    c.fx.push({ fx: 'putback', slot: c.held.from });
    c.held = null;
  }
  finalizePending(c);
  c.hover = null;
}

/** Pure reducer — the fuzz harness entry point (PRD 02 test 6: injectable op sequences). */
export function applyOp(state: DragState, op: DragOp): ApplyResult {
  const c = ctxOf(state);
  switch (op.op) {
    case 'press':
      press(c, op.target, op.shift === true, op.button ?? 'left');
      break;
    case 'release':
      release(c, op.target, op.button ?? 'left');
      break;
    case 'hover':
      c.hover = op.target;
      break;
    case 'sort':
      sortReserve(c);
      break;
    case 'close':
      close(c);
      break;
  }
  return result(c);
}
