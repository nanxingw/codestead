/**
 * CLI surface (tech-stack §3: `codestead start / install / uninstall`, plus
 * `record` — the M2 recorder). The npm `bin` wiring happens at M5 (PRD 06);
 * during M2 the entry stays `src/index.ts` + this exported runner (the real
 * argv entry for `pnpm dev` etc. is `src/cli-main.ts`).
 *
 * `homeDir` is an explicit dependency: ONLY the real bin entry passes
 * `os.homedir()`. Tests pass temp dirs — nothing in this package defaults to
 * the real `~/.claude` / `~/.codestead` (hard rule; resolveCodesteadPaths).
 *
 * `start` is THE composition root of the daemon (the seam the server/state
 * lanes left to integration): signal sources → normalized SessionEvents →
 * reduceSessions → diffSessionTables → WS broadcast frames. Nothing else in
 * the package wires these together.
 *
 * Integration decisions recorded here (implementation choices, not design law):
 * - TICK_INTERVAL_MS = 5s: §7.3 rows 10/11 compare event `at` against
 *   `lastSignalAt` (90s / 30min thresholds live in state/types.ts); the sweep
 *   cadence only bounds detection latency and is not pinned by the design docs.
 * - DEV_ALLOWED_ORIGINS: the dev-time Vite origin whitelist (tech-stack
 *   §4.1-5 — “开发期放行 Vite origin”; M5 switches to same-origin hosting).
 * - `install` writes the design-pinned base-port URL
 *   `http://127.0.0.1:43110/hooks` (tech-stack §4.1-1) — NOT the currently
 *   bound port; the marker window 43110–43119 keeps uninstall/reinstall
 *   convergent either way.
 * - PRIVACY: CLI output may contain ports, file paths and counts — never the
 *   token, hook bodies or transcript-derived strings.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import process from 'node:process';

import { DAEMON_HOST, DAEMON_PORT_BASE, HOOKS_PATH, PROTOCOL_VERSION } from '@codestead/shared';
import type { ServerMessage } from '@codestead/shared';

import { resolveCodesteadPaths } from './config/paths.js';
import { createFileDaemonRuntimeStore } from './config/runtime-store.js';
import { generateToken } from './config/token.js';
import { InstallerError, installHooks, uninstallHooks } from './install/installer.js';
import { startHookRecorder } from './install/recorder.js';
import { createDaemonServer } from './server/server.js';
import { normalizeHookEvent } from './signals/hooks-wire.js';
import { createHooksSignalSource } from './signals/hooks.js';
import { PS_ARGS, createPsPollSource } from './signals/ps.js';
import { createTranscriptWatchSource, scanTranscriptsForRebuild } from './signals/transcript.js';
import type { SessionEvent } from './state/events.js';
import { diffSessionTables, reduceSessions } from './state/reducer.js';
import { EMPTY_SESSION_TABLE } from './state/types.js';
import type { SessionTable } from './state/types.js';
import { createUpsertThrottle } from './state/upsert-throttle.js';

export type CliCommand = 'start' | 'install' | 'uninstall' | 'record';

export interface CliDeps {
  readonly homeDir: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  // ---- additive test seams (optional; the real bin entry omits them all) ----
  /** Resolves to trigger graceful shutdown of `start`/`record`; default: SIGINT/SIGTERM. */
  readonly waitForShutdown?: () => Promise<void>;
  /** `ps` runner for the process source; default spawns the real `ps` (read-only). */
  readonly execPs?: () => Promise<string>;
  /** Per-pid cwd reader (§12-D2-A3); default lsof (macOS) / procfs (Linux), read-only. */
  readonly readCwd?: (pid: number) => Promise<string | null>;
  /** Server/recorder port override (0 = OS-assigned, tests only); default 43110 window. */
  readonly basePort?: number;
  readonly now?: () => number;
}

/**
 * Staleness sweep cadence feeding `tick` events into the reducer (§7.3 rows
 * 10–11 + the M2 idle-reap backstop). Implementation choice — see file header.
 */
export const TICK_INTERVAL_MS = 5_000;

/** Dev-time Vite origins allowed on /handshake CORS + WS upgrade (tech-stack §4.1-5). */
export const DEV_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

/** Design-pinned install target (tech-stack §4.1-1): always the base port. */
export const INSTALL_HOOKS_URL = `http://${DAEMON_HOST}:${String(DAEMON_PORT_BASE)}${HOOKS_PATH}`;

const USAGE = [
  'usage: codestead <command>',
  '  start                       start the daemon (hooks + transcript + ps → WS broadcast)',
  '  install [--dry-run]         merge codestead hook entries into <home>/.claude/settings.json',
  '  uninstall [--dry-run]       remove codestead-marked hook entries (user hooks untouched)',
  '  record <out.jsonl> [port]   record raw hook events to a JSONL fixture (scrub before commit)',
];

