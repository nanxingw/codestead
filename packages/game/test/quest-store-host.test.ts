/**
 * quest-store-host.test.ts (PRD 05 §I/§E) — the subscription host that wires the
 * pure quest reducers to localStorage + outgoing WS frames. Asserts the external
 * behaviour the WS client and panels depend on:
 *  - submitAnswer → exactly one questAnswer frame (note flows IN, §12-3);
 *  - dismiss → exactly one questDismiss frame (zero-cost, §5);
 *  - prefs change → persisted + clientPrefs re-emitted (§4.7);
 *  - enabled=false drops offers locally (the承诺 is a game-side fact, §4.7).
 */
import { describe, expect, it, vi } from 'vitest';

import type { ClientMessage, Quest, ServerMessage } from '@codestead/shared';

import { QuestStore } from '../src/quest/quest-store-host.js';
import { QUEST_PREFS_KEY } from '../src/quest/quest-prefs.js';

function memStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function decisionQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    npcId: 'npc_keeper',
    kind: 'decision',
    title: '水往哪儿引',
    opener: '你那边在改登录的重试逻辑吧。',
    body: '登录失败之后，水往哪儿引？',
    options: [
      { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
      { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
    ],
    closer: '留口子，好习惯。',
    contextEcho: 'echo',
    questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
    source: 'ai',
    relatedSessionId: null,
    relatedCwd: null,
    reward: { gold: 120, xp: 60 },
    createdAt: '2026-06-10T09:12:31Z',
    ...overrides,
  };
}

const offer = (quest: Quest): ServerMessage => ({ v: 1, type: 'questOffer', payload: { quest } });

describe('QuestStore host — outgoing frames (§4.7)', () => {
  it('submitAnswer emits ONE questAnswer with the chosen option + note', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const store = new QuestStore(memStorage(), send);
    store.applyMessage(offer(decisionQuest()));
    store.dispatchUi({ kind: 'openDialogue' });
    store.dispatchUi({ kind: 'advance' });
    store.dispatchUi({ kind: 'selectOption', optionId: 'b' });
    store.dispatchUi({ kind: 'confirmOption' });
    send.mockClear();
    store.dispatchUi({ kind: 'submitAnswer', note: '给熔断留口子' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'questAnswer',
      payload: {
        questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
        optionId: 'b',
        note: '给熔断留口子',
      },
    });
    expect(store.getState().screen).toBe('closer');
  });

  it('reflection submitAnswer emits questAnswer with note and NO optionId', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const store = new QuestStore(memStorage(), send);
    store.applyMessage(offer(decisionQuest({ kind: 'reflection', options: undefined })));
    store.dispatchUi({ kind: 'openDialogue' });
    store.dispatchUi({ kind: 'advance' });
    send.mockClear();
    store.dispatchUi({ kind: 'submitAnswer', note: '我的回答' });

    expect(send).toHaveBeenCalledTimes(1);
    const frame = send.mock.calls[0][0];
    expect(frame.type).toBe('questAnswer');
    if (frame.type === 'questAnswer') {
      expect(frame.payload.optionId).toBeUndefined();
      expect(frame.payload.note).toBe('我的回答');
    }
  });

  it('dismiss emits ONE questDismiss frame (zero-cost §5)', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const store = new QuestStore(memStorage(), send);
    store.applyMessage(offer(decisionQuest()));
    store.dispatchUi({ kind: 'openDialogue' });
    send.mockClear();
    store.dispatchUi({ kind: 'dismiss' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'questDismiss',
      payload: { questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90' },
    });
  });

  it('no-op UI events emit nothing', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const store = new QuestStore(memStorage(), send);
    send.mockClear();
    store.dispatchUi({ kind: 'openDialogue' }); // no pending ⇒ no-op
    expect(send).not.toHaveBeenCalled();
  });
});

describe('QuestStore host — prefs (§6.4 / §4.7)', () => {
  it('updatePrefs persists to localStorage and re-emits clientPrefs', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const storage = memStorage();
    const store = new QuestStore(storage, send);
    store.updatePrefs({ frequency: 'normal' });

    expect(JSON.parse(storage.map.get(QUEST_PREFS_KEY) ?? '{}')).toEqual({
      enabled: true,
      frequency: 'normal',
    });
    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'clientPrefs',
      payload: { quests: { enabled: true, minIntervalRealMinutes: 15 } },
    });
  });

  it('emitClientPrefs sends the current prefs (low档 → 30) on connect', () => {
    const send = vi.fn<(m: ClientMessage) => void>();
    const store = new QuestStore(memStorage(), send);
    store.emitClientPrefs();
    expect(send).toHaveBeenCalledWith({
      v: 1,
      type: 'clientPrefs',
      payload: { quests: { enabled: true, minIntervalRealMinutes: 30 } },
    });
  });

  it('disabling the master switch drops a pending offer locally (§4.7)', () => {
    const store = new QuestStore(memStorage());
    store.applyMessage(offer(decisionQuest()));
    expect(store.getState().pending).not.toBeNull();
    store.updatePrefs({ enabled: false });
    expect(store.getState().pending).toBeNull();
  });

  it('loads persisted prefs at construction', () => {
    const storage = memStorage();
    storage.map.set(QUEST_PREFS_KEY, JSON.stringify({ enabled: false, frequency: 'normal' }));
    const store = new QuestStore(storage);
    expect(store.getState().prefs).toEqual({ enabled: false, frequency: 'normal' });
  });

  it('subscribers fire on commit', () => {
    const store = new QuestStore(memStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyMessage(offer(decisionQuest()));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
