/**
 * leveling.ts — XP, farm level derivation, counters (GDD §5.1/§5.2/§5.5).
 *
 * Single source of truth = xp + counters + achievements + profession; level, unlocks
 * and shop availability are ALWAYS derived, never stored (PRD 01 US73).
 * M1-core instruments counters only (bumpCounter call sites per GDD §5.6 list);
 * achievement definitions/rewards/UI are M1.5.
 *
 * M3 (PRD 04 §F36): the M1 `min(levelForXp(xp), 5)` clamp is LIFTED — effectiveLevel
 * now caps at LEVEL_CAP_M3 (= 10, the natural table maximum); XP keeps accruing to
 * XP_CAP = 15,000 (mastery bar, §5.1). M1_LEVEL_CAP stays exported from data/constants
 * as the frozen migration-source snapshot only. Retro catch-up for old saves whose xp
 * already exceeds Lv5 lives in profession.ts retroLevelUpEvents (§5.3 M1→M3 迁移).
 *
 * NOTE: this module sits in TWO deliberate, benign import cycles (same pattern as the
 * documented tiles.ts↔leveling.ts one): leveling→tiles→leveling and
 * leveling→profession→leveling. All cross-references are hoisted declarations or
 * consts read strictly at call time, never during module evaluation.
 *
 * The exported `*InPlace` variants exist for composition inside an already-cloned
 * pipeline (applyAction / runNight); the contract-named functions stay pure
 * (clone-in, new-state-out).
 */
import { BLUEPRINTS } from './data/buildings.js';
import { SHOP_CATALOG_M1, XP_CAP, XP_THRESHOLDS } from './data/constants.js';
import { LEVEL_CAP_M3, PROFESSION_MIN_LEVEL } from './profession.js';
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

/**
 * effectiveLevel = min(levelForXp(xp), LEVEL_CAP_M3) — the M1 min(·, 5) clamp is gone
 * (M3 cap lift, GDD §5.3 / PRD 04 US36). The clamp is technically a no-op against the
 * 10-entry threshold table; it stays as the explicit cap contract (and the switch
 * point future milestones would edit).
 */
export function effectiveLevel(xp: number): number {
  return Math.min(levelForXp(xp), LEVEL_CAP_M3);
}

/**
 * In-place XP grant for already-cloned pipeline states. Clamps at XP_CAP; emits one
 * FarmLevelUp event PER effective level crossed — with the M3 cap lift that is every
 * level up to Lv10 (GDD §5.3/§5.8 multi-level discipline). At the XP cap a dayLog
 * xpGained entry with amount 0 is still recorded for silent UI handling (GDD §5.8 —
 * no dedicated XP SimEvent exists in the §12 vocabulary; floaters ride
 * CropHarvested.xp / XP_PLANT).
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

// ---- Lv1~10 unlock table view (GDD §5.3; M3, PRD 04 US36/US37) ----

/**
 * What reaching `level` newly unlocks — a pure JOIN over the authority tables
 * (BLUEPRINTS unlock.farmLevel, SHOP_CATALOG_M1 unlockLevel, §1.4 tilled caps,
 * §5.3 profession row, §5.1 mastery row). Deliberately NOT a second hand-written
 * copy of the §5.3 table: every row keeps exactly one source of truth, so this view
 * can never drift from the data the shop/build catalogs actually enforce.
 *
 * Consumers: level-up banners & settlement lines (US36), and the retro catch-up
 * presentation for old saves (US37, paired with profession.retroLevelUpEvents).
 * Display strings stay render-side (ui/strings.ts) per the sim discipline.
 */
export interface LevelUnlockView {
  level: number;
  /** Blueprint ids whose unlock.farmLevel === level, table order (GDD §8.2). */
  blueprintIds: string[];
  /** M1 shop entries whose unlockLevel === level, catalog order (GDD §4.3). */
  shopEntryIds: string[];
  /** Tilled cap at this level (§1.4) and whether THIS level raises it (Lv3/5/7/9). */
  tilledCap: number;
  capRaised: boolean;
  /** Lv5+: the certificate desk opens (profession 二选一, §5.3). */
  professionChoice: boolean;
  /** Lv10: the XP bar becomes the mastery bar (§5.1/§5.3). */
  masteryBar: boolean;
}

export function unlocksForLevel(level: number): LevelUnlockView {
  return {
    level,
    blueprintIds: BLUEPRINTS.filter((b) => b.unlock.farmLevel === level).map((b) => b.id),
    shopEntryIds: SHOP_CATALOG_M1.filter((e) => e.unlockLevel === level).map((e) => e.entryId),
    tilledCap: tilledCapForLevel(level),
    capRaised: level > 1 && tilledCapForLevel(level) > tilledCapForLevel(level - 1),
    professionChoice: level === PROFESSION_MIN_LEVEL,
    masteryBar: level === LEVEL_CAP_M3,
  };
}
