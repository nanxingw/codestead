/**
 * CLI integration contract — the composition root (src/cli.ts) is where the
 * lanes meet: signal sources → reducer → diff → WS broadcast, plus runtime
 * file, installer and recorder command surfaces.
 *
 * HARD RULE: every command here runs against a mkdtemp() home — the real
 * `~/.claude` / `~/.codestead` are never read or written. Ports are
 * OS-assigned (`basePort: 0`), `ps` is canned, shutdown is injected.
 */
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDSHAKE_PATH,
  HOOKS_PATH,
  HandshakeResponseSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ServerMessage,
} from '@codestead/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { INSTALL_HOOKS_URL, runCli, type CliDeps } from '../src/cli.js';
import { HOOK_EVENTS, isCodesteadHookEntry } from '../src/install/installer.js';

const tempDirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codestead-cli-'));
  tempDirs.push(dir);
  return dir;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface TestCli {
  readonly deps: CliDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly shutdown: () => void;
}

function testCli(homeDir: string): TestCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const gate = deferred();
  return {
    deps: {
      homeDir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      waitForShutdown: () => gate.promise,
      execPs: () => Promise.resolve(''), // no claude processes in tests
      basePort: 0, // OS-assigned — never collides with a real daemon
    },
    stdout,
    stderr,
    shutdown: gate.resolve,
  };
}

describe('cli — start (composition root, end to end)', () => {
  it('rebuilds from transcripts, serves handshake+WS, broadcasts hook-driven frames, cleans up', async () => {
    const home = await tempHome();
    // §7.4-4 seed: one fresh transcript → rebuilt as working(transcript).
    const projectDir = join(home, '.claude', 'projects', '-tmp-rebuilt-proj');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'sess-rebuilt.jsonl'),
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Rebuilt session' })}\n`,
      'utf8',
    );

    const cli = testCli(home);
    const exitPromise = runCli(['start'], cli.deps);

    // The runtime file appears once the server is bound (port + token for CLI tools).
    const runtimeFile = join(home, '.codestead', 'daemon.json');
    await until(() => existsSync(runtimeFile));
    const runtime = JSON.parse(await readFile(runtimeFile, 'utf8')) as {
      port: number;
      wsPath: string;
      token: string;
      pid: number;
    };
    expect(runtime.pid).toBe(process.pid);
    expect(runtime.port).toBeGreaterThan(0);

    // Discovery: GET /handshake matches the runtime file.
    const res = await fetch(`http://127.0.0.1:${String(runtime.port)}${HANDSHAKE_PATH}`);
    const handshake = HandshakeResponseSchema.parse(await res.json());
    expect(handshake.port).toBe(runtime.port);
    expect(handshake.token).toBe(runtime.token);
    expect(handshake.wsPath).toBe(runtime.wsPath);

    // WS: auth → hello → snapshot (snapshot already carries the rebuilt session).
    const ws = new WebSocket(`ws://127.0.0.1:${String(runtime.port)}${runtime.wsPath}`);
    sockets.push(ws);
    const frames: ServerMessage[] = [];
    ws.on('message', (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : data.toString('utf8');
      frames.push(ServerMessageSchema.parse(JSON.parse(text)));
    });
    await once(ws, 'open');
    ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'auth', payload: { token: handshake.token } }),
    );
    await until(() => frames.length >= 2);
    expect(frames[0]?.type).toBe('hello');
    const snapshot = frames[1];
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot as second frame');
    const rebuilt = snapshot.payload.sessions.find((s) => s.sessionId === 'sess-rebuilt');
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.state).toBe('working');
    expect(rebuilt?.source).toBe('transcript');
    expect(rebuilt?.title).toBe('Rebuilt session');

    // Live hook POST → hooks source → reducer → sessionUpsert broadcast (row 1).
    const postHook = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(runtime.port)}${HOOKS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (
        await postHook({
          hook_event_name: 'SessionStart',
          session_id: 'sess-live',
          source: 'startup',
          cwd: '/tmp/live-proj',
        })
      ).status,
    ).toBe(204);
    await until(() =>
      frames.some((f) => f.type === 'sessionUpsert' && f.payload.session.sessionId === 'sess-live'),
    );
    const upsert = frames.find(
      (f) => f.type === 'sessionUpsert' && f.payload.session.sessionId === 'sess-live',
    );
    if (upsert?.type !== 'sessionUpsert') throw new Error('expected sessionUpsert');
    expect(upsert.payload.session.state).toBe('idle'); // §7.3 row 1
    expect(upsert.payload.session.source).toBe('hooks');
    expect(upsert.payload.session.cwd).toBe('/tmp/live-proj');

    // Row 8: SessionEnd → sessionRemoved broadcast.
    await postHook({ hook_event_name: 'SessionEnd', session_id: 'sess-live', reason: 'exit' });
    await until(() =>
      frames.some((f) => f.type === 'sessionRemoved' && f.payload.sessionId === 'sess-live'),
    );

    // Clean shutdown: exit 0 and the runtime file is gone (no stale advertising).
    ws.terminate();
    cli.shutdown();
    expect(await exitPromise).toBe(0);
    expect(existsSync(runtimeFile)).toBe(false);
  });
});

