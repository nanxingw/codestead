/**
 * End-to-end: canned `ps` output → the REAL createPsPollSource (cwd via the
 * injected readCwd seam, exactly like production's lsof/procfs reader) →
 * reduceSessions. Pins the behavior the reducer contract tests can only reach
 * by hand-injecting cwd values (review fix: the ps→reducer cwd link):
 *
 * 1. cwd collection makes row-12 case 2 LIVE — a discovered pid attaches to
 *    the hooks session sharing its cwd, which is what lets row 14 (kill -9
 *    reaping) cover hooks/transcript sessions (hud-sessions §12-D2-A3, §13-11);
 * 2. when cwd collection fails the discovery is held back while any pid-less
 *    record exists — but per-poll re-emission means the hold-back is
 *    re-evaluated each sweep and resolves once the pid-less record is gone
 *    (the unknown row appears; it is NOT suppressed forever);
 * 3. the idle ≥12h reap backstop is pid-aware: live idle sessions with an
 *    associated pid are never delisted by the timer (§7 分期注记).
 */
import { describe, expect, it } from 'vitest';

import { createPsPollSource } from '../src/signals/ps.js';
import type { SessionEvent } from '../src/state/events.js';
import { reduceSessions, syntheticProcessSessionId } from '../src/state/reducer.js';
import { EMPTY_SESSION_TABLE, IDLE_REAP_APPROX_MS } from '../src/state/types.js';
import type { SessionTable } from '../src/state/types.js';

const T0 = Date.UTC(2026, 5, 11, 9, 0, 0);
const SID = '53b273d5-9f1c-467b-aa8f-46f816bf61ef';
const CWD = '/work/codestead-api';

const psLine = (pid: number, args: string): string =>
  `  ${String(pid)}     1 ttys003  01:02 ${args}`;

/** Real source + reducer loop harness: canned ps text in, session table out. */
function harness(opts: { readCwd: (pid: number) => Promise<string | null> }) {
  let psOutput = '';
  let table: SessionTable = EMPTY_SESSION_TABLE;
  const apply = (event: SessionEvent): void => {
    table = reduceSessions(table, event);
  };
  const source = createPsPollSource({
    execPs: () => Promise.resolve(psOutput),
    readCwd: opts.readCwd,
    intervalMs: 3_600_000, // sweeps are driven manually via sweepNow()
    now: () => T0 + 10_000,
  });
  return {
    source,
    apply,
    setPs: (text: string) => {
      psOutput = text;
    },
    table: () => table,
  };
}

describe('ps source → reducer (production wiring, canned ps output)', () => {
  it('cwd collection attaches the pid to the hooks session; kill -9 then reaps it via row 14', async () => {
    const h = harness({ readCwd: () => Promise.resolve(CWD) });
    // hooks session registered the normal way (cwd from the hook body).
    h.apply({
      kind: 'hookSessionStart',
      at: T0,
      sessionId: SID,
      startSource: 'startup',
      cwd: CWD,
      transcriptPath: null,
    });
    h.setPs(psLine(4242, 'claude'));
    await h.source.start(h.apply);

    // Association, not duplication: still one row, pid attached.
    expect(h.table().size).toBe(1);
    expect(h.table().get(SID)?.pid).toBe(4242);

    // kill -9: the pid vanishes from ps → the HOOKS session is reaped (row 14).
    h.setPs('');
    await h.source.sweepNow();
    await h.source.stop();
    expect(h.table().size).toBe(0);
  });

  it('readCwd failure → hold-back while a pid-less record exists; per-poll re-emission resolves it afterwards', async () => {
    const h = harness({ readCwd: () => Promise.reject(new Error('lsof unavailable')) });
    h.apply({
      kind: 'hookSessionStart',
      at: T0,
      sessionId: SID,
      startSource: 'startup',
      cwd: CWD,
      transcriptPath: null,
    });
    h.setPs(psLine(5151, 'claude'));
    await h.source.start(h.apply);

    // cwd unobservable + a pid-less hooks record → held back (no ghost row).
    expect(h.table().size).toBe(1);
    expect(h.table().get(SID)?.pid).toBeNull();

    // The hooks session ends; the NEXT sweep re-emits the discovery and the
    // unknown row finally appears — hold-back is per-poll, not permanent.
    h.apply({ kind: 'hookSessionEnd', at: T0 + 60_000, sessionId: SID });
    expect(h.table().size).toBe(0);
    await h.source.sweepNow();
    await h.source.stop();
    const ghostId = syntheticProcessSessionId(5151);
    expect(h.table().get(ghostId)?.info).toMatchObject({ state: 'unknown', source: 'process' });
  });

  it('idle ≥12h backstop is pid-aware: a live idle session with an associated pid survives the timer', async () => {
    const h = harness({ readCwd: () => Promise.resolve(CWD) });
    h.apply({
      kind: 'hookSessionStart',
      at: T0,
      sessionId: SID,
      startSource: 'startup',
      cwd: CWD,
      transcriptPath: null,
    });
    h.setPs(psLine(626, 'claude'));
    await h.source.start(h.apply);
    await h.source.stop();
    expect(h.table().get(SID)?.pid).toBe(626);

    // 13h later the process is still alive: the idle reap must NOT fire.
    const before = h.table();
    h.apply({ kind: 'tick', at: T0 + IDLE_REAP_APPROX_MS + 3_600_000 });
    expect(h.table()).toBe(before);
    expect(h.table().get(SID)?.info.state).toBe('idle');
  });
});
