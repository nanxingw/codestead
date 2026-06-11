/**
 * displayProjection (§5.3 anti-jitter, review fix): heartbeat frames and
 * lastSignalAt-only upserts must NOT change the projection the render shell
 * keys its relayout on — while every display-relevant change must. Plus the
 * §4.6 day-end 会话一行 formatter (PRD 03 US33).
 */
import { describe, expect, it } from 'vitest';

import type { ServerMessage, SessionInfo } from '@codestead/shared';
import { PROTOCOL_VERSION } from '@codestead/shared';

import { HUD_SETTINGS_DEFAULTS } from '../../src/hud/settings';
import {
  applyServerMessage,
  createInitialHudState,
  displayProjection,
  formatDayEndSessionLine,
  stateCounts,
} from '../../src/hud/store';
import type { HudState } from '../../src/hud/types';

const T0 = Date.UTC(2026, 5, 11, 9, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: id,
    title: 'fix the webhook storm',
    subtitle: null,
    cwd: '/work/api',
    state: 'working',
    since: iso(T0),
    lastSignalAt: iso(T0),
    source: 'hooks',
    ...extra,
  };
}

const frame = (message: Omit<ServerMessage, 'v'>): ServerMessage =>
  ({ v: PROTOCOL_VERSION, ...message }) as ServerMessage;

/** Connected state with one snapshot session. */
function liveState(): HudState {
  let state = createInitialHudState({ ...HUD_SETTINGS_DEFAULTS }, true);
  state = { ...state, conn: { ...state.conn, phase: 'handshaking' } };
  state = applyServerMessage(
    state,
    frame({ type: 'hello', payload: { protocol: PROTOCOL_VERSION, daemonVersion: '0.1.0' } }),
    T0,
  );
  state = applyServerMessage(
    state,
    frame({ type: 'snapshot', payload: { sessions: [session('s1')] } }),
    T0,
  );
  return state;
}

describe('displayProjection — relayout key (§5.3/§10.2)', () => {
  it('heartbeat frames leave the projection unchanged', () => {
    const before = liveState();
    const after = applyServerMessage(
      before,
      frame({ type: 'heartbeat', payload: { at: iso(T0 + 25_000) } }),
      T0 + 25_000,
    );
    expect(after).not.toBe(before); // state object DID change (liveness bookkeeping)
    expect(displayProjection(after)).toBe(displayProjection(before));
  });

  it('lastSignalAt-only upserts leave the projection unchanged', () => {
    const before = liveState();
    const after = applyServerMessage(
      before,
      frame({
        type: 'sessionUpsert',
        payload: { session: session('s1', { lastSignalAt: iso(T0 + 9_000) }) },
      }),
      T0 + 9_000,
    );
    expect(displayProjection(after)).toBe(displayProjection(before));
  });

  it('every display-relevant field changes the projection', () => {
    const before = liveState();
    const variants: Partial<SessionInfo>[] = [
      { state: 'blocked', since: iso(T0 + 1_000) },
      { since: iso(T0 + 1) },
      { title: 'other' },
      { subtitle: 'last prompt' },
      { cwd: '/elsewhere' },
      { source: 'process' },
      { error: { kind: 'rate_limit' } },
    ];
    for (const patch of variants) {
      const after = applyServerMessage(
        before,
        frame({ type: 'sessionUpsert', payload: { session: session('s1', patch) } }),
        T0 + 1_000,
      );
      expect(displayProjection(after), JSON.stringify(patch)).not.toBe(displayProjection(before));
    }
    // Membership changes too.
    const added = applyServerMessage(
      before,
      frame({ type: 'sessionUpsert', payload: { session: session('s2') } }),
      T0 + 1_000,
    );
    expect(displayProjection(added)).not.toBe(displayProjection(before));
  });

  it('settings and connection phase are part of the projection', () => {
    const before = liveState();
    const settingsChanged: HudState = {
      ...before,
      settings: { ...before.settings, maxRows: 9 },
    };
    expect(displayProjection(settingsChanged)).not.toBe(displayProjection(before));
    const stale: HudState = { ...before, conn: { ...before.conn, phase: 'stale' } };
    expect(displayProjection(stale)).not.toBe(displayProjection(before));
  });
});

describe('formatDayEndSessionLine — §4.6 会话一行 (US33)', () => {
  const counts = (over: Partial<Record<keyof ReturnType<typeof stateCounts>, number>>) => ({
    blocked: 0,
    done: 0,
    working: 0,
    idle: 0,
    unknown: 0,
    ...over,
  });

  it('renders non-zero groups in §4.6 order (working, blocked, done, …)', () => {
    expect(formatDayEndSessionLine(counts({ working: 2, blocked: 1, done: 1 }), 'live')).toBe(
      '会话 · ◐ 工作中 2 ｜ ! 等待输入 1 ｜ ✓ 已完成 1',
    );
    expect(formatDayEndSessionLine(counts({ idle: 3 }), 'live')).toBe('会话 · ○ 空闲 3');
    expect(formatDayEndSessionLine(counts({ unknown: 1, working: 1 }), 'stale')).toBe(
      '会话 · ◐ 工作中 1 ｜ ? 未知 1',
    );
  });

  it('omits the whole line when disconnected or with 0 sessions', () => {
    expect(formatDayEndSessionLine(counts({}), 'live')).toBeNull();
    for (const phase of ['connecting', 'handshaking', 'backoff', 'incompatible'] as const) {
      expect(formatDayEndSessionLine(counts({ working: 2 }), phase)).toBeNull();
    }
  });
});
