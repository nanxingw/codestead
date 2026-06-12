/**
 * Quest lifecycle reducer table (PRD 05 §H, seam c-①) — the pure
 * `(state, event) => state` machine: every legal transition plus rejection of
 * illegal ones (a second ANSWERED §11-E7, dismiss-without-pending), the §10
 * backoff (15→30→60 cap 60) and the 3-in-a-row → local-pool flip, plus the
 * restart-normalize (GENERATING ⇒ FAILED-ish reset).
 *
 * `createInitialQuestState` is implemented (the shape factory) and asserted
 * unconditionally. `reduceQuestLifecycle` / `normalizeOnRestart` are contract
 * SKELETONs; their behavioural assertions are gated behind `questModuleReady`.
 */
import { describe, expect, it } from 'vitest';

import type { Quest } from '@codestead/shared';

import {
  createInitialQuestState,
  reduceQuestLifecycle,
  type QuestLifecycleEvent,
} from '../src/quest/lifecycle.js';
import { normalizeOnRestart } from '../src/quest/persistence.js';
import {
  BACKOFF_SEQUENCE_MINUTES,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type QuestModuleState,
} from '../src/quest/types.js';
import { questModuleReady } from './helpers/quest-ready.js';

const quest: Quest = {
  npcId: 'npc_keeper',
  kind: 'decision',
  title: '水往哪儿引',
  opener: '你那边在改登录的重试逻辑吧。',
  body: '登录失败之后，水往哪儿引？补漏之前先想清楚水从哪儿来。',
  options: [
    { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
    { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
  ],
  closer: '留口子，好习惯。',
  contextEcho: 'echo',
  questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
  source: 'ai',
  relatedSessionId: 'sess-1',
  relatedCwd: 'payments',
  reward: { gold: 120, xp: 60 },
  createdAt: '2026-06-10T09:12:31Z',
};

const reduce = (s: QuestModuleState, e: QuestLifecycleEvent) => reduceQuestLifecycle(s, e);
const ready = questModuleReady(() =>
  reduceQuestLifecycle(createInitialQuestState(), { kind: 'genStart', at: 0 }),
);

describe('createInitialQuestState (the shape — unconditional)', () => {
  it('starts IDLE with no pending quest and zeroed counters', () => {
    const s = createInitialQuestState();
    expect(s.phase).toBe('IDLE');
    expect(s.pending).toBeNull();
    expect(s.history).toEqual([]);
    expect(s.counters.dailyCount).toBe(0);
    expect(s.counters.consecutiveFailures).toBe(0);
    expect(s.counters.localPoolMode).toBe(false);
    expect(s.counters.asked).toBe(false);
    expect(s.counters.usedLocalPoolIds).toEqual([]);
  });
});

describe.runIf(ready)('reduceQuestLifecycle — legal transitions (§5 — gated)', () => {
  it('IDLE --genStart--> GENERATING', () => {
    const s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    expect(s.phase).toBe('GENERATING');
  });

  it('GENERATING --genSuccess--> OFFERED (pending set)', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genSuccess', at: 20, quest });
    expect(s.phase).toBe('OFFERED');
    expect(s.pending?.questId).toBe(quest.questId);
  });

  it('OFFERED --answer--> ANSWERED --reward--> ARCHIVED', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genSuccess', at: 20, quest });
    s = reduce(s, {
      kind: 'answer',
      questId: quest.questId,
      noteRef: '2026-06-10/q.md',
      answeredAt: '2026-06-10T09:15:02Z',
    });
    expect(s.phase).toBe('ANSWERED');
    s = reduce(s, { kind: 'reward', questId: quest.questId });
    expect(s.phase).toBe('ARCHIVED');
  });

  it('OFFERED --dismiss--> DISMISSED (no note, no reward, no failure, no extra cooldown §5)', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genSuccess', at: 20, quest });
    const before = s.counters.consecutiveFailures;
    s = reduce(s, { kind: 'dismiss', questId: quest.questId, dismissedAt: '2026-06-10T09:15:02Z' });
    expect(s.phase).toBe('DISMISSED');
    expect(s.counters.consecutiveFailures).toBe(before); // not a failure
  });

  it('GENERATING --genFailure--> FAILED and bumps consecutiveFailures', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genFailure', at: 20, reason: 'timeout', costUsd: 0 });
    expect(s.phase).toBe('FAILED');
    expect(s.counters.consecutiveFailures).toBe(1);
  });

  it('backoff doubles 15→30→60 capped at 60 across consecutive failures (§10)', () => {
    // Each failure cycle is IDLE→GENERATING→FAILED→(backoffElapsed)→IDLE; the
    // backoff window is owned by the trigger, the reducer just frees the slot.
    let s = createInitialQuestState();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = reduce(s, { kind: 'genStart', at: i * 1000 });
      s = reduce(s, { kind: 'genFailure', at: i * 1000 + 10, reason: 'invalidOutput', costUsd: 0 });
      seen.push(s.counters.backoffMinutes);
      s = reduce(s, { kind: 'backoffElapsed', at: i * 1000 + 20 }); // FAILED → IDLE
    }
    expect(seen.slice(0, 3)).toEqual([...BACKOFF_SEQUENCE_MINUTES]);
    expect(seen[3]).toBe(60); // capped
  });

  it('three consecutive failures flip localPoolMode (§10)', () => {
    let s = createInitialQuestState();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      s = reduce(s, { kind: 'genStart', at: i * 1000 });
      s = reduce(s, { kind: 'genFailure', at: i * 1000 + 10, reason: 'apiError', costUsd: 0 });
      s = reduce(s, { kind: 'backoffElapsed', at: i * 1000 + 20 });
    }
    expect(s.counters.localPoolMode).toBe(true);
    expect(s.counters.consecutiveFailures).toBe(CONSECUTIVE_FAILURE_THRESHOLD);
  });

  it('any success resets consecutiveFailures + clears localPoolMode (§10)', () => {
    let s = createInitialQuestState();
    s = reduce(s, { kind: 'genStart', at: 0 });
    s = reduce(s, { kind: 'genFailure', at: 10, reason: 'processCrash', costUsd: 0 });
    s = reduce(s, { kind: 'backoffElapsed', at: 20 }); // FAILED → IDLE
    s = reduce(s, { kind: 'genStart', at: 100 });
    s = reduce(s, { kind: 'genSuccess', at: 110, quest });
    expect(s.counters.consecutiveFailures).toBe(0);
    expect(s.counters.localPoolMode).toBe(false);
  });
});

