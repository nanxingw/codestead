/**
 * Daemon HTTP + WebSocket server — ONE port serving three contracts
 * (tech-stack §3/§4.1; hud-sessions §10):
 *
 *   POST /hooks      — hook ingestion. Response is ALWAYS an empty 2xx with no
 *                      body and no decision fields, no matter what the payload
 *                      was (listen-only, tech-stack §4.1-1).
 *   GET  /handshake  — endpoint discovery: `{ port, wsPath, token, daemonVersion }`
 *                      (HandshakeResponseSchema in @codestead/shared). CORS
 *                      allows ONLY the dev Vite origin whitelist (M5: same-origin).
 *   WS upgrade <wsPath> — protocol stream. Flow: client connects → first frame
 *                      MUST be a valid `auth { token }` within the auth window
 *                      → server replies `hello` then full `snapshot` → then
 *                      incremental `sessionUpsert`/`sessionRemoved` + `heartbeat`
 *                      every HEARTBEAT_INTERVAL_MS. Multiple clients = broadcast
 *                      (hud-sessions §11-21).
 *
 * Security tripod (tech-stack §4.1-5; hud-sessions §10.4-4) — non-negotiable:
 *   1. bind 127.0.0.1 ONLY (host is not configurable);
 *   2. Origin check on ALL THREE endpoints — /handshake CORS, WS upgrade AND
 *      POST /hooks (a browser page can fire a no-cors text/plain POST without
 *      preflight; such requests still get the mandated empty 2xx but their
 *      body is dropped — Claude Code's hook client sends no Origin and is
 *      unaffected);
 *   3. first-frame local token auth.
 * Defense-in-depth: Host header must be 127.0.0.1/localhost (DNS-rebinding
 * guard across all endpoints) and the WS server caps frames at 64KB
 * (maxPayload). There is NO error frame in the protocol: bad token / bad
 * Origin / malformed auth → close the connection (see shared/src/protocol.ts
 * note).
 *
 * Port: try `DAEMON_PORT_BASE`, on EADDRINUSE increment up to `DAEMON_PORT_MAX`,
 * then fail with a clear message (risk #13). The bound port goes into
 * daemon.json (CLI) and the handshake body (browser).
 *
 * Runtime deps: node:http + `ws` + `zod` only. All inbound frames go through
 * `ClientMessageSchema.safeParse`; outbound frames are typed `ServerMessage`.
 *
 * PRIVACY: no request body, frame payload, token or transcript-derived string
 * is ever logged. Log lines may contain counts, ports and event NAMES only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  ClientMessageSchema,
  DAEMON_HOST,
  DAEMON_PORT_BASE,
  DAEMON_PORT_MAX,
  DEFAULT_WS_PATH,
  HANDSHAKE_PATH,
  HEARTBEAT_INTERVAL_MS,
  HOOKS_PATH,
  PROTOCOL_VERSION,
  type ClientMessage,
  type HandshakeResponse,
  type ServerMessage,
  type SessionInfo,
} from '@codestead/shared';
import { WebSocketServer, type WebSocket } from 'ws';

export interface DaemonServerDeps {
  /** Local auth token (config/token.ts) returned by /handshake and required in the first WS frame. */
  readonly token: string;
  /** Reported in `hello` and /handshake. */
  readonly daemonVersion: string;
  /** Origin whitelist (dev: Vite origins, e.g. http://localhost:5173). Empty in M5 same-origin mode. */
  readonly allowedOrigins: readonly string[];
  /** Hook sink — hooks signal source's handleHookBody. Server answers empty 2xx regardless. */
  readonly onHookBody: (body: unknown, at: number) => void;
  /** Current table as wire infos, used for the post-auth snapshot. */
  readonly getSnapshot: () => SessionInfo[];
  /**
   * Post-auth client frames (M4: questAnswer / questDismiss / clientPrefs).
   * Fired only for frames that pass ClientMessageSchema.safeParse AND are not the
   * `auth` frame. The quest module is the sole consumer; omitted (M2-only boot or
   * 总开关关闭) ⇒ post-auth frames are parsed-and-dropped exactly as before. The
   * server never replies inline — quest responses go out via `broadcast`.
   */
  readonly onClientMessage?: (message: Exclude<ClientMessage, { type: 'auth' }>) => void;
  /**
   * Frames to send to a client immediately AFTER hello+snapshot (M4: the quest
   * questSnapshot for connect/reconnect recovery, §5/§11-E3). Returns 0 or more
   * frames; omitted ⇒ none. Kept separate from getSnapshot so the session HUD
   * snapshot stays untouched.
   */
  readonly getPostAuthFrames?: () => ServerMessage[];
  /** Injected for tests (random port = 0 is NOT allowed in production probing). */
  readonly basePort?: number;
  readonly maxPort?: number;
  /** WS path advertised in /handshake; default DEFAULT_WS_PATH. */
  readonly wsPath?: string;
  readonly now?: () => number;
}

