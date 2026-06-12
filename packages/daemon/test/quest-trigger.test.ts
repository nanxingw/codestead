/**
 * Trigger engine T1~T7 table + stricter-of-merge cooldown (PRD 05 §C, A2).
 *
 * `effectiveCooldownMinutes` is implemented and tested unconditionally (it is the
 * frequency铁律's load-bearing helper: stricter-of daemon cooldown and the client
 * interval). `evaluateTrigger` is a contract SKELETON; its table-driven T1~T7
 * assertions are gated behind `questModuleReady` so the suite is green now and
 * becomes a live A2 regression (pending ≤1, failures count toward cooldown,
 * clock-rollback conservative, enabled=false ⇒ disabled) the moment it lands.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_QUESTS_CONFIG, type AiQuestsConfig } from '../src/quest/config.js';
import {
  effectiveCooldownMinutes,
  evaluateTrigger,
  type CandidateSession,
  type TriggerInput,
} from '../src/quest/trigger.js';
import { questModuleReady } from './helpers/quest-ready.js';

// ---- builders ----

function cfg(overrides: Partial<AiQuestsConfig> = {}): AiQuestsConfig {
  return { ...DEFAULT_AI_QUESTS_CONFIG, ...overrides };
}

function candidate(overrides: Partial<CandidateSession> = {}): CandidateSession {
  return {
    sessionId: 'sess-1',
    cwd: '/work/payments',
    transcriptPath: '/home/u/.claude/projects/x/sess-1.jsonl',
    transcriptMtimeMs: 1_000_000,
    newExternalPrompts: 3,
    lastPromptAtMs: 1_000_000,
    wasLastQuestSession: false,
    ...overrides,
  };
}

const MIN = 60_000;

/** A baseline input where a trigger WOULD fire (AI on, fresh candidate, connected, consented). */
function input(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    config: cfg({ aiGeneration: true }),
    clientMinIntervalMinutes: 30,
    clientEnabled: true,
    gameConnected: true,
    pendingExists: false,
    nowMonotonicMs: 100 * MIN,
    nowDate: '2026-06-12',
    lastAttemptAtMs: 0, // long ago ⇒ cooldown satisfied
    dailyCount: 0,
    dailyCostUsd: 0,
    localPoolMode: false,
    lastRecoveryProbeAtMs: null,
    asked: true,
    candidate: candidate(),
    localPoolAvailable: true,
    ...overrides,
  };
}

const ready = questModuleReady(() => evaluateTrigger(input()));

// ---- effectiveCooldownMinutes (implemented — unconditional) ----

describe('effectiveCooldownMinutes — stricter-of merge (§3.2-T3 / 附录 A-23)', () => {
  it('takes the larger of daemon cooldown and the client interval', () => {
    expect(
      effectiveCooldownMinutes(
        input({ config: cfg({ cooldownMinutes: 15 }), clientMinIntervalMinutes: 30 }),
      ),
    ).toBe(30);
    expect(
      effectiveCooldownMinutes(
        input({ config: cfg({ cooldownMinutes: 60 }), clientMinIntervalMinutes: 30 }),
      ),
    ).toBe(60);
    expect(
      effectiveCooldownMinutes(
        input({ config: cfg({ cooldownMinutes: 15 }), clientMinIntervalMinutes: 15 }),
      ),
    ).toBe(15);
  });

  it('falls back to the daemon cooldown when no client interval is known yet', () => {
    expect(
      effectiveCooldownMinutes(
        input({ config: cfg({ cooldownMinutes: 45 }), clientMinIntervalMinutes: null }),
      ),
    ).toBe(45);
  });

  it('factory merge lands at 30 min (daemon 15 vs client low 30 → 30, double the floor)', () => {
    expect(
      effectiveCooldownMinutes(
        input({ config: cfg({ cooldownMinutes: 15 }), clientMinIntervalMinutes: 30 }),
      ),
    ).toBe(30);
  });
});

// ---- evaluateTrigger T1~T7 (gated on implementation) ----

