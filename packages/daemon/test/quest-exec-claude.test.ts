/**
 * exec-claude pipeline via the stub claude (PRD 05 seam e, A6/A7).
 *
 * Two layers:
 *  1. UNCONDITIONAL contract: the §4.5 fixed flag set (no --bare / --resume), the
 *     codestead-quest launch marker (backlog E-3), and the QuestGen json-schema
 *     fed to --json-schema. Plus a direct spawn of the stub proving each scripted
 *     outcome (success / invalid-schema / non-json / crash / budget / version)
 *     produces the raw shape the runner must map — this exercises the test seam
 *     itself so the gated assertions below have a trustworthy stub.
 *  2. GATED behaviour (`runGeneration` / `buildClaudeArgv` / `detectClaudeFeatures`
 *     are SKELETONs): once the exec body lands, the stub drives every §10 failure
 *     class and the success path through the REAL runner via an injected ClaudeRunner
 *     whose claudePath is `node stub-claude.mjs`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execPath } from 'node:process';

import { QuestGenSchema } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_QUESTS_CONFIG, type AiQuestsConfig } from '../src/quest/config.js';
import {
  CLAUDE_FIXED_FLAGS,
  QUEST_LAUNCH_ARG_MARKER,
  buildClaudeArgv,
  detectClaudeFeatures,
  questGenJsonSchema,
  runGeneration,
  type ClaudeRunner,
  type ClaudeRunResult,
} from '../src/quest/exec-claude.js';
import { questModuleReady, questModuleReadyAsync } from './helpers/quest-ready.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-claude.mjs', import.meta.url));

const cfg = (o: Partial<AiQuestsConfig> = {}): AiQuestsConfig => ({
  ...DEFAULT_AI_QUESTS_CONFIG,
  aiGeneration: true,
  ...o,
});

/** Run the stub directly with a STUB_CLAUDE_MODE and capture stdout/exit (drives the seam). */
function runStub(
  mode: string,
  args: string[] = ['-p'],
  stdinText = 'ctx',
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(execPath, [STUB, ...args], {
      env: { ...process.env, STUB_CLAUDE_MODE: mode, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }));
    child.stdin.end(stdinText);
  });
}

// ---- unconditional: argv contract (§4.5 / E-3) ----

describe('exec-claude fixed-flag contract (§4.5 / tech-stack §1)', () => {
  it('carries every headless flag and NEVER --bare / --resume', () => {
    for (const f of [
      '-p',
      '--strict-mcp-config',
      '--output-format',
      'json',
      '--json-schema',
      '--max-turns',
      '4',
      '--max-budget-usd',
      '--no-session-persistence',
      '--allowedTools',
      'Read',
      '--model',
      '--fallback-model',
      'sonnet',
      '--settings',
    ]) {
      expect(CLAUDE_FIXED_FLAGS).toContain(f);
    }
    expect(CLAUDE_FIXED_FLAGS.some((f) => f.includes('"disableAllHooks": true'))).toBe(true);
    expect(CLAUDE_FIXED_FLAGS).not.toContain('--bare');
    expect(CLAUDE_FIXED_FLAGS).not.toContain('--resume');
  });

  it('re-exports the codestead-quest launch marker as ONE shared token (E-3)', () => {
    expect(QUEST_LAUNCH_ARG_MARKER).toBe('codestead-quest');
  });

  it('emits the QuestGen json-schema for --json-schema (object with the model fields)', () => {
    const schema = questGenJsonSchema() as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'npcId',
        'kind',
        'title',
        'opener',
        'body',
        'options',
        'closer',
        'contextEcho',
      ]),
    );
  });
});

// ---- unconditional: prove the stub seam itself ----

