/**
 * Reducer contract — table-driven over the AUTHORITATIVE 14-row transition
 * table (hud-sessions §7.3) + the four arbitration rules (§7.4), replaying
 * wire-shaped event streams through normalizeHookEvent + reduceSessions
 * (PRD 03 testing decision 1, seam c).
 *
 * Time is injected on every event (`at`) — no waiting, no fake timers.
 * Rule 4 (restart rebuild) is an integration concern: transcript scan →
 * reducer → full snapshot push, covered in server.contract.test.ts. The
 * committed synthetic JSONL fixtures replay below (full event sequence →
 * expected state sequence); the RECORDED-fixture todo activates once the M2
 * recorder has captured a real scrubbed event stream into test/fixtures
 * (it cannot be fabricated — being real IS its value, risk #2).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SessionInfo } from '@codestead/shared';

import { normalizeHookEvent } from '../src/signals/hooks-wire.js';
import type {
  BlockedVia,
  DoneVia,
  HookStartSource,
  SessionEvent,
  ToolHeartbeatHook,
} from '../src/state/events.js';
import {
  diffSessionTables,
  reduceSessions,
  syntheticProcessSessionId,
} from '../src/state/reducer.js';
import {
  DONE_TO_IDLE_MS,
  EMPTY_SESSION_TABLE,
  IDLE_REAP_APPROX_MS,
  TRANSCRIPT_SILENCE_TO_DONE_MS,
} from '../src/state/types.js';
import type { SessionTable } from '../src/state/types.js';

// ---- fixtures & helpers ----------------------------------------------------

const T0 = Date.UTC(2026, 5, 11, 9, 0, 0);
const SID = '53b273d5-9f1c-467b-aa8f-46f816bf61ef';
const CWD = '/work/codestead-api';
const TRANSCRIPT = `/tmp/claude-projects/-work-codestead-api/${SID}.jsonl`;

const iso = (ms: number): string => new Date(ms).toISOString();

const start = (
  at: number,
  startSource: HookStartSource = 'startup',
  sessionId = SID,
  cwd = CWD,
): SessionEvent => ({
  kind: 'hookSessionStart',
  at,
  sessionId,
  startSource,
  cwd,
  transcriptPath: TRANSCRIPT,
});
const prompt = (at: number, sessionId = SID): SessionEvent => ({
  kind: 'hookUserPromptSubmit',
  at,
  sessionId,
});
const heartbeat = (
  at: number,
  hook: ToolHeartbeatHook = 'PreToolUse',
  sessionId = SID,
): SessionEvent => ({ kind: 'hookToolHeartbeat', at, sessionId, hook });
const blocked = (
  at: number,
  via: BlockedVia = 'PermissionRequest',
  sessionId = SID,
): SessionEvent => ({ kind: 'hookBlocked', at, sessionId, via });
const done = (at: number, via: DoneVia = 'Stop', sessionId = SID): SessionEvent => ({
  kind: 'hookDone',
  at,
  sessionId,
  via,
});
const stopFailure = (at: number, errorKind = 'rate_limit', sessionId = SID): SessionEvent => ({
  kind: 'hookStopFailure',
  at,
  sessionId,
  errorKind,
});
const sessionEnd = (at: number, sessionId = SID): SessionEvent => ({
  kind: 'hookSessionEnd',
  at,
  sessionId,
});
const append = (
  at: number,
  opts: { sessionId?: string; title?: string | null; subtitle?: string | null } = {},
): SessionEvent => ({
  kind: 'transcriptAppend',
  at,
  sessionId: opts.sessionId ?? SID,
  transcriptPath: TRANSCRIPT,
  title: opts.title ?? null,
  subtitle: opts.subtitle ?? null,
});
const tick = (at: number): SessionEvent => ({ kind: 'tick', at });
const discovered = (
  at: number,
  pid: number,
  opts: { tty?: string; cwd?: string | null } = {},
): SessionEvent => ({
  kind: 'processDiscovered',
  at,
  pid,
  tty: opts.tty ?? 'ttys003',
  cwd: opts.cwd ?? null,
});
const gone = (at: number, pid: number): SessionEvent => ({ kind: 'processGone', at, pid });

function replay(events: readonly SessionEvent[], from: SessionTable = EMPTY_SESSION_TABLE) {
  return events.reduce(reduceSessions, from);
}

function info(table: SessionTable, sessionId = SID): SessionInfo {
  const record = table.get(sessionId);
  if (record === undefined) throw new Error(`session ${sessionId} not in table`);
  return record.info;
}

// ---- §7.3 transition table, M2 first version: rows 1–11 ---------------------

describe('reduceSessions — hud-sessions §7.3 transition table (M2 first version: rows 1–11)', () => {
  it('row 1: SessionStart(startup|resume|clear) registers the session as idle and resets since', () => {
    for (const source of ['startup', 'resume', 'clear'] as const) {
      const registered = replay([start(T0, source)]);
      expect(info(registered)).toMatchObject({
        sessionId: SID,
        state: 'idle',
        since: iso(T0),
        lastSignalAt: iso(T0),
        source: 'hooks',
        cwd: CWD,
        title: null,
        subtitle: null,
      });
      expect(registered.get(SID)?.transcriptPath).toBe(TRANSCRIPT);
    }
    // From any state — and since resets even for idle→idle (row note “重置 since”).
    const working = replay([start(T0), prompt(T0 + 1_000)]);
    const cleared = reduceSessions(working, start(T0 + 60_000, 'clear'));
    expect(info(cleared).state).toBe('idle');
    expect(info(cleared).since).toBe(iso(T0 + 60_000));
    const reIdled = reduceSessions(cleared, start(T0 + 90_000, 'resume'));
    expect(info(reIdled).since).toBe(iso(T0 + 90_000));
  });

  it('row 2: SessionStart(compact) → working from any state (no flicker to idle during compaction)', () => {
    const fromIdle = replay([start(T0), start(T0 + 1_000, 'compact')]);
    expect(info(fromIdle).state).toBe('working');
    expect(info(fromIdle).since).toBe(iso(T0 + 1_000));
    // Already working: compact maintains working and does NOT reset since.
    const working = replay([start(T0), prompt(T0 + 1_000)]);
    const compacted = reduceSessions(working, start(T0 + 300_000, 'compact'));
    expect(info(compacted).state).toBe('working');
    expect(info(compacted).since).toBe(iso(T0 + 1_000));
    expect(info(compacted).lastSignalAt).toBe(iso(T0 + 300_000));
  });

  it('row 3: UserPromptSubmit → working from any state and dissolves done (= viewed)', () => {
    const fromIdle = replay([start(T0), prompt(T0 + 1_000)]);
    expect(info(fromIdle).state).toBe('working');
    const fromDone = replay([start(T0), prompt(T0 + 1_000), done(T0 + 5_000)]);
    expect(info(fromDone).state).toBe('done');
    const dissolved = reduceSessions(fromDone, prompt(T0 + 10_000));
    expect(info(dissolved).state).toBe('working');
    expect(info(dissolved).since).toBe(iso(T0 + 10_000));
    const fromBlocked = replay([start(T0), blocked(T0 + 1_000), prompt(T0 + 2_000)]);
    expect(info(fromBlocked).state).toBe('working');
    // Self-healing: an unregistered session registers-then-applies.
    const selfHealed = replay([prompt(T0)]);
    expect(info(selfHealed)).toMatchObject({ state: 'working', source: 'hooks', cwd: '' });
  });

  it('row 4: Pre/PostToolUse(Failure) heartbeat → working; same-state repeats refresh lastSignalAt only', () => {
    const hooks: ToolHeartbeatHook[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
    let table = replay([start(T0), blocked(T0 + 1_000)]);
    table = reduceSessions(table, heartbeat(T0 + 2_000, 'PreToolUse')); // edge ④ blocked → working
    expect(info(table).state).toBe('working');
    expect(info(table).since).toBe(iso(T0 + 2_000));
    let at = T0 + 2_000;
    for (const hook of hooks) {
      at += 30_000;
      table = reduceSessions(table, heartbeat(at, hook));
      expect(info(table).state).toBe('working');
      expect(info(table).since).toBe(iso(T0 + 2_000)); // NEVER reset by heartbeats
      expect(info(table).lastSignalAt).toBe(iso(at));
    }
  });

  it('row 5: PermissionRequest and Notification(permission_prompt) both → blocked', () => {
    for (const via of ['PermissionRequest', 'NotificationPermissionPrompt'] as const) {
      const table = replay([start(T0), prompt(T0 + 1_000), blocked(T0 + 2_000, via)]);
      expect(info(table).state).toBe('blocked');
      expect(info(table).since).toBe(iso(T0 + 2_000));
      expect(info(table).error).toBeUndefined();
    }
    // Same-state blocked keeps since (idempotence).
    const twice = replay([
      start(T0),
      blocked(T0 + 1_000),
      blocked(T0 + 9_000, 'NotificationPermissionPrompt'),
    ]);
    expect(info(twice).since).toBe(iso(T0 + 1_000));
    expect(info(twice).lastSignalAt).toBe(iso(T0 + 9_000));
  });

  it('row 6: Stop and Notification(idle_prompt) both → done from working/blocked', () => {
    const fromWorking = replay([start(T0), prompt(T0 + 1_000), done(T0 + 5_000, 'Stop')]);
    expect(info(fromWorking).state).toBe('done');
    expect(info(fromWorking).since).toBe(iso(T0 + 5_000));
    const fromBlocked = replay([
      start(T0),
      blocked(T0 + 1_000),
      done(T0 + 5_000, 'NotificationIdlePrompt'),
    ]);
    expect(info(fromBlocked).state).toBe('done'); // edge ⑤
    // Restricted from-set: a registered idle session only records the signal.
    const fromIdle = replay([start(T0), done(T0 + 5_000)]);
    expect(info(fromIdle).state).toBe('idle');
    expect(info(fromIdle).since).toBe(iso(T0));
    expect(info(fromIdle).lastSignalAt).toBe(iso(T0 + 5_000));
  });

  it('row 7: StopFailure → blocked carrying error.kind (rate_limit / billing_error / …)', () => {
    const table = replay([start(T0), prompt(T0 + 1_000), stopFailure(T0 + 5_000, 'rate_limit')]);
    expect(info(table).state).toBe('blocked');
    expect(info(table).error).toEqual({ kind: 'rate_limit' });
    // Recovery: signals reappearing pull it back to working and clear the error (edge ④).
    const recovered = reduceSessions(table, heartbeat(T0 + 60_000));
    expect(info(recovered).state).toBe('working');
    expect(info(recovered).error).toBeUndefined();
    // A permission-blocked after an error-blocked stays blocked (since kept) but is no longer an error.
    const reBlocked = reduceSessions(table, blocked(T0 + 6_000));
    expect(info(reBlocked).state).toBe('blocked');
    expect(info(reBlocked).since).toBe(iso(T0 + 5_000));
    expect(info(reBlocked).error).toBeUndefined();
  });

  it('row 8: SessionEnd deregisters the session (diff yields a removed patch)', () => {
    const before = replay([start(T0), prompt(T0 + 1_000)]);
    const after = reduceSessions(before, sessionEnd(T0 + 2_000));
    expect(after.has(SID)).toBe(false);
    expect(diffSessionTables(before, after)).toEqual([{ kind: 'removed', sessionId: SID }]);
    // Unregistered SessionEnd is a no-op (same reference).
    expect(reduceSessions(after, sessionEnd(T0 + 3_000))).toBe(after);
  });

  it('row 9: transcriptAppend → working ONLY when hooks signals are missing or stale (§7.4-1)', () => {
    // Fresh hooks (done 10s ago): denied — but display metadata still lands.
    const justDone = replay([start(T0), prompt(T0 + 1_000), done(T0 + 5_000)]);
    const denied = reduceSessions(
      justDone,
      append(T0 + 15_000, { title: '修复 webhook 重试风暴', subtitle: '帮我看看重试队列' }),
    );
    expect(info(denied).state).toBe('done');
    expect(info(denied).lastSignalAt).toBe(iso(T0 + 5_000)); // discarded signal does NOT freshen hooks
    expect(info(denied).title).toBe('修复 webhook 重试风暴');
    expect(info(denied).subtitle).toBe('帮我看看重试队列');
    // Stale hooks (≥90s of silence): transcript takes over.
    const taken = reduceSessions(
      justDone,
      append(T0 + 5_000 + TRANSCRIPT_SILENCE_TO_DONE_MS, { title: 't' }),
    );
    expect(info(taken)).toMatchObject({
      state: 'working',
      source: 'transcript',
      since: iso(T0 + 5_000 + TRANSCRIPT_SILENCE_TO_DONE_MS),
    });
    // Hooks missing (state owned by transcript tier): corrects immediately.
    const rebuilt = replay([append(T0)]);
    expect(info(rebuilt)).toMatchObject({ state: 'working', source: 'transcript', cwd: '' });
    // Confirming append on working keeps since, refreshes lastSignalAt, source stays hooks.
    const working = replay([start(T0), prompt(T0 + 1_000)]);
    const confirmed = reduceSessions(working, append(T0 + 50_000));
    expect(info(confirmed).state).toBe('working');
    expect(info(confirmed).since).toBe(iso(T0 + 1_000));
    expect(info(confirmed).lastSignalAt).toBe(iso(T0 + 50_000));
    expect(info(confirmed).source).toBe('hooks');
    // blocked is outside the row-9 from-set: never corrected by appends.
    const stillBlocked = replay([start(T0), blocked(T0 + 1_000), append(T0 + 600_000)]);
    expect(info(stillBlocked).state).toBe('blocked');
  });

  it('row 10: tick with working silent ≥90s and no blocked signal → done (Esc blind-spot)', () => {
    const working = replay([start(T0), prompt(T0 + 1_000)]); // Esc: no Stop ever arrives
    const justBefore = reduceSessions(
      working,
      tick(T0 + 1_000 + TRANSCRIPT_SILENCE_TO_DONE_MS - 1),
    );
    expect(justBefore).toBe(working); // boundary: not yet — and a no-op returns the same table
    const at = T0 + 1_000 + TRANSCRIPT_SILENCE_TO_DONE_MS;
    const degraded = reduceSessions(working, tick(at));
    expect(info(degraded)).toMatchObject({ state: 'done', since: iso(at), source: 'transcript' });
    // Activity (confirming appends) keeps resetting the silence timer.
    const active = replay([start(T0), prompt(T0 + 1_000), append(T0 + 80_000)]);
    const stillWorking = reduceSessions(active, tick(T0 + 1_000 + TRANSCRIPT_SILENCE_TO_DONE_MS));
    expect(info(stillWorking).state).toBe('working');
  });

  it('row 11: tick with done ≥30min → idle (daemon-side degradation; injected clock, no waiting)', () => {
    const doneAt = T0 + 5_000;
    const table = replay([start(T0), prompt(T0 + 1_000), done(doneAt)]);
    expect(reduceSessions(table, tick(doneAt + DONE_TO_IDLE_MS - 1))).toBe(table);
    const idled = reduceSessions(table, tick(doneAt + DONE_TO_IDLE_MS));
    expect(info(idled).state).toBe('idle');
    expect(info(idled).since).toBe(iso(doneAt + DONE_TO_IDLE_MS));
    expect(info(idled).source).toBe('hooks'); // timer row keeps the source
  });

  it('M2 first-cut reaping: tick with idle ≥12h deregisters (replaced by row 14 at M2-end)', () => {
    const table = replay([start(T0)]);
    expect(reduceSessions(table, tick(T0 + IDLE_REAP_APPROX_MS - 1))).toBe(table);
    const reaped = reduceSessions(table, tick(T0 + IDLE_REAP_APPROX_MS));
    expect(reaped.has(SID)).toBe(false);
    expect(diffSessionTables(table, reaped)).toEqual([{ kind: 'removed', sessionId: SID }]);
  });
});

// ---- §7.3 M2-end rows (ps source) -------------------------------------------

describe('reduceSessions — M2-end rows (ps source)', () => {
  it('row 12: processDiscovered with no hook record registers an unknown session (source=process)', () => {
    const table = replay([discovered(T0, 4242, { cwd: '/work/scratch' })]);
    const id = syntheticProcessSessionId(4242);
    expect(info(table, id)).toMatchObject({
      state: 'unknown',
      source: 'process',
      cwd: '/work/scratch',
      title: null,
    });
    expect(table.get(id)?.pid).toBe(4242);
    // cwd unobservable + empty table → still registers (cwd '' tolerance, §12-D2-A3).
    const noCwd = replay([discovered(T0, 4243)]);
    expect(info(noCwd, syntheticProcessSessionId(4243)).cwd).toBe('');
    // Re-discovery maintains the unknown session: lastSignalAt refreshes, since kept.
    const repolled = reduceSessions(table, discovered(T0 + 2_000, 4242, { cwd: '/work/scratch' }));
    expect(info(repolled, id).since).toBe(iso(T0));
    expect(info(repolled, id).lastSignalAt).toBe(iso(T0 + 2_000));
    // unknown never expires via tick — only ps reaps it (§7.4-3).
    expect(reduceSessions(table, tick(T0 + IDLE_REAP_APPROX_MS * 2))).toBe(table);
  });

  it('row 12 guards: headless tty filtered; pid correlates to a tracked session instead of duplicating', () => {
    // Defense-in-depth headless filter (§7.4-5): tty ?? / ? never enters the machine.
    expect(replay([discovered(T0, 5000, { tty: '??' })]).size).toBe(0);
    expect(replay([discovered(T0, 5001, { tty: '?' })]).size).toBe(0);
    // cwd match → pid attaches to the hook session; no unknown row, no wire frame.
    const hooked = replay([start(T0)]);
    const correlated = reduceSessions(hooked, discovered(T0 + 2_000, 4242, { cwd: CWD }));
    expect(correlated.size).toBe(1);
    expect(correlated.get(SID)?.pid).toBe(4242);
    expect(diffSessionTables(hooked, correlated)).toEqual([]);
    // ps never freshens a hook session's signal clock.
    expect(info(correlated).lastSignalAt).toBe(iso(T0));
    const repolled = reduceSessions(correlated, discovered(T0 + 4_000, 4242, { cwd: CWD }));
    expect(repolled).toBe(correlated);
    // cwd unobservable while a pid-less tracked session exists → held back (anti-ghost).
    const ambiguous = reduceSessions(hooked, discovered(T0 + 2_000, 9999));
    expect(ambiguous).toBe(hooked);
  });

  it('row 13: first hook event on an unknown session merges it into the four-state machine, source upgraded to hooks', () => {
    const unknownTable = replay([discovered(T0, 4242, { cwd: CWD })]);
    const merged = reduceSessions(unknownTable, start(T0 + 30_000, 'startup'));
    expect(merged.size).toBe(1); // ghost removed, real session in
    expect(merged.has(syntheticProcessSessionId(4242))).toBe(false);
    expect(info(merged)).toMatchObject({ state: 'idle', source: 'hooks', cwd: CWD });
    expect(merged.get(SID)?.pid).toBe(4242); // pid inherited → row 14 can reap it
    const patches = diffSessionTables(unknownTable, merged);
    expect(patches).toEqual([
      { kind: 'removed', sessionId: syntheticProcessSessionId(4242) },
      { kind: 'upsert', session: info(merged) },
    ]);
  });

  it('idle ≥12h reap backstop is pid-aware: live idle sessions with an associated pid are never delisted (§13-11)', () => {
    const withPid = replay([start(T0), discovered(T0 + 2_000, 777, { cwd: CWD })]);
    expect(withPid.get(SID)?.pid).toBe(777);
    // 24h of idleness later, the process is still in ps — the timer must not reap.
    expect(reduceSessions(withPid, tick(T0 + IDLE_REAP_APPROX_MS * 2))).toBe(withPid);
    // kill -9 is the replacement path (row 14).
    const killed = reduceSessions(withPid, gone(T0 + IDLE_REAP_APPROX_MS * 2, 777));
    expect(killed.has(SID)).toBe(false);
  });

  it('row 14: processGone deregisters from any state (kill -9 reaping, no ghosts)', () => {
    // Synthetic unknown session.
    const unknownTable = replay([discovered(T0, 4242, { cwd: '/work/scratch' })]);
    const reaped = reduceSessions(unknownTable, gone(T0 + 4_000, 4242));
    expect(reaped.size).toBe(0);
    // pid-correlated hook session, killed while blocked (ANY state).
    const hooked = replay([
      start(T0),
      blocked(T0 + 1_000),
      discovered(T0 + 2_000, 777, { cwd: CWD }),
    ]);
    const killed = reduceSessions(hooked, gone(T0 + 10_000, 777));
    expect(killed.has(SID)).toBe(false);
    // Unmatched pid is a no-op (same reference).
    expect(reduceSessions(hooked, gone(T0 + 10_000, 31337))).toBe(hooked);
  });
});

// ---- §7.4 arbitration & staleness rules -------------------------------------

describe('reduceSessions — arbitration & staleness rules (hud-sessions §7.4)', () => {
  it('rule 1: a fresher hooks signal wins over transcript; transcript never overrides fresh hooks', () => {
    // Transcript owns the state; a hooks signal arrives → hooks wins immediately.
    const transcriptOwned = replay([append(T0)]);
    expect(info(transcriptOwned).source).toBe('transcript');
    const hooksWin = reduceSessions(transcriptOwned, done(T0 + 1_000));
    expect(info(hooksWin)).toMatchObject({ state: 'done', source: 'hooks' });
    // …and a confirming hooks signal upgrades the source without resetting since.
    const confirmed = reduceSessions(transcriptOwned, heartbeat(T0 + 1_000));
    expect(info(confirmed)).toMatchObject({
      state: 'working',
      source: 'hooks',
      since: iso(T0),
      lastSignalAt: iso(T0 + 1_000),
    });
    // Fresh hooks-owned done is never flipped by trailing appends (see row 9 case for stale takeover).
    const justDone = replay([start(T0), prompt(T0 + 1_000), done(T0 + 5_000)]);
    const denied = reduceSessions(justDone, append(T0 + 6_000));
    expect(info(denied).state).toBe('done');
    expect(info(denied).source).toBe('hooks');
  });

  it('rule 2: idempotence — heartbeats never reset since (“已工作 47m” is not zeroed)', () => {
    const startedWorking = T0 + 1_000;
    let table = replay([start(T0), prompt(startedWorking)]);
    for (let i = 1; i <= 47; i += 1) {
      table = reduceSessions(table, heartbeat(startedWorking + i * 60_000));
      table = reduceSessions(table, append(startedWorking + i * 60_000 + 1));
    }
    expect(info(table).state).toBe('working');
    expect(info(table).since).toBe(iso(startedWorking)); // 47 minutes of heartbeats later
    expect(info(table).lastSignalAt).toBe(iso(startedWorking + 47 * 60_000 + 1));
  });

  it('rule 3: blocked is legitimately long-lived — no staleness degradation for blocked', () => {
    const table = replay([start(T0), prompt(T0 + 1_000), blocked(T0 + 2_000)]);
    // 13 hours later: past 90s, 30min and the 12h reap — blocked survives them all.
    const later = reduceSessions(table, tick(T0 + 13 * 60 * 60_000));
    expect(later).toBe(table);
    expect(info(later).state).toBe('blocked');
    // Same for error-blocked (StopFailure).
    const errored = replay([start(T0), prompt(T0 + 1_000), stopFailure(T0 + 2_000)]);
    expect(reduceSessions(errored, tick(T0 + 13 * 60 * 60_000))).toBe(errored);
  });

  // Rule 4 (restart rebuild) is not a reducer rule: scanTranscriptsForRebuild →
  // reducer → snapshot push is asserted end-to-end in server.contract.test.ts.

  it('purity: reduceSessions never mutates the input table (frozen-input probe)', () => {
    const table = replay([
      start(T0),
      prompt(T0 + 1_000),
      stopFailure(T0 + 2_000),
      discovered(T0 + 3_000, 4242, { cwd: '/elsewhere' }),
    ]);
    for (const record of table.values()) {
      Object.freeze(record);
      Object.freeze(record.info);
      if (record.info.error) Object.freeze(record.info.error);
    }
    const entriesBefore = [...table.entries()];
    const probes: SessionEvent[] = [
      start(T0 + 10_000, 'clear'),
      prompt(T0 + 10_000),
      heartbeat(T0 + 10_000),
      blocked(T0 + 10_000),
      done(T0 + 10_000),
      stopFailure(T0 + 10_000, 'overloaded'),
      sessionEnd(T0 + 10_000),
      append(T0 + 10_000, { title: 'x' }),
      tick(T0 + IDLE_REAP_APPROX_MS * 2),
      discovered(T0 + 10_000, 555, { cwd: CWD }),
      gone(T0 + 10_000, 4242),
    ];
    for (const event of probes) reduceSessions(table, event); // frozen records → mutation would throw
    expect([...table.entries()]).toEqual(entriesBefore);
  });

  it.todo(
    'fixture replay: recorded real event stream replays to the expected state timeline (drift alarm, risk #2) — activates when the recorder lands a scrubbed fixture in test/fixtures',
  );

  it('wire-shaped replay through normalizeHookEvent + reduceSessions (synthetic stand-in until a recorded fixture lands)', () => {
    // Bodies shaped per research/hooks.md §3 — including fields the schema
    // deliberately ignores (prompt/tool_input never reach events).
    const wire = (at: number, body: Record<string, unknown>) =>
      normalizeHookEvent({ session_id: SID, cwd: CWD, transcript_path: TRANSCRIPT, ...body }, at);
    const timeline: [SessionEvent | null, string][] = [
      [wire(T0, { hook_event_name: 'SessionStart', source: 'startup' }), 'idle'],
      [wire(T0 + 1_000, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }), 'working'],
      [
        wire(T0 + 2_000, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        }),
        'working',
      ],
      [
        wire(T0 + 3_000, {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow database write?',
        }),
        'blocked',
      ],
      [wire(T0 + 8_000, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }), 'working'],
      [wire(T0 + 20_000, { hook_event_name: 'Stop' }), 'done'],
      [wire(T0 + 30_000, { hook_event_name: 'UserPromptSubmit', prompt: 'thanks' }), 'working'],
      [wire(T0 + 40_000, { hook_event_name: 'StopFailure', error_type: 'rate_limit' }), 'blocked'],
    ];
    let table = EMPTY_SESSION_TABLE;
    for (const [event, expected] of timeline) {
      expect(event).not.toBeNull();
      if (event === null) continue;
      table = reduceSessions(table, event);
      expect(info(table).state).toBe(expected);
    }
    expect(info(table).error).toEqual({ kind: 'rate_limit' });
    // Ignored hook events normalize to null and change nothing.
    expect(wire(T0 + 41_000, { hook_event_name: 'SubagentStop' })).toBeNull();
    const end = wire(T0 + 50_000, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    expect(end).not.toBeNull();
    if (end !== null) table = reduceSessions(table, end);
    expect(table.size).toBe(0);
  });
});

// ---- diffSessionTables -------------------------------------------------------

describe('diffSessionTables — reducer output → wire frames', () => {
  it('emits nothing when nothing changed, an upsert for any wire-field change (incl. lastSignalAt)', () => {
    const table = replay([start(T0), prompt(T0 + 1_000)]);
    expect(diffSessionTables(table, table)).toEqual([]);
    const noop = reduceSessions(table, tick(T0 + 2_000));
    expect(diffSessionTables(table, noop)).toEqual([]);
    // Heartbeat only touches lastSignalAt — still an upsert (it IS a wire field).
    const beaten = reduceSessions(table, heartbeat(T0 + 10_000));
    expect(diffSessionTables(table, beaten)).toEqual([{ kind: 'upsert', session: info(beaten) }]);
  });

  it('orders deterministically: removals then upserts, each sorted by sessionId', () => {
    const a = replay([
      start(T0, 'startup', 'b-session', '/work/b'),
      start(T0, 'startup', 'a-session', '/work/a'),
      start(T0, 'startup', 'c-session', '/work/c'),
    ]);
    const b = replay(
      [
        sessionEnd(T0 + 1_000, 'c-session'),
        sessionEnd(T0 + 1_000, 'a-session'),
        prompt(T0 + 2_000, 'b-session'),
        start(T0 + 3_000, 'startup', 'd-session', '/work/d'),
      ],
      a,
    );
    expect(diffSessionTables(a, b)).toEqual([
      { kind: 'removed', sessionId: 'a-session' },
      { kind: 'removed', sessionId: 'c-session' },
      { kind: 'upsert', session: info(b, 'b-session') },
      { kind: 'upsert', session: info(b, 'd-session') },
    ]);
  });
});

// ---- fixture JSONL replay: full event sequence → expected state sequence ----
//
// The committed synthetic fixtures (privacy-gated by fixtures.test.ts) replay
// through the REAL pipeline — normalizeHookEvent + reduceSessions — and every
// line's outcome is pinned. When the recorder lands a real scrubbed fixture
// (todo above), it joins this harness with its own expectation table; a replay
// failure after a Claude Code upgrade IS the semantic-drift alarm (risk #2).

/** Expected outcome of one fixture line. */
type ReplayStep =
  | null // normalizeHookEvent → null (ignored event); the table must not change
  | { readonly removed: string }
  | {
      readonly id: string;
      readonly state: SessionInfo['state'];
      readonly since?: string;
      readonly errorKind?: string | null;
    };