describe.runIf(ready)('evaluateTrigger T1~T7 table (§3.2 — gated on implementation)', () => {
  it('T1 enabled===false ⇒ {none, disabled} (no AI, no local)', () => {
    const d = evaluateTrigger(input({ config: cfg({ enabled: false, aiGeneration: true }) }));
    expect(d).toEqual({ kind: 'none', reason: 'disabled' });
  });

  it('T2 a pending quest already exists ⇒ {none, pendingExists} (global ≤1)', () => {
    const d = evaluateTrigger(input({ pendingExists: true }));
    expect(d).toEqual({ kind: 'none', reason: 'pendingExists' });
  });

  it('T3 within the effective cooldown ⇒ {none, cooldown} (failures count — same path)', () => {
    const now = 100 * MIN;
    // last attempt 10 min ago, effective cooldown 30 ⇒ still cooling.
    const d = evaluateTrigger(input({ nowMonotonicMs: now, lastAttemptAtMs: now - 10 * MIN }));
    expect(d).toEqual({ kind: 'none', reason: 'cooldown' });
  });

  it('T3 once the cooldown elapses a trigger may fire again', () => {
    const now = 100 * MIN;
    const d = evaluateTrigger(input({ nowMonotonicMs: now, lastAttemptAtMs: now - 31 * MIN }));
    expect(d.kind).not.toBe('none');
  });

  it('T4 no connected game client ⇒ {none, notConnected} (no one playing ⇒ no spend)', () => {
    const d = evaluateTrigger(input({ gameConnected: false }));
    expect(d).toEqual({ kind: 'none', reason: 'notConnected' });
  });

  it('T5 daily count cap reached ⇒ AI path is blocked (local or none, never AI)', () => {
    const d = evaluateTrigger(input({ dailyCount: DEFAULT_AI_QUESTS_CONFIG.dailyMaxQuests }));
    expect(d.kind).not.toBe('aiGenerate');
  });

  it('T5 daily budget reached ⇒ AI path is blocked', () => {
    const d = evaluateTrigger(input({ dailyCostUsd: DEFAULT_AI_QUESTS_CONFIG.dailyBudgetUsd }));
    expect(d.kind).not.toBe('aiGenerate');
  });

  it('T6 a fresh candidate + AI on + budget ok ⇒ {aiGenerate, candidate}', () => {
    const c = candidate();
    const d = evaluateTrigger(input({ candidate: c, config: cfg({ aiGeneration: true }) }));
    expect(d.kind).toBe('aiGenerate');
    if (d.kind === 'aiGenerate') expect(d.candidate.sessionId).toBe(c.sessionId);
  });

  it('T6 no candidate but localTemplates on ⇒ {localPool}', () => {
    const d = evaluateTrigger(
      input({
        candidate: null,
        asked: true,
        config: cfg({ aiGeneration: true, localTemplates: true }),
      }),
    );
    expect(d.kind).toBe('localPool');
  });

  it('T6 no candidate and localTemplates off ⇒ {none, noCandidateNoLocal}', () => {
    const d = evaluateTrigger(
      input({
        candidate: null,
        asked: true,
        config: cfg({ aiGeneration: true, localTemplates: false }),
      }),
    );
    expect(d).toEqual({ kind: 'none', reason: 'noCandidateNoLocal' });
  });

  it('T7 aiGeneration===false ⇒ skip AI, go straight to the local branch', () => {
    const d = evaluateTrigger(
      input({ config: cfg({ aiGeneration: false, localTemplates: true }), asked: true }),
    );
    expect(d.kind).toBe('localPool'); // never aiGenerate
  });

  it('first-consent: AI off, never asked, a trigger would fire ⇒ {scriptedConsent} (§3.4 / A10)', () => {
    const d = evaluateTrigger(input({ config: cfg({ aiGeneration: false }), asked: false }));
    expect(d.kind).toBe('scriptedConsent');
  });

  it('clock rollback (now < lastAttempt) is conservative ⇒ treated as in-cooldown (§11-E10)', () => {
    const now = 100 * MIN;
    const d = evaluateTrigger(input({ nowMonotonicMs: now, lastAttemptAtMs: now + 50 * MIN }));
    expect(d).toEqual({ kind: 'none', reason: 'cooldown' });
  });

  it('local-pool mode probes AI only after the recovery interval (§10)', () => {
    const now = 1000 * MIN;
    // 10 min since the last probe (< 60) ⇒ AI path stays suppressed, local served.
    const d = evaluateTrigger(
      input({ localPoolMode: true, lastRecoveryProbeAtMs: now - 10 * MIN, nowMonotonicMs: now }),
    );
    expect(d.kind).not.toBe('aiGenerate');
  });
});

describe('implementation-landed tracker (A2)', () => {
  it('documents whether evaluateTrigger is implemented yet', () => {
    expect(typeof ready).toBe('boolean');
  });
});