describe('stub-claude seam (drives the §10 outcome classes deterministically)', () => {
  it('success ⇒ a JSON envelope whose structured_output passes QuestGenSchema', async () => {
    const { stdout, code } = await runStub('success');
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { structured_output: unknown; total_cost_usd: number };
    expect(env.total_cost_usd).toBeGreaterThan(0);
    expect(QuestGenSchema.safeParse(env.structured_output).success).toBe(true);
  });

  it('invalid-schema ⇒ structured_output that QuestGenSchema REJECTS (§4.6)', async () => {
    const { stdout } = await runStub('invalid-schema');
    const env = JSON.parse(stdout) as { structured_output: unknown };
    expect(QuestGenSchema.safeParse(env.structured_output).success).toBe(false);
  });

  it('missing-output ⇒ a valid envelope with NO structured_output (§10 invalidOutput)', async () => {
    const { stdout } = await runStub('missing-output');
    const env = JSON.parse(stdout) as Record<string, unknown>;
    expect('structured_output' in env).toBe(false);
  });

  it('non-json ⇒ unparseable stdout (§10 invalidOutput)', async () => {
    const { stdout, code } = await runStub('non-json');
    expect(code).toBe(0);
    expect(() => {
      JSON.parse(stdout);
    }).toThrow();
  });

  it('crash ⇒ non-zero exit (§10 processCrash)', async () => {
    const { code } = await runStub('crash');
    expect(code).toBe(1);
  });

  it('budget ⇒ envelope marked error_max_budget (§10 budget)', async () => {
    const { stdout } = await runStub('budget');
    expect(JSON.parse(stdout)).toMatchObject({ subtype: 'error_max_budget', is_error: true });
  });

  it('api-error ⇒ envelope with is_error true (§10 apiError)', async () => {
    const { stdout } = await runStub('api-error');
    expect(JSON.parse(stdout)).toMatchObject({ is_error: true });
  });

  it('--version ⇒ a version line (feature-detect); no-version ⇒ non-zero exit', async () => {
    expect((await runStub('success', ['--version'])).stdout).toMatch(/\d+\.\d+\.\d+/);
    expect((await runStub('no-version', ['--version'])).code).toBe(1);
  });

  it('echo-argv ⇒ reflects argv + stdin (lets the runner test assert the spawn argv)', async () => {
    const { stdout } = await runStub(
      'echo-argv',
      ['-p', 'codestead-quest', '--model', 'haiku'],
      'SANITIZED',
    );
    const echoed = JSON.parse(stdout) as { argv: string[]; stdin: string };
    expect(echoed.argv).toContain('codestead-quest');
    expect(echoed.stdin).toBe('SANITIZED');
  });

  it('hang ⇒ never exits on its own; ends only on SIGTERM (watchdog target)', async () => {
    // Spawn directly so the child is tracked and killed (no orphaned process).
    const child = spawn(execPath, [STUB, '-p'], {
      env: { ...process.env, STUB_CLAUDE_MODE: 'hang' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('ctx');
    let exited = false;
    const closed = new Promise<{ signal: string | null }>((resolve) =>
      child.on('close', (_c, signal) => {
        exited = true;
        resolve({ signal });
      }),
    );
    // It must still be running after a short window (the watchdog, not self-exit,
    // is what ends it).
    await new Promise((r) => setTimeout(r, 300));
    expect(exited).toBe(false);
    // SIGTERM ends it (the 90s→5s watchdog the daemon owns; simulated short here).
    child.kill('SIGTERM');
    const { signal } = await closed;
    expect(signal).toBe('SIGTERM');
  });
});

// ---- gated: the real runner driven by the stub ----

/** A ClaudeRunner that shells out to `node stub-claude.mjs` under a given mode. */
function stubRunner(mode: string, extraEnv: Record<string, string> = {}): ClaudeRunner {
  return {
    claudePath: execPath,
    run: ({ argv, stdinContext, sigtermMs, sigkillGraceMs }): Promise<ClaudeRunResult> =>
      new Promise((resolve) => {
        const startedAt = Date.now();
        const child = spawn(execPath, [STUB, ...argv], {
          env: { ...process.env, STUB_CLAUDE_MODE: mode, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let timedOut = false;
        const term = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), sigkillGraceMs);
        }, sigtermMs);
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code, signal) => {
          clearTimeout(term);
          resolve({ exitCode: code, signal, stdout, durationMs: Date.now() - startedAt, timedOut });
        });
        child.stdin.end(stdinContext);
      }),
  };
}

const argvReady = questModuleReady(() => buildClaudeArgv(cfg(), 'instructions'));

describe.runIf(argvReady)(
  'buildClaudeArgv (gated) — argv carries the §4.5 contract + marker',
  () => {
    it('includes every flag-NAME from the fixed set (value-bearing flags get per-call values)', () => {
      const argv = buildClaudeArgv(cfg({ perCallBudgetUsd: 0.2, model: 'haiku' }), 'do the thing');
      // Flag NAMES (the `--…` tokens) must all be present; value tokens like the
      // bare `{"disableAllHooks": true}` are substituted per call (the --settings
      // value also carries the marker — see the substring assertion below).
      for (const flag of CLAUDE_FIXED_FLAGS) {
        if (flag.startsWith('--') || flag === '-p') expect(argv).toContain(flag);
      }
      expect(argv).toContain('Read'); // --allowedTools value
      expect(argv).toContain('sonnet'); // --fallback-model value
      expect(argv).toContain('json'); // --output-format value
      expect(argv).toContain('4'); // --max-turns value
      expect(argv).not.toContain('--bare');
      expect(argv).not.toContain('--resume');
    });

    it('embeds the codestead-quest marker in argv (ps double-filter leg 2, E-3)', () => {
      const argv = buildClaudeArgv(cfg(), 'do the thing');
      // The marker need not be a standalone token — ps.ts matches it as a SUBSTRING
      // of the whole command-line string. The implementation carries it inside the
      // --settings JSON value alongside disableAllHooks.
      const joined = argv.join(' ');
      expect(joined).toContain(QUEST_LAUNCH_ARG_MARKER);
      expect(joined).toContain('"disableAllHooks": true'); // isolation flag preserved
    });

    it('the per-call budget sits after --max-budget-usd and is ≤ 0.20 (A7)', () => {
      const argv = buildClaudeArgv(cfg({ perCallBudgetUsd: 0.2 }), 'i');
      const budget = Number(argv[argv.indexOf('--max-budget-usd') + 1]);
      expect(budget).toBeLessThanOrEqual(0.2);
    });
  },
);

