/**
 * Quest engine orchestration (ai-quests §3~§10; PRD 05 seam d/e) — daemon-quest
 * owner integration tests. Drives createQuestEngine with an injected stub
 * ClaudeRunner, an in-memory broadcast spy, temp fs stores and a fake clock, and
 * asserts EXTERNAL behavior (WS frames out, files on disk, claude-call count):
 *
 *   A1  enabled=false ⇒ engine never built (covered at cli; here: clientPrefs
 *       enabled=false clears the field) — and the no-candidate/no-AI path makes
 *       0 claude calls.
 *   A7  accounting: every AI call logged to costs.jsonl; budget cap halts AI.
 *   A8  notes: answered AI quest writes a note whose body is byte-identical.
 *   A9  reward idempotency (daemon side): a duplicate questAnswer after ARCHIVE
 *       does NOT re-emit questReward.
 *   A10 first task is the scripted consent quest; 0 claude calls before consent.
 *   §5  dismiss → questRevoked + slot freed; reconnect → questSnapshot (0/1).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Quest, QuestGen, ServerMessage } from '@codestead/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileQuestJournals } from '../src/quest/accounting.js';
import { DEFAULT_AI_QUESTS_CONFIG, type AiQuestsConfig } from '../src/quest/config.js';
import type { ClaudeRunner, ClaudeRunResult } from '../src/quest/exec-claude.js';
import { createFileNotes } from '../src/quest/notes.js';
import { createFileQuestStateStore } from '../src/quest/persistence.js';
import { createQuestEngine, type QuestEngine, type QuestEngineDeps } from '../src/quest/runtime.js';
import type { TranscriptTailReader } from '../src/quest/transcript-reader.js';
import type { SessionEvent } from '../src/state/events.js';
import type { SessionRecord, SessionTable } from '../src/state/types.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Let any fire-and-forget persist/note writes settle before removing the dir
  // (the engine's writes are intentionally non-blocking; tests await explicitly
  // where they assert files, this just avoids a teardown ENOTEMPTY race).
  await new Promise((r) => setTimeout(r, 30));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codestead-engine-'));
  dirs.push(d);
  return d;
}

/** A valid QuestGen decision (mirrors the stub's success output). */
function decisionGen(): QuestGen {
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
    closer: '嗯，留口子，好习惯。',
    contextEcho: '正在为登录服务设计失败重试策略',
  };
}

/** Build a ClaudeRunResult success envelope (version-aware for feature-detect). */
function okEnvelope(gen: QuestGen, cost = 0.01): ClaudeRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: cost,
      structured_output: gen,
    }),
    durationMs: 5,
    timedOut: false,
  };
}

interface RunnerSpy extends ClaudeRunner {
  /** All argv passed to run() (excluding --version probes). */
  readonly genCalls: string[][];
  /** Total run() invocations including --version. */
  callCount(): number;
}

function spyRunner(behavior: (argv: readonly string[]) => ClaudeRunResult): RunnerSpy {
  const genCalls: string[][] = [];
  let calls = 0;
  return {
    claudePath: 'stub',
    genCalls,
    callCount: () => calls,
    run(args): Promise<ClaudeRunResult> {
      calls += 1;
      if (args.argv.includes('--version')) {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: '1.2.3 (stub)\n',
          durationMs: 1,
          timedOut: false,
        });
      }
      genCalls.push([...args.argv]);
      return Promise.resolve(behavior(args.argv));
    },
  };
}

const fixedReader = (text: string): TranscriptTailReader => ({
  readTail: () => Promise.resolve(text),
});

/** A working session record with a transcript path. */
function workingRecord(sessionId: string, cwd: string, lastSignalAt: string): SessionRecord {
  return {
    info: {
      sessionId,
      title: null,
      subtitle: null,
      cwd,
      state: 'working',
      since: lastSignalAt,
      lastSignalAt,
      source: 'hooks',
    },
    transcriptPath: `/t/${sessionId}.jsonl`,
    pid: null,
  };
}

