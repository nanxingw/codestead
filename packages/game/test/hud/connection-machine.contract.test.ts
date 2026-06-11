/**
 * HUD client contract (PRD 03 testing decision 4 — the client mirror of seam
 * c): connection machine reducer table-driven over hud-sessions §8.1, plus the
 * pure display selectors. Zero Phaser, zero network.
 */
import type { ServerMessage, SessionInfo } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { HUD_SETTINGS_DEFAULTS, type HudSettings } from '../../src/hud/settings.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_JITTER_RATIO,
  BACKOFF_LONG_AFTER_FAILURES,
  BACKOFF_LONG_MS,
  CONNECT_TIMEOUT_MS,
  HARD_CAP_ROWS,
  HIGHLIGHT_COOLDOWN_MS,
  INCOMPATIBLE_RETRY_MS,
  OVERFLOW_PREVIEW_MAX,
  RESORT_MERGE_WINDOW_MS,
  SOUND_GLOBAL_COOLDOWN_MS,
  applyConnectionEvent,
  applyServerMessage,
  computeBackoffDelayMs,
  createInitialHudState,
  displayName,
  filterDisplaySessions,
  formatDuration,
  movedRowIds,
  planOverflow,
  reduceConnection,
  resortDeferMs,
  sortSessionRows,
  stateCounts,
} from '../../src/hud/store.js';
import type { ConnectionState, HudState } from '../../src/hud/types.js';
import { STATE_RANK } from '../../src/hud/types.js';

// ---- builders ----

function conn(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    phase: 'connecting',
    attempt: 0,
    gotHello: false,
    daemonVersion: null,
    daemonProtocol: null,
    lastMessageAt: null,
    ...over,
  };
}

let seq = 0;
function session(over: Partial<SessionInfo> = {}): SessionInfo {
  seq += 1;
  return {
    sessionId: `s-${String(seq).padStart(3, '0')}`,
    title: null,
    subtitle: null,
    cwd: `/Users/dev/proj-${seq}`,
    state: 'working',
    since: '2026-06-11T08:00:00+08:00',
    lastSignalAt: '2026-06-11T08:00:00+08:00',
    source: 'hooks',
    ...over,
  };
}

function hudState(over: Partial<HudState> = {}, settings?: Partial<HudSettings>): HudState {
  const base = createInitialHudState({ ...HUD_SETTINGS_DEFAULTS, ...settings }, true);
  return { ...base, ...over };
}

function snapshotMsg(sessions: SessionInfo[]): ServerMessage {
  return { v: 1, type: 'snapshot', payload: { sessions } };
}

function upsertMsg(s: SessionInfo): ServerMessage {
  return { v: 1, type: 'sessionUpsert', payload: { session: s } };
}

describe('connection machine constants (hud-sessions §8.1 — values are design law)', () => {
  it('pins the backoff ladder parameters', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(BACKOFF_BASE_MS).toBe(1_000);
    expect(BACKOFF_CAP_MS).toBe(30_000);
    expect(BACKOFF_JITTER_RATIO).toBe(0.2);
    expect(BACKOFF_LONG_AFTER_FAILURES).toBe(10);
    expect(BACKOFF_LONG_MS).toBe(60_000);
    expect(INCOMPATIBLE_RETRY_MS).toBe(300_000);
    expect(RESORT_MERGE_WINDOW_MS).toBe(10_000);
  });

  it('pins the attention gradient order blocked > done > working > idle > unknown (§5.1)', () => {
    expect(STATE_RANK.blocked).toBeLessThan(STATE_RANK.done);
    expect(STATE_RANK.done).toBeLessThan(STATE_RANK.working);
    expect(STATE_RANK.working).toBeLessThan(STATE_RANK.idle);
    expect(STATE_RANK.idle).toBeLessThan(STATE_RANK.unknown);
  });
});

