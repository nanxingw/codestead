/**
 * Trigger engine — PURE T1~T7 decision (ai-quests §3.2).
 *
 * The frequency铁律 lives here as a snapshot-in / decision-out function so it can
 * be property-tested by event replay (PRD 05 testing seam c-②, verifies A2:
 * adjacent generation attempts ≥ effective cooldown, pending ≤1 always, failed
 * attempts count toward cooldown, clock-rollback stays conservative §11-E10).
 *
 * Evaluated every 60s (TRIGGER_TICK_MS). All inputs are injected — no clock, no
 * session table mutation, no fs. The decision is one of: run AI generation
 * (with the chosen candidate), serve a local-pool quest, or do nothing.
 */
import type { AiQuestsConfig } from './config.js';
import { AI_RECOVERY_PROBE_MINUTES } from './types.js';

/** What the §3.2 evaluation decides on a given tick. */
export type TriggerDecision =
  | { readonly kind: 'aiGenerate'; readonly candidate: CandidateSession }
  | { readonly kind: 'localPool' }
  | { readonly kind: 'scriptedConsent' } // §3.4 first-consent教学任务 (渠叔)
  | { readonly kind: 'none'; readonly reason: TriggerSkipReason };

/** Why a tick produced no quest (debugging only — never user-visible, §10). */
export type TriggerSkipReason =
  | 'disabled' // T1: enabled === false
  | 'pendingExists' // T2: a quest is already pending (global ≤1)
  | 'cooldown' // T3: within max(cooldown, clientPrefs interval)
  | 'notConnected' // T4: no authenticated game client
  | 'dailyCap' // T5: daily count/budget reached
  | 'localPoolExhausted' // §2.3: no AI, pool drained → idle chatter
  | 'noCandidateNoLocal'; // no candidate session and localTemplates off

/**
 * Read-only snapshot of a candidate working session (built from M2 SessionInfo +
 * transcript mtime + prompt-delta bookkeeping; §3.3). The trigger only sees this
 * projection — never the raw session table.
 */
export interface CandidateSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  /** Monotonic-ish mtime of the transcript (ms) — feeds the 10-min freshness gate. */
  readonly transcriptMtimeMs: number;
  /** New external (`userType:"external"`) prompts since this session was last quizzed. */
  readonly newExternalPrompts: number;
  /** Monotonic ms of the last UserPromptSubmit (tie-break, §3.3-③). */
  readonly lastPromptAtMs: number;
  /** True if the LAST quest was about this same session (down-weight, §3.3-③). */
  readonly wasLastQuestSession: boolean;
}

/** Effective-now and connection snapshot for one trigger evaluation. */
export interface TriggerInput {
  readonly config: AiQuestsConfig;
  /** Client-pref interval (stricter-of merge, §3.2-T3 / §4.7); null when no prefs yet. */
  readonly clientMinIntervalMinutes: 15 | 30 | null;
  /** Whether `clientPrefs.quests.enabled` is true (game-side switch, §4.7). */
  readonly clientEnabled: boolean;
  /** A game client is connected & authenticated (T4). */
  readonly gameConnected: boolean;
  /** A quest is already pending (T2). */
  readonly pendingExists: boolean;
  /** Monotonic ms now (cooldown math; §11-E10 conservative on rollback). */
  readonly nowMonotonicMs: number;
  /** Local-date string now (machine tz) for daily counter rollover (§3.1 / §11-E10). */
  readonly nowDate: string;
  /** Last generation attempt (monotonic ms; incl. failures, §3.2-T3); null = never. */
  readonly lastAttemptAtMs: number | null;
  /** AI generations counted today (§3.1 dailyMaxQuests). */
  readonly dailyCount: number;
  /** AI cost accrued today USD (§3.1 dailyBudgetUsd). */
  readonly dailyCostUsd: number;
  /** Module is in local-pool mode after 3 failures (§10) — AI path probed, not free. */
  readonly localPoolMode: boolean;
  /** Last AI-recovery probe (monotonic ms); null = none yet (§10). */
  readonly lastRecoveryProbeAtMs: number | null;
  /** Whether the first-consent flow has been shown (§3.4 `asked`). */
  readonly asked: boolean;
  /** Candidate working session if any (§3.3 selection done UPSTREAM of this fn). */
  readonly candidate: CandidateSession | null;
  /** Local-pool has at least one unused question for some NPC (§2.3). */
  readonly localPoolAvailable: boolean;
}

/**
 * Effective cooldown minutes = stricter (larger) of daemon `cooldownMinutes` and
 * the client interval (§3.2-T3). Pure helper, exported for the cooldown property test.
 */
export function effectiveCooldownMinutes(input: TriggerInput): number {
  const client = input.clientMinIntervalMinutes ?? 0;
  return Math.max(input.config.cooldownMinutes, client);
}