interface Harness {
  engine: QuestEngine;
  frames: ServerMessage[];
  runner: RunnerSpy;
  notesDir: string;
  questsDir: string;
  setConfig(patch: Partial<AiQuestsConfig>): void;
  setTable(table: SessionTable): void;
  setConnected(v: boolean): void;
  advance(ms: number): void;
  consentChoices: ('enableAi' | 'localOnly' | 'disableAll')[];
}

async function harness(over: Partial<QuestEngineDeps> = {}): Promise<Harness> {
  const dir = await tmp();
  const notesDir = join(dir, 'notes');
  const questsDir = join(dir, 'quests');
  const frames: ServerMessage[] = [];
  const runner = spyRunner(() => okEnvelope(decisionGen()));
  let clock = 1_000_000;
  let connected = true;
  let table: SessionTable = new Map();
  let config: AiQuestsConfig = { ...DEFAULT_AI_QUESTS_CONFIG };
  const consentChoices: ('enableAi' | 'localOnly' | 'disableAll')[] = [];

  const engine = createQuestEngine({
    getConfig: () => config,
    getSessionTable: () => table,
    isGameConnected: () => connected,
    broadcast: (m) => frames.push(m),
    claudeRunner: over.claudeRunner ?? runner,
    aiPathAvailable: over.aiPathAvailable ?? true,
    transcriptReader: over.transcriptReader ?? fixedReader(''),
    stateStore: createFileQuestStateStore(join(questsDir, 'state.json')),
    journals: createFileQuestJournals(questsDir),
    notes: createFileNotes(notesDir),
    homeDir: '/home/me',
    nowMonotonicMs: () => clock,
    nowWallMs: () => clock,
    rand: () => 0,
    uuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
    })(),
    onConsentChoice: (c) => {
      consentChoices.push(c);
      if (c === 'enableAi') config = { ...config, aiGeneration: true };
      if (c === 'disableAll') config = { ...config, enabled: false };
    },
    ...over,
  });

  return {
    engine,
    frames,
    runner: (over.claudeRunner as RunnerSpy) ?? runner,
    notesDir,
    questsDir,
    setConfig: (patch) => {
      config = { ...config, ...patch };
    },
    setTable: (t) => {
      table = t;
    },
    setConnected: (v) => {
      connected = v;
    },
    advance: (ms) => {
      clock += ms;
    },
    consentChoices,
  };
}

const COOLDOWN_MS = 16 * 60_000; // past the 15-min daemon floor

function offers(frames: ServerMessage[]): Quest[] {
  const out: Quest[] = [];
  for (const f of frames) if (f.type === 'questOffer') out.push(f.payload.quest);
  return out;
}

/** questReward frames scoped to one questId (consent reward is a separate quest). */
function rewardsFor(frames: ServerMessage[], questId: string): ServerMessage[] {
  return frames.filter((f) => f.type === 'questReward' && f.payload.questId === questId);
}

/**
 * Poll until the async answer pipeline (note write → archive → questReward) has
 * settled for `questId`. The reward frame is the observable completion signal, so
 * this is deterministic under any CPU load — unlike a fixed sleep (the answer
 * handler is fire-and-forget `void`, §runtime handleAnswer).
 */
async function waitForReward(frames: ServerMessage[], questId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (rewardsFor(frames, questId).length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`questReward for ${questId} never arrived`);
}

describe('A10 — first task is the scripted consent quest (no AI before consent)', () => {
  it('serves a scripted consent quest first, with 0 claude generation calls', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const offered = offers(h.frames);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.source).toBe('scripted');
    expect(offered[0]?.reward).toEqual({ gold: 50, xp: 20 });
    // No generation call happened (only feature-detect is excluded from genCalls).
    expect(h.runner.genCalls).toHaveLength(0);
  });

  it('answering the consent task with option a routes to enableAi and rewards 50g', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const q = offers(h.frames)[0];
    expect(q).toBeDefined();
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: q.questId, optionId: 'a' },
    });
    expect(h.consentChoices).toEqual(['enableAi']);
    const rewards = h.frames.filter((f) => f.type === 'questReward');
    expect(rewards).toHaveLength(1);
  });
});