/**
 * Parse argv (without node/script prefix) and run one command; resolves to a
 * process exit code. Unknown commands print usage and return 1.
 * - start:     resolve paths → token → sources → reducer loop → server; on
 *              startup, rebuild from transcripts (§7.4-4) then serve.
 * - install:   installHooks against resolveCodesteadPaths(homeDir) — the only
 *              user-triggered write path.
 * - uninstall: uninstallHooks (marked entries only).
 * - record:    startHookRecorder writing the given fixture file.
 */
export function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'start':
      return runStart(deps);
    case 'install':
      return runInstall(rest, deps);
    case 'uninstall':
      return runUninstall(rest, deps);
    case 'record':
      return runRecord(rest, deps);
    default: {
      for (const line of USAGE) deps.stderr(line);
      return Promise.resolve(1);
    }
  }
}

// ---------------------------------------------------------------------------
// start — the composition root
// ---------------------------------------------------------------------------

async function runStart(deps: CliDeps): Promise<number> {
  const paths = resolveCodesteadPaths(deps.homeDir);
  const now = deps.now ?? Date.now;
  const token = generateToken();
  const daemonVersion = readOwnVersion();

  // ---- reducer loop: single mutable cell, events in → frames out ----
  let table: SessionTable = EMPTY_SESSION_TABLE;
  let broadcast: ((message: ServerMessage) => void) | null = null;
  // lastSignalAt-only upserts are rate-limited per session (hud-sessions §10.2);
  // heartbeat frames keep liveness, getSnapshot reads the live table.
  const throttleUpserts = createUpsertThrottle();

  const applyEvent = (event: SessionEvent): void => {
    const next = reduceSessions(table, event);
    if (next === table) return; // no-op events produce no frames (reducer contract)
    const patches = throttleUpserts(diffSessionTables(table, next), now());
    table = next;
    if (broadcast === null) return;
    for (const patch of patches) {
      broadcast(
        patch.kind === 'removed'
          ? {
              v: PROTOCOL_VERSION,
              type: 'sessionRemoved',
              payload: { sessionId: patch.sessionId },
            }
          : { v: PROTOCOL_VERSION, type: 'sessionUpsert', payload: { session: patch.session } },
      );
    }
  };

  // ---- restart recovery (§7.4-4): rebuild BEFORE serving, snapshot covers it ----
  for (const event of await scanTranscriptsForRebuild({
    projectsDir: paths.claudeProjectsDir,
    now,
  })) {
    applyEvent(event);
  }
  // First sweep right away so the initial snapshot already reflects staleness
  // (scan events are stamped at=mtime; long-silent sessions degrade, not wake).
  applyEvent({ kind: 'tick', at: now() });

  // ---- signal sources (priority hooks > transcript > process, §7.4-1) ----
  const hooksSource = createHooksSignalSource(normalizeHookEvent);
  const transcriptSource = createTranscriptWatchSource({
    projectsDir: paths.claudeProjectsDir,
    now,
  });
  const psSource = createPsPollSource({
    execPs: deps.execPs ?? defaultExecPs,
    readCwd: deps.readCwd ?? defaultReadCwd,
    now,
  });
  await hooksSource.start(applyEvent);
  await transcriptSource.start(applyEvent);
  await psSource.start(applyEvent); // M2-end tier: rows 12/14 (discovery + kill -9 reaping)

  const tickTimer = setInterval(() => {
    applyEvent({ kind: 'tick', at: now() });
  }, TICK_INTERVAL_MS);
  tickTimer.unref();

  // ---- server + runtime file ----
  const server = await createDaemonServer({
    token,
    daemonVersion,
    allowedOrigins: DEV_ALLOWED_ORIGINS,
    onHookBody: (body, at) => {
      hooksSource.handleHookBody(body, at);
    },
    getSnapshot: () => [...table.values()].map((record) => record.info),
    basePort: deps.basePort,
    now,
  });
  broadcast = (message) => {
    server.broadcast(message);
  };

  const runtimeStore = createFileDaemonRuntimeStore(paths.daemonRuntimeFile);
  await runtimeStore.write({
    port: server.port,
    wsPath: server.wsPath,
    token,
    daemonVersion,
    pid: process.pid,
  });

  deps.stdout(
    `[codestead] daemon ${daemonVersion} listening on ${DAEMON_HOST}:${String(server.port)} (ws ${server.wsPath})`,
  );
  deps.stdout(`[codestead] runtime info written to ${paths.daemonRuntimeFile}`);
  deps.stdout('[codestead] Ctrl-C to stop.');

  await (deps.waitForShutdown ?? waitForSignals)();

  // ---- graceful shutdown: timers → sources → server → runtime file ----
  clearInterval(tickTimer);
  await psSource.stop();
  await transcriptSource.stop();
  await hooksSource.stop();
  await server.close();
  await runtimeStore.remove(); // a stale file must never advertise a dead daemon
  deps.stdout('[codestead] stopped.');
  return 0;
}

/** Real `ps` sweep (read-only; PS_ARGS pinned in signals/ps.ts). */
function defaultExecPs(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('ps', [...PS_ARGS], { maxBuffer: 8 * 1024 * 1024 }, (err, psStdout) => {
      if (err !== null) reject(new Error(`ps failed: ${err.message}`));
      else resolve(psStdout);
    });
  });
}

