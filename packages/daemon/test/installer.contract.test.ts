/**
 * Installer black-box contract (PRD 03 testing decision 5): external behavior
 * = settings file before/after, against TEMP-DIR fixtures ONLY (hard rule —
 * the real ~/.claude is never touched by tests).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOOK_EVENTS,
  HOOK_TIMEOUT_SECONDS,
  InstallerError,
  installHooks,
  isCodesteadHookEntry,
  uninstallHooks,
} from '../src/install/installer.js';
import { startHookRecorder, type HookRecorder } from '../src/install/recorder.js';

const HOOKS_URL = 'http://127.0.0.1:43110/hooks';

const tempDirs: string[] = [];
const recorders: HookRecorder[] = [];

afterEach(async () => {
  await Promise.all(recorders.splice(0).map((r) => r.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface TempInstall {
  readonly settingsFile: string;
  readonly backupFile: string;
  readonly hooksUrl: string;
}

async function tempInstallOpts(): Promise<TempInstall> {
  const dir = await mkdtemp(join(tmpdir(), 'codestead-installer-'));
  tempDirs.push(dir);
  return {
    settingsFile: join(dir, '.claude', 'settings.json'),
    backupFile: join(dir, '.claude', 'settings.json.codestead-bak'),
    hooksUrl: HOOKS_URL,
  };
}

async function seedSettings(file: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf8');
  return content;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const userStopHook = {
  matcher: '',
  hooks: [{ type: 'command', command: 'echo done', timeout: 10 }],
};

function codesteadEntriesIn(settings: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = (group as { hooks?: unknown[] }).hooks;
      if (!Array.isArray(entries)) continue;
      found.push(...entries.filter((e) => isCodesteadHookEntry(e)));
    }
  }
  return found;
}

describe('installHooks / uninstallHooks — file before/after (temp dirs only)', () => {
  it('first install creates settings.json.codestead-bak before writing (constraint ①)', async () => {
    const opts = await tempInstallOpts();
    const original = await seedSettings(opts.settingsFile, {
      theme: 'dark',
      hooks: { Stop: [userStopHook] },
    });

    const result = await installHooks(opts);

    expect(result.changed).toBe(true);
    expect(result.backupCreated).toBe(true);
    expect(await readFile(opts.backupFile, 'utf8')).toBe(original); // byte-exact pre-write copy
    expect(await readFile(opts.settingsFile, 'utf8')).not.toBe(original);
  });

  it('an existing backup is never overwritten by later installs', async () => {
    const opts = await tempInstallOpts();
    const original = await seedSettings(opts.settingsFile, { hooks: { Stop: [userStopHook] } });
    await installHooks(opts);

    // User edits their settings after the first install…
    const edited = await readJson(opts.settingsFile);
    edited['model'] = 'opus';
    await writeFile(opts.settingsFile, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');

    const second = await installHooks(opts);

    expect(second.backupCreated).toBe(false);
    expect(await readFile(opts.backupFile, 'utf8')).toBe(original); // still the FIRST pre-write copy
  });

  it('re-running install is idempotent — settings file is byte-identical', async () => {
    const opts = await tempInstallOpts();
    await seedSettings(opts.settingsFile, { theme: 'dark', hooks: { Stop: [userStopHook] } });

    await installHooks(opts);
    const afterFirst = await readFile(opts.settingsFile, 'utf8');
    const second = await installHooks(opts);

    expect(second.changed).toBe(false);
    expect(await readFile(opts.settingsFile, 'utf8')).toBe(afterFirst);
  });

  it('existing user hooks on the same event are preserved; codestead entries are appended (constraint ③)', async () => {
    const opts = await tempInstallOpts();
    await seedSettings(opts.settingsFile, { hooks: { Stop: [userStopHook] } });

    await installHooks(opts);

    const settings = await readJson(opts.settingsFile);
    const stopGroups = (settings['hooks'] as Record<string, unknown>)['Stop'] as unknown[];
    expect(stopGroups[0]).toEqual(userStopHook); // user group untouched, still first
    expect(stopGroups).toHaveLength(2);
    expect(stopGroups[1]).toEqual({
      hooks: [{ type: 'http', url: HOOKS_URL, timeout: HOOK_TIMEOUT_SECONDS }],
    });
  });

  it('installed entries are http-type, point at the hooks URL, timeout 3s, and cover exactly HOOK_EVENTS', async () => {
    const opts = await tempInstallOpts(); // no pre-existing settings file at all
    const result = await installHooks(opts);

    expect(result.changed).toBe(true);
    expect(result.backupCreated).toBe(false); // nothing existed to back up
    expect([...result.eventsInstalled]).toEqual([...HOOK_EVENTS]);

    const settings = await readJson(opts.settingsFile);
    const hooks = settings['hooks'] as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event] as unknown[];
      expect(groups).toEqual([
        { hooks: [{ type: 'http', url: HOOKS_URL, timeout: HOOK_TIMEOUT_SECONDS }] },
      ]);
      expect(isCodesteadHookEntry((groups[0] as { hooks: unknown[] }).hooks[0])).toBe(true);
    }
  });

  it('uninstall removes only marked (isCodesteadHookEntry) entries and keeps user hooks (constraint ②)', async () => {
    const opts = await tempInstallOpts();
    const original = await seedSettings(opts.settingsFile, {
      theme: 'dark',
      hooks: {
        Stop: [userStopHook],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo compacting' }] }],
      },
    });
    await installHooks(opts);

    const result = await uninstallHooks(opts);

    expect(result.changed).toBe(true);
    expect(result.entriesRemoved).toBe(HOOK_EVENTS.length);
    const settings = await readJson(opts.settingsFile);
    expect(codesteadEntriesIn(settings)).toHaveLength(0);
    const hooks = settings['hooks'] as Record<string, unknown>;
    expect(hooks['Stop']).toEqual([userStopHook]); // user hooks intact
    expect(hooks['PreCompact']).toEqual([
      { hooks: [{ type: 'command', command: 'echo compacting' }] },
    ]);
    expect(settings['theme']).toBe('dark');
    // The backup is deliberately preserved across uninstall (PRD 03 US50).
    expect(await readFile(opts.backupFile, 'utf8')).toBe(original);
  });

  it('corrupted settings JSON → safe failure: no write, file untouched, clear error', async () => {
    const opts = await tempInstallOpts();
    await mkdir(join(opts.settingsFile, '..'), { recursive: true });
    const corrupt = '{ "hooks": [unclosed';
    await writeFile(opts.settingsFile, corrupt, 'utf8');

    await expect(installHooks(opts)).rejects.toThrowError(InstallerError);
    await expect(installHooks(opts)).rejects.toThrow(/not valid JSON/);
    await expect(uninstallHooks(opts)).rejects.toThrowError(InstallerError);

    expect(await readFile(opts.settingsFile, 'utf8')).toBe(corrupt); // untouched
    expect(await fileExists(opts.backupFile)).toBe(false); // no backup of garbage
  });

  it('uninstall on a file without codestead entries changes nothing (not even formatting)', async () => {
    const opts = await tempInstallOpts();
    const original = `{"hooks":{"Stop":[${JSON.stringify(userStopHook)}]}}`; // deliberately compact
    await mkdir(join(opts.settingsFile, '..'), { recursive: true });
    await writeFile(opts.settingsFile, original, 'utf8');

    const result = await uninstallHooks(opts);

    expect(result).toEqual({ changed: false, entriesRemoved: 0 });
    expect(await readFile(opts.settingsFile, 'utf8')).toBe(original);
  });

  it('uninstall of a pure codestead install returns the file to a hookless state', async () => {
    const opts = await tempInstallOpts();
    await installHooks(opts); // fresh file, only our entries
    const result = await uninstallHooks(opts);

    expect(result.changed).toBe(true);
    expect(result.entriesRemoved).toBe(HOOK_EVENTS.length);
    expect(await readJson(opts.settingsFile)).toEqual({}); // hooks key removed entirely
  });

  it('rejects a hooksUrl the uninstall marker would not recognize (marker centralization)', async () => {
    const opts = await tempInstallOpts();
    for (const badUrl of [
      'http://127.0.0.1:9999/hooks', // outside the 43110–43119 window
      'http://localhost:43110/hooks', // wrong literal host
      'https://127.0.0.1:43110/hooks', // wrong scheme
      'http://127.0.0.1:43110/other', // wrong path
    ]) {
      await expect(installHooks({ ...opts, hooksUrl: badUrl })).rejects.toThrow(
        /not a codestead hooks endpoint/,
      );
    }
    expect(await fileExists(opts.settingsFile)).toBe(false); // nothing was written
  });

  it('isCodesteadHookEntry recognizes exactly the http entries in the port window', () => {
    const entry = (url: string): unknown => ({ type: 'http', url, timeout: 3 });
    expect(isCodesteadHookEntry(entry('http://127.0.0.1:43110/hooks'))).toBe(true);
    expect(isCodesteadHookEntry(entry('http://127.0.0.1:43119/hooks'))).toBe(true);
    expect(isCodesteadHookEntry(entry('http://127.0.0.1:43120/hooks'))).toBe(false);
    expect(isCodesteadHookEntry(entry('http://127.0.0.1:43109/hooks'))).toBe(false);
    expect(
      isCodesteadHookEntry({ type: 'command', command: 'curl http://127.0.0.1:43110/hooks' }),
    ).toBe(false);
    expect(isCodesteadHookEntry('http://127.0.0.1:43110/hooks')).toBe(false);
    expect(isCodesteadHookEntry(null)).toBe(false);
  });
});

describe('installHooks / uninstallHooks — dry-run prints a diff and writes nothing', () => {
  it('install dry-run returns a diff with the would-be entries and leaves all files untouched', async () => {
    const opts = await tempInstallOpts();
    const original = await seedSettings(opts.settingsFile, { hooks: { Stop: [userStopHook] } });

    const result = await installHooks({ ...opts, dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.backupCreated).toBe(false);
    expect(result.diff).toMatch(/^\+ +"url": "http:\/\/127\.0\.0\.1:43110\/hooks",$/m);
    expect(result.diff).not.toMatch(/^- .*command/m); // pure addition, user lines not removed
    expect(await readFile(opts.settingsFile, 'utf8')).toBe(original);
    expect(await fileExists(opts.backupFile)).toBe(false);
  });

  it('uninstall dry-run returns a removal diff and leaves the file untouched', async () => {
    const opts = await tempInstallOpts();
    await installHooks(opts);
    const installed = await readFile(opts.settingsFile, 'utf8');

    const result = await uninstallHooks({ ...opts, dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.entriesRemoved).toBe(HOOK_EVENTS.length);
    expect(result.diff).toMatch(/^- +"url": "http:\/\/127\.0\.0\.1:43110\/hooks",$/m);
    expect(await readFile(opts.settingsFile, 'utf8')).toBe(installed);
  });

  it('dry-run on an already-installed file reports changed=false with an empty diff', async () => {
    const opts = await tempInstallOpts();
    await installHooks(opts);
    const result = await installHooks({ ...opts, dryRun: true });
    expect(result.changed).toBe(false);
    expect(result.diff).toBe('');
  });
});

describe('hook event recorder (first M2 deliverable)', () => {
  async function tempOutFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'codestead-recorder-'));
    tempDirs.push(dir);
    return join(dir, 'hooks-raw.jsonl');
  }

  async function startRecorder(
    outFile: string,
    extra: { basePort?: number; maxPort?: number; now?: () => number } = {},
  ): Promise<HookRecorder> {
    const recorder = await startHookRecorder({ outFile, basePort: 0, ...extra });
    recorders.push(recorder);
    return recorder;
  }

  it('records each POSTed hook body as one JSONL line with ISO timestamp', async () => {
    const outFile = await tempOutFile();
    const at = Date.UTC(2026, 5, 10, 9, 0, 0);
    const recorder = await startRecorder(outFile, { now: () => at });

    const bodyA = { session_id: 's-1', hook_event_name: 'Stop', cwd: '/tmp/p' };
    const bodyB = { session_id: 's-2', hook_event_name: 'UserPromptSubmit', prompt: 'secret' };
    for (const body of [bodyA, bodyB]) {
      await fetch(`http://127.0.0.1:${String(recorder.port)}/hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const lines = (await readFile(outFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { at: string; body: unknown });
    expect(parsed[0].at).toBe('2026-06-10T09:00:00.000Z');
    expect(parsed[0].body).toEqual(bodyA);
    expect(parsed[1].body).toEqual(bodyB); // verbatim — scrubbing is a separate explicit step
    expect(recorder.eventCount()).toBe(2);
  });

  it('always answers an empty 2xx, like the daemon hooks endpoint', async () => {
    const outFile = await tempOutFile();
    const recorder = await startRecorder(outFile);
    const base = `http://127.0.0.1:${String(recorder.port)}`;

    const hookRes = await fetch(`${base}/hooks`, { method: 'POST', body: '{"a":1}' });
    expect(hookRes.status).toBeGreaterThanOrEqual(200);
    expect(hookRes.status).toBeLessThan(300);
    expect(await hookRes.text()).toBe(''); // empty body — listen-only, no decision fields

    // Even malformed bodies and unrelated requests never get a non-2xx (never block Claude Code).
    const malformed = await fetch(`${base}/hooks`, { method: 'POST', body: 'not json' });
    expect(malformed.status).toBeGreaterThanOrEqual(200);
    expect(malformed.status).toBeLessThan(300);
    const other = await fetch(`${base}/handshake`);
    expect(other.status).toBeGreaterThanOrEqual(200);
    expect(other.status).toBeLessThan(300);
    expect(await other.text()).toBe('');

    expect(recorder.eventCount()).toBe(2); // only POST /hooks is recorded
  });

  it('marks lines scrubbed=false so unscrubbed fixtures are detectable before commit (privacy red line)', async () => {
    const outFile = await tempOutFile();
    const recorder = await startRecorder(outFile);
    await fetch(`http://127.0.0.1:${String(recorder.port)}/hooks`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 's-1', hook_event_name: 'Stop' }),
    });

    const line = JSON.parse((await readFile(outFile, 'utf8')).trim()) as { scrubbed: boolean };
    expect(line.scrubbed).toBe(false);
  });

  it('increments to the next port when the base port is taken (daemon window semantics)', async () => {
    const outFile = await tempOutFile();
    const first = await startRecorder(outFile); // occupies an OS-assigned port
    const second = await startRecorder(outFile, {
      basePort: first.port,
      maxPort: first.port + 9,
    });
    expect(second.port).toBeGreaterThan(first.port);
    expect(second.port).toBeLessThanOrEqual(first.port + 9);
  });
});