describe('cli — install / uninstall (temp home only)', () => {
  it('dry-run writes nothing; install marks entries and preserves user hooks; uninstall removes only ours', async () => {
    const home = await tempHome();
    const settingsFile = join(home, '.claude', 'settings.json');
    const backupFile = join(home, '.claude', 'settings.json.codestead-bak');
    await mkdir(join(home, '.claude'), { recursive: true });
    const userSettings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
    };
    await writeFile(settingsFile, `${JSON.stringify(userSettings, null, 2)}\n`, 'utf8');
    const before = await readFile(settingsFile, 'utf8');

    // --dry-run: diff on stdout, file byte-identical, no backup.
    const dry = testCli(home);
    expect(await runCli(['install', '--dry-run'], dry.deps)).toBe(0);
    expect(dry.stdout.join('\n')).toContain('dry-run');
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(existsSync(backupFile)).toBe(false);

    // Real install: all 10 events get a marker-recognized http entry at the pinned URL.
    const inst = testCli(home);
    expect(await runCli(['install'], inst.deps)).toBe(0);
    const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    for (const event of HOOK_EVENTS) {
      const groups = settings.hooks[event] ?? [];
      const entries = groups.flatMap((g) => g.hooks);
      const marked = entries.filter((e) => isCodesteadHookEntry(e));
      expect(marked).toHaveLength(1);
      expect(marked[0]?.['url']).toBe(INSTALL_HOOKS_URL);
    }
    // Constraint ③: the user's Stop hook keeps its position; constraint ①: backup.
    expect(JSON.stringify(settings.hooks['Stop']?.[0])).toContain('echo user-hook');
    expect(await readFile(backupFile, 'utf8')).toBe(before);

    // Idempotent re-run reports no changes.
    const again = testCli(home);
    expect(await runCli(['install'], again.deps)).toBe(0);
    expect(again.stdout.join('\n')).toContain('already installed');

    // Uninstall removes ONLY marked entries; user hook and backup survive.
    const unin = testCli(home);
    expect(await runCli(['uninstall'], unin.deps)).toBe(0);
    const after = await readFile(settingsFile, 'utf8');
    expect(after).not.toContain(INSTALL_HOOKS_URL);
    expect(after).toContain('echo user-hook');
    expect(existsSync(backupFile)).toBe(true);
  });

  it('corrupt settings fail safely: non-zero exit, file untouched', async () => {
    const home = await tempHome();
    const settingsFile = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsFile, '{ not json', 'utf8');

    const cli = testCli(home);
    expect(await runCli(['install'], cli.deps)).toBe(1);
    expect(cli.stderr.join('\n')).toContain('install failed');
    expect(await readFile(settingsFile, 'utf8')).toBe('{ not json');
  });
});

describe('cli — record', () => {
  it('records raw hook bodies to JSONL and reports the count on shutdown', async () => {
    const home = await tempHome();
    const outFile = join(home, 'recording.jsonl');

    const cli = testCli(home);
    const exitPromise = runCli(['record', outFile, '0'], cli.deps);
    await until(() => cli.stdout.some((l) => l.includes('listening')));
    const m = /127\.0\.0\.1:(\d+)/.exec(cli.stdout.join('\n'));
    const port = Number(m?.[1]);
    expect(port).toBeGreaterThan(0);

    const body = { hook_event_name: 'Stop', session_id: 'sess-rec', extra: 'kept-verbatim' };
    const res = await fetch(`http://127.0.0.1:${String(port)}${HOOKS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
    await until(() => existsSync(outFile));

    cli.shutdown();
    expect(await exitPromise).toBe(0);
    const lines = (await readFile(outFile, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    const recorded = JSON.parse(lines[0] ?? '') as { body: unknown; scrubbed: boolean };
    expect(recorded.scrubbed).toBe(false);
    expect(recorded.body).toEqual(body);
    expect(cli.stdout.join('\n')).toContain('1 event(s) recorded');
  });

  it('record without an outFile prints usage and exits 1', async () => {
    const cli = testCli(await tempHome());
    expect(await runCli(['record'], cli.deps)).toBe(1);
    expect(cli.stderr.join('\n')).toContain('usage');
  });
});

describe('cli — argument surface', () => {
  it('unknown / missing command prints usage and exits 1', async () => {
    const home = await tempHome();
    for (const argv of [[], ['frobnicate']]) {
      const cli = testCli(home);
      expect(await runCli(argv, cli.deps)).toBe(1);
      expect(cli.stderr.join('\n')).toContain('usage: codestead');
    }
  });
});
