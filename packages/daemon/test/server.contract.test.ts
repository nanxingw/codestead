/**
 * Daemon server integration contract (PRD 03 testing decision 3, seam d):
 * boot a REAL server on an ephemeral/test port, fire fake hook HTTP events,
 * assert the WS frame sequence — plus the security red lines as automated
 * external behavior.
 */
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer as createPlainHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDSHAKE_PATH,
  HOOKS_PATH,
  HEARTBEAT_INTERVAL_MS,
  HandshakeResponseSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ServerMessage,
  type SessionInfo,
} from '@codestead/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createDaemonServer } from '../src/server/server.js';
import type { DaemonServer, DaemonServerDeps } from '../src/server/server.js';
import { normalizeHookEvent } from '../src/signals/hooks-wire.js';
import { scanTranscriptsForRebuild } from '../src/signals/transcript.js';
import { reduceSessions } from '../src/state/reducer.js';
import { EMPTY_SESSION_TABLE } from '../src/state/types.js';

const TOKEN = 'test-token-correct';
const DEV_ORIGIN = 'http://localhost:5173';

const servers: DaemonServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const ws of clients.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) await server.close();
});

function sessionInfo(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: id,
    title: null,
    subtitle: null,
    cwd: '/tmp/project',
    state: 'idle',
    since: '2026-06-11T00:00:00.000Z',
    lastSignalAt: '2026-06-11T00:00:00.000Z',
    source: 'hooks',
    ...extra,
  };
}

async function boot(overrides: Partial<DaemonServerDeps> = {}): Promise<DaemonServer> {
  const server = await createDaemonServer({
    token: TOKEN,
    daemonVersion: '0.0.0-test',
    allowedOrigins: [DEV_ORIGIN],
    onHookBody: () => undefined,
    getSnapshot: () => [],
    basePort: 0, // ephemeral — production probing uses the 43110–43119 window
    ...overrides,
  });
  servers.push(server);
  return server;
}

/** WS client + frame collector; every inbound frame must conform to ServerMessageSchema. */
function wsClient(
  server: DaemonServer,
  origin?: string,
): { ws: WebSocket; frames: ServerMessage[] } {
  const ws = new WebSocket(
    `ws://127.0.0.1:${String(server.port)}${server.wsPath}`,
    origin === undefined ? {} : { origin },
  );
  clients.push(ws);
  const frames: ServerMessage[] = [];
  ws.on('message', (data) => {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : data.toString('utf8');
    frames.push(ServerMessageSchema.parse(JSON.parse(text)));
  });
  ws.on('error', () => undefined); // rejection tests expect upgrade errors
  return { ws, frames };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function authedClient(
  server: DaemonServer,
  token = TOKEN,
): Promise<{ ws: WebSocket; frames: ServerMessage[] }> {
  const { ws, frames } = wsClient(server);
  await once(ws, 'open');
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'auth', payload: { token } }));
  await until(() => frames.length >= 2);
  return { ws, frames };
}