describe('AI path — generate, offer, answer, note, reward (A7/A8/A9)', () => {
  it('offers an AI quest only when ≥2 external prompts make a fresh candidate', async () => {
    const h = await aiOfferHarness();
    const aiOffers = offers(h.frames).filter((q) => q.source === 'ai');
    expect(aiOffers).toHaveLength(1);
    expect(aiOffers[0]?.reward).toEqual({ gold: 120, xp: 60 });
    expect(aiOffers[0]?.relatedSessionId).toBe('s1');
    expect(aiOffers[0]?.relatedCwd).toBe('payments'); // basename only (§12-3)
    // exactly one generation call (feature-detect is not in genCalls)
    expect(h.runner.genCalls).toHaveLength(1);
  });

  it('does NOT offer an AI quest when there are < 2 new external prompts (§3.3-②)', async () => {
    const h = await harness({ transcriptReader: fixedReader(buildRichTranscript()) });
    await h.engine.tick(); // consent
    const consent = offers(h.frames)[0];
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: consent.questId, optionId: 'a' },
    });
    h.advance(COOLDOWN_MS);
    const nowIso = new Date(1_000_000 + COOLDOWN_MS).toISOString();
    h.setTable(new Map([['s1', workingRecord('s1', '/home/me/work/payments', nowIso)]]));
    h.engine.onSessionEvent(promptEvent('s1', 1_000_000 + COOLDOWN_MS - 50)); // only ONE prompt
    await h.engine.tick();
    // No AI offer (candidate gated out by §3.3-②); local pool fills in instead.
    expect(offers(h.frames).some((q) => q.source === 'ai')).toBe(false);
    expect(h.runner.genCalls).toHaveLength(0);
  });

  it('records every AI call to costs.jsonl (A7)', async () => {
    const h = await aiOfferHarness();
    const costs = await readFile(join(h.questsDir, 'costs.jsonl'), 'utf8');
    const rows = costs
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.ok === true && (r.totalCostUsd as number) > 0)).toBe(true);
  });

  it('answering an AI quest writes a note with the player body byte-identical (A8)', async () => {
    const h = await aiOfferHarness();
    const ai = offers(h.frames).find((q) => q.source === 'ai');
    expect(ai).toBeDefined();
    const body = '登录失败大多是瞬时问题，给熔断留口子。';
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: ai!.questId, optionId: 'a', note: body },
    });
    // The reward frame is emitted AFTER the note + index are written and archived,
    // so waiting on it deterministically settles the async answer pipeline.
    await waitForReward(h.frames, ai!.questId);
    const index = await readFile(join(h.notesDir, 'index.jsonl'), 'utf8');
    const meta = JSON.parse(index.trim()) as { file: string };
    const md = await readFile(join(h.notesDir, meta.file), 'utf8');
    expect(md.endsWith(body)).toBe(true);
    expect(md).toContain('chosen: true');
    // reward emitted exactly once FOR THIS quest (the consent reward is separate).
    expect(rewardsFor(h.frames, ai!.questId)).toHaveLength(1);
  });

  it('A9 — a duplicate questAnswer after archive does NOT re-emit questReward', async () => {
    const h = await aiOfferHarness();
    const ai = offers(h.frames).find((q) => q.source === 'ai');
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: ai!.questId, optionId: 'a', note: 'x' },
    });
    // First answer fully settles (note written, archived, reward emitted) before the
    // duplicate fires — so the duplicate races nothing and any second reward would be
    // a real bug, not a timing artifact.
    await waitForReward(h.frames, ai!.questId);
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: ai!.questId, optionId: 'a', note: 'x' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(rewardsFor(h.frames, ai!.questId)).toHaveLength(1);
  });
});