/**
 * A canned-result runner: returns a fixed ClaudeRunResult WITHOUT spawning. Used
 * for the §10 failure-mapping rows so the suite exercises `runGeneration`'s real
 * envelope-parse/map logic deterministically and WITHOUT process-spawn load (the
 * real-spawn proof lives in the stub-claude seam block above + the success row
 * below). The result shapes mirror exactly what the corresponding stub mode emits.
 */
function cannedRunner(result: ClaudeRunResult): ClaudeRunner {
  return { claudePath: '/canned', run: () => Promise.resolve(result) };
}
const env = (subtype: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    total_cost_usd: 0.01,
    ...extra,
  });
const result = (over: Partial<ClaudeRunResult>): ClaudeRunResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  durationMs: 5,
  timedOut: false,
  ...over,
});

const runReady = await questModuleReadyAsync(() =>
  runGeneration(stubRunner('success'), cfg(), 'instructions', 'ctx'),
);

describe.runIf(runReady)('runGeneration — success via REAL stub spawn (end-to-end, A7)', () => {
  it('success ⇒ ok quest + a positive cost (accounting reads total_cost_usd)', async () => {
    const out = await runGeneration(stubRunner('success'), cfg(), 'i', 'ctx');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(QuestGenSchema.safeParse(out.quest).success).toBe(true);
      expect(out.costUsd).toBeGreaterThan(0);
    }
  });
});

describe.runIf(runReady)('runGeneration — §10 failure mapping (canned runner, no spawn)', () => {
  it('invalid-schema ⇒ {ok:false, invalidOutput} with a ≤2KB rawSample', async () => {
    const bad = env('success', {
      structured_output: {
        npcId: 'npc_keeper',
        kind: 'decision',
        title: 'xxxx',
        opener: 'x'.repeat(12),
        body: 'x'.repeat(22),
        options: [{ id: 'a', label: 'la', tradeoff: 'tr' }],
        closer: 'clos',
        contextEcho: 'e',
      },
    });
    const out = await runGeneration(cannedRunner(result({ stdout: bad })), cfg(), 'i', 'ctx');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('invalidOutput');
      expect(out.rawSample.length).toBeLessThanOrEqual(2 * 1024);
    }
  });

  it('missing structured_output ⇒ invalidOutput', async () => {
    const out = await runGeneration(
      cannedRunner(result({ stdout: env('success') })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalidOutput');
  });

  it('non-json stdout ⇒ invalidOutput', async () => {
    const out = await runGeneration(
      cannedRunner(result({ stdout: '<<<garbage>>>' })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalidOutput');
  });

  it('non-zero exit (non-budget) ⇒ processCrash', async () => {
    const out = await runGeneration(
      cannedRunner(result({ exitCode: 1, stdout: '' })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('processCrash');
  });

  it('timedOut ⇒ timeout (the 90s watchdog path)', async () => {
    const out = await runGeneration(
      cannedRunner(result({ exitCode: null, signal: 'SIGTERM', timedOut: true })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('timeout');
  });

  it('budget subtype ⇒ budget reason', async () => {
    const out = await runGeneration(
      cannedRunner(result({ stdout: env('error_max_budget') })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('budget');
  });

  it('is_error envelope ⇒ apiError reason', async () => {
    const out = await runGeneration(
      cannedRunner(result({ stdout: env('error', { error: { kind: 'rate_limit' } }) })),
      cfg(),
      'i',
      'ctx',
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('apiError');
  });
});

const detectReady = await questModuleReadyAsync(() => detectClaudeFeatures(stubRunner('success')));

describe.runIf(detectReady)('detectClaudeFeatures via stub (gated, A6) — graceful degrade', () => {
  it('available claude ⇒ {available:true}', async () => {
    const r = await detectClaudeFeatures(stubRunner('success'));
    expect(r.available).toBe(true);
  });

  it('unavailable claude (--version fails) ⇒ {available:false, reason} (never throws)', async () => {
    const r = await detectClaudeFeatures(stubRunner('no-version'));
    expect(r.available).toBe(false);
    expect(r.reason).not.toBeNull();
  });
});

describe('implementation-landed tracker (A6/A7)', () => {
  it('documents whether the exec bodies are implemented yet', () => {
    expect(typeof argvReady).toBe('boolean');
    expect(typeof runReady).toBe('boolean');
    expect(typeof detectReady).toBe('boolean');
  });
});