export interface DaemonServer {
  /** Actually bound port (within 43110–43119 in production). */
  readonly port: number;
  readonly wsPath: string;
  /** Send one frame to every authenticated client. */
  broadcast(message: ServerMessage): void;
  /** Number of authenticated clients (test observability). */
  clientCount(): number;
  /** Stop heartbeats, close clients, release the port. */
  close(): Promise<void>;
}

/** First WS frame must be a valid `auth` within this window, or the connection is closed. */
export const AUTH_WINDOW_MS = 10_000;

/** Hook bodies beyond this are discarded (still answered with an empty 2xx). */
const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/**
 * PRIVACY: the ONLY logging sink of the daemon server. Lines may contain
 * counts, ports, frame/event NAMES and 8-char session-id prefixes — never a
 * token, body, cwd, title, prompt or any transcript-derived string.
 */
function log(line: string): void {
  console.log(`[codestead-daemon] ${line}`);
}

/** Strip external input down to a safe, short identifier-ish string for logs. */
function sanitizeForLog(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return 'unknown';
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned === '' ? 'unknown' : cleaned.slice(0, maxLen);
}

/** `<hook_event_name> <session_id first 8>` — the only thing a hook POST leaves in logs. */
function hookLogLabel(body: unknown): string {
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return `hook ${sanitizeForLog(rec['hook_event_name'], 32)} ${sanitizeForLog(rec['session_id'], 8)}`;
}

/**
 * Origin policy (security tripod leg 2): browsers always send Origin — it must
 * be on the whitelist (exact match; `null` from sandboxed/file contexts is
 * rejected unless explicitly whitelisted, which it never should be). Requests
 * WITHOUT an Origin header are non-browser local tools (CLI, curl) and pass —
 * the token (leg 3) still gates the WS protocol itself.
 */
function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

/**
 * Host-header allowlist (defense-in-depth vs DNS rebinding, hud-sessions
 * §10.4-4): the daemon only ever binds 127.0.0.1, so any legitimate client —
 * browser, CLI, Claude Code hook delivery — addresses it as 127.0.0.1 or
 * localhost. A rebound hostname (evil.example resolving to 127.0.0.1) carries
 * that hostname in Host and is rejected. Absent Host (HTTP/1.0 tools) passes.
 */
function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return true;
  const name = host.startsWith('[')
    ? host.replace(/^\[([^\]]*)\].*$/, '$1') // [::1]:port → ::1
    : host.replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/** WS frames beyond this are rejected by ws (1009); auth frames are ~100 bytes. */
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Constant-time token comparison (hash first so length differences don't throw/leak). */
function tokenMatches(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Bind 127.0.0.1:<base>, walking up to <max> on EADDRINUSE (risk #13). */
function listenWithinWindow(
  server: HttpServer,
  basePort: number,
  maxPort: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const attempt = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && port < maxPort) {
          attempt(port + 1);
        } else if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `codestead daemon: ports ${String(basePort)}–${String(maxPort)} are all in use`,
            ),
          );
        } else {
          reject(err);
        }
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        // Report the ACTUAL bound port: identical to `port` in production, and
        // it makes the test-only ephemeral `basePort: 0` resolve correctly.
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Security tripod leg 1: loopback only — the host is NOT configurable.
      server.listen(port, DAEMON_HOST);
    };
    attempt(basePort);
  });
}