/** node:http request with arbitrary headers (fetch forbids overriding Host). */
function rawRequest(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: Record<string, string> & { body?: string },
): Promise<{ status: number; body: string }> {
  const { body, ...headers } = opts;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function postHook(server: DaemonServer, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(server.port)}${HOOKS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('daemon server — wire sequence', () => {
  it('connect → auth(token) → hello → snapshot, in that order', async () => {
    const snapshot = [sessionInfo('s1'), sessionInfo('s2', { state: 'working' })];
    const server = await boot({ getSnapshot: () => snapshot });

    const { frames } = await authedClient(server);

    expect(frames[0]).toEqual({
      v: 1,
      type: 'hello',
      payload: { protocol: 1, daemonVersion: '0.0.0-test' },
    });
    expect(frames[1]).toEqual({ v: 1, type: 'snapshot', payload: { sessions: snapshot } });
    expect(server.clientCount()).toBe(1);
  });

  it('hook POST that changes state triggers a sessionUpsert broadcast', async () => {
    // Minimal real pipeline: POST body → normalizeHookEvent → broadcast (the
    // reducer in between is covered by its own seam, state-reducer tests).
    let server: DaemonServer | null = null;
    server = await boot({
      onHookBody: (body, at) => {
        const event = normalizeHookEvent(body, at);
        if (event?.kind === 'hookSessionStart') {
          server?.broadcast({
            v: 1,
            type: 'sessionUpsert',
            payload: { session: sessionInfo(event.sessionId, { state: 'idle' }) },
          });
        }
      },
    });

    const { frames } = await authedClient(server);
    const res = await postHook(server, {
      session_id: 'sess-upsert-1',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: '/tmp/project',
    });
    expect(res.status).toBe(204);

    await until(() => frames.some((f) => f.type === 'sessionUpsert'));
    const upsert = frames.find((f) => f.type === 'sessionUpsert');
    expect(upsert?.payload).toMatchObject({ session: { sessionId: 'sess-upsert-1' } });
  });

  it('SessionEnd hook triggers sessionRemoved', async () => {
    let server: DaemonServer | null = null;
    server = await boot({
      onHookBody: (body, at) => {
        const event = normalizeHookEvent(body, at);
        if (event?.kind === 'hookSessionEnd') {
          server?.broadcast({
            v: 1,
            type: 'sessionRemoved',
            payload: { sessionId: event.sessionId },
          });
        }
      },
    });

    const { frames } = await authedClient(server);
    await postHook(server, {
      session_id: 'sess-ending',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    });

    await until(() => frames.some((f) => f.type === 'sessionRemoved'));
    expect(frames.find((f) => f.type === 'sessionRemoved')?.payload).toEqual({
      sessionId: 'sess-ending',
    });
  });

  it('heartbeat frame every 25s (injected timers, no real waiting)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = await boot({ now: () => Date.parse('2026-06-11T12:00:00.000Z') });
    const { frames } = await authedClient(server);

    expect(frames.some((f) => f.type === 'heartbeat')).toBe(false);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await until(() => frames.some((f) => f.type === 'heartbeat'));
    expect(frames.find((f) => f.type === 'heartbeat')?.payload).toEqual({
      at: '2026-06-11T12:00:00.000Z',
    });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await until(() => frames.filter((f) => f.type === 'heartbeat').length >= 2);
  });

  it('restart rebuild (§7.4-4 rule 4): transcript scan → reducer → full snapshot to a fresh client', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'codestead-rebuild-'));
    try {
      const group = join(projectsDir, '-work-codestead-api');
      await mkdir(group, { recursive: true });
      const jsonl = (...objects: unknown[]): string =>
        objects.map((o) => `${JSON.stringify(o)}\n`).join('');
      // One transcript fresh enough to survive the scan…
      await writeFile(
        join(group, 'sess-rebuilt.jsonl'),
        jsonl(
          { type: 'ai-title', aiTitle: '重启前的会话' },
          { type: 'last-prompt', lastPrompt: 'continue please' },
        ),
      );
      // …and one silent ≥12h: skipped by the scan (first-cut reap semantics).
      const ancient = join(group, 'sess-ancient.jsonl');
      await writeFile(ancient, jsonl({ type: 'ai-title', aiTitle: 'ghost' }));
      const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60_000);
      await utimes(ancient, thirteenHoursAgo, thirteenHoursAgo);

      // The daemon start sequence (§7.4-4): scan → replay through the reducer
      // (ordinary row-9 path) → serve the rebuilt table as the snapshot.
      const events = await scanTranscriptsForRebuild({ projectsDir, now: () => Date.now() });
      const table = events.reduce(reduceSessions, EMPTY_SESSION_TABLE);
      const server = await boot({
        getSnapshot: () => [...table.values()].map((record) => record.info),
      });

      const { frames } = await authedClient(server);
      expect(frames[1]?.type).toBe('snapshot');
      const sessions = frames[1]?.type === 'snapshot' ? frames[1].payload.sessions : [];
      expect(sessions).toHaveLength(1); // the ancient ghost never reaches the wire
      expect(sessions[0]).toMatchObject({
        sessionId: 'sess-rebuilt',
        state: 'working', // the next tick degrades it via row 10 if it stays silent
        source: 'transcript',
        title: '重启前的会话',
        subtitle: 'continue please',
      });
    } finally {
      await rm(projectsDir, { recursive: true, force: true });
    }
  });

  it('multiple authenticated clients all receive broadcasts (hud-sessions §11-21)', async () => {
    const server = await boot();
    const a = await authedClient(server);
    const b = await authedClient(server);
    expect(server.clientCount()).toBe(2);

    server.broadcast({
      v: 1,
      type: 'sessionUpsert',
      payload: { session: sessionInfo('shared-broadcast') },
    });

    await until(
      () =>
        a.frames.some((f) => f.type === 'sessionUpsert') &&
        b.frames.some((f) => f.type === 'sessionUpsert'),
    );
  });
});

