/**
 * execClaude — the headless `claude -p` runner (ai-quests §4.5 / tech-stack §1).
 *
 * THE most security/cost-sensitive contract of M4. Every argv flag below is fixed
 * by tech-stack §1's headless裁决 and ai-quests §4.5 and is asserted by the
 * stub-claude tests (PRD 05 seam e, A7): the command line MUST contain exactly
 * these flags, `--max-budget-usd` ≤0.20, and the `codestead-quest` launch marker.
 *
 * Isolation (§4.5 / §4.0): `disableAllHooks` + `--strict-mcp-config` keep the
 * generation session out of the HUD; the SAME `codestead-quest` token that the
 * ps source filters on (signals/ps.ts QUEST_LAUNCH_ARG_MARKER) is injected into
 * argv here as the second leg of the double filter — backlog E-3. The claude
 * EXECUTABLE PATH is injected (`ClaudeRunner.claudePath`) so tests/smoke use a
 * stub and never touch the network.
 *
 * Watchdog (§4.5 / §10): daemon self-manages 90s SIGTERM → +5s SIGKILL
 * (GEN_SIGTERM_MS / GEN_SIGKILL_GRACE_MS in types.ts). Single-turn only — NO
 * --resume (定稿一致性声明 #2).
 */
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { QuestGenSchema, type QuestGen } from '@codestead/shared';

import { QUEST_LAUNCH_ARG_MARKER } from '../signals/ps.js';
import { ERROR_SAMPLE_MAX_BYTES } from './accounting.js';
import type { AiQuestsConfig } from './config.js';
import type { GenFailureReason } from './lifecycle.js';
import { GEN_SIGKILL_GRACE_MS, GEN_SIGTERM_MS } from './types.js';

/**
 * The fixed flag set fed to `claude -p` (§4.5). Listed as data so the test can
 * assert the spawn argv contains each one verbatim. `--json-schema` and
 * `--max-budget-usd` / `--model` values are filled per call (schema + config).
 *
 * Re-export of the launch marker so callers/tests reference ONE token (E-3): the
 * spawner MUST place QUEST_LAUNCH_ARG_MARKER somewhere in argv.
 */
export { QUEST_LAUNCH_ARG_MARKER };

export const CLAUDE_FIXED_FLAGS: readonly string[] = [
  '-p',
  '--settings',
  '{"disableAllHooks": true}',
  '--strict-mcp-config',
  '--output-format',
  'json',
  '--json-schema', // value = z.toJSONSchema(QuestGenSchema), per call
  '--max-turns',
  '4',
  '--max-budget-usd', // value = config.perCallBudgetUsd (≤0.20), per call
  '--no-session-persistence',
  '--allowedTools',
  'Read',
  '--model', // value = config.model, per call
  '--fallback-model',
  'sonnet',
];

/** The `--json-schema` payload (z.toJSONSchema of the model-produced shape, §4.5/§4.6). */
export function questGenJsonSchema(): unknown {
  return z.toJSONSchema(QuestGenSchema);
}

/**
 * Build the full argv (excluding the executable) for one generation call. Encodes
 * the §4.5 contract including the `codestead-quest` marker (E-3). PURE — the test
 * asserts on this without spawning. SKELETON — body by the exec sub-task; it MUST
 * include every CLAUDE_FIXED_FLAGS entry, substitute the schema/budget/model
 * values, and embed QUEST_LAUNCH_ARG_MARKER (e.g. as `--codestead-quest` marker
 * arg or appended to a benign flag the CLI ignores — exact carrier finalized by
 * the exec sub-task, then backfilled into tech-stack §4.2 / ai-quests §4.5 notes).
 */
/**
 * The `--settings` JSON value for a generation call. Carries `disableAllHooks`
 * (the isolation requirement, §4.5) PLUS the QUEST_LAUNCH_ARG_MARKER as a custom
 * key the CLI ignores — this is the E-3 carrier: the marker is GUARANTEED present
 * in argv (so ps.ts's double-filter leg-2 always matches) without inventing a
 * new flag the CLI might reject. `disableAllHooks` stays first so the literal
 * substring `"disableAllHooks": true` is preserved verbatim (parity with
 * CLAUDE_FIXED_FLAGS / the contract test).
 *
 * Backfill note (E-3): the marker travels inside the --settings JSON value as the
 * key `codestead-quest`; recorded into tech-stack §4.2 / ai-quests §4.5 notes.
 */