describe('reduceConnection — §8.1 table-driven', () => {
  it('CONNECTING --wsOpen--> HANDSHAKING (client sends auth)', () => {
    expect(reduceConnection(conn(), { kind: 'wsOpen' }).phase).toBe('handshaking');
  });

  it('CONNECTING --connectTimeout(10s)/wsClose/wsError--> BACKOFF', () => {
    for (const kind of ['connectTimeout', 'wsClose', 'wsError'] as const) {
      const next = reduceConnection(conn(), { kind });
      expect(next.phase).toBe('backoff');
      expect(next.attempt).toBe(1);
    }
  });

  it('HANDSHAKING --helloOk + snapshotReceived--> LIVE (both required)', () => {
    const handshaking = conn({ phase: 'handshaking' });
    // snapshot before hello does NOT reach LIVE
    expect(reduceConnection(handshaking, { kind: 'snapshotReceived' }).phase).toBe('handshaking');
    const greeted = reduceConnection(handshaking, { kind: 'helloOk', daemonVersion: '1.2.3' });
    expect(greeted.phase).toBe('handshaking');
    expect(greeted.gotHello).toBe(true);
    expect(greeted.daemonVersion).toBe('1.2.3');
    expect(reduceConnection(greeted, { kind: 'snapshotReceived' }).phase).toBe('live');
  });

  it('HANDSHAKING --protoMismatch--> INCOMPATIBLE (5min slow retry, version shown in settings)', () => {
    const next = reduceConnection(conn({ phase: 'handshaking' }), {
      kind: 'protoMismatch',
      daemonProtocol: 2,
    });
    expect(next.phase).toBe('incompatible');
    expect(next.daemonProtocol).toBe(2);
  });

  it('LIVE --heartbeatTimeout(75s without ANY message)--> STALE', () => {
    expect(reduceConnection(conn({ phase: 'live' }), { kind: 'heartbeatTimeout' }).phase).toBe(
      'stale',
    );
    // heartbeatTimeout is a LIVE-only edge
    expect(
      reduceConnection(conn({ phase: 'handshaking' }), { kind: 'heartbeatTimeout' }).phase,
    ).toBe('handshaking');
  });

  it('STALE --anyMessage--> LIVE', () => {
    const next = reduceConnection(conn({ phase: 'stale' }), { kind: 'anyMessage', at: 42 });
    expect(next.phase).toBe('live');
    expect(next.lastMessageAt).toBe(42);
  });

  it('LIVE/STALE --wsClose/wsError--> BACKOFF and attempt increments', () => {
    for (const phase of ['live', 'stale'] as const) {
      for (const kind of ['wsClose', 'wsError'] as const) {
        const next = reduceConnection(conn({ phase, attempt: 2 }), { kind });
        expect(next.phase).toBe('backoff');
        expect(next.attempt).toBe(3);
      }
    }
  });

  it('BACKOFF --retryTimer--> CONNECTING; ladder 1s,2,4…cap 30s ±20%; ≥10 failures → 60s', () => {
    expect(
      reduceConnection(conn({ phase: 'backoff', attempt: 3 }), { kind: 'retryTimer' }).phase,
    ).toBe('connecting');
    expect(reduceConnection(conn({ phase: 'incompatible' }), { kind: 'retryTimer' }).phase).toBe(
      'connecting',
    );
    // ladder with neutral jitter (rand01 = 0.5)
    expect(computeBackoffDelayMs(1, 0.5)).toBe(1_000);
    expect(computeBackoffDelayMs(2, 0.5)).toBe(2_000);
    expect(computeBackoffDelayMs(3, 0.5)).toBe(4_000);
    expect(computeBackoffDelayMs(5, 0.5)).toBe(16_000);
    expect(computeBackoffDelayMs(6, 0.5)).toBe(30_000); // capped
    // jitter bounds ±20%
    expect(computeBackoffDelayMs(1, 0)).toBe(800);
    expect(computeBackoffDelayMs(1, 1)).toBe(1_200);
    // ≥10 consecutive failures park flat at 60s
    expect(computeBackoffDelayMs(10, 0.123)).toBe(60_000);
    expect(computeBackoffDelayMs(25, 0.9)).toBe(60_000);
  });

  it('reaching LIVE resets attempt to 0', () => {
    const greeted = conn({ phase: 'handshaking', gotHello: true, attempt: 7 });
    expect(reduceConnection(greeted, { kind: 'snapshotReceived' }).attempt).toBe(0);
  });

  it('computeBackoffDelayMs is pure: same (attempt, rand01) → same delay', () => {
    expect(computeBackoffDelayMs(4, 0.77)).toBe(computeBackoffDelayMs(4, 0.77));
  });
});

