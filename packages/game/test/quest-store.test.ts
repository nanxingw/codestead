/**
 * quest-store.test.ts (PRD 05 §D/§I) — the pure game-side quest reducers:
 * offer lifecycle, four-屏 answer flow, prefs merge. Asserts external behaviour
 * only (state transitions), per the M4 testing discipline.
 *
 * Two red lines pinned here:
 *  - A4 zero-disturbance (§3.5): an offer ONLY sets `pending` — screen stays
 *    'none' (no pause/camera/panel surrogate); the store carries no time/UI state
 *    by construction, so the assertion is "offer in ⇒ screen unchanged".
 *  - global ≤1 (T2): a second offer never displaces a pending quest.
 */
import { describe, expect, it } from 'vitest';

import type { Quest, QuestReward, ServerMessage } from '@codestead/shared';

import {
  applyQuestPrefs,
  applyQuestServerMessage,
  applyQuestUiEvent,
  createInitialQuestState,
  DEFAULT_QUEST_PREFS,
  frequencyToInterval,
  type QuestState,
} from '../src/quest/quest-store.js';

// ---- fixtures ----

function decisionQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    npcId: 'npc_keeper',
    kind: 'decision',
    title: '水往哪儿引',
    opener: '你那边在改登录的重试逻辑吧。',
    body: '登录失败之后，水往哪儿引？补漏之前，得先想清楚水从哪儿来。',
    options: [
      { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
      { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
    ],
    closer: '留口子，好习惯。',
    contextEcho: '正在为登录服务设计失败重试策略',
    questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
    source: 'ai',
    relatedSessionId: 'sess-1',
    relatedCwd: 'payments',
    reward: { gold: 120, xp: 60 },
    createdAt: '2026-06-10T09:12:31Z',
    ...overrides,
  };
}

function reflectionQuest(overrides: Partial<Quest> = {}): Quest {
  return decisionQuest({
    questId: 'a1b2c3d4-0000-4000-8000-000000000001',
    kind: 'reflection',
    options: undefined,
    body: '你现在手头这件事，最初要解决的问题是什么？现在还在解决它吗？',
    ...overrides,
  });
}

const offer = (quest: Quest): ServerMessage => ({ v: 1, type: 'questOffer', payload: { quest } });
const snapshot = (quests: Quest[]): ServerMessage => ({
  v: 1,
  type: 'questSnapshot',
  payload: { quests },
});
const revoked = (questId: string): ServerMessage => ({
  v: 1,
  type: 'questRevoked',
  payload: { questId },
});
const rewardMsg = (questId: string, reward: QuestReward): ServerMessage => ({
  v: 1,
  type: 'questReward',
  payload: { questId, reward },
});

/** Walk a decision quest to a given screen via UI events. */
function atScreen(quest: Quest, target: QuestState['screen']): QuestState {
  let s = applyQuestServerMessage(createInitialQuestState(), offer(quest));
  if (target === 'none') return s;
  s = applyQuestUiEvent(s, { kind: 'openDialogue' }); // opener
  if (target === 'opener') return s;
  s = applyQuestUiEvent(s, { kind: 'advance' }); // question
  if (target === 'question') return s;
  s = applyQuestUiEvent(s, { kind: 'selectOption', optionId: 'a' });
  s = applyQuestUiEvent(s, { kind: 'confirmOption' }); // compose
  if (target === 'compose') return s;
  s = applyQuestUiEvent(s, { kind: 'submitAnswer', note: 'x' }); // closer
  return s;
}

