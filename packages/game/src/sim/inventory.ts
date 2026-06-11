/**
 * inventory.ts — 12-slot backpack, hotbar = slots 0..8, stacking rules
 * (GDD §6.1/§6.2; M1-core: click-move only, no drag state machine).
 *
 * Stacking: fill same-id non-full stacks first (hotbar left→right, then reserve
 * left→right — i.e. plain slot index order), then the first empty slot. Partial add
 * returns {added, rejected}; harvest is all-or-nothing at the call site (GDD §3.9 #1),
 * purchase degrades quantity. New save: slot0 hoe, slot1 watering_can, no seeds (§6.2).
 *
 * The `*InPlace` variants exist for composition inside already-cloned pipeline states.
 */
import { INVENTORY } from './data/constants.js';
import { getItemDef, ITEMS_BY_ID } from './data/items.js';
import type { ItemId } from './data/items.js';
import type { InventoryState, SimEvent, WorldState } from './types.js';

/** Total units of `itemId` that still fit (same-id headroom + empty slots × stackMax). */
export function maxAddable(inv: InventoryState, itemId: ItemId): number {
  const def = getItemDef(itemId);
  let room = 0;
  for (const stack of inv.slots) {
    if (stack === null) room += def.stackMax;
    else if (stack.itemId === itemId) room += def.stackMax - stack.count;
  }
  return room;
}

export function canAdd(inv: InventoryState, itemId: ItemId, count: number): boolean {
  return maxAddable(inv, itemId) >= count;
}

/** In-place add following the §6.2 stacking rules. Returns how much fit. */
export function addInPlace(
  inv: InventoryState,
  itemId: ItemId,
  count: number,
): { added: number; rejected: number } {
  const def = getItemDef(itemId);
  let remaining = count;
  // Pass 1: top up same-id non-full stacks in slot order.
  for (const stack of inv.slots) {
    if (remaining === 0) break;
    if (stack !== null && stack.itemId === itemId && stack.count < def.stackMax) {
      const take = Math.min(def.stackMax - stack.count, remaining);
      stack.count += take;
      remaining -= take;
    }
  }
  // Pass 2: first empty slots.
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    if (inv.slots[i] === null) {
      const take = Math.min(def.stackMax, remaining);
      inv.slots[i] = { itemId, count: take };
      remaining -= take;
    }
  }
  return { added: count - remaining, rejected: remaining };
}

export function add(
  inv: InventoryState,
  itemId: ItemId,
  count: number,
): { inv: InventoryState; added: number; rejected: number } {
  const next = structuredClone(inv);
  const { added, rejected } = addInPlace(next, itemId, count);
  return { inv: next, added, rejected };
}

/** In-place removal from a specific slot. Returns how much was actually removed. */
export function removeAtInPlace(inv: InventoryState, slot: number, count: number): number {
  const stack = inv.slots[slot];
  if (!stack || count <= 0) return 0;
  const removed = Math.min(count, stack.count);
  stack.count -= removed;
  if (stack.count === 0) inv.slots[slot] = null;
  return removed;
}

/** In-place removal by item id (first stacks in slot order); used by plant to consume seeds. */
export function removeItemInPlace(inv: InventoryState, itemId: ItemId, count: number): number {
  let remaining = count;
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    const stack = inv.slots[i];
    if (stack !== null && stack.itemId === itemId) {
      remaining -= removeAtInPlace(inv, i, remaining);
    }
  }
  return count - remaining;
}

export function removeAt(
  inv: InventoryState,
  slot: number,
  count: number,
): { inv: InventoryState; removed: number } {
  const next = structuredClone(inv);
  const removed = removeAtInPlace(next, slot, count);
  return { inv: next, removed };
}

/**
 * Click-move semantics (pick up / put down / merge / swap); M1-core has no drag.
 * Same id merges up to stackMax with the leftover staying at `from`; different ids swap.
 */
export function move(inv: InventoryState, from: number, to: number): InventoryState {
  const next = structuredClone(inv);
  if (from === to || from < 0 || to < 0 || from >= next.slots.length || to >= next.slots.length) {
    return next;
  }
  const src = next.slots[from];
  if (src === null) return next;
  const dst = next.slots[to];
  if (dst === null) {
    next.slots[to] = src;
    next.slots[from] = null;
  } else if (dst.itemId === src.itemId) {
    const def = ITEMS_BY_ID.get(src.itemId);
    const stackMax = def?.stackMax ?? 99;
    const take = Math.min(stackMax - dst.count, src.count);
    if (take > 0) {
      dst.count += take;
      src.count -= take;
      if (src.count === 0) next.slots[from] = null;
    } else {
      // Target full: degenerate merge becomes a swap (visible no-op for equal stacks).
      next.slots[to] = src;
      next.slots[from] = dst;
    }
  } else {
    next.slots[to] = src;
    next.slots[from] = dst;
  }
  return next;
}

/** Hotbar selection 0..8 (GDD §6.2); out-of-range input is clamped. */
export function select(inv: InventoryState, slot: number): InventoryState {
  const next = structuredClone(inv);
  next.selected = Math.min(Math.max(Math.trunc(slot), 0), INVENTORY.HOTBAR_SIZE - 1);
  return next;
}

/**
 * Trash-can discard = destroy; discardable:false rejects (GDD §6.3; undo slot is M1.5).
 * No SimEvent exists for discards in the §12 vocabulary — the UI animates locally.
 */
export function discardAt(
  state: WorldState,
  slot: number,
): { state: WorldState; events: SimEvent[] } {
  const stack = state.inventory.slots[slot];
  if (!stack) return { state, events: [] };
  const def = ITEMS_BY_ID.get(stack.itemId);
  if (!def || !def.discardable) return { state, events: [] }; // UI plays the head-shake
  const next = structuredClone(state);
  next.inventory.slots[slot] = null;
  return { state: next, events: [] };
}