async function loadFixture(name: string): Promise<{ at: number; body: unknown }[]> {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const content = await readFile(path, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed = JSON.parse(line) as { at: string; body: unknown };
      return { at: Date.parse(parsed.at), body: parsed.body };
    });
}

async function replayFixture(name: string, steps: readonly ReplayStep[]): Promise<SessionTable> {
  const lines = await loadFixture(name);
  expect(lines, `${name}: expectation table must cover every line`).toHaveLength(steps.length);
  let table = EMPTY_SESSION_TABLE;
  lines.forEach(({ at, body }, i) => {
    const step = steps[i];
    const label = `${name} line ${String(i + 1)}`;
    const event = normalizeHookEvent(body, at);
    if (step === null) {
      expect(event, label).toBeNull();
      return; // ignored events change nothing by construction
    }
    expect(event, label).not.toBeNull();
    if (event === null) return;
    table = reduceSessions(table, event);
    if ('removed' in step) {
      expect(table.has(step.removed), label).toBe(false);
      return;
    }
    const session = info(table, step.id);
    expect(session.state, label).toBe(step.state);
    if (step.since !== undefined) expect(session.since, label).toBe(step.since);
    if (step.errorKind !== undefined) {
      expect(session.error?.kind ?? null, label).toBe(step.errorKind);
    }
  });
  return table;
}

