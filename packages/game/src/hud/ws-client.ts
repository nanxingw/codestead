/**
 * WsClient — browser-side daemon connection (discovery, auth, reconnect,
 * heartbeat watchdog). Per PRD 03 impl. decision 1 this is “native WebSocket
 * + hand-rolled exponential backoff”; pure types + injected dependencies — no
 * Phaser, no sim, no globals (the render shell supplies real fetch/WebSocket/
 * timers via createBrowserWsDeps-style wiring in ui/hud/session-hud.ts).
 *
 * Behavior contract:
 * - DISCOVERY: GET /handshake over DAEMON_PROBE_PORTS (43110–43119) in order
 *   (shared/endpoint.ts); a probe miss is silent (everConnected gate, §8.2).
 *   Graceful fallback while the daemon-side handshake is not yet shipped:
 *   direct-connect to 43110 (§10.3); no heartbeat seen ⇒ never enter STALE.
 * - CONNECT: open `ws://127.0.0.1:<port><wsPath>`, send `auth { token }` as
 *   the FIRST frame, then expect `hello` → `snapshot`.
 * - WATCHDOGS: 10s connect timeout (until snapshot ⇒ LIVE); after the first
 *   heartbeat is seen, HEARTBEAT_STALE_MS (75s) without ANY message ⇒
 *   heartbeatTimeout event. Timers are injected — tests never sleep.
 * - RECONNECT: delays from computeBackoffDelayMs; INCOMPATIBLE retries every
 *   INCOMPATIBLE_RETRY_MS. The player NEVER reconnects manually (US36).
 * - PARSING: every inbound frame goes through ServerMessageSchema.safeParse;
 *   malformed frames are dropped silently. A `hello` whose payload.protocol ≠
 *   PROTOCOL_VERSION is the ONE pre-parse special case (the strict schema
 *   would reject it): it dispatches protoMismatch (§8.1 INCOMPATIBLE).
 * - The client emits ConnectionEvents + parsed messages; ALL HUD state lives
 *   in the store reducer. (The client keeps a private consecutive-failure
 *   counter purely to compute retry delays — timer bookkeeping, not state.)
 */
import {
  DAEMON_HOST,
  DAEMON_PORT_BASE,
  DAEMON_PROBE_PORTS,
  DEFAULT_WS_PATH,
  HEARTBEAT_STALE_MS,
  HandshakeResponseSchema,
  PROTOCOL_VERSION,
  handshakeUrl,
  type ClientMessage,
  type HandshakeResponse,
  type ServerMessage,
  ServerMessageSchema,
} from '@codestead/shared';

import { CONNECT_TIMEOUT_MS, INCOMPATIBLE_RETRY_MS, computeBackoffDelayMs } from './store.js';
import type { ConnectionEvent } from './types.js';

/** Minimal WebSocket surface the client needs (native WebSocket satisfies it; tests fake it). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Injected timer facade (setTimeout/clearTimeout shaped, fake-able). */
export interface TimerHost {
  set(ms: number, fn: () => void): number;
  clear(id: number): void;
}

/** Port-probing discovery seam; the default implementation wraps fetch + HandshakeResponseSchema. */
export interface HandshakeProber {
  /** Resolve the first responding port's handshake, or null when no daemon answered. */
  probe(): Promise<HandshakeResponse | null>;
}

export interface WsClientDeps {
  readonly prober: HandshakeProber;
  readonly createSocket: (url: string) => WsLike;
  readonly timers: TimerHost;
  readonly rand01: () => number; // jitter source for the backoff ladder
  readonly now?: () => number; // message receive timestamps (defaults to Date.now)
  /** Store dispatch — connection edges (§8.1). */
  readonly dispatch: (event: ConnectionEvent) => void;
  /** Validated frames only; the client already dropped malformed ones. */
  readonly onServerMessage: (message: ServerMessage, at: number) => void;
  /**
   * M4: fired each time a connection reaches LIVE (snapshot received). The quest
   * host uses it to re-emit `clientPrefs` on every (re)connect so the daemon's
   * stricter-of merge always has the current preference (ai-quests §4.7). Optional
   * — the M2 HUD wiring omits it.
   */
  readonly onLive?: () => void;
}

