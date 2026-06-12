/**
 * Quest lifecycle reducer — PURE `(state, event) => state` (ai-quests §5).
 *
 * THE highest-value daemon test seam for M4 (PRD 05 testing seam c-①):
 * table-driven over every legal transition plus rejection of illegal ones
 * (e.g. a second ANSWERED, §11-E7). No clock / fs / spawn — `at` (monotonic ms)
 * and `now` (ISO) arrive on the event, randomness does not exist here.
 *
 * Transition table (§5):
 *   IDLE        --genStart-->        GENERATING
 *   GENERATING  --genSuccess(quest)--> OFFERED      (questOffer pushed by caller)
 *   GENERATING  --genFailure(reason)-> FAILED       (backoff; counters bump §10)
 *   FAILED      --backoffElapsed-->   IDLE          (3-in-a-row ⇒ localPoolMode)
 *   OFFERED     --answer-->           ANSWERED      (caller writes the note §7)
 *   ANSWERED    --reward-->           ARCHIVED      (caller pushes questReward + accounts)
 *   OFFERED     --dismiss-->          DISMISSED     (no note, no reward, no failure)
 *   DISMISSED/ARCHIVED --reset-->     IDLE          (slot freed for the next trigger)
 *   ANY         --revokeAll-->        IDLE          (总开关关闭 clears the field §9)
 *
 * SKELETON: state shapes, event alphabet, and the reducer signature are fixed;
 * the per-row body is filled in by the lifecycle sub-task. Illegal transitions
 * MUST return the SAME state reference (no-op), never throw — the caller treats
 * "no change" as "rejected" (mirrors the session reducer discipline).
 */
import type { Quest } from '@codestead/shared';

import type { QuestCounters, QuestMeta, QuestModuleState } from './types.js';
import {
  BACKOFF_CAP_MINUTES,
  BACKOFF_SEQUENCE_MINUTES,
  CONSECUTIVE_FAILURE_THRESHOLD,
} from './types.js';

/** Why a generation attempt failed (§10 table; drives accounting & error log). */
export type GenFailureReason =
  | 'timeout' // 90s no exit → SIGTERM/SIGKILL
  | 'budget' // CLI aborted on --max-budget-usd
  | 'invalidOutput' // structured_output missing / safeParse failed (no in-tick retry)
  | 'processCrash' // exit code ≠ 0
  | 'apiError'; // is_error / StopFailure (rate_limit / auth / billing)

/**
 * Lifecycle events. Every event carries `at` (monotonic ms) for counters; quest
 * payloads carry their own ISO `createdAt`. The reducer never reads a clock.
 */
export type QuestLifecycleEvent =
  | { readonly kind: 'genStart'; readonly at: number }
  | { readonly kind: 'genSuccess'; readonly at: number; readonly quest: Quest }
  | {
      readonly kind: 'genFailure';
      readonly at: number;
      readonly reason: GenFailureReason;
      readonly costUsd: number;
    }
  | { readonly kind: 'genCostOnly'; readonly at: number; readonly costUsd: number } // success cost accrual
  | { readonly kind: 'backoffElapsed'; readonly at: number }
  | {
      readonly kind: 'answer';
      readonly questId: string;
      readonly noteRef: string | null;
      readonly answeredAt: string;
    }
  | { readonly kind: 'reward'; readonly questId: string }
  | { readonly kind: 'dismiss'; readonly questId: string; readonly dismissedAt: string }
  | { readonly kind: 'reset'; readonly at: number }
  | { readonly kind: 'revokeAll'; readonly at: number }
  /**
   * Mark a consent flow shown (§3.4). The first-consent markAsked records `choice`
   * (a/b/c) so the one-time follow-up can be gated on the 'b' path without reading
   * mutable config. The follow-up markAsked carries `followUp: true` and is terminal.
   */
  | { readonly kind: 'markAsked'; readonly choice?: 'a' | 'b' | 'c'; readonly followUp?: boolean }
  /** Record a drawn local-pool question id (no-repeat, §2.3). */
  | { readonly kind: 'localDrawn'; readonly poolId: string };