describe('fixture replay — synthetic JSONL streams through normalize + reduce (risk #2 harness)', () => {
  const A1 = 'a1a1a1a1-1111-4aaa-8aaa-0123456789ab';
  const B2 = 'b2b2b2b2-2222-4bbb-8bbb-0123456789ab';

  it('hooks-synthetic.jsonl replays to the expected state sequence (full installed event set)', async () => {
    const table = await replayFixture('hooks-synthetic.jsonl', [
      /* 1 SessionStart(startup) */ { id: A1, state: 'idle' },
      /* 2 UserPromptSubmit     */ { id: A1, state: 'working' },
      /* 3 PreToolUse           */ { id: A1, state: 'working' },
      /* 4 PostToolUse          */ { id: A1, state: 'working' },
      /* 5 SessionStart B       */ { id: B2, state: 'idle' },
      /* 6 UserPromptSubmit B   */ { id: B2, state: 'working' },
      /* 7 Notification(permission_prompt) */
      { id: A1, state: 'blocked', since: '2026-06-10T09:00:30.000Z' },
      /* 8 PermissionRequest — same-state: since is NOT reset (§7.4-2) */
      { id: A1, state: 'blocked', since: '2026-06-10T09:00:30.000Z' },
      /* 9 PreToolUse — edge ④ */ { id: A1, state: 'working' },
      /* 10 PostToolUseFailure B */ { id: B2, state: 'working' },
      /* 11 StopFailure B → blocked + error (row 7) */
      { id: B2, state: 'blocked', errorKind: 'rate_limit' },
      /* 12 Notification(idle_prompt) → done */
      { id: A1, state: 'done', since: '2026-06-10T09:01:10.000Z' },
      /* 13 Stop — same-state confirm keeps since */
      { id: A1, state: 'done', since: '2026-06-10T09:01:10.000Z' },
      /* 14 UserPromptSubmit dissolves done (= viewed) */
      { id: A1, state: 'working', since: '2026-06-10T09:02:00.000Z' },
      /* 15 SessionStart(compact) maintains working, since kept (row 2) */
      { id: A1, state: 'working', since: '2026-06-10T09:02:00.000Z' },
      /* 16 Notification(auth_success) ignored */ null,
      /* 17 SubagentStop ignored               */ null,
      /* 18 SessionStart(clear) B → idle, since reset, error cleared (row 1) */
      { id: B2, state: 'idle', since: '2026-06-10T09:03:00.000Z', errorKind: null },
      /* 19 Stop A */ { id: A1, state: 'done' },
      /* 20 SessionEnd A */ { removed: A1 },
      /* 21 SessionEnd B */ { removed: B2 },
    ]);
    expect(table.size).toBe(0); // both sessions deregistered — no ghosts
  });

  it('synthetic-hooks-m2.jsonl replays two interleaved sessions to the expected timeline', async () => {
    const A = 'sess-aaaa-0001';
    const B = 'sess-bbbb-0002';
    const table = await replayFixture('synthetic-hooks-m2.jsonl', [
      /* 1 */ { id: A, state: 'idle' },
      /* 2 Notification(auth_success) */ null,
      /* 3 */ { id: A, state: 'working', since: '2026-06-10T09:01:00.000Z' },
      /* 4 */ { id: B, state: 'idle' },
      /* 5 heartbeat keeps since */ { id: A, state: 'working', since: '2026-06-10T09:01:00.000Z' },
      /* 6 */ { id: A, state: 'blocked' },
      /* 7 */ { id: B, state: 'working', since: '2026-06-10T09:03:00.000Z' },
      /* 8 edge ④ */ { id: A, state: 'working', since: '2026-06-10T09:03:30.000Z' },
      /* 9 heartbeat keeps since */ { id: A, state: 'working', since: '2026-06-10T09:03:30.000Z' },
      /* 10 SubagentStop */ null,
      /* 11 */ { id: A, state: 'done' },
      /* 12 heartbeat keeps B since */
      { id: B, state: 'working', since: '2026-06-10T09:03:00.000Z' },
      /* 13 dissolves done */ { id: A, state: 'working' },
      /* 14 */ { id: A, state: 'blocked', errorKind: 'rate_limit' },
      /* 15 compact maintains working, since kept */
      { id: B, state: 'working', since: '2026-06-10T09:03:00.000Z' },
      /* 16 recovery clears the error */ { id: A, state: 'working', errorKind: null },
      /* 17 */ { id: A, state: 'done' },
      /* 18 MessageDisplay */ null,
      /* 19 Notification(idle_prompt) */ { id: B, state: 'done' },
      /* 20 */ { removed: A },
      /* 21 */ { id: B, state: 'working', since: '2026-06-10T09:10:00.000Z' },
      /* 22 missing session_id → unreplayable */ null,
    ]);
    expect([...table.keys()]).toEqual([B]); // A deregistered; B survives, working
  });
});
