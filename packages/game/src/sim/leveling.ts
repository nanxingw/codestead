/**
 * leveling.ts — XP, farm level derivation, counters (GDD §5.1/§5.2/§5.5).
 *
 * Single source of truth = xp + counters + achievements + profession; level, unlocks
 * and shop availability are ALWAYS derived, never stored (PRD 01 US73).
 * M1-core instruments counters only (bumpCounter call sites per GDD §5.6 list);
 * achievement definitions/rewards/UI are M1.5.
 *
 * The exported `*InPlace` variants exist for composition inside an already-cloned
 * pipeline (applyAction / runNight); the contract-named functions stay pure
 * (clone-in, new-state-out).
 */
import { M1_LEVEL_CAP, SHOP_CATALOG_M1, XP_CAP, XP_THRESHOLDS } from './data/constants.js';
import { tilledCapForLevel } from './tiles.js';
import type { CounterId, SimEvent, WorldState } from './types.js';

/** Level (1..10) derived from cumulative XP via XP_THRESHOLDS (GDD §5.1, ruling B-1). */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

/** effectiveLevel = min(levelForXp(xp), M1_LEVEL_CAP); XP itself is never capped at 5. */
export function effectiveLevel(xp: number): number {
  return Math.min(levelForXp(xp), M1_LEVEL_CAP);
}

/**
 * In-place XP grant for already-cloned pipeline states. Clamps at XP_CAP; emits one
 * FarmLevelUp event PER effective level crossed (M1 cap: events stop at Lv5 even
 * though XP keeps accruing, GDD §5.3). At cap a dayLog xpGained entry with amount 0
 * is still recorded for silent UI handling (GDD §5.8 — no dedicated XP SimEvent
 * exists in the §12 vocabulary; floaters ride CropHarvested.xp / XP_PLANT).
 */
export function grantXpInPlace(state: WorldState, amount: number): SimEvent[] {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`grantXp: amount must be a non-negative integer, got ${amount}`);
  }
  const before = state.progress.xp;
  const after = Math.min(before + amount, XP_CAP);
  state.progress.xp = after;
  state.dayLog.push({ kind: 'xpGained', amount: after - before });

  const events: SimEvent[] = [];
  const lvlBefore = effectiveLevel(before);
  const lvlAfter = effectiveLevel(after);
  for (let level = lvlBefore + 1; level <= lvlAfter; level++) {
    events.push({ type: 'FarmLevelUp', level, tilledCap: tilledCapForLevel(level) });
    state.dayLog.push({ kind: 'levelUp', level });
    // NEW-badge bookkeeping (GDD §4.3): entries unlocking at this level are badged
    // for the current game day; runNight prunes stale days.
    for (const entry of SHOP_CATALOG_M1) {
      if (entry.unlockLevel === level) {
        state.economy.newEntriesSeenDay[entry.entryId] = state.time.day;
      }
    }
  }
  return events;
}

/**
 * Grant XP (clamped at XP_CAP); multi-level jumps emit one FarmLevelUp event PER level
 * (GDD §5.5/§5.8). Pure variant of grantXpInPlace.
 */
export function grantXp(
  state: WorldState,
  amount: number,
): { state: WorldState; events: SimEvent[] } {
  const next = structuredClone(state);
  const events = grantXpInPlace(next, amount);
  return { state: next, events };
}

/** In-place counter bump for already-cloned pipeline states (GDD §5.6). */
export function bumpCounterInPlace(state: WorldState, id: CounterId, delta: number): void {
  state.progress.counters[id] = (state.progress.counters[id] ?? 0) + delta;
}

/** In-place "raise to at least" for peak-style counters (regrowChainMax, GDD §5.6). */
export function raiseCounterInPlace(state: WorldState, id: CounterId, value: number): void {
  state.progress.counters[id] = Math.max(state.progress.counters[id] ?? 0, value);
}

/** Idempotent counter bump; achievement unlock checks attach here in M1.5 (GDD §5.6). */
export function bumpCounter(state: WorldState, id: CounterId, delta: number): WorldState {
  const next = structuredClone(state);
  bumpCounterInPlace(next, id, delta);
  return next;
}
