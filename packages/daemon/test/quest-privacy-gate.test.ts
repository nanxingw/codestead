/**
 * Privacy / cost gate — the M4 red line as external engine behaviour (PRD 05 §E/§F,
 * verification A1). Complements the daemon-quest owner's quest-engine.test.ts
 * (which covers the AI happy path / notes / reward / snapshot with real-fs journals)
 * by isolating the NON-NEGOTIABLE gates with spy IO so a regression is unambiguous:
 *
 *   A1  enabled=false ⇒ the engine is INERT: 0 claude spawns, 0 quest WS frames,
 *       0 state writes — no matter how perfect the candidate (§9).
 *   A7/§3.1  a zero daily budget blocks the AI path entirely (0 spawns).
 *   A6  feature-detect off (aiPathAvailable=false) ⇒ never spawns claude.
 *   A10 a fresh engine never spawns claude before the scripted consent is answered.
 *   §4.3/§12  ONLY the sanitized, length-bounded text reaches the runner's stdin —
 *       never the raw transcript (the stdin is ≤MAX_CONTEXT_CHARS and carries no
 *       seeded secret).
 *
 * Spy IO (no fs, no network) keeps these assertions about call-counts and the
 * exact stdin payload deterministic and load-free.
 */
import type { ServerMessage } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/state/events.js';
import type { SessionRecord, SessionTable } from '../src/state/types.js';
import { createQuestEngine, type QuestEngineDeps } from '../src/quest/runtime.js';
import { DEFAULT_AI_QUESTS_CONFIG, type AiQuestsConfig } from '../src/quest/config.js';
import type { ClaudeRunResult } from '../src/quest/exec-claude.js';
import type { QuestStateStore } from '../src/quest/persistence.js';
import type { QuestJournals } from '../src/quest/accounting.js';
import type { TranscriptTailReader } from '../src/quest/transcript-reader.js';
import type { NotesWriter } from '../src/quest/notes.js';
import type { QuestModuleState } from '../src/quest/types.js';
import { MAX_CONTEXT_CHARS } from '../src/quest/types.js';

const SEEDED_SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuv';

/** A QuestGen success envelope (model-produced shape). */
const OK_RESULT: ClaudeRunResult = {
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    structured_output: {
      npcId: 'npc_keeper',
      kind: 'reflection',
      title: '一个问题',
      opener: '渠叔放下斗笠看了你一眼，慢慢开口问你。',
      body: '你现在手头这件事，最初要解决的问题是什么？现在还在解决它吗？',
      closer: '想好了再答，地里的活儿不急。',
      contextEcho: '正在设计登录重试策略',
    },
  }),
  durationMs: 5,
  timedOut: false,
};

function spyRunner(result = OK_RESULT) {
  const runner = {
    claudePath: '/stub/claude',
    calls: 0,
    genCalls: 0,
    lastStdin: '',
    run: (a: {
      argv: readonly string[];
      stdinContext: string;
      sigtermMs: number;
      sigkillGraceMs: number;
    }): Promise<ClaudeRunResult> => {
      runner.calls += 1;
      if (a.argv.includes('--version')) {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: '1.2.3\n',
          durationMs: 1,
          timedOut: false,
        });
      }
      runner.genCalls += 1;
      runner.lastStdin = a.stdinContext;
      return Promise.resolve(result);
    },
  };
  return runner;
}

function memStore() {
  const s = {
    writes: 0,
    last: null as QuestModuleState | null,
    read: (): Promise<QuestModuleState | null> => Promise.resolve(s.last),
    write: (st: QuestModuleState): Promise<void> => {
      s.writes += 1;
      s.last = st;
      return Promise.resolve();
    },
  } satisfies QuestStateStore & { writes: number; last: QuestModuleState | null };
  return s;
}

const noopJournals: QuestJournals = {
  appendCost: () => Promise.resolve(),
  appendError: () => Promise.resolve(),
};

const noopNotes = {
  writerFor: (): NotesWriter => ({ write: () => Promise.resolve('2026-06-12/x.md') }),
  backfill: {
    listNotes: () => Promise.resolve([]),
    renderNote: () => Promise.resolve(''),
  },
};