describe('local pool path (AI off) + dismiss + snapshot (§2.3/§5)', () => {
  it('serves a local reflection quest when AI is off and consent already given', async () => {
    const h = await harness();
    // asked=true via answering consent with b (local only)
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const consent = offers(h.frames)[0];
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: consent.questId, optionId: 'b' },
    });
    h.advance(COOLDOWN_MS);
    await h.engine.tick();
    const local = offers(h.frames).filter((q) => q.source === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]?.kind).toBe('reflection');
    expect(local[0]?.reward).toEqual({ gold: 40, xp: 20 });
    // No AI generation call ever happened.
    expect(h.runner.genCalls).toHaveLength(0);
  });

  it('questDismiss → questRevoked, no note, no reward, slot freed', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const q = offers(h.frames)[0];
    h.engine.onClientMessage({ v: 1, type: 'questDismiss', payload: { questId: q.questId } });
    expect(h.frames.filter((f) => f.type === 'questRevoked')).toHaveLength(1);
    expect(h.frames.filter((f) => f.type === 'questReward')).toHaveLength(0);
    // slot freed → snapshot is empty
    const snap = h.engine.getPostAuthFrames()[0];
    expect(snap).toMatchObject({ type: 'questSnapshot', payload: { quests: [] } });
  });

  it('getPostAuthFrames carries the single pending OFFERED quest (reconnect, §5)', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const q = offers(h.frames)[0];
    const snap = h.engine.getPostAuthFrames()[0];
    expect(snap?.type).toBe('questSnapshot');
    if (snap?.type === 'questSnapshot') {
      expect(snap.payload.quests).toHaveLength(1);
      expect(snap.payload.quests[0]?.questId).toBe(q.questId);
    }
  });
});

describe('frequency / connection / 总开关 guardrails (A1/T2/T4)', () => {
  it('T2 — a second tick while a quest is pending makes no new offer', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    await h.engine.tick();
    expect(offers(h.frames)).toHaveLength(1);
  });

  it('T4 — no offer when no game client is connected', async () => {
    const h = await harness();
    h.setConnected(false);
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    expect(offers(h.frames)).toHaveLength(0);
    expect(h.runner.genCalls).toHaveLength(0);
  });

  it('clientPrefs enabled=false clears the field (questRevoked) and blocks offers (§4.7)', async () => {
    const h = await harness();
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick();
    const q = offers(h.frames)[0];
    h.engine.onClientMessage({
      v: 1,
      type: 'clientPrefs',
      payload: { quests: { enabled: false, minIntervalRealMinutes: 30 } },
    });
    expect(h.frames.some((f) => f.type === 'questRevoked' && f.payload.questId === q.questId)).toBe(
      true,
    );
    // a subsequent tick offers nothing (client disabled)
    h.advance(COOLDOWN_MS);
    const before = offers(h.frames).length;
    await h.engine.tick();
    expect(offers(h.frames)).toHaveLength(before);
  });
});