/**
 * Best-effort per-pid cwd (hud-sessions §12-D2-A3): Linux reads procfs
 * directly; macOS (and other BSDs) spawn `lsof -a -p <pid> -d cwd -Fn`
 * (read-only; `n<path>` field line). null on any failure — the reducer then
 * treats the pid as cwd-unobservable (hold-back path). The ps source caches
 * the result per pid, so lsof runs once per discovered process.
 */
function defaultReadCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return readlink(`/proc/${String(pid)}/cwd`).then(
      (target) => target,
      () => null,
    );
  }
  return new Promise<string | null>((resolve) => {
    execFile(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { maxBuffer: 1024 * 1024 },
      (err, lsofStdout) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        const line = lsofStdout.split('\n').find((l) => l.startsWith('n'));
        resolve(line !== undefined && line.length > 1 ? line.slice(1).trim() : null);
      },
    );
  });
}

function waitForSignals(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      resolve();
    });
    process.once('SIGTERM', () => {
      resolve();
    });
  });
}

/** Daemon version from our own package.json (same source as src/index.ts). */
function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    return typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// install / uninstall — the only user-triggered write paths
// ---------------------------------------------------------------------------

async function runInstall(args: readonly string[], deps: CliDeps): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const paths = resolveCodesteadPaths(deps.homeDir);
  try {
    const result = await installHooks({
      settingsFile: paths.claudeSettingsFile,
      backupFile: paths.claudeSettingsBackupFile,
      hooksUrl: INSTALL_HOOKS_URL,
      dryRun,
    });
    if (dryRun) {
      deps.stdout(`[codestead] install --dry-run — NOTHING written to ${paths.claudeSettingsFile}`);
      deps.stdout(result.changed ? (result.diff ?? '') : '(already installed — no changes)');
      return 0;
    }
    if (!result.changed) {
      deps.stdout(`[codestead] already installed — ${paths.claudeSettingsFile} unchanged`);
      return 0;
    }
    if (result.backupCreated) {
      deps.stdout(`[codestead] backup created: ${paths.claudeSettingsBackupFile}`);
    }
    deps.stdout(
      `[codestead] installed hooks for ${String(result.eventsInstalled.length)} events → ${paths.claudeSettingsFile}`,
    );
    deps.stdout(`[codestead] hook endpoint: ${INSTALL_HOOKS_URL} — run \`codestead start\``);
    return 0;
  } catch (err) {
    deps.stderr(`[codestead] install failed: ${errorMessage(err)}`);
    return 1;
  }
}

async function runUninstall(args: readonly string[], deps: CliDeps): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const paths = resolveCodesteadPaths(deps.homeDir);
  try {
    const result = await uninstallHooks({
      settingsFile: paths.claudeSettingsFile,
      backupFile: paths.claudeSettingsBackupFile,
      hooksUrl: INSTALL_HOOKS_URL,
      dryRun,
    });
    if (dryRun) {
      deps.stdout(
        `[codestead] uninstall --dry-run — NOTHING written to ${paths.claudeSettingsFile}`,
      );
      deps.stdout(result.changed ? (result.diff ?? '') : '(nothing to remove)');
      return 0;
    }
    deps.stdout(
      result.changed
        ? `[codestead] removed ${String(result.entriesRemoved)} codestead hook entr${result.entriesRemoved === 1 ? 'y' : 'ies'} from ${paths.claudeSettingsFile}`
        : `[codestead] nothing to remove — ${paths.claudeSettingsFile} unchanged`,
    );
    return 0;
  } catch (err) {
    deps.stderr(`[codestead] uninstall failed: ${errorMessage(err)}`);
    return 1;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof InstallerError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// record — the M2 fixture recorder (see install/recorder.ts; privacy: raw
// bodies go to the file ONLY, never to stdout; scrub before committing)
// ---------------------------------------------------------------------------

async function runRecord(args: readonly string[], deps: CliDeps): Promise<number> {
  const [outFile, basePortArg] = args;
  if (outFile === undefined || outFile === '') {
    deps.stderr('usage: codestead record <outFile.jsonl> [basePort]');
    return 1;
  }
  let basePort = deps.basePort;
  if (basePortArg !== undefined) {
    basePort = Number(basePortArg);
    if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535) {
      deps.stderr(`[codestead] basePort must be an integer port number, got "${basePortArg}"`);
      return 1;
    }
  }

  const recorder = await startHookRecorder({ outFile, basePort, now: deps.now });
  deps.stdout(
    `[codestead recorder] listening on http://${DAEMON_HOST}:${String(recorder.port)}${HOOKS_PATH}`,
  );
  deps.stdout(`[codestead recorder] appending RAW (scrubbed=false) events to ${outFile}`);
  deps.stdout(
    '[codestead recorder] use Claude Code normally, then Ctrl-C; scrub before committing (test/fixtures/README.md).',
  );

  await (deps.waitForShutdown ?? waitForSignals)();
  await recorder.close();
  deps.stdout(`[codestead recorder] stopped — ${String(recorder.eventCount())} event(s) recorded.`);
  return 0;
}