/** Fresh module state for a brand-new install (counters zeroed, §5). */
export function createInitialQuestState(): QuestModuleState {
  return {
    phase: 'IDLE',
    pending: null,
    history: [],
    counters: {
      lastAttemptAt: null,
      dailyDate: null,
      dailyCount: 0,
      dailyCostUsd: 0,
      consecutiveFailures: 0,
      backoffMinutes: 0,
      localPoolMode: false,
      lastRecoveryProbeAt: null,
      asked: false,
      firstConsentChoice: null,
      askedFollowUp: false,
      localCompletedCount: 0,
      usedLocalPoolIds: [],
    },
  };
}

/**
 * Pure lifecycle transition. MUST NOT mutate `state`; returns the SAME reference
 * on a no-op / illegal transition. SKELETON — body implemented by the lifecycle
 * sub-task per the §5 table above.
 */
/**
 * Backoff minutes after the Nth consecutive failure (§10): 15 → 30 → 60, capped
 * at 60. `consecutive` is the post-increment count (1-based).
 */
function backoffForFailure(consecutive: number): number {
  const idx = Math.min(consecutive - 1, BACKOFF_SEQUENCE_MINUTES.length - 1);
  return Math.min(BACKOFF_SEQUENCE_MINUTES[idx] ?? BACKOFF_CAP_MINUTES, BACKOFF_CAP_MINUTES);
}

/** Shallow counter patch helper (keeps the reducer no-mutation invariant). */
function withCounters(state: QuestModuleState, patch: Partial<QuestCounters>): QuestCounters {
  return { ...state.counters, ...patch };
}

