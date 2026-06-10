import { describe, expect, it } from 'vitest';

import {
  AuthMessageSchema,
  HeartbeatMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  SessionInfoSchema,
  SessionStateSchema,
  SnapshotMessageSchema,
  type SessionInfo,
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

  it('rejects an unknown session state enum value', () => {
    expect(SessionStateSchema.safeParse('paused').success).toBe(false);
    expect(SessionInfoSchema.safeParse({ ...validSession, state: 'paused' }).success).toBe(false);
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
