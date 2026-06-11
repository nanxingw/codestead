/**
 * WsClient behavior tests (PRD 03 testing decision 4) — injected prober,
 * sockets and timers; zero network, zero sleeping. Mirrors the contract in
 * src/hud/ws-client.ts file header.
 */
import { describe, expect, it } from 'vitest';

import type { HandshakeResponse } from '@codestead/shared';

import { INCOMPATIBLE_RETRY_MS } from '../../src/hud/store.js';
import type { ConnectionEvent } from '../../src/hud/types.js';
import {
  createFetchHandshakeProber,
  createWsClient,
  type TimerHost,
  type WsClientDeps,
  type WsLike,
} from '../../src/hud/ws-client.js';

class FakeTimers implements TimerHost {
  now = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  set(ms: number, fn: () => void): number {
    const id = this.seq;
    this.seq += 1;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(id: number): void {
    this.timers.delete(id);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }

  pending(): number {
    return this.timers.size;
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
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }
}

const HANDSHAKE: HandshakeResponse = {
  port: 43112,
  wsPath: '/ws',
  token: 'tok-123',
  daemonVersion: '0.2.0',
};

interface Harness {
  timers: FakeTimers;
  sockets: FakeSocket[];
  events: ConnectionEvent[];
  messages: { type: string }[];
  probes: number;
  client: ReturnType<typeof createWsClient>;
  flush: () => Promise<void>;
}

function harness(
  over: Partial<WsClientDeps> & { handshake?: HandshakeResponse | null } = {},
): Harness {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const events: ConnectionEvent[] = [];
  const messages: { type: string }[] = [];
  const h: Harness = {
    timers,
    sockets,
    events,
    messages,
    probes: 0,
    client: undefined as unknown as ReturnType<typeof createWsClient>,
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  h.client = createWsClient({
    prober: {
      probe: () => {
        h.probes += 1;
        return Promise.resolve(over.handshake === undefined ? HANDSHAKE : over.handshake);
      },
    },
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers,
    rand01: () => 0.5, // neutral jitter
    now: () => timers.now,
    dispatch: (event) => events.push(event),
    onServerMessage: (message) => messages.push(message),
    ...('prober' in over ? { prober: over.prober! } : {}),
  });
  return h;
}

const hello = { v: 1, type: 'hello', payload: { protocol: 1, daemonVersion: '0.2.0' } };
const snapshot = { v: 1, type: 'snapshot', payload: { sessions: [] } };
const heartbeat = { v: 1, type: 'heartbeat', payload: { at: '2026-06-11T08:00:00+08:00' } };

describe('createWsClient — discovery, auth, parsing', () => {
  it('connects to the handshake port/path and sends auth{token} as the FIRST frame', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe('ws://127.0.0.1:43112/ws');
    h.sockets[0].open();
    expect(h.events).toEqual([{ kind: 'wsOpen' }]);
    expect(h.sockets[0].sent[0]).toBe(
      JSON.stringify({ v: 1, type: 'auth', payload: { token: 'tok-123' } }),
    );
  });

  it('falls back to direct 43110/ws with an empty token when no handshake answers (§10.3)', async () => {
    const h = harness({ handshake: null });
    h.client.start();
    await h.flush();
    expect(h.sockets[0].url).toBe('ws://127.0.0.1:43110/ws');
    h.sockets[0].open();
    expect(h.sockets[0].sent[0]).toBe(
      JSON.stringify({ v: 1, type: 'auth', payload: { token: '' } }),
    );
  });

  it('forwards validated frames and drops malformed ones silently', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.frame('not json {');
    ws.frame({ v: 1, type: 'mystery', payload: {} });
    ws.frame(hello);
    ws.frame(snapshot);
    expect(h.messages.map((m) => m.type)).toEqual(['hello', 'snapshot']);
    // malformed frames produced no connection edges either
    expect(h.events).toEqual([{ kind: 'wsOpen' }]);
  });

  it('hello with a mismatched protocol dispatches protoMismatch and retries after 5min', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.frame({ v: 2, type: 'hello', payload: { protocol: 2, daemonVersion: '9.9.9' } });
    expect(h.events).toEqual([{ kind: 'wsOpen' }, { kind: 'protoMismatch', daemonProtocol: 2 }]);
    expect(ws.closed).toBe(true);
    // slow retry: nothing before 5min, reconnect cycle after
    h.timers.advance(INCOMPATIBLE_RETRY_MS - 1);
    expect(h.events).toHaveLength(2);
    h.timers.advance(1);
    await h.flush();
    expect(h.events.at(-1)).toEqual({ kind: 'retryTimer' });
    expect(h.sockets).toHaveLength(2);
  });
});

