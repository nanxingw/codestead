/**
 * Signal-source unit tests: hook-body normalization (rows 1–8 of hud-sessions
 * §7.3), the hooks source plumbing, and the ps parse/poll source (M2-end tier,
 * rows 12/14 emission side). The reducer semantics themselves live in
 * state-reducer.contract.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/state/events.js';
import { createHooksSignalSource } from '../src/signals/hooks.js';
import { normalizeHookEvent } from '../src/signals/hooks-wire.js';
import {
  createPsPollSource,
  parseClaudeProcesses,
  QUEST_LAUNCH_ARG_MARKER,
} from '../src/signals/ps.js';

const AT = 1_770_000_000_000;
const SID = 'sess-aaaa-bbbb';

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('normalizeHookEvent — hook wire → SessionEvent (hud-sessions §7.3 rows 1–8)', () => {
  it('SessionStart(startup/resume/clear/compact) → hookSessionStart with startSource', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact'] as const) {
      expect(
        normalizeHookEvent(
          {
            session_id: SID,
            hook_event_name: 'SessionStart',
            source,
            cwd: '/tmp/p',
            transcript_path: '/tmp/p/t.jsonl',
          },
          AT,
        ),
      ).toEqual({
        kind: 'hookSessionStart',
        at: AT,
        sessionId: SID,
        startSource: source,
        cwd: '/tmp/p',
        transcriptPath: '/tmp/p/t.jsonl',
      });
    }
  });

  it('SessionStart with an unrecognized/missing source defaults to startup; missing cwd/transcript degrade', () => {
    const event = normalizeHookEvent({ session_id: SID, hook_event_name: 'SessionStart' }, AT);
    expect(event).toEqual({
      kind: 'hookSessionStart',
      at: AT,
      sessionId: SID,
      startSource: 'startup',
      cwd: '',
      transcriptPath: null,
    });
    expect(
      normalizeHookEvent(
        { session_id: SID, hook_event_name: 'SessionStart', source: 'future-mode' },
        AT,
      ),
    ).toMatchObject({ startSource: 'startup' });
  });

  it('UserPromptSubmit → hookUserPromptSubmit and carries NO prompt content (privacy red line)', () => {
    const event = normalizeHookEvent(
      { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'TOP-SECRET' },
      AT,
    );
    expect(event).toEqual({ kind: 'hookUserPromptSubmit', at: AT, sessionId: SID });
    expect(JSON.stringify(event)).not.toContain('TOP-SECRET');
  });

  it('Pre/PostToolUse(Failure) → hookToolHeartbeat, tool payloads dropped', () => {
    for (const hook of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const) {
      const event = normalizeHookEvent(
        {
          session_id: SID,
          hook_event_name: hook,
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /secret' },
        },
        AT,
      );
      expect(event).toEqual({ kind: 'hookToolHeartbeat', at: AT, sessionId: SID, hook });
      expect(JSON.stringify(event)).not.toContain('secret');
    }
  });

  it('PermissionRequest and Notification(permission_prompt) → hookBlocked (union, distinct via)', () => {
    expect(
      normalizeHookEvent({ session_id: SID, hook_event_name: 'PermissionRequest' }, AT),
    ).toEqual({ kind: 'hookBlocked', at: AT, sessionId: SID, via: 'PermissionRequest' });
    expect(
      normalizeHookEvent(
        {
          session_id: SID,
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
        },
        AT,
      ),
    ).toEqual({ kind: 'hookBlocked', at: AT, sessionId: SID, via: 'NotificationPermissionPrompt' });
  });

  it('Stop and Notification(idle_prompt) → hookDone (union, distinct via)', () => {
    expect(normalizeHookEvent({ session_id: SID, hook_event_name: 'Stop' }, AT)).toEqual({
      kind: 'hookDone',
      at: AT,
      sessionId: SID,
      via: 'Stop',
    });
    expect(
      normalizeHookEvent(
        { session_id: SID, hook_event_name: 'Notification', notification_type: 'idle_prompt' },
        AT,
      ),
    ).toEqual({ kind: 'hookDone', at: AT, sessionId: SID, via: 'NotificationIdlePrompt' });
  });

  it('StopFailure → hookStopFailure with errorKind (fallback unknown)', () => {
    expect(
      normalizeHookEvent(
        { session_id: SID, hook_event_name: 'StopFailure', error_type: 'rate_limit' },
        AT,
      ),
    ).toEqual({ kind: 'hookStopFailure', at: AT, sessionId: SID, errorKind: 'rate_limit' });
    expect(normalizeHookEvent({ session_id: SID, hook_event_name: 'StopFailure' }, AT)).toEqual({
      kind: 'hookStopFailure',
      at: AT,
      sessionId: SID,
      errorKind: 'unknown',
    });
  });

  it('SessionEnd → hookSessionEnd', () => {
    expect(
      normalizeHookEvent(
        { session_id: SID, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
        AT,
      ),
    ).toEqual({ kind: 'hookSessionEnd', at: AT, sessionId: SID });
  });

  it('unrecognized events/matchers → null, never a throw (forward compatibility, risk #2)', () => {
    expect(normalizeHookEvent({ session_id: SID, hook_event_name: 'SubagentStop' }, AT)).toBeNull();
    expect(
      normalizeHookEvent({ session_id: SID, hook_event_name: 'MessageDisplay' }, AT),
    ).toBeNull();
    expect(
      normalizeHookEvent(
        { session_id: SID, hook_event_name: 'Notification', notification_type: 'auth_success' },
        AT,
      ),
    ).toBeNull();
    expect(normalizeHookEvent({ session_id: SID, hook_event_name: 'Notification' }, AT)).toBeNull();
  });

  it('unparseable bodies → null (missing keys, wrong types, non-objects)', () => {
    expect(normalizeHookEvent('a string', AT)).toBeNull();
    expect(normalizeHookEvent(42, AT)).toBeNull();
    expect(normalizeHookEvent(null, AT)).toBeNull();
    expect(normalizeHookEvent({}, AT)).toBeNull();
    expect(normalizeHookEvent({ hook_event_name: 'Stop' }, AT)).toBeNull(); // no session_id
    expect(normalizeHookEvent({ session_id: SID }, AT)).toBeNull(); // no event name
    expect(normalizeHookEvent({ session_id: 7, hook_event_name: 'Stop' }, AT)).toBeNull();
  });

  it('tolerates unknown extra fields (looseObject — wire has no stability guarantee)', () => {
    expect(
      normalizeHookEvent(
        {
          session_id: SID,
          hook_event_name: 'Stop',
          stop_hook_active: true,
          some_future_field: { nested: 1 },
        },
        AT,
      ),
    ).toMatchObject({ kind: 'hookDone' });
  });
});

describe('hooks signal source — server-fed plumbing', () => {
  it('emits normalized events after start, drops bodies before start and after stop', async () => {
    const events: SessionEvent[] = [];
    const source = createHooksSignalSource(normalizeHookEvent);
    const body = { session_id: SID, hook_event_name: 'Stop' };

    source.handleHookBody(body, AT); // before start — dropped
    await source.start((event) => events.push(event));
    source.handleHookBody(body, AT);
    source.handleHookBody({ malformed: true }, AT); // normalizes to null — dropped
    await source.stop();
    source.handleHookBody(body, AT); // after stop — dropped

    expect(events).toEqual([{ kind: 'hookDone', at: AT, sessionId: SID, via: 'Stop' }]);
  });

  it('never throws even when the normalizer does', async () => {
    const source = createHooksSignalSource(() => {
      throw new Error('normalizer exploded');
    });
    await source.start(() => undefined);
    expect(() => {
      source.handleHookBody({ session_id: SID, hook_event_name: 'Stop' }, AT);
    }).not.toThrow();
  });
});

describe('parseClaudeProcesses — portable ps parse + headless double filter (M2-end)', () => {
  it('keeps interactive claude processes on macOS-shaped output', () => {
    const macOut = [
      '  501     1 ttys012    01:02:03 /usr/local/bin/claude --resume',
      '  502     1 ??         01:02:03 /usr/local/bin/claude -p generate quest', // headless tty
      '  503     1 ttys013       00:10 node /x/claude-wrapper', // first token is not claude
      '  504     1 ttys014       00:10 claude',
      `  505     1 ttys015       00:10 claude -p --marker ${QUEST_LAUNCH_ARG_MARKER}:abc`, // quest marker
      '  506     1 ttys016       00:10 vim claude-notes.md', // claude not first token
    ].join('\n');

    expect(parseClaudeProcesses(macOut)).toEqual([
      { pid: 501, tty: 'ttys012', args: '/usr/local/bin/claude --resume' },
      { pid: 504, tty: 'ttys014', args: 'claude' },
    ]);
  });

  it('keeps interactive claude processes on Linux-shaped output (pts/N, single ?)', () => {
    const linuxOut = [
      ' 1201  1200 pts/3      01:02 /home/me/.local/bin/claude',
      ' 1202  1200 ?          01:02 claude', // headless tty (Linux spelling)
      ' 1203  1200 pts/4      01:02 /usr/bin/claudette serve', // claudette ≠ claude
      'garbage line that does not parse',
      '',
    ].join('\n');

    expect(parseClaudeProcesses(linuxOut)).toEqual([
      { pid: 1201, tty: 'pts/3', args: '/home/me/.local/bin/claude' },
    ]);
  });
});

describe('createPsPollSource — discovery & kill -9 reaping (M2-end)', () => {
  const psLine = (pid: number, args: string): string =>
    `  ${String(pid)}     1 ttys000  01:02 ${args}`;

  it('emits processDiscovered for live pids (re-emitted every sweep) and processGone when a pid vanishes', async () => {
    const outputs = [
      [psLine(901, 'claude'), psLine(902, '/usr/local/bin/claude --resume')].join('\n'),
      psLine(902, '/usr/local/bin/claude --resume'), // 901 killed (kill -9)
    ];
    let call = 0;
    const events: SessionEvent[] = [];
    const source = createPsPollSource({
      execPs: () => Promise.resolve(outputs[Math.min(call++, outputs.length - 1)] ?? ''),
      intervalMs: 5,
      now: () => AT,
    });

    await source.start((event) => events.push(event));
    expect(events).toEqual([
      { kind: 'processDiscovered', at: AT, pid: 901, tty: 'ttys000', cwd: null },
      { kind: 'processDiscovered', at: AT, pid: 902, tty: 'ttys000', cwd: null },
    ]);

    await until(() => events.some((e) => e.kind === 'processGone'));
    await source.stop();

    expect(events.filter((e) => e.kind === 'processGone')).toEqual([
      { kind: 'processGone', at: AT, pid: 901 },
    ]);
    // Survivor 902 was re-announced on the second sweep (per-poll re-evaluation,
    // hud-sessions §12-D2-A3) — the reducer no-ops adopted pids.
    expect(
      events.filter((e) => e.kind === 'processDiscovered' && e.pid === 902).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a failing ps cycle never reaps (no processGone on exec failure)', async () => {
    const out = psLine(903, 'claude');
    let call = 0;
    const events: SessionEvent[] = [];
    const source = createPsPollSource({
      execPs: () => {
        call += 1;
        return call === 2 ? Promise.reject(new Error('ps exploded')) : Promise.resolve(out);
      },
      intervalMs: 5,
      now: () => AT,
    });

    await source.start((event) => events.push(event));
    await until(() => call >= 3);
    await source.stop();

    expect(events.filter((e) => e.kind === 'processGone')).toEqual([]);
    const discoveries = events.filter((e) => e.kind === 'processDiscovered');
    expect(discoveries.length).toBeGreaterThanOrEqual(1); // re-emitted on healthy sweeps
    for (const event of discoveries) {
      expect(event).toEqual({
        kind: 'processDiscovered',
        at: AT,
        pid: 903,
        tty: 'ttys000',
        cwd: null,
      });
    }
  });

  it('collects cwd per pid via the injected readCwd, caches it, and falls back to null on failure', async () => {
    const out = [psLine(910, 'claude'), psLine(911, 'claude')].join('\n');
    const events: SessionEvent[] = [];
    const reads: number[] = [];
    const source = createPsPollSource({
      execPs: () => Promise.resolve(out),
      readCwd: (pid) => {
        reads.push(pid);
        return pid === 910
          ? Promise.resolve('/work/api')
          : Promise.reject(new Error('lsof failed'));
      },
      intervalMs: 60_000,
      now: () => AT,
    });

    await source.start((event) => events.push(event));
    await source.sweepNow(); // second sweep: cwd must come from the cache
    await source.stop();

    expect(events.filter((e) => e.kind === 'processDiscovered' && e.pid === 910)).toEqual([
      { kind: 'processDiscovered', at: AT, pid: 910, tty: 'ttys000', cwd: '/work/api' },
      { kind: 'processDiscovered', at: AT, pid: 910, tty: 'ttys000', cwd: '/work/api' },
    ]);
    expect(events.filter((e) => e.kind === 'processDiscovered' && e.pid === 911)).toEqual([
      { kind: 'processDiscovered', at: AT, pid: 911, tty: 'ttys000', cwd: null },
      { kind: 'processDiscovered', at: AT, pid: 911, tty: 'ttys000', cwd: null },
    ]);
    expect(reads.sort()).toEqual([910, 911]); // one readCwd per pid — cached afterwards
  });
});