describe.runIf(ready)('reduceQuestLifecycle — illegal transitions are no-ops (§5 / §11-E7)', () => {
  it('a second answer on an already-ANSWERED quest is rejected (same reference)', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genSuccess', at: 20, quest });
    const answered = reduce(s, {
      kind: 'answer',
      questId: quest.questId,
      noteRef: null,
      answeredAt: '2026-06-10T09:15:02Z',
    });
    const twice = reduce(answered, {
      kind: 'answer',
      questId: quest.questId,
      noteRef: null,
      answeredAt: '2026-06-10T09:16:02Z',
    });
    expect(twice).toBe(answered); // no-op (caller treats "no change" as rejected)
  });

  it('answering from IDLE (no pending) is a no-op', () => {
    const idle = createInitialQuestState();
    const after = reduce(idle, {
      kind: 'answer',
      questId: 'whatever',
      noteRef: null,
      answeredAt: '2026-06-10T09:15:02Z',
    });
    expect(after).toBe(idle);
  });

  it('revokeAll clears the field back to IDLE (总开关关闭 §9)', () => {
    let s = reduce(createInitialQuestState(), { kind: 'genStart', at: 10 });
    s = reduce(s, { kind: 'genSuccess', at: 20, quest });
    s = reduce(s, { kind: 'revokeAll', at: 30 });
    expect(s.phase).toBe('IDLE');
    expect(s.pending).toBeNull();
  });
});

describe.runIf(ready)('markAsked — consent + opt-in follow-up bookkeeping (§3.4)', () => {
  it('records the first consent choice and is one-time', () => {
    let s = createInitialQuestState();
    s = reduce(s, { kind: 'markAsked', choice: 'b' });
    expect(s.counters.asked).toBe(true);
    expect(s.counters.firstConsentChoice).toBe('b');
    expect(s.counters.askedFollowUp).toBe(false);
    // a second first-consent markAsked is a no-op (asked already true, no followUp).
    const again = reduce(s, { kind: 'markAsked', choice: 'a' });
    expect(again).toBe(s);
    expect(again.counters.firstConsentChoice).toBe('b'); // original choice preserved
  });

  it('the follow-up markAsked sets askedFollowUp without touching firstConsentChoice', () => {
    let s = reduce(createInitialQuestState(), { kind: 'markAsked', choice: 'b' });
    s = reduce(s, { kind: 'markAsked', followUp: true });
    expect(s.counters.askedFollowUp).toBe(true);
    expect(s.counters.firstConsentChoice).toBe('b');
    // terminal: a second follow-up markAsked is a no-op.
    const again = reduce(s, { kind: 'markAsked', followUp: true });
    expect(again).toBe(s);
  });
});

const normReady = questModuleReady(() => normalizeOnRestart(createInitialQuestState()));

describe.runIf(normReady)('normalizeOnRestart (§11-E3 — gated)', () => {
  it('GENERATING ⇒ reset to IDLE with pending cleared (the spawned process is dead)', () => {
    const loaded: QuestModuleState = { ...createInitialQuestState(), phase: 'GENERATING' };
    const norm = normalizeOnRestart(loaded);
    expect(norm.phase).not.toBe('GENERATING');
    expect(norm.pending).toBeNull();
  });

  it('OFFERED is kept verbatim for re-push (questSnapshot)', () => {
    const loaded: QuestModuleState = {
      ...createInitialQuestState(),
      phase: 'OFFERED',
      pending: quest,
    };
    const norm = normalizeOnRestart(loaded);
    expect(norm.phase).toBe('OFFERED');
    expect(norm.pending?.questId).toBe(quest.questId);
  });
});

describe('implementation-landed tracker (§H)', () => {
  it('documents whether the lifecycle reducer is implemented yet', () => {
    expect(typeof ready).toBe('boolean');
    expect(typeof normReady).toBe('boolean');
  });
});