describe('applyServerMessage — server-authoritative table (§8.1/§8.3)', () => {
  const live = (over: Partial<HudState> = {}, settings?: Partial<HudSettings>): HudState =>
    hudState(
      { conn: conn({ phase: 'live', gotHello: true }), hasSnapshot: true, ...over },
      settings,
    );

  it('sessionUpsert/sessionRemoved before the first snapshot are dropped (§11-7)', () => {
    const state = hudState({ conn: conn({ phase: 'handshaking', gotHello: true }) });
    const s = session();
    const afterUpsert = applyServerMessage(state, upsertMsg(s), 1_000);
    expect(afterUpsert.sessions.size).toBe(0);
    const afterRemove = applyServerMessage(
      state,
      { v: 1, type: 'sessionRemoved', payload: { sessionId: s.sessionId } },
      1_000,
    );
    expect(afterRemove.sessions.size).toBe(0);
  });

  it('snapshot replaces the table wholesale but preserves cooldowns by sessionId (§11-4)', () => {
    const keep = session();
    const gone = session();
    const state = live({
      sessions: new Map([
        [keep.sessionId, keep],
        [gone.sessionId, gone],
      ]),
      cooldowns: new Map([
        [keep.sessionId, { lastHighlightAt: 500, lastSoundAt: 400 }],
        [gone.sessionId, { lastHighlightAt: 600, lastSoundAt: null }],
      ]),
    });
    const fresh = session();
    const next = applyServerMessage(state, snapshotMsg([keep, fresh]), 2_000);
    expect([...next.sessions.keys()].sort()).toEqual([keep.sessionId, fresh.sessionId].sort());
    // surviving cooldown preserved — no highlight storm after a daemon restart
    expect(next.cooldowns.get(keep.sessionId)).toEqual({ lastHighlightAt: 500, lastSoundAt: 400 });
    expect(next.cooldowns.has(gone.sessionId)).toBe(false);
    expect(next.hasSnapshot).toBe(true);
  });

  it('snapshot completes the handshake: HANDSHAKING(gotHello) → LIVE', () => {
    const state = hudState({ conn: conn({ phase: 'handshaking', gotHello: true }) });
    const next = applyServerMessage(state, snapshotMsg([]), 1_000);
    expect(next.conn.phase).toBe('live');
  });

  it('entering BACKOFF clears the session list (never show stale working rows, US35)', () => {
    const s = session();
    const state = live({ sessions: new Map([[s.sessionId, s]]) });
    const next = applyConnectionEvent(state, { kind: 'wsClose' });
    expect(next.conn.phase).toBe('backoff');
    expect(next.sessions.size).toBe(0);
    expect(next.hasSnapshot).toBe(false);
    // cooldowns survive (§8.1 reconnect rule)
    expect(next.cooldowns).toBe(state.cooldowns);
  });

  it('first hello sets everConnected=true (gate §8.2) and records daemonVersion', () => {
    const fresh = createInitialHudState(HUD_SETTINGS_DEFAULTS, false);
    const state = { ...fresh, conn: conn({ phase: 'handshaking' }) };
    const next = applyServerMessage(
      state,
      { v: 1, type: 'hello', payload: { protocol: 1, daemonVersion: '0.2.0' } },
      1_000,
    );
    expect(next.everConnected).toBe(true);
    expect(next.conn.gotHello).toBe(true);
    expect(next.conn.daemonVersion).toBe('0.2.0');
  });

  it('any message refreshes liveness: STALE → LIVE (§8.1)', () => {
    const state = live({ conn: conn({ phase: 'stale', gotHello: true }) });
    const next = applyServerMessage(
      state,
      { v: 1, type: 'heartbeat', payload: { at: '2026-06-11T08:00:00+08:00' } },
      3_000,
    );
    expect(next.conn.phase).toBe('live');
    expect(next.conn.lastMessageAt).toBe(3_000);
  });

  it('upsert entering blocked/done stamps the highlight cooldown once per 8s (§6.1)', () => {
    const s = session({ state: 'working' });
    let state = live({ sessions: new Map([[s.sessionId, s]]) });
    state = applyServerMessage(state, upsertMsg({ ...s, state: 'blocked' }), 10_000);
    expect(state.cooldowns.get(s.sessionId)?.lastHighlightAt).toBe(10_000);
    // flip back and re-enter within the 8s cooldown — no new stamp
    state = applyServerMessage(state, upsertMsg({ ...s, state: 'working' }), 12_000);
    state = applyServerMessage(state, upsertMsg({ ...s, state: 'blocked' }), 14_000);
    expect(state.cooldowns.get(s.sessionId)?.lastHighlightAt).toBe(10_000);
    // after the cooldown a new entry stamps again
    state = applyServerMessage(
      state,
      upsertMsg({ ...s, state: 'done' }),
      10_000 + HIGHLIGHT_COOLDOWN_MS,
    );
    expect(state.cooldowns.get(s.sessionId)?.lastHighlightAt).toBe(10_000 + HIGHLIGHT_COOLDOWN_MS);
  });

  it('same-state upserts do not stamp highlights (migration idempotence mirror, §7.4-2)', () => {
    const s = session({ state: 'blocked' });
    let state = live({ sessions: new Map([[s.sessionId, s]]) });
    state = applyServerMessage(
      state,
      upsertMsg({ ...s, lastSignalAt: '2026-06-11T08:01:00+08:00' }),
      9_000,
    );
    expect(state.cooldowns.get(s.sessionId)?.lastHighlightAt ?? null).toBeNull();
  });

  it('sound stamps respect the tier and the GLOBAL 20s cooldown (§3.4)', () => {
    const a = session({ state: 'working' });
    const b = session({ state: 'working' });
    const base = live(
      {
        sessions: new Map([
          [a.sessionId, a],
          [b.sessionId, b],
        ]),
      },
      { sound: 'blocked' },
    );
    // tier 'blocked': done does NOT stamp a sound
    let state = applyServerMessage(base, upsertMsg({ ...a, state: 'done' }), 1_000);
    expect(state.cooldowns.get(a.sessionId)?.lastSoundAt ?? null).toBeNull();
    // blocked stamps
    state = applyServerMessage(base, upsertMsg({ ...a, state: 'blocked' }), 1_000);
    expect(state.cooldowns.get(a.sessionId)?.lastSoundAt).toBe(1_000);
    // a second session going blocked inside the global window stays silent
    state = applyServerMessage(state, upsertMsg({ ...b, state: 'blocked' }), 5_000);
    expect(state.cooldowns.get(b.sessionId)?.lastSoundAt ?? null).toBeNull();
    // …but highlights are per-session and DO stamp
    expect(state.cooldowns.get(b.sessionId)?.lastHighlightAt).toBe(5_000);
    // past the 20s global window the next entry sounds again
    state = applyServerMessage(state, upsertMsg({ ...b, state: 'working' }), 6_000);
    state = applyServerMessage(
      state,
      upsertMsg({ ...b, state: 'blocked' }),
      1_000 + SOUND_GLOBAL_COOLDOWN_MS,
    );
    expect(state.cooldowns.get(b.sessionId)?.lastSoundAt).toBe(1_000 + SOUND_GLOBAL_COOLDOWN_MS);
  });

  it('sound default off ⇒ no sound stamps ever (anti-pattern 7)', () => {
    const s = session({ state: 'working' });
    const state = applyServerMessage(
      live({ sessions: new Map([[s.sessionId, s]]) }),
      upsertMsg({ ...s, state: 'blocked' }),
      1_000,
    );
    expect(state.cooldowns.get(s.sessionId)?.lastSoundAt ?? null).toBeNull();
  });

  it('sessionRemoved drops the row (renderer closes a hovering tooltip, §11-17)', () => {
    const s = session();
    const state = live({ sessions: new Map([[s.sessionId, s]]) });
    const next = applyServerMessage(
      state,
      { v: 1, type: 'sessionRemoved', payload: { sessionId: s.sessionId } },
      1_000,
    );
    expect(next.sessions.size).toBe(0);
  });
});

