/**
 * achievements.ts — pure achievement engine (GDD §5.6; PRD 02 implementation decision 2).
 *
 * Judgement model: achievements are a pure function of the progression counters, tool
 * tiers, xp and profession (the ProgressView). The sweep runs after every command and
 * time batch (sim.ts), which subsumes the contract trigger points "after every
 * bumpCounter and after tool-upgrade events" — predicates are monotonic over
 * append-only counters, so coarser sweep timing can never miss an unlock.
 *
 * Idempotence: `progress.achievements` is append-only (GDD §5.5); an id already in the
 * array is never re-unlocked and never re-rewarded, across repeat triggers, reloads and
 * imports alike. Unknown (future-version) ids in the array are preserved untouched
 * (§5.8 forward-compat boundary).
 *
 * Rewards (PRD 02 implementation decision 4):
 *   - xp goes through the SAME grantXp pipeline as planting/harvesting (level cap,
 *     FarmLevelUp events, dayLog xpGained entries all apply);
 *   - gold is credited instantly to the wallet (GOLD_CAP clamped), never via the
 *     shipping bin (§4.7 one-time faucet, 340g total in M1.5);
 *   - achievement gold does NOT bump the `goldEarned` counter — that counter is the
 *     sales-settlement cumulative (§5.6/§4.8), and keeping faucet gold out of it
 *     prevents #7/#8 from feeding on their own rewards.
 *
 * Milestone gate: only UNLOCKABLE_MILESTONES entries may fire. The M3 build widens the
 * set to {'M1.5','M3'} — #15~#18/#21/#22 are live (PRD 04 §I), while the M4 rows
 * (#19 first_quest / #20 notebook) stay inert data until their milestone (§0.4
 * milestone boundary). The engine itself is untouched by the widening (PRD 02 §F37
 * data-driven contract).
 */
import {
  ACHIEVEMENTS,
  type AchievementDef,
  type AchievementMilestone,
  type ProgressView,
} from './data/achievements.js';
import { credit } from './economy.js';
import { grantXpInPlace } from './leveling.js';
import type { SimEvent, WorldState } from './types.js';

/** Milestones whose achievements may unlock in THIS build (M4 widens this set). */
export const UNLOCKABLE_MILESTONES: ReadonlySet<AchievementMilestone> = new Set(['M1.5', 'M3']);

/** Read-only predicate view over the sim state (counters + tools + xp + profession). */
export function progressView(state: WorldState): ProgressView {
  return {
    counters: state.progress.counters,
    tools: state.tools,
    xp: state.progress.xp,
    profession: state.progress.profession,
  };
}

/** Defs that are unlockable now, satisfied, and not yet unlocked — in §5.6 table order. */
export function pendingUnlocks(state: WorldState): AchievementDef[] {
  const unlocked = new Set(state.progress.achievements);
  const view = progressView(state);
  return ACHIEVEMENTS.filter(
    (def) =>
      UNLOCKABLE_MILESTONES.has(def.milestone) && !unlocked.has(def.id) && def.predicate(view),
  );
}

/**
 * In-place unlock sweep for an already-cloned state. Single pass in table order is
 * sufficient and deterministic: rewards never feed any M1.5 predicate (xp/wallet gold
 * are not M1.5 counters), so an unlock cannot enable another within the same sweep.
 */
export function checkAchievementsInPlace(state: WorldState): SimEvent[] {
  const events: SimEvent[] = [];
  for (const def of pendingUnlocks(state)) {
    state.progress.achievements.push(def.id); // append-only ⇒ idempotent
    events.push({
      type: 'AchievementUnlocked',
      id: def.id,
      xp: def.reward.xp,
      gold: def.reward.gold,
    });
    if (def.reward.gold > 0) {
      const before = state.economy.gold;
      state.economy.gold = credit(before, def.reward.gold); // instant, GOLD_CAP clamped
      events.push({
        type: 'GoldChanged',
        gold: state.economy.gold,
        delta: state.economy.gold - before,
      });
    }
    if (def.reward.xp > 0) {
      events.push(...grantXpInPlace(state, def.reward.xp)); // unified XP pipeline (§5.2)
    }
  }
  return events;
}

/**
 * Pure unlock sweep (clone-in, new-state-out). The no-unlock fast path returns the
 * SAME state reference and allocates nothing — safe to call once per sim command and
 * per advanceMinutes batch.
 */
export function checkAchievements(state: WorldState): { state: WorldState; events: SimEvent[] } {
  if (pendingUnlocks(state).length === 0) return { state, events: [] };
  const next = structuredClone(state);
  const events = checkAchievementsInPlace(next);
  return { state: next, events };
}

/** Whether an achievement id (known or future-version) is recorded as unlocked. */
export function isUnlocked(state: WorldState, id: string): boolean {
  return state.progress.achievements.includes(id);
}