/**
 * Pure T1~T7 evaluation. SKELETON — body implemented by the trigger sub-task per
 * §3.2. Contract the implementation must satisfy (the property tests, A2):
 *  - T1 enabled===false ⇒ {none,'disabled'} (and the module never even starts, §9);
 *  - T2 pendingExists ⇒ {none,'pendingExists'};
 *  - T3 now-lastAttempt < effectiveCooldown ⇒ {none,'cooldown'} (failures count);
 *  - T4 !gameConnected ⇒ {none,'notConnected'};
 *  - T5 dailyCount≥cap OR dailyCost≥budget ⇒ local path (or none);
 *  - T6 candidate present & aiGeneration on & not budget-blocked ⇒ {aiGenerate};
 *       else localTemplates ⇒ {localPool}; else {none,'noCandidateNoLocal'};
 *  - T7 aiGeneration===false ⇒ skip AI, go straight to T6 local branch;
 *  - first-consent: aiGeneration off & !asked & a trigger would fire ⇒ {scriptedConsent} (§3.4);
 *  - localPoolMode: only attempt AI after AI_RECOVERY_PROBE_MINUTES since last probe (§10);
 *  - clock rollback (nowMonotonicMs < lastAttemptAt or date mismatch) ⇒ conservative
 *    (treat as in-cooldown / reset daily) (§11-E10).
 */
const MS_PER_MINUTE = 60_000;

export function evaluateTrigger(input: TriggerInput): TriggerDecision {
  const { config } = input;

  // T1 — 总开关. enabled===false short-circuits everything (the module would not
  // even be started in production, §9/A1; this guard keeps the pure fn honest).
  // The game-side switch is merged STRICTER: either side off ⇒ off (§4.7).
  if (!config.enabled || !input.clientEnabled) {
    return { kind: 'none', reason: 'disabled' };
  }

  // T2 — global pending ≤1. A live quest blocks all generation (§3.2-T2).
  if (input.pendingExists) {
    return { kind: 'none', reason: 'pendingExists' };
  }

  // T4 — no authenticated game client ⇒ nobody is playing; never spend / pile up.
  if (!input.gameConnected) {
    return { kind: 'none', reason: 'notConnected' };
  }

  // T3 — cooldown on ATTEMPTS (failures included). Effective cooldown is the
  // stricter (larger) of daemon cooldown and the client interval (§3.2-T3).
  // Clock-rollback is conservative: a now earlier than lastAttempt means the
  // monotonic source jumped — treat as still-in-cooldown (§11-E10).
  const cooldownMs = effectiveCooldownMinutes(input) * MS_PER_MINUTE;
  if (input.lastAttemptAtMs !== null) {
    const elapsed = input.nowMonotonicMs - input.lastAttemptAtMs;
    if (elapsed < 0 || elapsed < cooldownMs) {
      return { kind: 'none', reason: 'cooldown' };
    }
  }

  // §10 — in local-pool mode the AI path is probed, not free: only attempt AI
  // again after AI_RECOVERY_PROBE_MINUTES since the last probe. Until then the AI
  // branch is suppressed (we fall through to the local branch below).
  let aiAllowed = config.aiGeneration;
  if (input.localPoolMode) {
    const probeMs = AI_RECOVERY_PROBE_MINUTES * MS_PER_MINUTE;
    const sinceProbe =
      input.lastRecoveryProbeAtMs === null
        ? Number.POSITIVE_INFINITY
        : input.nowMonotonicMs - input.lastRecoveryProbeAtMs;
    if (sinceProbe < 0 || sinceProbe < probeMs) {
      aiAllowed = false; // still backing off the AI path
    }
  }

  // T5 — daily caps. Reaching either the count cap or the budget ceiling drops the
  // AI path for the rest of the day; the local branch still runs (§3.1/§9).
  const dailyCapHit =
    input.dailyCount >= config.dailyMaxQuests || input.dailyCostUsd >= config.dailyBudgetUsd;
  if (dailyCapHit) aiAllowed = false;

  // First-consent gate (§3.4 / A10): before the user has been asked, AI is off and
  // a trigger WOULD fire ⇒ serve the scripted教学任务 (渠叔) instead of anything
  // else. This precedes both the AI and local branches so the very first quest in a
  // fresh install is always the consent task.
  if (!config.aiGeneration && !input.asked) {
    return { kind: 'scriptedConsent' };
  }

  // T6/T7 — AI branch when allowed AND a candidate exists; else fall back to the
  // local pool (if localTemplates on AND the pool still has an unused question);
  // else nothing (宁缺毋滥).
  if (aiAllowed && input.candidate !== null) {
    return { kind: 'aiGenerate', candidate: input.candidate };
  }

  if (config.localTemplates) {
    if (!input.localPoolAvailable) {
      // Pool drained and AI not producing → idle chatter (§2.3/§3.3-④).
      return { kind: 'none', reason: 'localPoolExhausted' };
    }
    return { kind: 'localPool' };
  }

  // localTemplates off and no AI quest produced → nothing this tick. Prefer the
  // most informative reason: a hit daily cap is the cause when it fired.
  if (dailyCapHit) return { kind: 'none', reason: 'dailyCap' };
  return { kind: 'none', reason: 'noCandidateNoLocal' };
}
