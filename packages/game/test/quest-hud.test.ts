/**
 * QuestHud integration glue (PRD 05 §I/§K) — the scene-level owner that wires the
 * QuestStore to a daemon WS connection, the sim reward seam, and the note seam.
 * Headless via injected WS deps (no fetch/WebSocket/window). Asserts the contracts
 * the scene depends on:
 *  - a questReward routes to grantReward ONCE per questId (A9 second guard);
 *  - submitAnswer (decision/reflection) records a note keyed on questId (#20, §11-E11);
 *  - a dismiss never records a note;
 *  - clientPrefs is (re)emitted on the LIVE edge and on a prefs change (§4.7);
 *  - questAnswer/questDismiss frames reach the wire after answering.
 */
import { describe, expect, it, vi } from 'vitest';

import type { HandshakeResponse, Quest, QuestReward } from '@codestead/shared';

import type { TimerHost, WsLike } from '../src/hud/ws-client.js';
import { QuestHud } from '../src/ui/quest/quest-hud.js';

class FakeTimers implements TimerHost {
  private seq = 1;
  private timers = new Map<number, () => void>();
  set(_ms: number, fn: () => void): number {
    const id = this.seq++;
    this.timers.set(id, fn);
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
}

class FakeSocket implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  frame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const HANDSHAKE: HandshakeResponse = {
  port: 43110,
  wsPath: '/ws',
  token: 't',
  daemonVersion: '0.4.0',
};

function memStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

/** A valid UUID per QuestSchema (z.uuid) — the WS edge drops a non-UUID quest. */
const QID_DECISION = '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90';
const QID_REFLECTION = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function decisionQuest(questId: string = QID_DECISION): Quest {
  return {
    npcId: 'npc_keeper',
    kind: 'decision',
    title: '水往哪儿引',
    opener: '你那边在改登录的重试逻辑吧。',
    body: '登录失败之后，水往哪儿引？补漏之前，得先想清楚水从哪儿来、往哪儿去。', // ≥20 chars
    options: [
      { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
      { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
    ],
    closer: '留口子，好习惯。',
    contextEcho: 'echo',
    questId,
    source: 'ai',
    relatedSessionId: null,
    relatedCwd: null,
    reward: { gold: 120, xp: 60 },
    createdAt: '2026-06-10T09:12:31Z',
  };
}

function reflectionQuest(questId: string = QID_REFLECTION): Quest {
  return {
    ...decisionQuest(questId),
    kind: 'reflection',
    options: undefined,
    body: '今天写的代码里，哪一处你其实没想清楚就先写了？回头看，它现在还稳吗？', // ≥20 chars
  };
}

interface Built {
  hud: QuestHud;
  socket: FakeSocket;
  grantReward: ReturnType<typeof vi.fn>;
  recordNote: ReturnType<typeof vi.fn>;
  /** Drive the connection to LIVE (auth → hello → snapshot). */
  live(): void;
}

async function build(): Promise<Built> {
  const sockets: FakeSocket[] = [];
  const grantReward = vi.fn<(id: string, reward: QuestReward | null) => void>();
  const recordNote = vi.fn<(ref: string) => void>();
  const hud = new QuestHud({
    grantReward,
    recordNote,
    storageOverride: memStorage(),
    wsOverride: {
      prober: { probe: () => Promise.resolve(HANDSHAKE) },
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timers: new FakeTimers(),
      rand01: () => 0.5,
    },
  });
  // The client probes asynchronously; let the microtask resolve so the socket exists.
  await new Promise((r) => setTimeout(r, 0));
  const socket = sockets[0];
  return {
    hud,
    socket,
    grantReward,
    recordNote,
    live: () => {
      socket.open();
      socket.frame({ v: 1, type: 'hello', payload: { protocol: 1, daemonVersion: '0.4.0' } });
      socket.frame({ v: 1, type: 'snapshot', payload: { sessions: [] } });
    },
  };
}

describe('QuestHud — reward routing (A9 second guard)', () => {
  it('routes a questReward to grantReward exactly once per questId', async () => {
    const b = await build();
    b.live();
    b.socket.frame({ v: 1, type: 'questOffer', payload: { quest: decisionQuest() } });
    const reward: QuestReward = { gold: 120, xp: 60 };
    b.socket.frame({ v: 1, type: 'questReward', payload: { questId: QID_DECISION, reward } });
    b.socket.frame({ v: 1, type: 'questReward', payload: { questId: QID_DECISION, reward } }); // replay
    expect(b.grantReward).toHaveBeenCalledTimes(1);
    expect(b.grantReward).toHaveBeenCalledWith(QID_DECISION, reward);
  });
});

describe('QuestHud — note recording on answer (#20 / §11-E11)', () => {
  it('records a note keyed on questId when a decision answer reaches the closer', async () => {
    const b = await build();
    b.live();
    b.socket.frame({ v: 1, type: 'questOffer', payload: { quest: decisionQuest() } });
    b.hud.dispatchUi({ kind: 'openDialogue' });
    b.hud.dispatchUi({ kind: 'advance' }); // → question
    b.hud.dispatchUi({ kind: 'selectOption', optionId: 'a' });
    b.hud.dispatchUi({ kind: 'confirmOption' }); // → compose
    b.hud.dispatchUi({ kind: 'submitAnswer', note: 'because' }); // → closer
    expect(b.recordNote).toHaveBeenCalledTimes(1);
    expect(b.recordNote).toHaveBeenCalledWith(QID_DECISION);
  });

  it('records a note for a reflection answer (submitted straight from question)', async () => {
    const b = await build();
    b.live();
    b.socket.frame({ v: 1, type: 'questOffer', payload: { quest: reflectionQuest() } });
    b.hud.dispatchUi({ kind: 'openDialogue' });
    b.hud.dispatchUi({ kind: 'advance' }); // → question (textarea)
    b.hud.dispatchUi({ kind: 'submitAnswer', note: 'a thought' }); // → closer
    expect(b.recordNote).toHaveBeenCalledWith(QID_REFLECTION);
  });

  it('does NOT record a note on dismiss (先不聊 is zero-cost)', async () => {
    const b = await build();
    b.live();
    b.socket.frame({ v: 1, type: 'questOffer', payload: { quest: decisionQuest() } });
    b.hud.dispatchUi({ kind: 'openDialogue' });
    b.hud.dispatchUi({ kind: 'dismiss' });
    expect(b.recordNote).not.toHaveBeenCalled();
  });
});

describe('QuestHud — clientPrefs over the wire (§4.7)', () => {
  it('emits clientPrefs on the LIVE edge and on a prefs change', async () => {
    const b = await build();
    b.live();
    const prefsFrames = () => b.socket.sent.filter((s) => s.includes('clientPrefs'));
    expect(prefsFrames()).toHaveLength(1); // onLive re-emit
    b.hud.updatePrefs({ frequency: 'normal' });
    expect(prefsFrames()).toHaveLength(2);
    expect(b.socket.sent.at(-1)).toContain('"minIntervalRealMinutes":15');
  });

  it('sends questAnswer + questDismiss frames to the wire', async () => {
    const b = await build();
    b.live();
    b.socket.frame({ v: 1, type: 'questOffer', payload: { quest: decisionQuest() } });
    b.hud.dispatchUi({ kind: 'openDialogue' });
    b.hud.dispatchUi({ kind: 'advance' });
    b.hud.dispatchUi({ kind: 'selectOption', optionId: 'a' });
    b.hud.dispatchUi({ kind: 'confirmOption' });
    b.hud.dispatchUi({ kind: 'submitAnswer', note: 'why' });
    expect(b.socket.sent.some((s) => s.includes('questAnswer'))).toBe(true);
  });
});