/** Rich transcript whose sanitized form clears the 300-char floor and seeds a secret. */
function richTranscript(): string {
  const lines: unknown[] = [
    { type: 'ai-title', title: '登录服务重试策略' },
    { type: 'last-prompt', text: '我在纠结重试和熔断的边界，应该怎么设计才稳' },
  ];
  for (let i = 0; i < 6; i++) {
    lines.push({
      type: 'user',
      userType: 'external',
      message: {
        role: 'user',
        content: `第${String(i)}轮：登录服务高峰期超时，重试要不要退避，会不会打死下游，顺带 token=${SEEDED_SECRET} 不要复述。`,
      },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

let nowMs = 1_000_000;

function workingTable(): SessionTable {
  const rec: SessionRecord = {
    info: {
      sessionId: 's1',
      title: null,
      subtitle: null,
      cwd: '/Users/me/work/payments',
      state: 'working',
      since: new Date(nowMs).toISOString(),
      lastSignalAt: new Date(nowMs).toISOString(),
      source: 'hooks',
    },
    transcriptPath: '/t/s1.jsonl',
    pid: null,
  };
  return new Map([['s1', rec]]);
}

function buildEngine(opts: {
  config?: Partial<AiQuestsConfig>;
  aiPathAvailable?: boolean;
  table?: SessionTable;
  reader?: TranscriptTailReader;
}) {
  const broadcasts: ServerMessage[] = [];
  const runner = spyRunner();
  const store = memStore();
  const deps: QuestEngineDeps = {
    getConfig: () => ({ ...DEFAULT_AI_QUESTS_CONFIG, ...opts.config }),
    getSessionTable: () => opts.table ?? new Map(),
    isGameConnected: () => true,
    broadcast: (m) => broadcasts.push(m),
    claudeRunner: runner,
    aiPathAvailable: opts.aiPathAvailable ?? true,
    transcriptReader: opts.reader ?? { readTail: () => Promise.resolve(richTranscript()) },
    stateStore: store,
    journals: noopJournals,
    notes: noopNotes,
    homeDir: '/Users/me',
    nowMonotonicMs: () => nowMs,
    nowWallMs: () => nowMs,
    rand: () => 0,
    uuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
    onConsentChoice: () => undefined,
  };
  return { engine: createQuestEngine(deps), broadcasts, runner, store };
}

const prompt = (at: number): SessionEvent => ({
  kind: 'hookUserPromptSubmit',
  at,
  sessionId: 's1',
});
const questFrames = (f: ServerMessage[]) => f.filter((m) => m.type.startsWith('quest'));

describe('A1 总开关 — enabled=false ⇒ engine fully inert (§9)', () => {
  it('no claude spawn, no quest WS frame, no state write — even with a perfect candidate', async () => {
    nowMs = 1_000_000;
    const h = buildEngine({
      config: { enabled: false, aiGeneration: true },
      table: workingTable(),
    });
    h.engine.onSessionEvent(prompt(nowMs - 2));
    h.engine.onSessionEvent(prompt(nowMs - 1));
    await h.engine.tick();
    await h.engine.tick();
    expect(h.runner.calls).toBe(0);
    expect(questFrames(h.broadcasts)).toEqual([]);
    expect(h.store.writes).toBe(0);
  });
});

describe('A10 — no AI spawn before scripted consent is answered (§3.4)', () => {
  it('a fresh engine ticks the scripted consent and never calls claude generation', async () => {
    nowMs = 1_000_000;
    const h = buildEngine({
      config: { enabled: true, aiGeneration: false },
      table: workingTable(),
    });
    h.engine.onSessionEvent(prompt(nowMs - 1));
    await h.engine.tick();
    expect(h.runner.genCalls).toBe(0);
    const offer = h.broadcasts.find((m) => m.type === 'questOffer');
    expect(offer?.type).toBe('questOffer');
    if (offer?.type === 'questOffer') {
      expect(offer.payload.quest.source).toBe('scripted');
    }
  });
});

describe('cost / feature-detect gates ⇒ 0 spawns (A6 / A7 / §3.1)', () => {
  it('a zero daily budget blocks the AI path (0 generation calls)', async () => {
    nowMs = 1_000_000;
    const h = buildEngine({
      config: { enabled: true, aiGeneration: true, dailyBudgetUsd: 0, localTemplates: true },
      table: workingTable(),
    });
    h.engine.onSessionEvent(prompt(nowMs - 2));
    h.engine.onSessionEvent(prompt(nowMs - 1));
    await h.engine.tick();
    expect(h.runner.genCalls).toBe(0);
  });

  it('feature-detect off (aiPathAvailable=false) ⇒ 0 generation calls (degrade to local)', async () => {
    nowMs = 1_000_000;
    const h = buildEngine({
      config: { enabled: true, aiGeneration: true, localTemplates: true },
      aiPathAvailable: false,
      table: workingTable(),
    });
    h.engine.onSessionEvent(prompt(nowMs - 2));
    h.engine.onSessionEvent(prompt(nowMs - 1));
    await h.engine.tick();
    expect(h.runner.genCalls).toBe(0);
  });
});

describe('§4.3/§12 — ONLY sanitized, bounded text reaches the runner stdin', () => {
  it('the runner stdin is ≤MAX_CONTEXT_CHARS and carries no seeded secret', async () => {
    nowMs = 1_000_000;
    const h = buildEngine({
      config: { enabled: true, aiGeneration: true },
      table: workingTable(),
    });
    // consent first, answer it to enable AI, then 2 prompts make a fresh candidate.
    await h.engine.tick();
    const consent = h.broadcasts.find((m) => m.type === 'questOffer') as Extract<
      ServerMessage,
      { type: 'questOffer' }
    >;
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: consent.payload.quest.questId, optionId: 'a' },
    });
    // The onConsentChoice spy does not flip config here, so drive AI directly:
    nowMs += 31 * 60_000; // past cooldown
    const freshTable = (() => {
      const rec: SessionRecord = {
        info: {
          sessionId: 's1',
          title: null,
          subtitle: null,
          cwd: '/Users/me/work/payments',
          state: 'working',
          since: new Date(nowMs).toISOString(),
          lastSignalAt: new Date(nowMs).toISOString(),
          source: 'hooks',
        },
        transcriptPath: '/t/s1.jsonl',
        pid: null,
      };
      return new Map([['s1', rec]]);
    })();
    const h2 = buildEngine({
      config: { enabled: true, aiGeneration: true },
      table: freshTable,
    });
    h2.engine.onSessionEvent(prompt(nowMs - 2));
    h2.engine.onSessionEvent(prompt(nowMs - 1));
    await h2.engine.tick();

    expect(h2.runner.genCalls).toBe(1);
    const stdin = h2.runner.lastStdin;
    expect(stdin.length).toBeGreaterThan(0);
    expect(stdin.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    // Privacy: the seeded secret never reaches the model stdin.
    expect(stdin).not.toContain(SEEDED_SECRET);
  });
});
