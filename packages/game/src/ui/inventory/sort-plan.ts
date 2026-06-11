/**
 * sort-plan.ts — pure planner for the R-key one-shot tidy (GDD §6.2, M1.5).
 *
 * Order: category `tool < seed < crop < material < quest` → itemId lexicographic →
 * count DESC (full stacks first; the post-merge partial trails its fulls). Only the
 * reserve slots (index >= hotbarSize) are touched — hotbar order is muscle memory
 * and MUST stay put (GDD §6.2).
 *
 * The plan is expressed exclusively as `{from, to}` move pairs with the EXISTING sim
 * `move()` semantics (place / merge-leftover-stays-at-from / swap, GDD §6.2), so the
 * UI realizes a sort by dispatching plain `moveItem` SimCommands — zero InventoryApi
 * or SimCommand change (PRD 02 red line). Phase 1 greedily merges same-id partial
 * stacks; phase 2 selection-sorts positions left→right. Both phases only ever touch
 * indices inside the reserve range, never `excluded` slots (the drag store excludes
 * the pending-discard slot so an armed undo survives a sort, GDD §6.3).
 */
import { getItemDef } from '../../sim/data/items';
import { move } from '../../sim/inventory';
import type { InventoryState, ItemStack } from '../../sim/types';

export type Slots = (ItemStack | null)[];

export interface SortMove {
  from: number;
  to: number;
}

/** GDD §6.2 category order; artisan_good (M3) slots before quest, unknown sinks last. */
const CATEGORY_RANK: Readonly<Record<string, number>> = {
  tool: 0,
  seed: 1,
  crop: 2,
  material: 3,
  artisan_good: 4,
  quest: 5,
};

export function categoryRank(category: string): number {
  return CATEGORY_RANK[category] ?? 99;
}

/** category → id (lexicographic) → count DESC (GDD §6.2 + M1.5 count tiebreak). */
export function compareStacks(a: ItemStack, b: ItemStack): number {
  const ra = categoryRank(getItemDef(a.itemId).category);
  const rb = categoryRank(getItemDef(b.itemId).category);
  if (ra !== rb) return ra - rb;
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  return b.count - a.count;
}

/** Apply one sim-semantics move to a plain slots array (clones via sim `move`). */
export function applyMoveToSlots(slots: Slots, from: number, to: number): Slots {
  const inv = { slots, capacity: slots.length, selected: 0 } as InventoryState;
  return move(inv, from, to).slots;
}

function stackEq(a: ItemStack | null, b: ItemStack | null): boolean {
  if (a === null || b === null) return a === b;
  return a.itemId === b.itemId && a.count === b.count;
}

/**
 * Plan the move sequence that tidies the reserve slots. Applying the returned moves
 * in order with sim `move()` semantics yields: merged stacks, sorted by
 * `compareStacks`, packed into the (non-excluded) reserve slots front-to-back.
 * Planning a sorted reserve returns [] (idempotence).
 */
export function planSortMoves(
  slots: Slots,
  opts: { hotbarSize: number; excluded?: ReadonlySet<number> },
): SortMove[] {
  const excluded = opts.excluded ?? new Set<number>();
  const reserve: number[] = [];
  for (let i = opts.hotbarSize; i < slots.length; i++) {
    if (!excluded.has(i)) reserve.push(i);
  }
  let work = slots.map((s) => (s ? { ...s } : null));
  const moves: SortMove[] = [];
  const emit = (from: number, to: number): void => {
    moves.push({ from, to });
    work = applyMoveToSlots(work, from, to);
  };

  // Phase 1 — merge: per item id keep at most one partial stack (greedy, in order).
  const partialByItem = new Map<string, number>(); // itemId -> index of current partial
  for (const idx of reserve) {
    const stack = work[idx];
    if (!stack) continue;
    const def = getItemDef(stack.itemId);
    if (def.stackMax <= 1) continue;
    const partialIdx = partialByItem.get(stack.itemId);
    if (partialIdx === undefined) {
      if (stack.count < def.stackMax) partialByItem.set(stack.itemId, idx);
      continue;
    }
    emit(idx, partialIdx);
    const target = work[partialIdx];
    if (target && target.count < def.stackMax) {
      // Source fully absorbed, target still has room — it stays the partial.
      continue;
    }
    // Target filled up; the leftover (if any) becomes the new partial.
    const leftover = work[idx];
    if (leftover && leftover.count < def.stackMax) partialByItem.set(stack.itemId, idx);
    else partialByItem.delete(stack.itemId);
  }

  // Phase 2 — arrange: goal = merged stacks sorted, packed into reserve order.
  const goalStacks = reserve
    .map((i) => work[i])
    .filter((s): s is ItemStack => s !== null)
    .sort(compareStacks);
  for (let pi = 0; pi < reserve.length; pi++) {
    const p = reserve[pi];
    const goal = pi < goalStacks.length ? goalStacks[pi] : null;
    if (stackEq(work[p], goal)) continue;
    // goal !== null here: the reserve multiset equals the goal multiset, prefixes
    // match, so a missing stack must still sit at some later position q.
    for (let qi = pi + 1; qi < reserve.length; qi++) {
      const q = reserve[qi];
      if (stackEq(work[q], goal)) {
        emit(q, p);
        break;
      }
    }
  }
  return moves;
}
