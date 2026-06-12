#!/usr/bin/env node
/**
 * stub-claude.mjs — a fake `claude` executable for M4 daemon-pipeline tests
 * (PRD 05 testing seam e). It NEVER touches the network and is fully
 * deterministic: the test injects it as `ClaudeRunner.claudePath` (or on PATH)
 * and selects a scripted behaviour via the STUB_CLAUDE_MODE env var.
 *
 * It mimics the surface the exec-claude runner reads (ai-quests §4.5):
 *  - `--output-format json` ⇒ a JSON envelope on stdout carrying
 *    `structured_output` (the QuestGen object) and `total_cost_usd`;
 *  - `--version` ⇒ a version string (for detectClaudeFeatures);
 *  - a non-zero exit / no-output / hang for the failure paths (§10).
 *
 * Modes (STUB_CLAUDE_MODE):
 *   success            valid QuestGen decision, cost 0.01, exit 0          (happy path)
 *   success-reflection valid QuestGen reflection, cost 0.01, exit 0
 *   invalid-schema     structured_output violates QuestGenSchema (decision w/ 1 option)
 *   non-json           garbage on stdout, exit 0                           (§10 invalidOutput)
 *   missing-output     valid JSON envelope but NO structured_output field  (§10 invalidOutput)
 *   crash              prints to stderr, exit 1                            (§10 processCrash)
 *   budget             envelope with subtype 'error_max_budget', exit 0 *  (§10 budget)
 *   api-error          envelope with is_error: true (rate_limit)           (§10 apiError)
 *   hang               never exits — exercises the 90s SIGTERM/5s SIGKILL watchdog
 *   version            print a version line, exit 0                        (feature-detect)
 *   no-version         exit 1 on --version                                 (feature-detect fail)
 *   echo-argv          dump argv + stdin to stdout as JSON (argv/stdin assertions)
 *   slow-exit          print success then exit after STUB_CLAUDE_DELAY_MS  (watchdog timing)
 *
 * Cost / model can be overridden with STUB_CLAUDE_COST and the call always echoes
 * the model from `--model <m>` into the envelope so accounting assertions can read it.
 *
 * Zero deps; reads stdin fully (the daemon writes the sanitized context there) so
 * the pipe never blocks the parent.
 */
import { stdin, stdout, stderr, argv, env, exit } from 'node:process';

const MODE = env.STUB_CLAUDE_MODE ?? 'success';
const COST = env.STUB_CLAUDE_COST !== undefined ? Number(env.STUB_CLAUDE_COST) : 0.01;
const DELAY_MS = env.STUB_CLAUDE_DELAY_MS !== undefined ? Number(env.STUB_CLAUDE_DELAY_MS) : 0;

const args = argv.slice(2);

/** Read the `--flag value` pair from argv (the value that follows `flag`). */
function flagValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const model = flagValue('--model') ?? 'haiku';

// --version short-circuit (feature-detect, §4.5) — runs before reading stdin.
if (args.includes('--version')) {
  if (MODE === 'no-version') {
    stderr.write('stub-claude: unknown flag --version\n');
    exit(1);
  }
  stdout.write('1.2.3 (Claude Code stub)\n');
  exit(0);
}

/** Read all of stdin so the daemon's pipe write resolves; returns '' if none. */
async function readStdin() {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** A valid QuestGen decision object (passes QuestGenSchema). */
function decisionQuest() {
  return {
    npcId: 'npc_keeper',
    kind: 'decision',
    title: '登录失败往哪引',
    opener: '你那边在改登录的重试逻辑吧。补漏之前，先想清楚水从哪儿来。',
    body: '登录失败之后，水往哪儿引？退避重试、立即熔断、还是降级到只读？',
    options: [
      { id: 'a', label: '指数退避重试，封顶 5 次', tradeoff: '瞬时故障友好，但雪崩时仍打死下游' },
      { id: 'b', label: '立即熔断，亮灯等人', tradeoff: '保护下游，但夜里没人值班就是全停' },
    ],
    closer: '嗯，留口子，好习惯。渠也是这么修的。',
    contextEcho: '正在为登录服务设计失败重试策略，纠结重试与熔断的边界',
  };
}

/** A valid QuestGen reflection object (no options). */
function reflectionQuest() {
  return {
    npcId: 'npc_carpenter',
    kind: 'reflection',
    title: '承重墙是哪堵',
    opener: '拆这堵墙，房子靠什么站着？',
    body: '当前的方案里，最让你不安的那个假设是什么？把它讲清楚。',
    closer: '想明白了再动手，地基才稳。',
    contextEcho: '正在重构一个模块的依赖方向',
  };
}

/** Wrap a structured_output in the `--output-format json` envelope (§4.5). */
function envelope(structuredOutput, extra = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: COST,
    model,
    structured_output: structuredOutput,
    ...extra,
  });
}

async function main() {
  // Always drain stdin first so the parent's write end never deadlocks.
  const stdinText = await readStdin();

  switch (MODE) {
    case 'hang':
      // Never exits — the daemon watchdog must SIGTERM at 90s, SIGKILL at +5s.
      // A bare never-resolving Promise does NOT keep Node's event loop alive once
      // stdin is drained, so hold it open with a long timer (well past any test
      // window). The watchdog's SIGTERM/SIGKILL is what ends this process.
      setInterval(() => {}, 1 << 30);
      await new Promise(() => {});
      return;

    case 'success':
      stdout.write(envelope(decisionQuest()));
      exit(0);
      return;

    case 'success-reflection':
      stdout.write(envelope(reflectionQuest()));
      exit(0);
      return;

    case 'slow-exit':
      stdout.write(envelope(decisionQuest()));
      await new Promise((r) => setTimeout(r, DELAY_MS));
      exit(0);
      return;

    case 'invalid-schema': {
      // decision with a single option ⇒ superRefine rejects (§4.6) ⇒ invalidOutput.
      const bad = decisionQuest();
      bad.options = [bad.options[0]];
      stdout.write(envelope(bad));
      exit(0);
      return;
    }

    case 'missing-output':
      // Valid envelope, but no structured_output at all (§10 invalidOutput).
      stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          total_cost_usd: COST,
          model,
        }),
      );
      exit(0);
      return;

    case 'non-json':
      stdout.write('this is not json at all <<<garbage>>>');
      exit(0);
      return;

    case 'crash':
      stderr.write('stub-claude: simulated crash\n');
      exit(1);
      return;

    case 'budget':
      // CLI aborted on --max-budget-usd: envelope marks the budget subtype (§10 budget).
      stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_budget',
          is_error: true,
          total_cost_usd: COST,
          model,
        }),
      );
      exit(0);
      return;

    case 'api-error':
      stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          total_cost_usd: 0,
          model,
          error: { kind: 'rate_limit' },
        }),
      );
      exit(0);
      return;

    case 'echo-argv':
      stdout.write(JSON.stringify({ argv: args, model, stdin: stdinText }));
      exit(0);
      return;

    default:
      stderr.write(`stub-claude: unknown STUB_CLAUDE_MODE=${MODE}\n`);
      exit(2);
  }
}

void main();