/** Minimal raw rejection during the upgrade handshake (no error frame exists in the protocol). */
function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export async function createDaemonServer(deps: DaemonServerDeps): Promise<DaemonServer> {
  const now = deps.now ?? Date.now;
  const wsPath = deps.wsPath ?? DEFAULT_WS_PATH;
  const basePort = deps.basePort ?? DAEMON_PORT_BASE;
  const maxPort = deps.maxPort ?? DAEMON_PORT_MAX;

  /** Authenticated clients only — the broadcast set. */
  const authed = new Set<WebSocket>();
  let boundPort = 0;

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of authed) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // ---- HTTP: POST /hooks (listen-only) + GET /handshake (discovery) ----

  function handleHookPost(req: IncomingMessage, res: ServerResponse): void {
    // Origin leg of the tripod (hud-sessions §10.4-4): a browser-sent POST
    // carries Origin; off-whitelist (or rebound-Host) requests still get the
    // mandated empty 2xx but their body never reaches the state machine.
    // Claude Code's hook client sends no Origin → unaffected.
    const trusted =
      originAllowed(req.headers.origin, deps.allowedOrigins) && hostAllowed(req.headers.host);
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_HOOK_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      res.writeHead(204).end();
    });
    req.on('end', () => {
      // ALWAYS an empty 2xx, before anything else can fail — no body, no
      // decision fields, no matter what arrived (tech-stack §4.1-1).
      res.writeHead(204).end();
      if (!trusted) {
        log('hook dropped (origin/host not allowed)'); // names/counts only — never the value
        return;
      }
      if (overflow) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return; // unparseable bodies are silently dropped (and never logged)
      }
      log(hookLogLabel(body));
      try {
        deps.onHookBody(body, now());
      } catch {
        // The sink must never break the empty-2xx contract.
      }
    });
  }

  function handleHandshake(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!originAllowed(origin, deps.allowedOrigins) || !hostAllowed(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    const body: HandshakeResponse = {
      port: boundPort,
      wsPath,
      token: deps.token,
      daemonVersion: deps.daemonVersion,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin !== undefined) {
      headers['access-control-allow-origin'] = origin;
      headers['vary'] = 'Origin';
    }
    res.writeHead(200, headers).end(JSON.stringify(body));
  }

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path === HOOKS_PATH) {
      handleHookPost(req, res);
    } else if (req.method === 'GET' && path === HANDSHAKE_PATH) {
      handleHandshake(req, res);
    } else {
      res.writeHead(404).end();
    }
  });

  // ---- WS: upgrade gate (path + Origin) → auth → hello → snapshot → stream ----

  // 64KB maxPayload (vs ws's 100MiB default) — auth frames are tiny; anything
  // larger is hostile or broken (hud-sessions §10.4-4 defense-in-depth).
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== wsPath) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    if (!originAllowed(req.headers.origin, deps.allowedOrigins) || !hostAllowed(req.headers.host)) {
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws);
    });
  });

  function handleConnection(ws: WebSocket): void {
    let isAuthed = false;
    const authTimer = setTimeout(() => {
      if (!isAuthed) ws.close();
    }, AUTH_WINDOW_MS);
    authTimer.unref();

    const decodeText = (data: unknown): string =>
      Array.isArray(data)
        ? Buffer.concat(data as Buffer[]).toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : (data as Buffer).toString('utf8');

    ws.on('message', (data, isBinary) => {
      // Post-auth client frames (M4): parse + dispatch to the quest module via
      // onClientMessage. Anything that is not a valid non-auth ClientMessage (or
      // when no consumer is wired) is parsed-and-dropped — the M2 behavior.
      if (isAuthed) {
        if (deps.onClientMessage === undefined || isBinary) return;
        try {
          const parsed = ClientMessageSchema.safeParse(JSON.parse(decodeText(data)));
          if (parsed.success && parsed.data.type !== 'auth') {
            deps.onClientMessage(parsed.data);
          }
        } catch {
          // malformed post-auth frame — dropped silently (no error frame exists)
        }
        return;
      }
      clearTimeout(authTimer);

      let ok = false;
      if (!isBinary) {
        try {
          const parsed = ClientMessageSchema.safeParse(JSON.parse(decodeText(data)));
          ok =
            parsed.success &&
            parsed.data.type === 'auth' &&
            tokenMatches(parsed.data.payload.token, deps.token);
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        // Bad/missing token, malformed or non-auth first frame: close — the
        // protocol has no error frame (shared/src/protocol.ts note).
        ws.close();
        log('ws client rejected');
        return;
      }

      isAuthed = true;
      authed.add(ws);
      send(ws, {
        v: PROTOCOL_VERSION,
        type: 'hello',
        payload: { protocol: PROTOCOL_VERSION, daemonVersion: deps.daemonVersion },
      });
      send(ws, {
        v: PROTOCOL_VERSION,
        type: 'snapshot',
        payload: { sessions: deps.getSnapshot() },
      });
      // M4: post-auth recovery frames (questSnapshot) right after the session
      // snapshot, so a reconnecting client re-receives its single pending quest
      // (§5/§11-E3). M2 boots omit getPostAuthFrames ⇒ nothing extra is sent.
      if (deps.getPostAuthFrames !== undefined) {
        for (const frame of deps.getPostAuthFrames()) send(ws, frame);
      }
      log(`ws client authenticated (clients=${String(authed.size)})`);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (authed.delete(ws)) log(`ws client closed (clients=${String(authed.size)})`);
    });
    ws.on('error', () => {
      // Socket-level errors surface as 'close'; nothing (and no payload) to log.
    });
  }

  const heartbeatTimer = setInterval(() => {
    broadcast({
      v: PROTOCOL_VERSION,
      type: 'heartbeat',
      payload: { at: new Date(now()).toISOString() },
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  boundPort = await listenWithinWindow(httpServer, basePort, maxPort);
  log(`listening on ${DAEMON_HOST}:${String(boundPort)} (ws ${wsPath})`);

  return {
    port: boundPort,
    wsPath,
    broadcast,
    clientCount: () => authed.size,
    async close(): Promise<void> {
      clearInterval(heartbeatTimer);
      for (const ws of wss.clients) ws.terminate();
      authed.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        httpServer.closeAllConnections();
      });
      log('stopped');
    },
  };
}