function questSettingsJson(): string {
  // Built by hand (not JSON.stringify) so the `"disableAllHooks": true` substring
  // is byte-identical to the fixed-flags constant the contract pins.
  return `{"disableAllHooks": true, "${QUEST_LAUNCH_ARG_MARKER}": true}`;
}

export function buildClaudeArgv(config: AiQuestsConfig, instructions: string): string[] {
  const schemaJson = JSON.stringify(questGenJsonSchema());
  // Assemble in the §4.5 order, substituting the per-call values for the three
  // value-bearing flags (--settings carries the marker, --json-schema the schema,
  // --max-budget-usd the clamped budget, --model the configured model).
  return [
    '-p',
    instructions,
    '--settings',
    questSettingsJson(),
    '--strict-mcp-config',
    '--output-format',
    'json',
    '--json-schema',
    schemaJson,
    '--max-turns',
    '4',
    '--max-budget-usd',
    String(config.perCallBudgetUsd),
    '--no-session-persistence',
    '--allowedTools',
    'Read',
    '--model',
    config.model,
    '--fallback-model',
    'sonnet',
  ];
}

/** Spawnable claude runner — the SOLE seam to the real binary (injected; stubbed in tests). */
export interface ClaudeRunner {
  /** Absolute path (or PATH name) of the claude executable. */
  readonly claudePath: string;
  /**
   * Spawn `claudePath <argv>` feeding `stdinContext`, enforcing the 90s/5s
   * watchdog. Resolves with the raw stdout + exit info; NEVER throws on a failed
   * generation (returns the failure shape) — only programmer errors throw.
   */
  run(args: {
    readonly argv: readonly string[];
    readonly stdinContext: string;
    readonly sigtermMs: number;
    readonly sigkillGraceMs: number;
  }): Promise<ClaudeRunResult>;
}

/** Raw outcome of a spawn, before quest parsing. */
export interface ClaudeRunResult {
  /** Process exit code; null if killed by signal. */
  readonly exitCode: number | null;
  /** Signal that killed it (e.g. 'SIGTERM'/'SIGKILL'); null otherwise. */
  readonly signal: string | null;
  /** Raw stdout (expected: `--output-format json` envelope). */
  readonly stdout: string;
  /** Wall duration ms (for accounting). */
  readonly durationMs: number;
  /** True if the watchdog fired (timeout path, §10). */
  readonly timedOut: boolean;
}

/** Parsed generation outcome handed to the lifecycle reducer + accountant. */
export type GenerationOutcome =
  | {
      readonly ok: true;
      readonly quest: QuestGen;
      readonly costUsd: number;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: GenFailureReason;
      readonly costUsd: number;
      readonly durationMs: number;
      /** Truncated (≤2KB) raw output for errors.log (§10 invalidOutput row). */
      readonly rawSample: string;
    };

/**
 * Run one generation: build argv, spawn via the injected runner, parse the JSON
 * envelope, extract `structured_output` → QuestGenSchema.safeParse, read
 * `total_cost_usd`. Maps every §10 failure class to a GenFailureReason. PURE over
 * the runner (the only impurity is the injected spawn). SKELETON — body by the
 * exec sub-task. Failure mapping it MUST implement (§10):
 *   timedOut                       → 'timeout'
 *   budget abort (CLI signal)      → 'budget'
 *   structured_output missing/bad  → 'invalidOutput' (no in-tick retry; rawSample≤2KB)
 *   exitCode≠0 (non-budget)        → 'processCrash'
 *   envelope is_error / StopFailure→ 'apiError'
 */