describe('display selectors — pure functions (PRD 03 testing decision 4)', () => {
  it('sortSessionRows: stateRank → since ascending (longest-waiting blocked first) → sessionId tiebreak', () => {
    const blockedOld = session({
      sessionId: 'b-old',
      state: 'blocked',
      since: '2026-06-11T07:00:00+08:00',
    });
    const blockedNew = session({
      sessionId: 'b-new',
      state: 'blocked',
      since: '2026-06-11T07:30:00+08:00',
    });
    const done = session({ sessionId: 'd-1', state: 'done' });
    const working = session({ sessionId: 'w-1', state: 'working' });
    const idle = session({ sessionId: 'i-1', state: 'idle' });
    const unknown = session({ sessionId: 'u-1', state: 'unknown' });
    const tieA = session({
      sessionId: 'w-a',
      state: 'working',
      since: '2026-06-11T08:00:00+08:00',
    });
    const tieB = session({
      sessionId: 'w-b',
      state: 'working',
      since: '2026-06-11T08:00:00+08:00',
    });
    const sorted = sortSessionRows([
      unknown,
      tieB,
      working,
      idle,
      blockedNew,
      done,
      tieA,
      blockedOld,
    ]);
    expect(sorted.map((s) => s.sessionId)).toEqual([
      'b-old',
      'b-new',
      'd-1',
      'w-1', // since 08:00 — equal to ties; sessionId orders w-1 < w-a < w-b
      'w-a',
      'w-b',
      'i-1',
      'u-1',
    ]);
  });

  it('planOverflow: blocked rows are NEVER folded; panel grows to the hard cap of 9 rows', () => {
    const blocked = Array.from({ length: 7 }, (_, i) =>
      session({ sessionId: `b-${i}`, state: 'blocked' }),
    );
    const others = Array.from({ length: 4 }, (_, i) =>
      session({ sessionId: `w-${i}`, state: 'working' }),
    );
    const sorted = sortSessionRows([...blocked, ...others]);
    const plan = planOverflow(sorted, 5);
    // 7 blocked > maxRows 5 ⇒ window widens to 7; all blocked visible
    expect(plan.visible.filter((s) => s.state === 'blocked')).toHaveLength(7);
    expect(plan.visible).toHaveLength(7);
    expect(plan.overflowCount).toBe(4);
    // 12 blocked exceed even the hard cap ⇒ exactly 9 rows (§11-11/§11-12)
    const many = Array.from({ length: 12 }, (_, i) =>
      session({ sessionId: `bb-${i}`, state: 'blocked' }),
    );
    const capped = planOverflow(sortSessionRows(many), 5);
    expect(capped.visible).toHaveLength(HARD_CAP_ROWS);
    expect(capped.overflowCount).toBe(3);
  });

  it('planOverflow: overflow tooltip preview caps at 12 entries (§11-12)', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session({ sessionId: `w-${String(i).padStart(2, '0')}`, state: 'working' }),
    );
    const plan = planOverflow(sortSessionRows(sessions), 3);
    expect(plan.visible).toHaveLength(3);
    expect(plan.overflowCount).toBe(17);
    expect(plan.overflowPreview).toHaveLength(OVERFLOW_PREVIEW_MAX);
  });

  it('displayName: title → cwd basename → sessionId[0..8) fallback chain; duplicate names get ·parentDir', () => {
    const titled = session({ title: '修复 webhook 重试风暴', cwd: '/Users/dev/api' });
    expect(displayName(titled, [titled])).toBe('修复 webhook 重试风暴');
    const pathOnly = session({ title: null, cwd: '/Users/dev/work/codestead-api' });
    expect(displayName(pathOnly, [pathOnly])).toBe('codestead-api');
    const bare = session({ title: null, cwd: '', sessionId: 'abcdef1234567890' });
    expect(displayName(bare, [bare])).toBe('abcdef12');
    // two `api` directories disambiguate with ·父目录名 (§11-9)
    const apiA = session({ title: null, cwd: '/Users/dev/payments/api' });
    const apiB = session({ title: null, cwd: '/Users/dev/billing/api' });
    expect(displayName(apiA, [apiA, apiB])).toBe('api·payments');
    expect(displayName(apiB, [apiA, apiB])).toBe('api·billing');
  });

  it('formatDuration: <1m 刚刚 / 12m / 1h23m / 12h / 2d; negative clamps to 0 (§2.3, §11-18)', () => {
    expect(formatDuration(-5_000)).toBe('刚刚'); // clock skew clamps to 0
    expect(formatDuration(0)).toBe('刚刚');
    expect(formatDuration(59_999)).toBe('刚刚');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
    expect(formatDuration(60 * 60_000 + 23 * 60_000)).toBe('1h23m');
    expect(formatDuration(9 * 3_600_000 + 59 * 60_000)).toBe('9h59m');
    expect(formatDuration(10 * 3_600_000)).toBe('10h');
    expect(formatDuration(23 * 3_600_000 + 59 * 60_000)).toBe('23h');
    expect(formatDuration(24 * 3_600_000)).toBe('1d');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d');
  });

  it('stateCounts feeds the day-end line (§4.6) — renderer omits the line on disconnect/0 sessions', () => {
    const sessions = [
      session({ state: 'working' }),
      session({ state: 'working' }),
      session({ state: 'blocked' }),
      session({ state: 'done' }),
      session({ state: 'unknown' }),
    ];
    const counts = stateCounts(new Map(sessions.map((s) => [s.sessionId, s])));
    expect(counts).toEqual({ blocked: 1, done: 1, working: 2, idle: 0, unknown: 1 });
    expect(stateCounts(new Map())).toEqual({
      blocked: 0,
      done: 0,
      working: 0,
      idle: 0,
      unknown: 0,
    });
  });

  it('filterDisplaySessions: showIdle/showUnknown=false remove rows AND overflow count (§5.2, M2-end keys)', () => {
    const sessions = [
      session({ state: 'working' }),
      session({ state: 'idle' }),
      session({ state: 'unknown' }),
    ];
    const all = filterDisplaySessions(sessions, HUD_SETTINGS_DEFAULTS);
    expect(all).toHaveLength(3); // defaults: both shown
    const noIdle = filterDisplaySessions(sessions, { ...HUD_SETTINGS_DEFAULTS, showIdle: false });
    expect(noIdle.map((s) => s.state)).toEqual(['working', 'unknown']);
    const quiet = filterDisplaySessions(sessions, {
      ...HUD_SETTINGS_DEFAULTS,
      showIdle: false,
      showUnknown: false,
    });
    expect(quiet.map((s) => s.state)).toEqual(['working']);
  });
});

