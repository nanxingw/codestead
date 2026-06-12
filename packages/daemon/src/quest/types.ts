/**
 * Quest lifecycle state machine — shapes & timing constants.
 *
 * Source of truth (LITERAL): ai-quests.md §5 (state machine) / §10 (failure &
 * backoff) / §3 (trigger T1~T7, frequency guardrails). The lifecycle reducer
 * (lifecycle.ts) is a PURE function `(state, event) => state` — no clock, no fs,
 * no spawn; time arrives on the event, exactly like the session reducer.
 *
 * The seven lifecycle states (§5):
 *   IDLE → GENERATING → OFFERED → ANSWERED → ARCHIVED
 *   branches: FAILED (backoff; 3-in-a-row → local-pool mode)
 *             DISMISSED (no note, no reward, no failure, no extra cooldown)
 */
import type { Quest } from '@codestead/shared';

// ---- timing & guardrail constants (design law — do not tune in code) ----

/** Generation watchdog: 90s SIGTERM (§4.5 / tech-stack §1). */
export const GEN_SIGTERM_MS = 90_000;
/** +5s SIGKILL after SIGTERM (§4.5). */
export const GEN_SIGKILL_GRACE_MS = 5_000;

/** Trigger evaluation cadence: every 60s (§3.2). */
export const TRIGGER_TICK_MS = 60_000;

/** Backoff sequence after failure: 15 → 30 → 60 minutes, capped at 60 (§10). */
export const BACKOFF_SEQUENCE_MINUTES = [15, 30, 60] as const;
export const BACKOFF_CAP_MINUTES = 60;

/** Consecutive failures that flip the module into local-pool mode (§10). */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/** Answered local-pool quests after which the opt-in follow-up consent fires once (§3.4). */
export const FOLLOW_UP_AFTER_LOCAL_COUNT = 3;

/** While in local-pool mode, probe AI-path recovery every 60 minutes (§10). */
export const AI_RECOVERY_PROBE_MINUTES = 60;

/** Candidate-session freshness: transcript mtime within 10 real minutes (§3.3-①). */
export const CANDIDATE_FRESHNESS_MS = 10 * 60_000;
/** Minimum new external prompts since last quest on a session (§3.3-②). */
export const MIN_NEW_PROMPTS = 2;
/** Sanitized context floor: <300 chars ⇒ abandon AI generation this tick (§3.3-④). */
export const MIN_CONTEXT_CHARS = 300;
/** Sanitized context ceiling fed to stdin (§4.3 / §4.5). */
export const MAX_CONTEXT_CHARS = 6_000;

/** Settings interval档 (§3.1 / §6.4): low=30 (factory default), normal=15. */
export const MIN_INTERVAL_LOW_MINUTES = 30;
export const MIN_INTERVAL_NORMAL_MINUTES = 15;

// ---- lifecycle state ----

export type QuestLifecyclePhase =
  | 'IDLE'
  | 'GENERATING'
  | 'OFFERED'
  | 'ANSWERED'
  | 'ARCHIVED'
  | 'FAILED'
  | 'DISMISSED';

/** Compact metadata for history rows (full Quest is only kept for the live pending one). */
export interface QuestMeta {
  readonly questId: string;
  readonly phase: Extract<QuestLifecyclePhase, 'ARCHIVED' | 'DISMISSED'>;
  readonly source: Quest['source'];
  readonly npcId: Quest['npcId'];
  readonly relatedSessionId: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  /** Set when answered/archived (ISO 8601); null for dismissed. */
  readonly answeredAt: string | null;
  /** Set when dismissed (ISO 8601); null otherwise. */
  readonly dismissedAt: string | null;
  /** Note file relative path (notes/YYYY-MM-DD/<questId>.md); null if not written. */
  readonly noteRef: string | null;
}

/** Throttle/cost counters, persisted alongside the pending quest (§5 / §3.2 / §10). */
export interface QuestCounters {
  /** Monotonic-clock ms of the last generation ATTEMPT (incl. failures, §3.2-T3). */
  readonly lastAttemptAt: number | null;
  /** Local-date string (machine tz) the daily counters belong to (§3.1 / §11-E10). */
  readonly dailyDate: string | null;
  /** AI generations counted today (§3.1 dailyMaxQuests / T5). */
  readonly dailyCount: number;
  /** AI cost accrued today USD (§3.1 dailyBudgetUsd / T5). */
  readonly dailyCostUsd: number;
  /** Consecutive failures (resets to 0 on any success, §10). */
  readonly consecutiveFailures: number;
  /** Current backoff in minutes (15→30→60), 0 when not backing off (§10). */
  readonly backoffMinutes: number;
  /** True once 3 failures in a row flipped to local-pool mode (§10). */
  readonly localPoolMode: boolean;
  /** Last AI-recovery probe time while in local-pool mode (monotonic ms, §10). */
  readonly lastRecoveryProbeAt: number | null;
  /** Whether the first-consent flow has been shown (§3.4 `asked`). */
  readonly asked: boolean;
  /**
   * The option chosen at the FIRST consent flow (§3.4): 'a' enableAi / 'b' localOnly
   * / 'c' disableAll; null until consent is answered. Persisted so the one-time
   * follow-up (only for the 'b' path) survives a daemon restart and is never
   * inferred from mutable config (which a later settings change could falsify).
   */
  readonly firstConsentChoice: 'a' | 'b' | 'c' | null;
  /** Opt-in follow-up (one-time after 3rd local quest if first choice was b, §3.4). */
  readonly askedFollowUp: boolean;
  /** Count of completed local-pool quests (drives the §3.4 3rd-quest follow-up). */
  readonly localCompletedCount: number;
  /** Local-pool question ids already used (no-repeat draw; pool exhausted ⇒ idle chatter, §2.3). */
  readonly usedLocalPoolIds: readonly string[];
}

/**
 * Whole-module persisted state (`~/.codestead/quests/state.json`, §5):
 * one pending quest at most (global ≤1, T2), history metas, and the counters.
 */
export interface QuestModuleState {
  /** Current lifecycle phase of the single in-flight quest slot. */
  readonly phase: QuestLifecyclePhase;
  /** The live quest while OFFERED/ANSWERED; null when IDLE/GENERATING/FAILED. */
  readonly pending: Quest | null;
  readonly history: readonly QuestMeta[];
  readonly counters: QuestCounters;
}