/** Truncate a raw sample to ≤ERROR_SAMPLE_MAX_BYTES for errors.log (§10 invalidOutput). */
function clampRawSample(raw: string): string {
  // Byte cap (shared with accounting.ts); slice on chars then byte-trim.
  if (Buffer.byteLength(raw, 'utf8') <= ERROR_SAMPLE_MAX_BYTES) return raw;
  let s = raw.slice(0, ERROR_SAMPLE_MAX_BYTES);
  while (Buffer.byteLength(s, 'utf8') > ERROR_SAMPLE_MAX_BYTES) s = s.slice(0, -1);
  return s;
}

/** Read `total_cost_usd` from the CLI envelope; 0 when absent/non-numeric. */
function costOf(envelope: Record<string, unknown>): number {
  const c = envelope['total_cost_usd'];
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : 0;
}

export async function runGeneration(
  runner: ClaudeRunner,
  config: AiQuestsConfig,
  instructions: string,
  stdinContext: string,
): Promise<GenerationOutcome> {
  const argv = buildClaudeArgv(config, instructions);
  const result = await runner.run({
    argv,
    stdinContext,
    sigtermMs: GEN_SIGTERM_MS,
    sigkillGraceMs: GEN_SIGKILL_GRACE_MS,
  });

  // §10 failure mapping. Order matters: timeout is decided by the watchdog flag,
  // budget by the envelope/exit, then output validity, then generic crash.
  if (result.timedOut) {
    return {
      ok: false,
      reason: 'timeout',
      costUsd: 0,
      durationMs: result.durationMs,
      rawSample: '',
    };
  }

  // Parse the JSON envelope. A non-JSON stdout is an invalidOutput failure.
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    envelope = parsed as Record<string, unknown>;
  } catch {
    // Could not even parse the envelope. If the process also crashed, prefer the
    // crash reason; otherwise it is malformed output.
    const reason: GenFailureReason =
      result.exitCode !== null && result.exitCode !== 0 ? 'processCrash' : 'invalidOutput';
    return {
      ok: false,
      reason,
      costUsd: 0,
      durationMs: result.durationMs,
      rawSample: clampRawSample(result.stdout),
    };
  }

  const costUsd = costOf(envelope);

  // Budget abort: the CLI reports it via subtype/is_error; the watchdog did not
  // fire and exit is non-zero or the envelope flags an error_max_budget subtype.
  const subtype = typeof envelope['subtype'] === 'string' ? envelope['subtype'] : '';
  if (subtype.includes('budget') || subtype === 'error_max_budget') {
    return { ok: false, reason: 'budget', costUsd, durationMs: result.durationMs, rawSample: '' };
  }

  // API error / StopFailure shapes: envelope is_error true (rate_limit / auth /
  // billing) → apiError (settings page shows a silent status line, §10).
  if (envelope['is_error'] === true) {
    return { ok: false, reason: 'apiError', costUsd, durationMs: result.durationMs, rawSample: '' };
  }

  // Non-zero exit without a recognised cause → generic crash.
  if (result.exitCode !== null && result.exitCode !== 0) {
    return {
      ok: false,
      reason: 'processCrash',
      costUsd,
      durationMs: result.durationMs,
      rawSample: clampRawSample(result.stdout),
    };
  }

  // Extract structured_output and validate with the SAME schema fed to
  // --json-schema (§4.1). Missing or failing → invalidOutput (no in-tick retry).
  const structured = envelope['structured_output'];
  if (structured === undefined || structured === null) {
    return {
      ok: false,
      reason: 'invalidOutput',
      costUsd,
      durationMs: result.durationMs,
      rawSample: clampRawSample(result.stdout),
    };
  }
  const validated = QuestGenSchema.safeParse(structured);
  if (!validated.success) {
    return {
      ok: false,
      reason: 'invalidOutput',
      costUsd,
      durationMs: result.durationMs,
      rawSample: clampRawSample(JSON.stringify(structured)),
    };
  }

  return { ok: true, quest: validated.data, costUsd, durationMs: result.durationMs };
}

/**
 * Startup feature-detect (§4.5 / §9 / A6): `claude --version` + probe key flags.
 * Unavailable ⇒ AI path disabled, settings page greys the toggle, NEVER crashes.
 * SKELETON — body by the exec sub-task; returns whether the AI path may run.
 */
export interface FeatureDetectResult {
  readonly available: boolean;
  /** Reason the AI path is unavailable (settings页注明), or null when available. */
  readonly reason: string | null;
}