export function reduceQuestLifecycle(
  state: QuestModuleState,
  event: QuestLifecycleEvent,
): QuestModuleState {
  switch (event.kind) {
    // ---- generation lifecycle (counter-bearing) ----
    case 'genStart': {
      // Only IDLE may begin a generation; lastAttemptAt advances even on the start
      // (T3 防抖 counts attempts, §3.2-T3). Illegal from any other phase → no-op.
      if (state.phase !== 'IDLE') return state;
      return {
        ...state,
        phase: 'GENERATING',
        pending: null,
        counters: withCounters(state, { lastAttemptAt: event.at }),
      };
    }

    case 'genSuccess': {
      if (state.phase !== 'GENERATING') return state;
      // Success resets the failure streak & backoff and clears local-pool mode
      // (§10: "any success resets count & cooldown"). Cost accrual rides genCostOnly.
      return {
        ...state,
        phase: 'OFFERED',
        pending: event.quest,
        counters: withCounters(state, {
          consecutiveFailures: 0,
          backoffMinutes: 0,
          localPoolMode: false,
          lastRecoveryProbeAt: null,
        }),
      };
    }

    case 'genCostOnly': {
      // A successful AI call's cost accrues into the daily counter (T5 budget).
      // Valid in GENERATING (right after success) or OFFERED (success already
      // applied). Pure bump — no phase change.
      if (state.phase !== 'GENERATING' && state.phase !== 'OFFERED') return state;
      return {
        ...state,
        counters: withCounters(state, {
          dailyCount: state.counters.dailyCount + 1,
          dailyCostUsd: state.counters.dailyCostUsd + event.costUsd,
        }),
      };
    }

    case 'genFailure': {
      if (state.phase !== 'GENERATING') return state;
      const consecutive = state.counters.consecutiveFailures + 1;
      const localPoolMode =
        state.counters.localPoolMode || consecutive >= CONSECUTIVE_FAILURE_THRESHOLD;
      // A failed call still consumed budget (§10 budget/api rows) — accrue it so
      // the daily ceiling counts failures too. The attempt count (dailyCount) is
      // an AI-generation success counter, so it is NOT bumped on failure.
      return {
        ...state,
        phase: 'FAILED',
        pending: null,
        counters: withCounters(state, {
          consecutiveFailures: consecutive,
          backoffMinutes: backoffForFailure(consecutive),
          localPoolMode,
          dailyCostUsd: state.counters.dailyCostUsd + event.costUsd,
        }),
      };
    }

    case 'backoffElapsed': {
      // FAILED → IDLE once the backoff window passed (the trigger owns the timing;
      // this just frees the slot). localPoolMode/streak persist until a success.
      if (state.phase !== 'FAILED') return state;
      return {
        ...state,
        phase: 'IDLE',
        pending: null,
        counters: withCounters(state, { backoffMinutes: 0 }),
      };
    }

    // ---- player-driven transitions ----
    case 'answer': {
      // Exactly one OFFERED→ANSWERED per quest (§11-E7): only from OFFERED, and the
      // questId must match the live pending quest. A second answer is a no-op.
      if (state.phase !== 'OFFERED' || state.pending === null) return state;
      if (state.pending.questId !== event.questId) return state;
      const q = state.pending;
      const meta: QuestMeta = {
        questId: q.questId,
        phase: 'ARCHIVED',
        source: q.source,
        npcId: q.npcId,
        relatedSessionId: q.relatedSessionId,
        createdAt: q.createdAt,
        answeredAt: event.answeredAt,
        dismissedAt: null,
        noteRef: event.noteRef,
      };
      // Keep `pending` populated through ANSWERED so the reward event can read the
      // quest's source for accounting; it is cleared at ARCHIVE (reward).
      return {
        ...state,
        phase: 'ANSWERED',
        history: [...state.history, meta],
        // local-pool completion drives the §3.4 3rd-quest follow-up prompt.
        counters:
          q.source === 'local'
            ? withCounters(state, {
                localCompletedCount: state.counters.localCompletedCount + 1,
              })
            : state.counters,
      };
    }

    case 'reward': {
      if (state.phase !== 'ANSWERED' || state.pending === null) return state;
      if (state.pending.questId !== event.questId) return state;
      // Note is already written, reward already pushed by the caller; archive the
      // slot so the next trigger may run.
      return {
        ...state,
        phase: 'ARCHIVED',
        pending: null,
      };
    }

    case 'dismiss': {
      // "先不聊" — only from OFFERED; no note, no reward, no failure, no extra
      // cooldown (§5). DISMISSED enters history then frees the slot at reset.
      if (state.phase !== 'OFFERED' || state.pending === null) return state;
      if (state.pending.questId !== event.questId) return state;
      const q = state.pending;
      const meta: QuestMeta = {
        questId: q.questId,
        phase: 'DISMISSED',
        source: q.source,
        npcId: q.npcId,
        relatedSessionId: q.relatedSessionId,
        createdAt: q.createdAt,
        answeredAt: null,
        dismissedAt: event.dismissedAt,
        noteRef: null,
      };
      return {
        ...state,
        phase: 'DISMISSED',
        pending: null,
        history: [...state.history, meta],
      };
    }

    case 'reset': {
      // ARCHIVED / DISMISSED / FAILED → IDLE: free the slot for the next trigger.
      // From any other phase this is a no-op (the live quest must finish first).
      if (state.phase !== 'ARCHIVED' && state.phase !== 'DISMISSED' && state.phase !== 'FAILED') {
        return state;
      }
      return { ...state, phase: 'IDLE', pending: null };
    }

    case 'revokeAll': {
      // 总开关关闭 clears the field from ANY phase (§9). Idempotent: already-IDLE &
      // empty → no-op so the caller's "changed?" check stays meaningful.
      if (state.phase === 'IDLE' && state.pending === null) return state;
      return { ...state, phase: 'IDLE', pending: null };
    }

    // ---- counter-only bookkeeping (phase-independent) ----
    case 'markAsked': {
      const followUp = event.followUp === true;
      // The follow-up is terminal (one-time): once askedFollowUp is set, ignore.
      // The first consent is one-time too, but records `firstConsentChoice` so the
      // 'b'-path follow-up can later be gated without reading mutable config (§3.4).
      if (state.counters.asked && (!followUp || state.counters.askedFollowUp)) return state;
      return {
        ...state,
        counters: withCounters(state, {
          asked: true,
          // Record the first-consent choice only on the first markAsked (not the
          // follow-up, which keeps the original 'b' on record).
          firstConsentChoice:
            !followUp && event.choice !== undefined
              ? event.choice
              : state.counters.firstConsentChoice,
          askedFollowUp: followUp ? true : state.counters.askedFollowUp,
        }),
      };
    }

    case 'localDrawn': {
      if (state.counters.usedLocalPoolIds.includes(event.poolId)) return state;
      return {
        ...state,
        counters: withCounters(state, {
          usedLocalPoolIds: [...state.counters.usedLocalPoolIds, event.poolId],
        }),
      };
    }

    default: {
      // Exhaustiveness guard — a new event.kind must add a case above.
      return state;
    }
  }
}