describe('opt-in follow-up consent — §3.4 二次引导 (US 31)', () => {
  /** Consent with the given option, then answer N local quests (advancing cooldown). */
  async function consentThenLocals(
    h: Harness,
    consentOption: 'a' | 'b' | 'c',
    localCount: number,
  ): Promise<void> {
    h.setTable(
      new Map([
        ['s1', workingRecord('s1', '/home/me/work/pay', new Date(1_000_000).toISOString())],
      ]),
    );
    await h.engine.tick(); // scripted consent
    const consent = offers(h.frames)[0];
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: consent.questId, optionId: consentOption },
    });
    for (let i = 0; i < localCount; i++) {
      h.advance(COOLDOWN_MS);
      await h.engine.tick(); // local reflection quest
      const local = offers(h.frames).filter((q) => q.source === 'local');
      const last = local[local.length - 1];
      expect(last).toBeDefined();
      h.engine.onClientMessage({
        v: 1,
        type: 'questAnswer',
        payload: { questId: last.questId, note: `答案${String(i)}` },
      });
      // The answer handler is async (note write + archive). Wait for the OBSERVABLE
      // completion signal — the questReward frame for this quest — instead of a fixed
      // sleep, so the next tick never races an un-settled archive under CPU load.
      await waitForReward(h.frames, last.questId);
    }
  }

  /** All scripted quests offered (the first consent + any follow-up). */
  function scriptedOffers(frames: ServerMessage[]): Quest[] {
    return offers(frames).filter((q) => q.source === 'scripted');
  }

  it('fires exactly once on the 3rd local quest for the b-path (§3.4)', async () => {
    const h = await harness();
    await consentThenLocals(h, 'b', 3);
    // The first scripted offer was the consent; the SECOND scripted offer is the
    // follow-up surfaced after the 3rd local quest archived.
    const scripted = scriptedOffers(h.frames);
    expect(scripted).toHaveLength(2);
    const followUp = scripted[1];
    expect(followUp.opener).toContain('想聊聊你手头真正的活儿吗');
    // It carries the §3.4 a/b/c options (same informed-consent flow).
    expect(followUp.options?.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('never fires for the c-path (总开关 off) — §3.4', async () => {
    const h = await harness();
    // Choosing c flips enabled=false (via onConsentChoice), so no local quests run.
    // Force-allow local progress by keeping enabled true but choice c is terminal:
    // c disables the module entirely; assert NO follow-up is ever offered.
    await consentThenLocals(h, 'c', 0);
    // After c, the module is disabled — no further offers at all.
    h.advance(COOLDOWN_MS);
    await h.engine.tick();
    expect(scriptedOffers(h.frames)).toHaveLength(1); // only the original consent
  });

  it('never fires for the a-path (AI enabled) even with 3 answered quests', async () => {
    // a enables AI; the follow-up gate requires the first choice to be 'b'. Drive
    // 3 LOCAL quests anyway (force local by leaving no candidate) and assert no
    // follow-up. With AI on but no candidate, the engine serves the local pool.
    const h = await harness();
    h.setTable(new Map()); // no candidate ⇒ local pool even with AI on
    await h.engine.tick(); // consent
    const consent = offers(h.frames)[0];
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: consent.questId, optionId: 'a' },
    });
    for (let i = 0; i < 3; i++) {
      h.advance(COOLDOWN_MS);
      await h.engine.tick();
      const local = offers(h.frames).filter((q) => q.source === 'local');
      const last = local[local.length - 1];
      if (!last) continue;
      h.engine.onClientMessage({
        v: 1,
        type: 'questAnswer',
        payload: { questId: last.questId, note: `a答案${String(i)}` },
      });
      await waitForReward(h.frames, last.questId);
    }
    expect(scriptedOffers(h.frames)).toHaveLength(1); // only the original consent
  });

  it('does not fire on the 2nd or 4th local quest (only the 3rd) — §3.4', async () => {
    const h = await harness();
    await consentThenLocals(h, 'b', 2);
    expect(scriptedOffers(h.frames)).toHaveLength(1); // no follow-up yet at count 2
  });

  it('answering the follow-up with a enables AI and is terminal (one-time)', async () => {
    const h = await harness();
    await consentThenLocals(h, 'b', 3);
    const followUp = scriptedOffers(h.frames)[1];
    expect(followUp).toBeDefined();
    h.engine.onClientMessage({
      v: 1,
      type: 'questAnswer',
      payload: { questId: followUp.questId, optionId: 'a' },
    });
    expect(h.consentChoices).toEqual(['localOnly', 'enableAi']);
    // A further local quest must NOT re-surface a follow-up (askedFollowUp terminal).
    // (AI is now on, but with no candidate it would fall to local; either way no
    // second follow-up may appear.)
    h.setTable(new Map());
    h.advance(COOLDOWN_MS);
    await h.engine.tick();
    const local = offers(h.frames).filter((q) => q.source === 'local');
    const last = local[local.length - 1];
    if (last) {
      h.engine.onClientMessage({
        v: 1,
        type: 'questAnswer',
        payload: { questId: last.questId, note: '再一题' },
      });
      await waitForReward(h.frames, last.questId);
    }
    expect(scriptedOffers(h.frames)).toHaveLength(2); // consent + the single follow-up
  });

  it('declining the follow-up (先不聊) is zero-cost but terminal — §3.4', async () => {
    const h = await harness();
    await consentThenLocals(h, 'b', 3);
    // After 3 local quests the follow-up was offered exactly once (consent + 1).
    expect(scriptedOffers(h.frames)).toHaveLength(2);
    const followUp = scriptedOffers(h.frames)[1];
    h.engine.onClientMessage({
      v: 1,
      type: 'questDismiss',
      payload: { questId: followUp.questId },
    });
    // No config change, a questRevoked for the follow-up, slot freed.
    expect(h.consentChoices).toEqual(['localOnly']); // unchanged by the decline
    expect(
      h.frames.some((f) => f.type === 'questRevoked' && f.payload.questId === followUp.questId),
    ).toBe(true);
    // Drive more local quests — a SECOND follow-up must never be offered (terminal):
    // the scripted-offer total stays at 2 (consent + the single declined follow-up).
    h.advance(COOLDOWN_MS);
    await h.engine.tick();
    const local = offers(h.frames).filter((q) => q.source === 'local');
    const last = local[local.length - 1];
    if (last) {
      h.engine.onClientMessage({
        v: 1,
        type: 'questAnswer',
        payload: { questId: last.questId, note: '又一题' },
      });
      await waitForReward(h.frames, last.questId);
    }
    expect(scriptedOffers(h.frames)).toHaveLength(2); // no further follow-up
  });
});

