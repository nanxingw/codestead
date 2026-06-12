/**
 * quest-reward.ts — sim-side quest reward grant (PRD 05 §K; verification A9).
 *
 * The economy-unbreakable side of M4: a `questReward` from the daemon credits
 * gold + XP ONCE per questId. Idempotency key = `quests.grantedQuestIds` (the
 * SaveDoc quests block, GDD §10.2). Reconnect replays, save imports to another
 * machine and roll-backs therefore never double-credit (§5 / §11-E4).
 *
 * Trust boundary's second leg (§4.6 / GDD §5.2): the reward载荷 is safeParsed at
 * the WS edge against the shared QuestRewardSchema (gold ≤120, xp ≤QUEST_XP_MAX)
 * BEFORE it reaches here — so this function takes an already-bounded reward. As
 * defence-in-depth it ALSO clamps to the shared constants, so a bug upstream
 * still cannot mint out-of-band gold/XP.
 *
 * Reuses the SAME faucets as achievements (PRD 02 decision 4): `credit` for
 * instant wallet gold (GOLD_CAP clamped, never via the shipping bin), and
 * `grantXpInPlace` for the unified XP pipeline (level-ups, dayLog xpGained). Like
 * achievement gold, quest gold does NOT bump the `goldEarned` sales counter.
 *
 * Completion counter: a granted reward bumps `quests.completedCount` and the
 * `questsCompleted` progression counter (achievement #19 智者 predicate, GDD §5.6);
 * `notesWritten` is bumped separately by the note-writing path (#20 思考的痕迹).
 *
 * Zero Phaser, zero wall clock — pure, headless-testable (the §K seam).
 */
import { QUEST_GOLD_MAX, QUEST_XP_MAX, type QuestReward, type SaveQuests } from '@codestead/shared';

import { credit } from './economy.js';
import { bumpCounterInPlace, grantXpInPlace } from './leveling.js';
import type { SimEvent, WorldState } from './types.js';

/** Clamp a (possibly buggy) reward to the shared bounds — last-line defence (§4.6). */
export function clampQuestReward(reward: QuestReward): { gold: number; xp: number } {
  const gold = Math.max(0, Math.min(Math.trunc(reward.gold), QUEST_GOLD_MAX));
  const xp = Math.max(0, Math.min(Math.trunc(reward.xp), QUEST_XP_MAX));
  return { gold, xp };
}

export interface GrantQuestRewardResult {
  readonly state: WorldState;
  readonly quests: SaveQuests;
  readonly events: SimEvent[];
  /** False when the questId was already granted (idempotent no-op) — UI shows nothing. */
  readonly granted: boolean;
}

/**
 * Idempotently grant a quest reward keyed on `questId` (§K / A9). If `questId` is
 * already in `quests.grantedQuestIds`, returns the SAME state/quests references,
 * no events, `granted: false`. Otherwise credits clamped gold instantly, runs the
 * XP through the level pipeline, records the questId, bumps completedCount +
 * `questsCompleted`, and returns the new state/quests with the gold/level events.
 *
 * Contract (the §K tests):
 *  - same questId twice ⇒ second call is a byte-identical no-op (A9);
 *  - gold credited via `credit` (GOLD_CAP clamp), never the shipping bin;
 *  - xp via `grantXpInPlace` (emits FarmLevelUp on crossings);
 *  - `goldEarned` counter is NOT bumped by quest gold;
 *  - completedCount and `questsCompleted` rise by exactly 1 on a fresh grant.
 */
export function grantQuestReward(
  state: WorldState,
  quests: SaveQuests,
  questId: string,
  reward: QuestReward,
): GrantQuestRewardResult {
  // Idempotency key = grantedQuestIds (A9): a replayed reward (reconnect, save
  // import, roll-back) is a byte-identical no-op — SAME references, no events.
  if (quests.grantedQuestIds.includes(questId)) {
    return { state, quests, events: [], granted: false };
  }

  const next = structuredClone(state);
  const events: SimEvent[] = [];
  // Defence-in-depth (§4.6 second leg): clamp again even though the WS edge
  // already safeParsed the reward against the shared bounds.
  const { gold, xp } = clampQuestReward(reward);

  // Gold via the SAME faucet as achievements: instant wallet credit (GOLD_CAP
  // clamped, never the shipping bin) and — like achievement gold — it does NOT
  // bump the `goldEarned` sales counter (PRD 02 decision 4 / §5.6).
  if (gold > 0) {
    const before = next.economy.gold;
    next.economy.gold = credit(before, gold);
    events.push({
      type: 'GoldChanged',
      gold: next.economy.gold,
      delta: next.economy.gold - before,
    });
  }
  // XP through the unified pipeline (level-ups, dayLog xpGained, FarmLevelUp).
  if (xp > 0) {
    events.push(...grantXpInPlace(next, xp));
  }

  // Completion counters: completedCount (save block) + questsCompleted
  // (progression counter, #19 智者 predicate, GDD §5.6). #19 fires via the
  // achievement sweep; this only moves the counter it watches.
  bumpCounterInPlace(next, 'questsCompleted', 1);

  const nextQuests: SaveQuests = {
    ...quests,
    grantedQuestIds: [...quests.grantedQuestIds, questId],
    completedCount: quests.completedCount + 1,
  };

  return { state: next, quests: nextQuests, events, granted: true };
}

/**
 * Record that a thinking note was written (§K / GDD §5.6 #20 notebook predicate).
 * Adds `noteRef` to `quests.noteRefs` (idempotent on the ref) and bumps the
 * `notesWritten` progression counter. Separate from reward granting because a
 * dismissed/unrewarded path writes no note, and a note write must move #20 even
 * when the reward was withheld (§11-E11 — note exists, reward does not).
 */
export function recordNoteWritten(
  state: WorldState,
  quests: SaveQuests,
  noteRef: string,
): { state: WorldState; quests: SaveQuests; events: SimEvent[]; recorded: boolean } {
  // Idempotent on the ref: a replayed note write is a no-op — SAME references,
  // so #20 notebook can never be inflated by a re-sync of the same note.
  if (quests.noteRefs.includes(noteRef)) {
    return { state, quests, events: [], recorded: false };
  }

  const next = structuredClone(state);
  // notesWritten drives #20 思考的痕迹 (≥10 notes, +30 XP via the achievement
  // sweep). Decoupled from reward granting: a dismissed/withheld path writes no
  // note, and a note write must move #20 even when the reward was withheld
  // (§11-E11 — note exists on disk, reward does not).
  bumpCounterInPlace(next, 'notesWritten', 1);

  const nextQuests: SaveQuests = {
    ...quests,
    noteRefs: [...quests.noteRefs, noteRef],
  };

  return { state: next, quests: nextQuests, events: [], recorded: true };
}