describe('createWsClient — watchdogs & reconnect', () => {
  it('connectTimeout fires after 10s without reaching snapshot, then backs off', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    h.sockets[0].open(); // open but the daemon never finishes the handshake
    h.timers.advance(10_000);
    expect(h.events).toEqual([{ kind: 'wsOpen' }, { kind: 'connectTimeout' }]);
    // first failure → 1s neutral-jitter retry
    h.timers.advance(1_000);
    await h.flush();
    expect(h.events.at(-1)).toEqual({ kind: 'retryTimer' });
    expect(h.sockets).toHaveLength(2);
  });

  it('snapshot clears the connect timer (no spurious timeout once LIVE)', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.frame(hello);
    ws.frame(snapshot);
    h.timers.advance(10_000);
    expect(h.events).toEqual([{ kind: 'wsOpen' }]); // no connectTimeout
  });

  it('arms the 75s STALE watchdog only after the first heartbeat (graceful fallback §10.3)', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.frame(hello);
    ws.frame(snapshot);
    // no heartbeat seen yet ⇒ silence never goes STALE
    h.timers.advance(80_000);
    expect(h.events.some((e) => e.kind === 'heartbeatTimeout')).toBe(false);
    ws.frame(heartbeat);
    // any message resets the deadline…
    h.timers.advance(60_000);
    ws.frame(heartbeat);
    h.timers.advance(74_999);
    expect(h.events.some((e) => e.kind === 'heartbeatTimeout')).toBe(false);
    // …75s of full silence trips it (socket stays open)
    h.timers.advance(1);
    expect(h.events.at(-1)).toEqual({ kind: 'heartbeatTimeout' });
    expect(ws.closed).toBe(false);
  });

  it('close after LIVE restarts the ladder at 1s; repeated failures climb 1s→2s→4s', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.frame(hello);
    ws.frame(snapshot);
    ws.onclose?.(); // daemon killed after LIVE
    expect(h.events.at(-1)).toEqual({ kind: 'wsClose' });
    h.timers.advance(1_000); // failure #1 → 1s
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].onerror?.(); // failure #2
    h.timers.advance(1_999);
    await h.flush();
    expect(h.sockets).toHaveLength(2); // 2s not yet elapsed
    h.timers.advance(1);
    await h.flush();
    expect(h.sockets).toHaveLength(3);
    h.sockets[2].onclose?.(); // failure #3 → 4s
    h.timers.advance(4_000);
    await h.flush();
    expect(h.sockets).toHaveLength(4);
  });

  it('onerror followed by onclose on the same socket counts ONE failure', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    ws.onerror?.();
    ws.onclose?.();
    const failureEdges = h.events.filter((e) => e.kind === 'wsError' || e.kind === 'wsClose');
    expect(failureEdges).toHaveLength(1);
    expect(h.timers.pending()).toBe(1); // exactly one retry timer
  });

  it('stop() tears down socket and timers without further dispatches', async () => {
    const h = harness();
    h.client.start();
    await h.flush();
    const ws = h.sockets[0];
    ws.open();
    h.client.stop();
    expect(ws.closed).toBe(true);
    expect(h.timers.pending()).toBe(0);
    const before = h.events.length;
    h.timers.advance(120_000);
    await h.flush();
    expect(h.events.length).toBe(before);
    expect(h.sockets).toHaveLength(1);
  });
});

describe('createFetchHandshakeProber — sequential 43110–43119 (§10.3 P2)', () => {
  it('returns the first port whose handshake parses; misses are silent', async () => {
    const calls: string[] = [];
    const prober = createFetchHandshakeProber((url) => {
      calls.push(url);
      if (url.includes('43110')) return Promise.reject(new Error('refused'));
      if (url.includes('43111')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: true }) });
      }
      if (url.includes('43112')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(HANDSHAKE) });
      }
      return Promise.reject(new Error('unreachable'));
    });
    const result = await prober.probe();
    expect(result).toEqual(HANDSHAKE);
    expect(calls).toEqual([
      'http://127.0.0.1:43110/handshake',
      'http://127.0.0.1:43111/handshake',
      'http://127.0.0.1:43112/handshake',
    ]);
  });

  it('resolves null when no port answers (silent — everConnected gate §8.2)', async () => {
    const prober = createFetchHandshakeProber(() => Promise.reject(new Error('refused')));
    await expect(prober.probe()).resolves.toBeNull();
  });
});