describe('applyQuestServerMessage — offer lifecycle (§4.7)', () => {
  it('offer sets pending WITHOUT advancing the screen (A4 zero-disturbance §3.5)', () => {
    const q = decisionQuest();
    const s = applyQuestServerMessage(createInitialQuestState(), offer(q));
    expect(s.pending).toEqual(q);
    expect(s.screen).toBe('none'); // world bubble only — no pause/camera/panel surrogate
    expect(s.selectedOption).toBeNull();
  });

  it('a second offer never displaces the pending quest (global ≤1, T2)', () => {
    const first = decisionQuest();
    const second = decisionQuest({ questId: '00000000-0000-4000-8000-000000000002' });
    let s = applyQuestServerMessage(createInitialQuestState(), offer(first));
    s = applyQuestServerMessage(s, offer(second));
    expect(s.pending?.questId).toBe(first.questId);
  });

  it('drops an offer locally when prefs.enabled is false (daemon-不识别 fallback §4.7)', () => {
    const disabled = createInitialQuestState({ enabled: false, frequency: 'low' });
    const s = applyQuestServerMessage(disabled, offer(decisionQuest()));
    expect(s.pending).toBeNull();
    expect(s).toBe(disabled); // SAME reference — no change
  });

  it('snapshot with 0 quests clears any pending and resets the dialogue', () => {
    const open = atScreen(decisionQuest(), 'question');
    const s = applyQuestServerMessage(open, snapshot([]));
    expect(s.pending).toBeNull();
    expect(s.screen).toBe('none');
  });

  it('snapshot with 1 quest restores pending (reconnect, §11-E3)', () => {
    const q = decisionQuest();
    const s = applyQuestServerMessage(createInitialQuestState(), snapshot([q]));
    expect(s.pending).toEqual(q);
    expect(s.screen).toBe('none');
  });

  it('snapshot of the SAME pending quest keeps dialogue progress', () => {
    const q = decisionQuest();
    const open = atScreen(q, 'question');
    const s = applyQuestServerMessage(open, snapshot([q]));
    expect(s.screen).toBe('question'); // unchanged
    expect(s).toBe(open);
  });

  it('revoked clears the matching pending and closes any open dialogue (§3.5)', () => {
    const q = decisionQuest();
    const open = atScreen(q, 'compose');
    const s = applyQuestServerMessage(open, revoked(q.questId));
    expect(s.pending).toBeNull();
    expect(s.screen).toBe('none');
  });

  it('revoked for a non-pending questId is a no-op', () => {
    const q = decisionQuest();
    const s0 = applyQuestServerMessage(createInitialQuestState(), offer(q));
    const s = applyQuestServerMessage(s0, revoked('other-id'));
    expect(s).toBe(s0);
  });

  it('reward stashes pendingReward for the closer屏 (grant is sim-side)', () => {
    const q = decisionQuest();
    const s0 = applyQuestServerMessage(createInitialQuestState(), offer(q));
    const s = applyQuestServerMessage(s0, rewardMsg(q.questId, { gold: 120, xp: 60 }));
    expect(s.pendingReward).toEqual({ gold: 120, xp: 60 });
  });

  it('ignores non-quest frames (HUD concern, §13) returning the SAME reference', () => {
    const s0 = createInitialQuestState();
    const heartbeat: ServerMessage = {
      v: 1,
      type: 'heartbeat',
      payload: { at: '2026-06-10T09:12:31Z' },
    };
    expect(applyQuestServerMessage(s0, heartbeat)).toBe(s0);
  });
});