describe('daemon server — security tripod (tech-stack §4.1-5)', () => {
  it('binds 127.0.0.1 only', async () => {
    const server = await boot();

    const loopback = await fetch(`http://127.0.0.1:${String(server.port)}${HANDSHAKE_PATH}`);
    expect(loopback.status).toBe(200);

    // The same port on ANY other interface (IPv6 loopback here) must refuse.
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect({ host: '::1', port: server.port, family: 6 });
        socket.on('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.on('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('WS without auth frame, with wrong token, or with non-auth first frame → connection closed (no error frame exists)', async () => {
    const server = await boot();

    // (a) malformed first frame
    const a = wsClient(server);
    await once(a.ws, 'open');
    a.ws.send('not json {{{');
    await once(a.ws, 'close');

    // (b) wrong token
    const b = wsClient(server);
    await once(b.ws, 'open');
    b.ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token: 'wrong-token' } }));
    await once(b.ws, 'close');

    // (c) structurally valid but non-auth first frame
    const c = wsClient(server);
    await once(c.ws, 'open');
    c.ws.send(JSON.stringify({ v: 1, type: 'heartbeat', payload: { at: 'x' } }));
    await once(c.ws, 'close');

    expect(a.frames).toEqual([]);
    expect(b.frames).toEqual([]);
    expect(c.frames).toEqual([]);
    expect(server.clientCount()).toBe(0);
  });

  it('WS upgrade / handshake CORS from a non-whitelisted Origin is rejected', async () => {
    const server = await boot();

    // WS upgrade with an off-list Origin never opens.
    const evil = wsClient(server, 'http://evil.example');
    await once(evil.ws, 'error');

    // `Origin: null` (sandboxed/file context) is off-list too → rejected.
    const sandboxed = wsClient(server, 'null');
    await once(sandboxed.ws, 'error');

    // Whitelisted origin upgrades fine.
    const ok = wsClient(server, DEV_ORIGIN);
    await once(ok.ws, 'open');

    // Handshake CORS mirrors the same policy.
    const forbidden = await fetch(`http://127.0.0.1:${String(server.port)}${HANDSHAKE_PATH}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe('');

    const allowed = await fetch(`http://127.0.0.1:${String(server.port)}${HANDSHAKE_PATH}`, {
      headers: { origin: DEV_ORIGIN },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(DEV_ORIGIN);
  });

  it('POST /hooks always answers an empty 2xx — even for garbage bodies — and never echoes content', async () => {
    const seen: unknown[] = [];
    const server = await boot({
      onHookBody: (body) => {
        seen.push(body);
      },
    });

    const garbage = await postHook(server, 'this is } not json');
    expect(garbage.status).toBe(204);
    expect(await garbage.text()).toBe('');

    const valid = await postHook(server, { session_id: 's1', hook_event_name: 'Stop' });
    expect(valid.status).toBe(204);
    expect(await valid.text()).toBe('');

    // Sink throwing must not break the empty-2xx contract either.
    const exploding = await createDaemonServer({
      token: TOKEN,
      daemonVersion: '0.0.0-test',
      allowedOrigins: [],
      onHookBody: () => {
        throw new Error('sink exploded');
      },
      getSnapshot: () => [],
      basePort: 0,
    });
    servers.push(exploding);
    const res = await postHook(exploding, { session_id: 's2', hook_event_name: 'Stop' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    await until(() => seen.length >= 1);
    expect(seen).toEqual([{ session_id: 's1', hook_event_name: 'Stop' }]); // garbage never reached the sink
  });

  it('POST /hooks with an off-whitelist Origin: still empty 2xx, but the body never reaches the sink (hud-sessions §10.4-4)', async () => {
    const seen: unknown[] = [];
    const server = await boot({
      onHookBody: (body) => {
        seen.push(body);
      },
    });
    const base = `http://127.0.0.1:${String(server.port)}${HOOKS_PATH}`;

    // Hostile page: no-cors text/plain POST carrying JSON, browser Origin set.
    const hostile = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
      body: JSON.stringify({ session_id: 'fake', hook_event_name: 'PermissionRequest' }),
    });
    expect(hostile.status).toBe(204); // listen-only empty-2xx contract holds
    expect(await hostile.text()).toBe('');

    // Whitelisted dev origin passes; Claude Code's hook client (no Origin) passes.
    const fromGame = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: DEV_ORIGIN },
      body: JSON.stringify({ session_id: 'a1', hook_event_name: 'Stop' }),
    });
    expect(fromGame.status).toBe(204);
    const noOrigin = await postHook(server, { session_id: 'a2', hook_event_name: 'Stop' });
    expect(noOrigin.status).toBe(204);

    await until(() => seen.length >= 2);
    expect(seen).toEqual([
      { session_id: 'a1', hook_event_name: 'Stop' },
      { session_id: 'a2', hook_event_name: 'Stop' },
    ]); // the fabricated PermissionRequest never entered the state machine
  });

  it('Host header off the 127.0.0.1/localhost allowlist is rejected (DNS-rebinding guard)', async () => {
    const seen: unknown[] = [];
    const server = await boot({
      onHookBody: (body) => {
        seen.push(body);
      },
    });

    // node:http allows overriding Host (fetch forbids it per spec).
    const rebound = await rawRequest(server.port, 'POST', HOOKS_PATH, {
      host: 'evil.example',
      'content-type': 'text/plain',
      body: JSON.stringify({ session_id: 'fake', hook_event_name: 'Stop' }),
    });
    expect(rebound.status).toBe(204); // hooks keep the empty-2xx shape…
    const handshake = await rawRequest(server.port, 'GET', HANDSHAKE_PATH, {
      host: 'evil.example:43110',
    });
    expect(handshake.status).toBe(403); // …handshake rejects outright

    const legit = await postHook(server, { session_id: 'h1', hook_event_name: 'Stop' });
    expect(legit.status).toBe(204);
    await until(() => seen.length >= 1);
    expect(seen).toEqual([{ session_id: 'h1', hook_event_name: 'Stop' }]); // rebound body dropped
  });

  it('WS frames beyond maxPayload (64KB) close the connection instead of buffering 100MiB', async () => {
    const server = await boot();
    const { ws } = wsClient(server, DEV_ORIGIN);
    await once(ws, 'open');
    ws.send('x'.repeat(70 * 1024)); // oversized first frame
    await once(ws, 'close');
    expect(server.clientCount()).toBe(0);
  });

  it('GET /handshake returns { port, wsPath, token, daemonVersion } matching HandshakeResponseSchema', async () => {
    const server = await boot();
    const res = await fetch(`http://127.0.0.1:${String(server.port)}${HANDSHAKE_PATH}`);
    expect(res.status).toBe(200);

    const body = HandshakeResponseSchema.parse(await res.json());
    expect(body).toEqual({
      port: server.port,
      wsPath: server.wsPath,
      token: TOKEN,
      daemonVersion: '0.0.0-test',
    });
  });

  it('EADDRINUSE on base port → binds the next port within 43110–43119', async () => {
    // Occupy a port, then ask the daemon to start its walk exactly there.
    const blocker = createPlainHttpServer(() => undefined);
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const blockedPort = (blocker.address() as AddressInfo).port;

    try {
      const server = await boot({ basePort: blockedPort, maxPort: blockedPort + 5 });
      expect(server.port).toBeGreaterThan(blockedPort);
      expect(server.port).toBeLessThanOrEqual(blockedPort + 5);

      // The advertised handshake port matches the actually bound one.
      const res = await fetch(`http://127.0.0.1:${String(server.port)}${HANDSHAKE_PATH}`);
      const body = HandshakeResponseSchema.parse(await res.json());
      expect(body.port).toBe(server.port);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('privacy: server log output contains no token, no cwd/title/prompt content (log capture probe)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const secretToken = 'SECRET-TOKEN-d34dbeef';
    const server = await createDaemonServer({
      token: secretToken,
      daemonVersion: '0.0.0-test',
      allowedOrigins: [DEV_ORIGIN],
      onHookBody: () => undefined,
      getSnapshot: () => [
        sessionInfo('sess1234-5678-uuid', {
          title: '秘密标题-private-title',
          subtitle: 'TOP-SECRET-PROMPT-TEXT',
          cwd: '/Users/privacy-probe/secret-project',
        }),
      ],
      basePort: 0,
    });
    servers.push(server);

    const { ws, frames } = wsClient(server);
    await once(ws, 'open');
    ws.send(JSON.stringify({ v: 1, type: 'auth', payload: { token: secretToken } }));
    await until(() => frames.length >= 2);

    await postHook(server, {
      session_id: 'sess1234-5678-uuid',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/Users/privacy-probe/secret-project',
      prompt: 'TOP-SECRET-PROMPT-TEXT',
    });
    await until(() =>
      logSpy.mock.calls.some((call) => call.join(' ').includes('UserPromptSubmit')),
    );

    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');

    // Allowed: event names, 8-char session-id prefix, counts, ports.
    expect(allOutput).toContain('UserPromptSubmit');
    expect(allOutput).toContain('sess1234');
    // Forbidden: token, full session id, cwd, title, prompt content.
    expect(allOutput).not.toContain(secretToken);
    expect(allOutput).not.toContain('sess1234-5678-uuid');
    expect(allOutput).not.toContain('privacy-probe');
    expect(allOutput).not.toContain('secret-project');
    expect(allOutput).not.toContain('秘密标题');
    expect(allOutput).not.toContain('TOP-SECRET-PROMPT-TEXT');
  });
});