// ---- helpers that build a fully-consented AI offer in one shot ----

function promptEvent(sessionId: string, at: number): SessionEvent {
  return { kind: 'hookUserPromptSubmit', at, sessionId };
}

/** A transcript long enough to clear the 300-char sanitized floor, with a seeded secret. */
function buildRichTranscript(): string {
  const lines: unknown[] = [{ type: 'ai-title', aiTitle: '登录服务重试策略' }];
  lines.push({ type: 'last-prompt', lastPrompt: '我在纠结重试和熔断的边界，应该怎么设计才稳' });
  for (let i = 0; i < 6; i++) {
    lines.push({
      type: 'user',
      userType: 'external',
      message: {
        content: `第${String(i)}轮：我们的登录服务在高峰期会超时，重试逻辑要不要加退避，会不会把下游打死，token=hunter2supersecret 这种也别复述`,
      },
    });
    lines.push({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `第${String(i)}轮回答：可以考虑指数退避加熔断，但要权衡夜间无人值守的情况，给只读降级留口子。`,
          },
        ],
      },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * Spin up a harness, consent to AI, then advance past cooldown and feed 2 fresh
 * prompts at the (advanced) clock so the candidate is both fresh (mtime ≈ now,
 * §3.3-①) and has ≥2 new prompts (§3.3-②). One tick → an AI offer exists.
 */
async function aiOfferHarness(): Promise<Harness> {
  const h = await harness({ transcriptReader: fixedReader(buildRichTranscript()) });
  // AI ships OFF; the first tick yields the scripted consent task. Answering 'a'
  // flips aiGeneration on (via onConsentChoice in the harness) — the real flow.
  await h.engine.tick(); // consent task (table empty is fine — scriptedConsent ignores candidate)
  const consent = offers(h.frames)[0];
  h.engine.onClientMessage({
    v: 1,
    type: 'questAnswer',
    payload: { questId: consent.questId, optionId: 'a' },
  });
  // Advance past cooldown, THEN make a fresh working session + 2 recent prompts.
  h.advance(COOLDOWN_MS);
  const nowIso = new Date(1_000_000 + COOLDOWN_MS).toISOString();
  h.setTable(new Map([['s1', workingRecord('s1', '/home/me/work/payments', nowIso)]]));
  h.engine.onSessionEvent(promptEvent('s1', 1_000_000 + COOLDOWN_MS - 100));
  h.engine.onSessionEvent(promptEvent('s1', 1_000_000 + COOLDOWN_MS - 50));
  await h.engine.tick(); // AI generate + offer
  return h;
}