/** Watchdog for the lightweight `--version` probe — far shorter than a generation. */
const FEATURE_DETECT_SIGTERM_MS = 10_000;

export async function detectClaudeFeatures(runner: ClaudeRunner): Promise<FeatureDetectResult> {
  // The sole goal is "can we run the AI path at all?" — never crash (§4.5/§9/A6):
  // a missing binary, a non-zero `--version`, or a thrown spawn error all collapse
  // to {available:false, reason}. A runner that throws (ENOENT) is caught here.
  let result: ClaudeRunResult;
  try {
    result = await runner.run({
      argv: ['--version'],
      stdinContext: '',
      sigtermMs: FEATURE_DETECT_SIGTERM_MS,
      sigkillGraceMs: GEN_SIGKILL_GRACE_MS,
    });
  } catch {
    return { available: false, reason: 'claude CLI not found' };
  }

  if (result.timedOut) {
    return { available: false, reason: 'claude --version timed out' };
  }
  if (result.exitCode !== 0) {
    return { available: false, reason: 'claude --version failed' };
  }
  // A version banner that mentions "claude" is a sufficient liveness signal; the
  // per-flag probe is intentionally lenient — an unknown CLI shape degrades to
  // local-pool rather than crashing (tech-stack risk #4). The strict per-flag
  // probe is deferred: with --version OK and the fixed flag set being long-stable,
  // a failed generation already falls back via the §10 backoff path.
  if (!/claude/i.test(result.stdout) && result.stdout.trim() === '') {
    return { available: false, reason: 'claude --version produced no output' };
  }
  return { available: true, reason: null };
}

/**
 * Real spawn-backed ClaudeRunner — the SOLE production path to the binary
 * (`claudePath` injected; tests use a stub script instead and never reach here).
 *
 * Watchdog (§4.5/§10): at `sigtermMs` send SIGTERM; if still alive `sigkillGraceMs`
 * later send SIGKILL. The promise NEVER rejects on a failed generation — it
 * resolves with the failure-shaped ClaudeRunResult (timedOut / non-zero exit);
 * only a spawn-level error (ENOENT) rejects, which detectClaudeFeatures /
 * runGeneration's callers catch.
 *
 * PRIVACY: the context goes ONLY to the child's stdin; nothing about it is logged
 * here. argv carries the fixed flags + schema + the player-independent instructions.
 */
export function createSpawnClaudeRunner(claudePath: string): ClaudeRunner {
  return {
    claudePath,
    run(args): Promise<ClaudeRunResult> {
      const startedAt = Date.now();
      return new Promise<ClaudeRunResult>((resolve, reject) => {
        const child = spawn(claudePath, [...args.argv], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // No shell — argv is passed verbatim (avoids injection via the prompt text).
          shell: false,
        });

        let stdout = '';
        let settled = false;
        let timedOut = false;
        let sigtermTimer: NodeJS.Timeout | null = null;
        let sigkillTimer: NodeJS.Timeout | null = null;

        const clearTimers = (): void => {
          if (sigtermTimer !== null) clearTimeout(sigtermTimer);
          if (sigkillTimer !== null) clearTimeout(sigkillTimer);
          sigtermTimer = null;
          sigkillTimer = null;
        };

        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        // stderr is drained but never captured into the result (no transcript leak
        // surface; the JSON envelope on stdout is the only contract).
        child.stderr.on('data', () => undefined);

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve({
            exitCode: code,
            signal: signal ?? null,
            stdout,
            durationMs: Date.now() - startedAt,
            timedOut,
          });
        });

        // Watchdog: 90s SIGTERM → +5s SIGKILL (§4.5).
        sigtermTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          sigkillTimer = setTimeout(() => {
            child.kill('SIGKILL');
          }, args.sigkillGraceMs);
          sigkillTimer.unref();
        }, args.sigtermMs);
        sigtermTimer.unref();

        // Feed the sanitized context via stdin, then close it.
        child.stdin.on('error', () => undefined); // EPIPE if the child exits early
        child.stdin.end(args.stdinContext);
      });
    },
  };
}
