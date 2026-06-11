/**
 * Wire-side lastSignalAt-only upsert throttle (state/upsert-throttle.ts;
 * hud-sessions §10.2 lastSignalAt row): heartbeat-driven upserts whose only
 * change is `lastSignalAt` are rate-limited to one per session per 5s, while
 * ANY display-relevant change (state/title/since/error/…) passes immediately.
 */
import { describe, expect, it } from 'vitest';

import type { SessionInfo } from '@codestead/shared';

import type { SessionPatch } from '../src/state/reducer.js';
import {
  LAST_SIGNAL_ONLY_THROTTLE_MS,
  createUpsertThrottle,
} from '../src/state/upsert-throttle.js';

const T0 = Date.UTC(2026, 5, 11, 9, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

function info(extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
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

const upsert = (session: SessionInfo): SessionPatch => ({ kind: 'upsert', session });
const removed = (sessionId: string): SessionPatch => ({ kind: 'removed', sessionId });

describe('createUpsertThrottle — lastSignalAt-only rate limit (hud-sessions §10.2)', () => {
  it('first upsert passes; lastSignalAt-only repeats within 5s are held back', () => {
    const throttle = createUpsertThrottle();
    expect(throttle([upsert(info())], T0)).toHaveLength(1);
    // 1s later, only lastSignalAt moved → dropped.
    expect(throttle([upsert(info({ lastSignalAt: iso(T0 + 1_000) }))], T0 + 1_000)).toEqual([]);
    // Still inside the window, compared against the last SENT frame → dropped.
    expect(throttle([upsert(info({ lastSignalAt: iso(T0 + 4_000) }))], T0 + 4_000)).toEqual([]);
    // Window elapsed → passes and restarts the window.
    const at5 = T0 + LAST_SIGNAL_ONLY_THROTTLE_MS;
    expect(throttle([upsert(info({ lastSignalAt: iso(at5) }))], at5)).toHaveLength(1);
    expect(throttle([upsert(info({ lastSignalAt: iso(at5 + 1_000) }))], at5 + 1_000)).toEqual([]);
  });

  it('any display-relevant change passes immediately, even inside the window', () => {
    const throttle = createUpsertThrottle();
    throttle([upsert(info())], T0);
    const cases: Partial<SessionInfo>[] = [
      { state: 'blocked', since: iso(T0 + 500) },
      { title: 'now reviewing' },
      { subtitle: 'last prompt text' },
      { cwd: '/work/api-v2' },
      { source: 'transcript' },
      { error: { kind: 'rate_limit' } },
    ];
    let at = T0;
    for (const patch of cases) {
      at += 100; // far inside any window
      const out = throttle([upsert(info({ lastSignalAt: iso(at), ...patch }))], at);
      expect(out, JSON.stringify(patch)).toHaveLength(1);
    }
  });

  it('removals always pass and clear the per-session bookkeeping', () => {
    const throttle = createUpsertThrottle();
    throttle([upsert(info())], T0);
    expect(throttle([removed('s1')], T0 + 100)).toEqual([removed('s1')]);
    // Re-registration right away is a brand-new session for the throttle.
    expect(throttle([upsert(info({ lastSignalAt: iso(T0 + 200) }))], T0 + 200)).toHaveLength(1);
  });

  it('sessions are throttled independently', () => {
    const throttle = createUpsertThrottle();
    throttle([upsert(info())], T0);
    const other = info({ sessionId: 's2' });
    expect(throttle([upsert(other)], T0 + 1_000)).toHaveLength(1); // s2 unaffected by s1's window
  });
});
