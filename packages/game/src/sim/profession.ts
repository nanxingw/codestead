/**
 * profession.ts — Lv5 profession choice + M3 level-cap lift contract
 * (GDD §5.3; PRD 04 §F36~39; ruling A-13 enum).
 *
 * Settled rules (§5.3):
 * - enum 'horticulturist' (crops ×1.10) | 'artisan' (artisan goods ×1.25) — the
 *   multipliers live ONLY inside economy.unitSalePrice (§4.5 single pricing entry);
 * - chosen ACTIVELY at the farmhouse certificate desk, Lv5+; double-confirm states
 *   permanence; never blocks any level-up while unchosen; irreversible forever;
 * - the settlement screen hints exactly ONCE on the day the condition is first met
 *   (one-shot `professionHintShown` counter flag, no nagging — PRD 04 US39; same
 *   counter-as-flag precedent as introLetterRead, zero schema change);
 * - choosing fires achievement #18 signed_papers (0 XP, §5.6) via the regular sweep
 *   (profession is part of ProgressView already — no special-case unlock path).
 *
 * Level-cap lift (M3): leveling.effectiveLevel now clamps at LEVEL_CAP_M3 (the
 * constant below) instead of the M1 min(·, 5), so Lv6~10 unlock per §5.3 while XP
 * stays hard-capped at 15,000 (mastery bar, §5.1).
 *
 * Retro catch-up (§5.3 / §5.5 acceptance "xp=2,400 的 M1 档载入补发 Lv6"):
 * the v1→v2 migration is structural (shared); the EVENT side happens at load via
 * retroLevelUpEvents — banners queue one per level (§5.8 FIFO queue), plus one-shot
 * retro unlocks (blueprints/shop NEW badges) and the quiet "木匠服务已开通"
 * settlement line. Pair each level with leveling.unlocksForLevel for the banner copy.
 *
 * NOTE: this module and leveling.ts form a deliberate, benign import cycle
 * (leveling.effectiveLevel reads LEVEL_CAP_M3; the functions here call levelForXp /
 * effectiveLevel) — same documented pattern as tiles.ts↔leveling.ts. Everything is
 * referenced strictly at call time, never during module evaluation.
 */
import type { Profession } from '@codestead/shared';

import { effectiveLevel, levelForXp } from './leveling.js';
import { tilledCapForLevel } from './tiles.js';
import type { SimEvent, WorldState } from './types.js';

export type { Profession };

/** M3 lifts the cap to the natural table maximum (GDD §5.1/§5.3). */
export const LEVEL_CAP_M3 = 10;

/** Minimum farm level to sign at the certificate desk (GDD §5.3). */
export const PROFESSION_MIN_LEVEL = 5;

export type ProfessionError =
  | 'LEVEL_TOO_LOW' // below Lv5
  | 'ALREADY_CHOSEN'; // irreversible — second choice is impossible (§5.3)

export type ProfessionResult =
  | { ok: true; state: WorldState; events: SimEvent[] }
  | { ok: false; error: ProfessionError };

/** Query for the desk UI: may the player sign now, and which one is already held? */
export function canChooseProfession(state: WorldState): {
  allowed: boolean;
  current: Profession | null;
  reason?: ProfessionError;
} {
  const current = state.progress.profession;
  if (current !== null) return { allowed: false, current, reason: 'ALREADY_CHOSEN' };
  if (effectiveLevel(state.progress.xp) < PROFESSION_MIN_LEVEL) {
    return { allowed: false, current: null, reason: 'LEVEL_TOO_LOW' };
  }
  return { allowed: true, current: null };
}

/**
 * Commit the irreversible choice (double-confirm is the UI's job; the sim only
 * enforces LEVEL_TOO_LOW / ALREADY_CHOSEN). Emits ProfessionChosen; achievement #18
 * unlocks via the regular sweep (profession is part of ProgressView already).
 * Pure: clone-in, new-state-out; the multiplier itself applies from the next
 * settlement through economy.unitSalePrice (§4.5 — no price data is stored here).
 */
export function chooseProfession(state: WorldState, profession: Profession): ProfessionResult {
  const gate = canChooseProfession(state);
  if (!gate.allowed) {
    return { ok: false, error: gate.reason ?? 'ALREADY_CHOSEN' };
  }
  const next = structuredClone(state);
  next.progress.profession = profession;
  return { ok: true, state: next, events: [{ type: 'ProfessionChosen', profession }] };
}

/**
 * Retro level-up events for a save whose xp already exceeds the old cap
 * (§5.3 M1→M3 migration; PRD 04 US37): one FarmLevelUp per level in
 * (fromLevel, min(levelForXp(xp), LEVEL_CAP_M3)], in ascending order, with the
 * §1.4 tilledCap values. Pure — called once at load by the hydrate path, tested
 * standalone (canonical fixture: xp=2,400, fromLevel=5 ⇒ [Lv6]).
 */
export function retroLevelUpEvents(xp: number, fromLevel: number): SimEvent[] {
  const target = Math.min(levelForXp(xp), LEVEL_CAP_M3);
  const events: SimEvent[] = [];
  for (let level = fromLevel + 1; level <= target; level++) {
    events.push({ type: 'FarmLevelUp', level, tilledCap: tilledCapForLevel(level) });
  }
  return events;
}

// ---- one-shot settlement hint (PRD 04 US39) ----

/**
 * Should TONIGHT's settlement screen show the gentle "证书桌已就绪" line?
 * True exactly while: Lv5+ reached ∧ no profession chosen ∧ never hinted before.
 * The settlement/UI layer shows the line once and then calls
 * markProfessionHintShownInPlace — after that the desk waits silently forever.
 */
export function professionHintPending(state: WorldState): boolean {
  return (
    state.progress.profession === null &&
    effectiveLevel(state.progress.xp) >= PROFESSION_MIN_LEVEL &&
    (state.progress.counters.professionHintShown ?? 0) === 0
  );
}

/** Burn the one-shot hint flag (idempotent; counters persist via SaveDoc unchanged). */
export function markProfessionHintShownInPlace(state: WorldState): void {
  state.progress.counters.professionHintShown = 1;
}
