import { describe, expect, it } from 'vitest';

import {
  AuthMessageSchema,
  ClientMessageSchema,
  DAEMON_PORT_BASE,
  DAEMON_PORT_MAX,
  DAEMON_PROBE_PORTS,
  HandshakeResponseSchema,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  HeartbeatMessageSchema,
  handshakeUrl,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SessionInfoSchema,
  SessionStateSchema,
  SnapshotMessageSchema,
  type SessionInfo,
  type ServerMessage,
} from '../src/index.js';

const validSession: SessionInfo = {
  sessionId: 'sess-1',
  title: 'api refactor',
  subtitle: 'split auth middleware',
  cwd: '/home/dev/api',
  state: 'working',
  since: '2026-06-10T08:00:00Z',
  lastSignalAt: '2026-06-10T08:05:00Z',
  source: 'hooks',
};

describe('protocol schema roundtrip', () => {
  it('accepts a valid snapshot message through JSON encode/decode', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      payload: { sessions: [validSession] },
    };
    const wire: unknown = JSON.parse(JSON.stringify(message));
    const result = SnapshotMessageSchema.safeParse(wire);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(message);
    }
  });

  it('accepts a sessionInfo carrying the optional error field (StopFailure)', () => {
    const result = SessionInfoSchema.safeParse({
      ...validSession,
      state: 'blocked',
      error: { kind: 'rate_limit' },
    });
    expect(result.success).toBe(true);
  });

  it('discriminates server messages by type', () => {
    const heartbeat: unknown = JSON.parse(
      JSON.stringify({ v: 1, type: 'heartbeat', payload: { at: '2026-06-10T08:00:25Z' } }),
    );
    const parsed = ServerMessageSchema.safeParse(heartbeat);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'heartbeat') {
      expect(parsed.data.payload.at).toBe('2026-06-10T08:00:25Z');
    }
    expect(HeartbeatMessageSchema.safeParse(heartbeat).success).toBe(true);
  });

  it('rejects a session missing required fields', () => {
    const { cwd: _cwd, ...withoutCwd } = validSession;
    expect(SessionInfoSchema.safeParse(withoutCwd).success).toBe(false);
  });

  it('keeps SessionStateSchema strict but parses unrecognized wire states as unknown', () => {
    // Strict enum for daemon-internal use…
    expect(SessionStateSchema.safeParse('paused').success).toBe(false);
    // …but a frame from a NEWER daemon still parses; HUD renders it as `unknown`
    // (hud-sessions §10.2 forward compatibility, PRD 03 testing decision 2).
    const parsed = SessionInfoSchema.safeParse({ ...validSession, state: 'paused' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.state).toBe('unknown');
  });

  it('rejects a wrong envelope version', () => {
    const result = AuthMessageSchema.safeParse({
      v: 2,
      type: 'auth',
      payload: { token: 'local-token' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(SessionInfoSchema.safeParse({ ...validSession, since: 'yesterday' }).success).toBe(
      false,
    );
  });
});

// PRD 03 testing decision 2 (seam b): every M2 message survives a JSON wire roundtrip.
describe('M2 message set roundtrip (hud-sessions §10.1 — complete set, no error frame)', () => {
  const roundtrip = (message: unknown): unknown => JSON.parse(JSON.stringify(message));

  it('auth (game→daemon, first frame after connect)', () => {
    const result = ClientMessageSchema.safeParse(
      roundtrip({ v: 1, type: 'auth', payload: { token: 'local-token' } }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('auth');
  });

  it.each<[string, ServerMessage]>([
    ['hello', { v: 1, type: 'hello', payload: { protocol: 1, daemonVersion: '0.2.0' } }],
    ['snapshot', { v: 1, type: 'snapshot', payload: { sessions: [validSession] } }],
    ['sessionUpsert', { v: 1, type: 'sessionUpsert', payload: { session: validSession } }],
    ['sessionRemoved', { v: 1, type: 'sessionRemoved', payload: { sessionId: 'sess-1' } }],
    ['heartbeat', { v: 1, type: 'heartbeat', payload: { at: '2026-06-10T08:00:25Z' } }],
  ])('%s (daemon→game)', (type, message) => {
    const result = ServerMessageSchema.safeParse(roundtrip(message));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(type);
      expect(result.data).toEqual(message);
    }
  });

  it('tolerates extra fields on envelope, payload and SessionInfo (additive evolution)', () => {
    const wire = roundtrip({
      v: 1,
      type: 'sessionUpsert',
      payload: { session: { ...validSession, host: 'future-field' }, traceId: 'future' },
      sentAt: 'future',
    });
    const result = ServerMessageSchema.safeParse(wire);
    expect(result.success).toBe(true);
  });

  it('rejects malformed frames (safeParse is the only entry for inbound data)', () => {
    expect(ServerMessageSchema.safeParse({ type: 'snapshot' }).success).toBe(false);
    expect(ServerMessageSchema.safeParse('not-json-object').success).toBe(false);
    expect(ServerMessageSchema.safeParse({ v: 1, type: 'nope', payload: {} }).success).toBe(false);
    expect(AuthMessageSchema.safeParse({ v: 1, type: 'auth', payload: {} }).success).toBe(false);
  });

  it('pins the heartbeat cadence contract: 25s send / 75s stale', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(HEARTBEAT_STALE_MS).toBe(75_000);
    expect(HEARTBEAT_STALE_MS).toBe(3 * HEARTBEAT_INTERVAL_MS);
  });
});

describe('endpoint discovery contract (hud-sessions §10.3 P2)', () => {
  it('probes exactly 43110–43119 in ascending order', () => {
    expect(DAEMON_PORT_BASE).toBe(43110);
    expect(DAEMON_PORT_MAX).toBe(43119);
    expect(DAEMON_PROBE_PORTS).toEqual([
      43110, 43111, 43112, 43113, 43114, 43115, 43116, 43117, 43118, 43119,
    ]);
    expect(handshakeUrl(43111)).toBe('http://127.0.0.1:43111/handshake');
  });

  it('accepts the documented handshake response shape', () => {
    const result = HandshakeResponseSchema.safeParse({
      port: 43110,
      wsPath: '/ws',
      token: 'abc',
      daemonVersion: '0.2.0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a handshake response missing the token', () => {
    expect(
      HandshakeResponseSchema.safeParse({ port: 43110, wsPath: '/ws', daemonVersion: '0.2.0' })
        .success,
    ).toBe(false);
  });
});