export interface WsClient {
  /** Begin probing/connecting. Safe to call once per game boot. */
  start(): void;
  /** Tear down socket + timers (page hide does NOT stop it — §8.3: WS keeps running while the tab is hidden). */
  stop(): void;
  /**
   * M4: queue an outbound client frame (questAnswer / questDismiss / clientPrefs,
   * §4.7). Frames sent before the socket is LIVE are buffered and flushed once the
   * snapshot lands; frames sent while disconnected wait for the next LIVE edge.
   * `auth` is the client's own concern and must NOT be sent through here.
   */
  send(message: ClientMessage): void;
}

/** Per-port probe budget; misses must be quick AND silent (gate §8.2). */
const PROBE_TIMEOUT_MS = 1_000;

/** Narrow fetch surface so tests can fake it without DOM lib types. */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Default HandshakeProber: sequential GET /handshake over 43110–43119 (§10.3 P2). */
export function createFetchHandshakeProber(fetchFn: FetchLike): HandshakeProber {
  return {
    async probe(): Promise<HandshakeResponse | null> {
      for (const port of DAEMON_PROBE_PORTS) {
        try {
          const response = await fetchFn(handshakeUrl(port), {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (!response.ok) continue;
          const parsed = HandshakeResponseSchema.safeParse(await response.json());
          if (parsed.success) return parsed.data;
        } catch {
          // Probe misses are silent by design (no daemon installed, §8.2).
        }
      }
      return null;
    },
  };
}

export function createWsClient(deps: WsClientDeps): WsClient {
  const now = deps.now ?? (() => Date.now());
  let running = false;
  let socket: WsLike | null = null;
  let connectTimer: number | null = null;
  let retryTimer: number | null = null;
  let watchdogTimer: number | null = null;
  /** Consecutive failed attempts — mirrors the store's `attempt` for delay math only. */
  let failures = 0;
  /** Guards double-counting when onerror is followed by onclose on the same socket. */
  let settled = false;
  let sawHeartbeat = false;
  let sawSnapshot = false;
  /** Outbound client frames queued until the socket is LIVE (post-snapshot, §4.7). */
  const outbound: ClientMessage[] = [];

  function clearTimer(id: number | null): null {
    if (id !== null) deps.timers.clear(id);
    return null;
  }

  function teardownSocket(): void {
    connectTimer = clearTimer(connectTimer);
    watchdogTimer = clearTimer(watchdogTimer);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
      socket = null;
    }
  }

  function scheduleRetry(delayMs: number): void {
    if (!running) return;
    retryTimer = clearTimer(retryTimer);
    retryTimer = deps.timers.set(delayMs, () => {
      retryTimer = null;
      deps.dispatch({ kind: 'retryTimer' });
      void connectCycle();
    });
  }

  /** One failed attempt: emit the edge, count it, back off, retry. */
  function fail(edge: ConnectionEvent): void {
    if (settled) return;
    settled = true;
    teardownSocket();
    if (!running) return;
    deps.dispatch(edge);
    failures += 1;
    scheduleRetry(computeBackoffDelayMs(failures, deps.rand01()));
  }

  function armWatchdog(): void {
    if (!sawHeartbeat) return; // graceful fallback: no heartbeat ⇒ never STALE (§10.3)
    watchdogTimer = clearTimer(watchdogTimer);
    watchdogTimer = deps.timers.set(HEARTBEAT_STALE_MS, () => {
      watchdogTimer = null;
      // Keep the socket: STALE keeps data dimmed; any message returns to LIVE.
      deps.dispatch({ kind: 'heartbeatTimeout' });
    });
  }

  function handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return; // malformed frames are dropped silently
    }
    // Pre-parse special case: mismatched hello (strict schema would reject it).
    if (typeof raw === 'object' && raw !== null) {
      const frame = raw as { type?: unknown; payload?: { protocol?: unknown } };
      if (frame.type === 'hello' && frame.payload?.protocol !== PROTOCOL_VERSION) {
        settled = true;
        teardownSocket();
        deps.dispatch({
          kind: 'protoMismatch',
          daemonProtocol: typeof frame.payload?.protocol === 'number' ? frame.payload.protocol : -1,
        });
        scheduleRetry(INCOMPATIBLE_RETRY_MS); // 5min slow retry (§8.1)
        return;
      }
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.type === 'heartbeat') sawHeartbeat = true;
    if (parsed.data.type === 'snapshot') {
      sawSnapshot = true;
      failures = 0; // reaching LIVE resets the ladder (§8.1)
      connectTimer = clearTimer(connectTimer);
      // LIVE edge: flush any buffered client frames, then let the quest host
      // re-emit clientPrefs for the stricter-of merge (§4.7). Order matters only
      // in that the daemon must be authed first — which the snapshot guarantees.
      flushOutbound();
      deps.onLive?.();
    }
    deps.onServerMessage(parsed.data, now());
    armWatchdog();
  }

  /** Send all buffered client frames once the socket is LIVE (§4.7). */
  function flushOutbound(): void {
    if (socket === null || !sawSnapshot) return;
    while (outbound.length > 0) {
      const message = outbound.shift();
      if (message === undefined) break;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // Socket died mid-flush: requeue and stop; the next LIVE edge retries.
        outbound.unshift(message);
        break;
      }
    }
  }

  function openSocket(handshake: HandshakeResponse | null): void {
    settled = false;
    sawHeartbeat = false;
    sawSnapshot = false;
    const port = handshake?.port ?? DAEMON_PORT_BASE;
    const wsPath = handshake?.wsPath ?? DEFAULT_WS_PATH;
    const token = handshake?.token ?? '';
    let ws: WsLike;
    try {
      ws = deps.createSocket(`ws://${DAEMON_HOST}:${String(port)}${wsPath}`);
    } catch {
      fail({ kind: 'wsError' });
      return;
    }
    socket = ws;
    // 10s budget spans connect + handshake until snapshot ⇒ LIVE (§8.1).
    connectTimer = deps.timers.set(CONNECT_TIMEOUT_MS, () => {
      connectTimer = null;
      fail({ kind: 'connectTimeout' });
    });
    ws.onopen = () => {
      deps.dispatch({ kind: 'wsOpen' });
      // auth is ALWAYS the first frame (tech-stack §4.1-5 token check).
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } }));
    };
    ws.onmessage = (event) => handleFrame(event.data);
    ws.onerror = () => fail({ kind: 'wsError' });
    ws.onclose = () => {
      if (sawSnapshot && !settled) failures = 0; // post-LIVE drop: ladder restarts at 1s
      fail({ kind: 'wsClose' });
    };
  }

  async function connectCycle(): Promise<void> {
    if (!running) return;
    let handshake: HandshakeResponse | null;
    try {
      handshake = await deps.prober.probe();
    } catch {
      handshake = null;
    }
    if (!running) return;
    // null handshake → transitional direct-connect to 43110 (§10.3 fallback);
    // when nothing listens there the socket errors out and backs off silently.
    openSocket(handshake);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      void connectCycle();
    },
    stop(): void {
      running = false;
      retryTimer = clearTimer(retryTimer);
      settled = true;
      teardownSocket();
    },
    send(message: ClientMessage): void {
      // Buffer first, then flush — so a frame sent before LIVE is delivered on the
      // snapshot edge, and a frame sent while LIVE goes out immediately (§4.7).
      outbound.push(message);
      flushOutbound();
    },
  };
}