describe('applyQuestUiEvent — four-屏 answer flow (§6.2)', () => {
  it('dialogue never opens when pending is null', () => {
    const s0 = createInitialQuestState();
    expect(applyQuestUiEvent(s0, { kind: 'openDialogue' })).toBe(s0);
  });

  it('decision: opener → question → (select+confirm) → compose → closer', () => {
    const q = decisionQuest();
    let s = applyQuestServerMessage(createInitialQuestState(), offer(q));
    s = applyQuestUiEvent(s, { kind: 'openDialogue' });
    expect(s.screen).toBe('opener');
    s = applyQuestUiEvent(s, { kind: 'advance' });
    expect(s.screen).toBe('question');
    s = applyQuestUiEvent(s, { kind: 'selectOption', optionId: 'b' });
    expect(s.selectedOption).toBe('b');
    s = applyQuestUiEvent(s, { kind: 'confirmOption' });
    expect(s.screen).toBe('compose');
    s = applyQuestUiEvent(s, { kind: 'submitAnswer', note: 'because' });
    expect(s.screen).toBe('closer');
  });

  it('decision: confirmOption requires a selected option', () => {
    const s = atScreen(decisionQuest(), 'question');
    expect(applyQuestUiEvent(s, { kind: 'confirmOption' })).toBe(s); // no selection yet
  });

  it('reflection: question → submitAnswer goes straight to closer (skips compose)', () => {
    const q = reflectionQuest();
    let s = applyQuestServerMessage(createInitialQuestState(), offer(q));
    s = applyQuestUiEvent(s, { kind: 'openDialogue' });
    s = applyQuestUiEvent(s, { kind: 'advance' });
    expect(s.screen).toBe('question');
    s = applyQuestUiEvent(s, { kind: 'submitAnswer', note: '我的回答' });
    expect(s.screen).toBe('closer');
  });

  it('reflection: empty note submit is rejected (提交需非空 §2.2)', () => {
    const q = reflectionQuest();
    let s = applyQuestServerMessage(createInitialQuestState(), offer(q));
    s = applyQuestUiEvent(s, { kind: 'openDialogue' });
    s = applyQuestUiEvent(s, { kind: 'advance' });
    expect(applyQuestUiEvent(s, { kind: 'submitAnswer', note: '   ' })).toBe(s);
    expect(applyQuestUiEvent(s, { kind: 'submitAnswer' })).toBe(s);
  });

  it('dismiss from any answer screen returns to the world bubble (zero-cost §2.1)', () => {
    for (const screen of ['opener', 'question', 'compose'] as const) {
      const s = atScreen(decisionQuest(), screen);
      const after = applyQuestUiEvent(s, { kind: 'dismiss' });
      expect(after.screen).toBe('none');
      expect(after.selectedOption).toBeNull();
    }
  });

  it('dismiss is a no-op on the closer屏 (already answered)', () => {
    const s = atScreen(decisionQuest(), 'closer');
    expect(applyQuestUiEvent(s, { kind: 'dismiss' })).toBe(s);
  });

  it('closeDialogue only fires from the closer屏', () => {
    const closed = applyQuestUiEvent(atScreen(decisionQuest(), 'closer'), {
      kind: 'closeDialogue',
    });
    expect(closed.screen).toBe('none');
    const onQuestion = atScreen(decisionQuest(), 'question');
    expect(applyQuestUiEvent(onQuestion, { kind: 'closeDialogue' })).toBe(onQuestion);
  });
});

describe('applyQuestPrefs — local prefs merge (§6.4 / GDD §10.7)', () => {
  it('factory defaults to enabled + low档 (附录 A-23)', () => {
    expect(DEFAULT_QUEST_PREFS).toEqual({ enabled: true, frequency: 'low' });
    expect(frequencyToInterval(DEFAULT_QUEST_PREFS.frequency)).toBe(30);
  });

  it('changing frequency updates prefs', () => {
    const s = applyQuestPrefs(createInitialQuestState(), { frequency: 'normal' });
    expect(s.prefs.frequency).toBe('normal');
  });

  it('no-op patch returns the SAME reference', () => {
    const s0 = createInitialQuestState();
    expect(applyQuestPrefs(s0, { enabled: true, frequency: 'low' })).toBe(s0);
  });

  it('disabling the master switch drops a pending offer locally (§4.7)', () => {
    const withPending = applyQuestServerMessage(createInitialQuestState(), offer(decisionQuest()));
    const s = applyQuestPrefs(withPending, { enabled: false });
    expect(s.prefs.enabled).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.screen).toBe('none');
  });
});
