/**
 * ps polling signal source — discovery & reaping (priority 'process', the
 * lowest). M2-END deliverable (hud-sessions §7 分期注记; PRD 03 impl. decision 6):
 * the first M2 version ships WITHOUT this source and approximates reaping via
 * idle ≥12h (state/types.ts IDLE_REAP_APPROX_MS).
 *
 * Contract (tech-stack §4.1-2, decided — do not redesign):
 * - every 2s (PS_POLL_INTERVAL_MS) spawn `ps -axo pid=,ppid=,tty=,etime=,args=`
 *   itself (NO ps-list dependency — runtime deps are ws + zod only);
 * - a claude process = first token of args matches /(^|\/)claude( |$)/;
 * - HEADLESS FILTER (hud-sessions §12-D2-A4, the M4 isolation guarantee):
 *   tty `??` / `?` is excluded, AND processes carrying the codestead quest
 *   launch-arg marker are excluded — double filter; quest sessions must be
 *   architecturally unable to reach the HUD;
 * - cwd is NOT observable from ps output: it is collected best-effort per pid
 *   via the injected `readCwd` (macOS `lsof -p <pid> -a -d cwd`, Linux
 *   `readlink /proc/<pid>/cwd` — wired in cli.ts), cached per pid, null on
 *   failure (hud-sessions §12-D2-A3). This is what lets the reducer associate
 *   a pid with a hooks/transcript session by cwd, which in turn is what makes
 *   kill -9 reaping (row 14) cover those sessions;
 * - emits `processDiscovered` for EVERY live claude pid on EVERY sweep — not
 *   only newly seen ones — so the reducer re-evaluates association/hold-back
 *   each poll (adopted pids are an idempotent no-op there, §12-D2-A3); emits
 *   `processGone` when a previously seen pid vanishes (row 14).
 *
 * `execPs`/`readCwd` are injected so tests feed canned output — no real
 * processes. `sweepNow()` is a test seam for deterministic polling.
 */
import { PS_POLL_INTERVAL_MS } from '../state/types.js';
import type { SignalEmit, SignalSource } from './types.js';

export const PS_ARGS: readonly string[] = ['-axo', 'pid=,ppid=,tty=,etime=,args='];

/**
 * Launch-arg marker for codestead's own headless quest sessions (M4) — the
 * second leg of the double filter (hud-sessions §12-D2-A4). The M4 spawner
 * MUST include this token somewhere in the spawned argv; any ps row whose args
 * contain it is excluded here, so quest sessions are architecturally unable to
 * reach the HUD even if the tty rule ever mis-fires.
 */
export const QUEST_LAUNCH_ARG_MARKER = 'codestead-quest';

/** A claude process = FIRST TOKEN of args matches this (tech-stack §4.1-2). */
const CLAUDE_FIRST_TOKEN_RE = /(^|\/)claude( |$)/;

/** Detached/headless tty markers: `??` on macOS, `?` on Linux. */
const HEADLESS_TTYS = new Set(['??', '?']);

/** Parsed, already-filtered candidate row of ps output. */
export interface DiscoveredClaudeProcess {
  readonly pid: number;
  readonly tty: string;
  readonly args: string;
}

/**
 * Pure parse + filter of raw `ps` output (interactive claude processes only).
 * Table-driven tests cover the regex and the tty/marker double filter on
 * macOS- and Linux-shaped output (CI matrix obligation, tech-stack risk #12).
 */
export function parseClaudeProcesses(psOutput: string): DiscoveredClaudeProcess[] {
  const out: DiscoveredClaudeProcess[] = [];
  for (const raw of psOutput.split('\n')) {
    // Columns (PS_ARGS): pid ppid tty etime args… — args is everything after etime.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const tty = m[3] ?? '';
    const args = (m[5] ?? '').trim();
    const firstToken = args.split(/\s+/, 1)[0] ?? '';
    if (!CLAUDE_FIRST_TOKEN_RE.test(firstToken)) continue;
    if (HEADLESS_TTYS.has(tty)) continue; // headless filter leg 1 (tty rule)
    if (args.includes(QUEST_LAUNCH_ARG_MARKER)) continue; // leg 2 (launch-arg marker)
    out.push({ pid, tty, args });
  }
  return out;
}

export interface PsPollOptions {
  /** Injected runner for `ps ${PS_ARGS}` — canned output in tests. */
  readonly execPs: () => Promise<string>;
  /**
   * Best-effort per-pid cwd collection (hud-sessions §12-D2-A3); cached per
   * pid (claude does not chdir mid-session), null when unobservable. Omitted
   * (tests) ⇒ every pid resolves to null.
   */
  readonly readCwd?: (pid: number) => Promise<string | null>;
  readonly intervalMs?: number; // default PS_POLL_INTERVAL_MS
  readonly now: () => number;
}

/** SignalSource plus the deterministic-polling test seam. */
export interface PsPollSource extends SignalSource {
  /** Run one sweep now (awaits cwd collection + emits) — tests only. */
  sweepNow(): Promise<void>;
}

export function createPsPollSource(opts: PsPollOptions): PsPollSource {
  const { execPs, now } = opts;
  const readCwd = opts.readCwd ?? (() => Promise.resolve<string | null>(null));
  const intervalMs = opts.intervalMs ?? PS_POLL_INTERVAL_MS;

  let emit: SignalEmit | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sweeping = false;
  /** pids seen on the previous sweep — the diff basis for `processGone`. */
  let seen = new Set<number>();
  /** Per-pid cwd cache (null = collection failed; kept — no per-sweep retry storm). */
  const cwdCache = new Map<number, string | null>();

  async function sweep(): Promise<void> {
    const emitFn = emit;
    if (emitFn === null || sweeping) return;
    sweeping = true;
    try {
      const current = parseClaudeProcesses(await execPs());
      const currentPids = new Set(current.map((p) => p.pid));
      // Collect cwd for pids we have not resolved yet (best-effort, §12-D2-A3).
      for (const proc of current) {
        if (!cwdCache.has(proc.pid)) {
          let cwd: string | null = null;
          try {
            cwd = await readCwd(proc.pid);
          } catch {
            cwd = null;
          }
          cwdCache.set(proc.pid, cwd);
        }
      }
      const at = now();
      for (const proc of current) {
        // Row 12: discovery — re-emitted EVERY sweep so the reducer re-evaluates
        // cwd association / hold-back each poll (adopted pids no-op there).
        emitFn({
          kind: 'processDiscovered',
          at,
          pid: proc.pid,
          tty: proc.tty,
          cwd: cwdCache.get(proc.pid) ?? null,
        });
      }
      for (const pid of seen) {
        // Row 14: kill -9 reaping — the pid vanished from ps.
        if (!currentPids.has(pid)) {
          emitFn({ kind: 'processGone', at, pid });
          cwdCache.delete(pid);
        }
      }
      seen = currentPids;
    } catch {
      // ps failed this cycle — keep the previous view; NEVER reap on exec
      // failure (a broken ps must not deregister live sessions).
    } finally {
      sweeping = false;
    }
  }

  return {
    name: 'process',

    async start(emitFn: SignalEmit): Promise<void> {
      emit = emitFn;
      await sweep(); // immediate first sweep, then steady cadence
      timer = setInterval(() => void sweep(), intervalMs);
      timer.unref();
    },

    stop(): Promise<void> {
      if (timer !== null) clearInterval(timer);
      timer = null;
      emit = null;
      return Promise.resolve();
    },

    sweepNow(): Promise<void> {
      return sweep();
    },
  };
}