describe('resort discipline — §5.3 jitter merge (display layer)', () => {
  it('movedRowIds: relative-order changes count; index shifts from insert/remove do not', () => {
    // pure insertion at the head: nobody re-sorted relative to peers
    expect(movedRowIds(['a', 'b'], ['new', 'a', 'b'])).toEqual([]);
    // removal: survivors keep relative order
    expect(movedRowIds(['a', 'b', 'c'], ['a', 'c'])).toEqual([]);
    // a and b swapped — both moved
    expect(movedRowIds(['a', 'b', 'c'], ['b', 'a', 'c']).sort()).toEqual(['a', 'b']);
  });

  it('resortDeferMs: a row that re-sorted <10s ago defers the reflow by the remaining window', () => {
    const movedAt = new Map([['a', 1_000]]);
    // a wants to move again at t=4000 → defer for 7000ms
    expect(resortDeferMs(['a', 'b'], ['b', 'a'], movedAt, 4_000)).toBe(7_000);
    // window elapsed → apply now
    expect(resortDeferMs(['a', 'b'], ['b', 'a'], movedAt, 11_001)).toBe(0);
    // rows without a stamp reflow immediately
    expect(resortDeferMs(['x', 'y'], ['y', 'x'], new Map(), 4_000)).toBe(0);
  });
});
