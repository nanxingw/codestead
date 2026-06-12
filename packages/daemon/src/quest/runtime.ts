/**
 * Quest engine — the M4 composition core that ties the pure pieces together
 * (ai-quests §3~§10). This is the ONLY stateful orchestrator in the quest module;
 * every IO is injected so it is integration-testable with a stub claude, a temp
 * fs and a fake clock, never the real ~/.codestead or the network.
 *
 * Responsibilities (all gated by the `enabled` 总开关 — when false the engine is
 * NEVER constructed by the caller, §9/A1):
 *  - track per-session prompt-delta bookkeeping from normalized hook events
 *    (§3.3-②: ≥2 new external prompts since last quizzed);
 *  - on each tick, run evaluateTrigger (T1~T7); route to AI generation / local
 *    pool / scripted consent / nothing (§3.2);
 *  - AI path: select candidate → read transcript tail → sanitize → build prompt →
 *    runGeneration (stub-injectable) → complete the Quest → offer (§4);
 *  - drive the lifecycle reducer + atomic persistence (§5); push questOffer /
 *    questSnapshot / questRevoked / questReward over WS;
 *  - handle inbound questAnswer / questDismiss / clientPrefs (§4.7);
 *  - account every AI call, log errors, write notes on answer (§4.5/§7/§10).
 *
 * PRIVACY: no transcript-derived content is ever logged or pushed over WS; only
 * the sanitized text reaches the model via stdin, and only display-safe Quest
 * fields cross the wire (§12).
 */
import { randomUUID } from 'node:crypto';

import {
  rewardFor,
  type ClientMessage,
  type NpcId,
  type Quest,
  type QuestGen,
  type QuestReward,
  type ServerMessage,
} from '@codestead/shared';

import type { SessionEvent } from '../state/events.js';
import type { SessionRecord, SessionTable } from '../state/types.js';
import type { QuestJournals } from './accounting.js';
import { selectCandidate, type CandidateRow } from './candidate.js';
import type { AiQuestsConfig } from './config.js';
import { runGeneration, type ClaudeRunner } from './exec-claude.js';
import {
  createInitialQuestState,
  reduceQuestLifecycle,
  type GenFailureReason,
  type QuestLifecycleEvent,
} from './lifecycle.js';
import { drawLocalQuestion, LOCAL_POOL } from './local-pool.js';
import type { NoteFrontmatter, NotesWriter } from './notes.js';
import { createFileNotes } from './notes.js';
import { buildPrompt, renderContextDocument } from './prompt.js';
import type { QuestStateStore } from './persistence.js';
import { normalizeOnRestart } from './persistence.js';
import { sanitize } from './sanitize.js';
import { readTranscriptContext, type TranscriptTailReader } from './transcript-reader.js';
import { evaluateTrigger, type CandidateSession, type TriggerInput } from './trigger.js';
import { FOLLOW_UP_AFTER_LOCAL_COUNT, MIN_CONTEXT_CHARS } from './types.js';

/** Scripted first-consent task copy (§3.4) — fixed local text, NEVER AI-generated. */
const SCRIPTED_CONSENT: Omit<QuestGen, 'npcId'> & { npcId: NpcId } = {
  npcId: 'npc_keeper',
  kind: 'decision',
  title: '渠叔的请求',
  opener: '巡渠的间隙，渠叔放下斗笠：「有件事想先问过你。」',
  body: '村里人想偶尔跟你聊聊你手头的活儿。这需要本机的 claude 帮忙读你的会话记录、想问题——会消耗你自己的 Claude 额度（订阅或 API），内容只在你这台机器和你已有的 Claude 通道里走。',
  options: [
    { id: 'a', label: '好，开聊（开启 AI 任务）', tradeoff: '会用到你自己的 Claude 额度' },
    { id: 'b', label: '只用你们自己想的问题', tradeoff: '只出本地题库、不读你的工作' },
    { id: 'c', label: '都不要，让我安静种地', tradeoff: '关闭村民任务，村民只闲聊' },
  ],
  closer: '渠叔点点头：「都依你。地里见。」',
  contextEcho: '首次启用 AI 出题前的知情同意。',
};

/** The §3.4 opt-in follow-up closer add-on, appended to the 3rd local quest's NPC. */
const FOLLOW_UP_OPENER = '收工前，村民多问了一句：「下回……想聊聊你手头真正的活儿吗？」';

/**
 * Build the one-time opt-in follow-up consent task (§3.4): SAME informed-consent
 * body + a/b/c options as the first consent, but the opener carries the §3.4
 * follow-up line and the NPC is the villager who just gave the 3rd local quest
 * (so it reads as that villager's收尾追问, not 渠叔 again unless 渠叔 gave it).
 */
function followUpConsent(npcId: NpcId): Omit<QuestGen, 'npcId'> & { npcId: NpcId } {
  return { ...SCRIPTED_CONSENT, npcId, opener: FOLLOW_UP_OPENER };
}

/** Pick the NPC for a local-pool quest from the drawn entry's affinity tag (§1.1). */
function npcForLocal(poolId: string): NpcId {
  const entry = LOCAL_POOL.find((e) => e.id === poolId);
  return entry?.npcId ?? 'npc_keeper'; // 兜底 渠叔 (§1.1)
}

/** Per-session prompt-delta bookkeeping for §3.3-② (kept in-engine, not persisted). */
interface SessionProbe {
  /** New external prompts observed since this session was last quizzed. */
  newExternalPrompts: number;
  /** Monotonic-ish ms of the most recent UserPromptSubmit. */
  lastPromptAtMs: number;
}

export interface QuestEngineDeps {
  /** Live config (already clamped). The engine reads it each tick (hot-updatable). */
  getConfig: () => AiQuestsConfig;
  /** The current session table (read-only view from the M2 reducer loop). */
  getSessionTable: () => SessionTable;
  /** True when ≥1 game client is authenticated (T4). */
  isGameConnected: () => boolean;
  /** Broadcast a server frame to all authed clients. */
  broadcast: (message: ServerMessage) => void;
  /** Injected claude runner (stub in tests; real spawn in production). */
  claudeRunner: ClaudeRunner;
  /** True when feature-detect passed; false ⇒ AI path stays off (degrade to local). */
  aiPathAvailable: boolean;
  /** Transcript tail reader (injected; never the real fs in tests). */
  transcriptReader: TranscriptTailReader;
  /** Persisted state store (atomic temp+rename). */
  stateStore: QuestStateStore;
  /** Cost + error journals. */
  journals: QuestJournals;
  /** Notes factory rooted at the notes dir. */
  notes: ReturnType<typeof createFileNotes>;
  /** Absolute home dir for sanitize() $HOME rewrite (injected — no os.homedir here). */
  homeDir: string;
  /** Monotonic ms clock (cooldown math; §11-E10). Default performance.now-ish via caller. */
  nowMonotonicMs: () => number;
  /** Wall clock ms (ISO timestamps / daily date). */
  nowWallMs: () => number;
  /** Randomness for the local-pool draw (injected for determinism). */
  rand?: () => number;
  /** UUID generator (injected for deterministic tests). */
  uuid?: () => string;
  /**
   * Called when the scripted consent task is answered (§3.4). The caller owns the
   * config.json mutation: 'enableAi' → aiGeneration=true; 'localOnly' → unchanged;
   * 'disableAll' → enabled=false (which also triggers shutdownClearField via the
   * config's getConfig().enabled flipping false on the next tick).
   */
  onConsentChoice?: (choice: 'enableAi' | 'localOnly' | 'disableAll') => void;
}

/** Inbound non-auth client frames the engine consumes (§4.7). */
export type QuestClientMessage = Exclude<ClientMessage, { type: 'auth' }>;

export interface QuestEngine {
  /** Feed a normalized session event (prompt-delta bookkeeping). */
  onSessionEvent(event: SessionEvent): void;
  /** Run one trigger evaluation + (async) pipeline step. Resolves when settled. */
  tick(): Promise<void>;
  /** Handle an inbound non-auth client frame (questAnswer/questDismiss/clientPrefs). */
  onClientMessage(message: QuestClientMessage): void;
  /** Frames a freshly-authed client should receive after hello+snapshot (questSnapshot). */
  getPostAuthFrames(): ServerMessage[];
  /** Load + normalize persisted state (call once at startup before serving). */
  init(): Promise<void>;
  /** Clear the field on 总开关关闭 (revokeAll + questRevoked broadcast). */
  shutdownClearField(): void;
}

export function createQuestEngine(deps: QuestEngineDeps): QuestEngine {
  const rand = deps.rand ?? Math.random;
  const uuid = deps.uuid ?? randomUUID;

  let state = createInitialQuestState();
  /** Client-pref merge inputs (§4.7); null until the client sends clientPrefs. */
  let clientEnabled = true;
  let clientMinInterval: 15 | 30 | null = null;
  /** Per-session probe bookkeeping (§3.3-②). */
  const probes = new Map<string, SessionProbe>();
  /** Guard so overlapping ticks never spawn two generations. */
  let generating = false;
  /** Synchronous answer guard (§11-E7 first-come): questId being answered right now. */
  let answeringQuestId: string | null = null;
  /** sessionId of the last quest's related session (down-weight, §3.3-③). */
  let lastQuestSessionId: string | null = null;
  /**
   * questId of the in-flight opt-in follow-up consent task (§3.4), or null. A
   * scripted quest with this id routes its a/b/c through the consent flow AND marks
   * the follow-up terminal (markAsked followUp:true) — distinguishing it from the
   * first-consent scripted task, which records the first choice instead.
   */
  let followUpQuestId: string | null = null;

  function persist(): void {
    void deps.stateStore.write(state).catch(() => {
      // E11: a write failure must not crash; the in-memory state is authoritative
      // for this run and the next successful write recovers (logged by the caller).
    });
  }

  function apply(event: QuestLifecycleEvent): boolean {
    const next = reduceQuestLifecycle(state, event);
    if (next === state) return false;
    state = next;
    return true;
  }

  /** Roll the daily counters over when the machine-local date changes (§3.1/§11-E10). */
  function ensureDailyDate(): void {
    const today = new Date(deps.nowWallMs()).toISOString().slice(0, 10);
    if (state.counters.dailyDate !== today) {
      state = {
        ...state,
        counters: { ...state.counters, dailyDate: today, dailyCount: 0, dailyCostUsd: 0 },
      };
    }
  }

  /** Build the trigger input from live state + injected clocks. */
  function buildTriggerInput(candidate: CandidateSession | null): TriggerInput {
    return {
      config: deps.getConfig(),
      clientMinIntervalMinutes: clientMinInterval,
      clientEnabled,
      gameConnected: deps.isGameConnected(),
      pendingExists: state.phase === 'OFFERED' || state.phase === 'GENERATING',
      nowMonotonicMs: deps.nowMonotonicMs(),
      nowDate: new Date(deps.nowWallMs()).toISOString().slice(0, 10),
      lastAttemptAtMs: state.counters.lastAttemptAt,
      dailyCount: state.counters.dailyCount,
      dailyCostUsd: state.counters.dailyCostUsd,
      localPoolMode: state.counters.localPoolMode,
      lastRecoveryProbeAtMs: state.counters.lastRecoveryProbeAt,
      asked: state.counters.asked,
      candidate,
      localPoolAvailable: drawLocalQuestion(state.counters.usedLocalPoolIds, () => 0) !== null,
    };
  }

  /** Project the session table into candidate rows (§3.3 input). */
  function candidateRows(): CandidateRow[] {
    const rows: CandidateRow[] = [];
    for (const [sessionId, record] of deps.getSessionTable()) {
      const probe = probes.get(sessionId);
      rows.push({
        sessionId,
        cwd: record.info.cwd,
        state: record.info.state,
        transcriptPath: record.transcriptPath,
        // The transcript mtime is approximated by the session's lastSignalAt — the
        // hooks/transcript sources stamp it on every append (fresh ⇔ recent signal).
        transcriptMtimeMs: probe?.lastPromptAtMs ?? lastSignalMs(record),
        newExternalPrompts: probe?.newExternalPrompts ?? 0,
        lastPromptAtMs: probe?.lastPromptAtMs ?? 0,
        wasLastQuestSession: sessionId === lastQuestSessionId,
      });
    }
    return rows;
  }

  function lastSignalMs(record: SessionRecord): number {
    const t = Date.parse(record.info.lastSignalAt);
    return Number.isNaN(t) ? 0 : t;
  }

  /** Offer a freshly-built quest: reduce → persist → broadcast questOffer (§5/§4.7). */
  function offerQuest(quest: Quest, costUsd: number, isAi: boolean): void {
    apply({ kind: 'genSuccess', at: deps.nowMonotonicMs(), quest });
    if (isAi) {
      apply({ kind: 'genCostOnly', at: deps.nowMonotonicMs(), costUsd });
    }
    lastQuestSessionId = quest.relatedSessionId;
    persist();
    deps.broadcast({ v: 1, type: 'questOffer', payload: { quest } });
  }

  /** Assemble a complete Quest from a model/local/scripted QuestGen (daemon补全, §4.6). */
  function completeQuest(
    gen: QuestGen,
    source: Quest['source'],
    related: { sessionId: string | null; cwd: string | null },
  ): Quest {
    return {
      ...gen,
      questId: uuid(),
      source,
      relatedSessionId: related.sessionId,
      relatedCwd: related.cwd,
      // Reward by TABLE lookup (§8.1) — the model has no authority here (§4.6/§11-E8).
      reward: rewardFor(source, gen.kind),
      createdAt: new Date(deps.nowWallMs()).toISOString(),
    };
  }

  /** Mark a generation attempt's start (lastAttemptAt advances for T3, §3.2). */
  function beginAttempt(): void {
    apply({ kind: 'genStart', at: deps.nowMonotonicMs() });
    persist();
  }

  async function runAiPath(candidate: CandidateSession): Promise<void> {
    beginAttempt();
    // Read transcript tail (injected reader) → extract whitelisted context (§4.2).
    let extracted;
    try {
      extracted = await readTranscriptContext(deps.transcriptReader, candidate.transcriptPath);
    } catch {
      // Any read error → treat as a failed attempt; never crash (§11-E6).
      recordFailure('processCrash', 0, '');
      return;
    }
    const doc = renderContextDocument(extracted);
    const sanitized = sanitize(doc, { homeDir: deps.homeDir });
    // §3.3-④: sanitized context too thin → abandon AI this tick WITHOUT a call.
    // This is NOT a failure (no claude was spawned, no streak bump): just release
    // the GENERATING slot back to IDLE so the next tick may route to the local
    // pool. lastAttemptAt already advanced in beginAttempt(), so the cooldown
    // still applies (a thin context does not get a free immediate retry).
    if (sanitized.length < MIN_CONTEXT_CHARS) {
      state = { ...state, phase: 'IDLE', pending: null };
      persist();
      return;
    }
    const prompt = buildPrompt(extracted, sanitized);
    const outcome = await runGeneration(
      deps.claudeRunner,
      deps.getConfig(),
      prompt.instructions,
      prompt.stdinContext,
    );
    const questId = state.pending?.questId ?? null;
    await deps.journals
      .appendCost({
        ts: new Date(deps.nowWallMs()).toISOString(),
        questId,
        model: deps.getConfig().model,
        totalCostUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
        ok: outcome.ok,
      })
      .catch(() => undefined);

    if (!outcome.ok) {
      recordFailure(outcome.reason, outcome.costUsd, outcome.rawSample);
      return;
    }
    // Success: complete + offer. The cost is accrued via genCostOnly in offerQuest.
    const quest = completeQuest(outcome.quest, 'ai', {
      sessionId: candidate.sessionId,
      cwd: basenameOf(candidate.cwd),
    });
    offerQuest(quest, outcome.costUsd, true);
    // Reset the quizzed session's prompt-delta (§3.3-②).
    const probe = probes.get(candidate.sessionId);
    if (probe !== undefined) probe.newExternalPrompts = 0;
  }

  function recordFailure(reason: GenFailureReason, costUsd: number, rawSample: string): void {
    apply({ kind: 'genFailure', at: deps.nowMonotonicMs(), reason, costUsd });
    if (reason === 'invalidOutput' && rawSample !== '') {
      void deps.journals.appendError(null, rawSample).catch(() => undefined);
    }
    // §10: in local-pool mode the recovery probe time advances so we wait 60 min.
    if (state.counters.localPoolMode) {
      state = {
        ...state,
        counters: { ...state.counters, lastRecoveryProbeAt: deps.nowMonotonicMs() },
      };
    }
    persist();
    // Free the FAILED slot immediately for the next tick (backoff is enforced by
    // the cooldown in evaluateTrigger via lastAttemptAt, not by holding FAILED).
    apply({ kind: 'backoffElapsed', at: deps.nowMonotonicMs() });
    persist();
  }

  function runLocalPath(): void {
    beginAttempt();
    const entry = drawLocalQuestion(state.counters.usedLocalPoolIds, rand);
    if (entry === null) {
      // Pool exhausted between the trigger check and here — release the slot.
      apply({ kind: 'backoffElapsed', at: deps.nowMonotonicMs() });
      // genStart moved us to GENERATING; reset back to IDLE with no pending.
      state = { ...state, phase: 'IDLE', pending: null };
      persist();
      return;
    }
    apply({ kind: 'localDrawn', poolId: entry.id });
    const gen: QuestGen = {
      npcId: npcForLocal(entry.id),
      kind: 'reflection',
      title: '村民的问题',
      opener: '村民放下手里的活，看了你一眼。',
      body: entry.question,
      closer: '想好了再答，地里的活儿不急。',
      contextEcho: '',
    };
    const quest = completeQuest(gen, 'local', { sessionId: null, cwd: null });
    offerQuest(quest, 0, false);
  }

  function runScriptedConsent(): void {
    beginAttempt();
    const quest = completeQuest({ ...SCRIPTED_CONSENT }, 'scripted', {
      sessionId: null,
      cwd: null,
    });
    offerQuest(quest, 0, false);
  }

  // ---- public surface ----

  async function tick(): Promise<void> {
    if (generating) return; // a previous tick's async pipeline is still running
    if (!deps.getConfig().enabled) return; // 总开关 (defensive; engine not built when off)
    ensureDailyDate();

    // Candidate selection is done UPSTREAM of evaluateTrigger (§3.3). Only do the
    // (cheap) projection when the AI path could plausibly run.
    const config = deps.getConfig();
    const wantCandidate = config.aiGeneration && deps.aiPathAvailable;
    const candidate = wantCandidate
      ? selectCandidate(candidateRows(), deps.nowMonotonicMs())
      : null;

    const decision = evaluateTrigger(buildTriggerInput(candidate));
    switch (decision.kind) {
      case 'none':
        return;
      case 'scriptedConsent':
        runScriptedConsent();
        return;
      case 'localPool':
        runLocalPath();
        return;
      case 'aiGenerate': {
        if (!deps.aiPathAvailable) {
          // Feature-detect said no — fall back to local rather than spawn.
          runLocalPath();
          return;
        }
        generating = true;
        try {
          await runAiPath(decision.candidate);
        } finally {
          generating = false;
        }
        return;
      }
    }
  }

  function onSessionEvent(event: SessionEvent): void {
    // §3.3-②: count external user prompts since this session was last quizzed. The
    // hook UserPromptSubmit IS an external prompt (interactive sessions only — the
    // headless quest session is filtered out at the ps/tty + marker level, §4.5).
    if (event.kind === 'hookUserPromptSubmit') {
      const probe = probes.get(event.sessionId) ?? { newExternalPrompts: 0, lastPromptAtMs: 0 };
      probe.newExternalPrompts += 1;
      probe.lastPromptAtMs = event.at;
      probes.set(event.sessionId, probe);
    } else if (event.kind === 'hookSessionEnd') {
      // E2: the quest may still be offered after SessionEnd; we only drop the
      // prompt-delta bookkeeping (no longer a candidate), never the live quest.
      probes.delete(event.sessionId);
    }
  }

  function onClientMessage(message: QuestClientMessage): void {
    // The payloads are already validated by ClientMessageSchema (the server
    // safeParses before this is called), so narrowing on `type` gives fully-typed
    // payloads — no casts.
    if (message.type === 'clientPrefs') {
      const { quests } = message.payload;
      clientEnabled = quests.enabled;
      clientMinInterval = quests.minIntervalRealMinutes;
      // Game-side disable clears the field too (§4.7 stricter merge).
      if (!clientEnabled) shutdownClearField();
      return;
    }
    if (message.type === 'questDismiss') {
      const { questId } = message.payload;
      // Declining (先不聊) the opt-in follow-up consent is zero-cost but STILL
      // one-time (§3.4 「拒绝则一切如旧、零代价」, terminal): mark it asked so it
      // never re-fires. The first-consent task is never dismiss-routed (the player
      // always picks a/b/c there), but be defensive — only the follow-up burns here.
      const wasFollowUp = questId === followUpQuestId;
      const changed = apply({
        kind: 'dismiss',
        questId,
        dismissedAt: new Date(deps.nowWallMs()).toISOString(),
      });
      if (changed) {
        if (wasFollowUp) {
          followUpQuestId = null;
          apply({ kind: 'markAsked', followUp: true });
        }
        persist();
        deps.broadcast({ v: 1, type: 'questRevoked', payload: { questId } });
        // Free the slot for the next trigger (DISMISSED → IDLE).
        apply({ kind: 'reset', at: deps.nowMonotonicMs() });
        persist();
      }
      return;
    }
    // questAnswer
    const { questId, optionId, note } = message.payload;
    void handleAnswer(questId, optionId, note);
  }

  async function handleAnswer(
    questId: string,
    optionId: 'a' | 'b' | 'c' | 'd' | undefined,
    note: string | undefined,
  ): Promise<void> {
    // Only act on the live OFFERED quest matching questId (first-come, §11-E7).
    // The SYNCHRONOUS `answeringQuestId` guard wins the race when two tabs answer
    // the same quest before the (async) note write completes — the second call
    // sees the in-flight id and bails, so questReward is emitted exactly once.
    if (state.phase !== 'OFFERED' || state.pending === null || state.pending.questId !== questId) {
      return;
    }
    if (answeringQuestId === questId) return;
    answeringQuestId = questId;
    const quest = state.pending;

    // Scripted consent task routes the choice to config (§3.4) and writes NO note.
    // A follow-up consent (§3.4 opt-in二次引导) is the same a/b/c flow but marks the
    // follow-up terminal instead of recording the first choice.
    if (quest.source === 'scripted') {
      const isFollowUp = quest.questId === followUpQuestId;
      applyConsentChoice(optionId, isFollowUp);
      if (isFollowUp) followUpQuestId = null;
      finishAnswerNoNote(quest);
      return;
    }

    // Write the note (§7). On fs failure: withhold the reward but still archive,
    // so the player is not stuck and is not double-asked (§11-E11).
    let noteRef: string | null = null;
    let noteOk = true;
    try {
      noteRef = await writeNote(quest, optionId, note);
    } catch {
      noteOk = false;
    }
    apply({
      kind: 'answer',
      questId,
      noteRef,
      answeredAt: new Date(deps.nowWallMs()).toISOString(),
    });
    persist();
    if (noteOk) {
      grantAndArchive(quest);
    } else {
      // No note → no reward (§11-E11); archive so the slot frees.
      apply({ kind: 'reward', questId });
      apply({ kind: 'reset', at: deps.nowMonotonicMs() });
      persist();
      answeringQuestId = null;
    }
  }

  function applyConsentChoice(
    optionId: 'a' | 'b' | 'c' | 'd' | undefined,
    isFollowUp: boolean,
  ): void {
    // a → aiGeneration on; b → local only; c → 总开关 off. The CONFIG mutation is
    // surfaced to the caller via a side-channel callback would be cleaner, but the
    // engine只 owns its own asked flags; the caller persists config from a/b/c.
    // The first consent records its choice (§3.4 follow-up gate); the follow-up
    // marks itself terminal (askedFollowUp) so it can never fire twice.
    if (isFollowUp) {
      apply({ kind: 'markAsked', followUp: true });
    } else {
      // optionId is always one of a/b/c for the scripted task (option 'd' never
      // appears in SCRIPTED_CONSENT); narrow defensively for the reducer.
      const choice =
        optionId === 'a' || optionId === 'b' || optionId === 'c' ? optionId : undefined;
      apply({ kind: 'markAsked', choice });
    }
    if (optionId === 'a') deps.onConsentChoice?.('enableAi');
    else if (optionId === 'b') deps.onConsentChoice?.('localOnly');
    else if (optionId === 'c') deps.onConsentChoice?.('disableAll');
    persist();
  }

  function finishAnswerNoNote(quest: Quest): void {
    apply({
      kind: 'answer',
      questId: quest.questId,
      noteRef: null,
      answeredAt: new Date(deps.nowWallMs()).toISOString(),
    });
    persist();
    grantAndArchive(quest);
  }

  function grantAndArchive(quest: Quest): void {
    const reward: QuestReward = quest.reward;
    deps.broadcast({ v: 1, type: 'questReward', payload: { questId: quest.questId, reward } });
    apply({ kind: 'reward', questId: quest.questId });
    apply({ kind: 'reset', at: deps.nowMonotonicMs() });
    persist();
    answeringQuestId = null;
    // §3.4 opt-in 二次引导: after the 3rd ANSWERED local-pool quest archives, if the
    // first consent picked 'b' (localOnly) and AI was never enabled and the follow-up
    // was never asked, surface the one-time follow-up consent (same a/b/c flow) on
    // the just-answered villager. Must run AFTER the slot is freed above so it owns
    // the single pending slot.
    if (quest.source === 'local') maybeOfferFollowUp(quest.npcId);
  }

  /**
   * Surface the §3.4 opt-in follow-up consent IFF every condition holds (one-time):
   *  - the player has answered exactly 3 local-pool quests (localCompletedCount===3);
   *  - the FIRST consent choice was 'b' (localOnly) — choice 'a'/'c' never trigger;
   *  - AI generation was never enabled (config.aiGeneration still false);
   *  - the follow-up has not already been asked (askedFollowUp false).
   * Offering it occupies the pending slot directly (the §3.4 line is its opener) —
   * the trigger path can't re-emit a scripted consent once `asked` is true, so the
   * engine offers it here, not via evaluateTrigger.
   */
  function maybeOfferFollowUp(npcId: NpcId): void {
    const c = state.counters;
    if (c.localCompletedCount !== FOLLOW_UP_AFTER_LOCAL_COUNT) return;
    if (c.firstConsentChoice !== 'b') return;
    if (c.askedFollowUp) return;
    if (deps.getConfig().aiGeneration) return; // AI was enabled at some point → skip
    if (state.phase !== 'IDLE') return; // slot must be free (defensive)
    beginAttempt();
    const quest = completeQuest(followUpConsent(npcId), 'scripted', {
      sessionId: null,
      cwd: null,
    });
    followUpQuestId = quest.questId;
    offerQuest(quest, 0, false);
  }

  async function writeNote(
    quest: Quest,
    optionId: 'a' | 'b' | 'c' | 'd' | undefined,
    note: string | undefined,
  ): Promise<string> {
    const localDate = new Date(deps.nowWallMs()).toISOString().slice(0, 10);
    const writer: NotesWriter = deps.notes.writerFor(localDate);
    const options =
      quest.options !== undefined
        ? quest.options.map((o) => ({
            id: o.id,
            label: o.label,
            ...(o.id === optionId ? { chosen: true } : {}),
          }))
        : undefined;
    const fm: NoteFrontmatter = {
      questId: quest.questId,
      source: quest.source,
      kind: quest.kind,
      npcId: quest.npcId,
      title: quest.title,
      relatedSessionId: quest.relatedSessionId,
      relatedCwd: quest.relatedCwd,
      contextEcho: quest.contextEcho,
      question: quest.body,
      ...(options !== undefined ? { options } : {}),
      reward: quest.reward,
      createdAt: quest.createdAt,
      answeredAt: new Date(deps.nowWallMs()).toISOString(),
    };
    return writer.write(fm, note ?? '');
  }

  function getPostAuthFrames(): ServerMessage[] {
    // questSnapshot carries the 0-or-1 pending quest on connect/reconnect (§5).
    const quests = state.phase === 'OFFERED' && state.pending !== null ? [state.pending] : [];
    return [{ v: 1, type: 'questSnapshot', payload: { quests } }];
  }

  async function init(): Promise<void> {
    const loaded = await deps.stateStore.read();
    if (loaded !== null) {
      state = normalizeOnRestart(loaded);
      persist();
    }
  }

  function shutdownClearField(): void {
    const pendingId = state.pending?.questId ?? null;
    const changed = apply({ kind: 'revokeAll', at: deps.nowMonotonicMs() });
    if (changed) {
      persist();
      if (pendingId !== null) {
        deps.broadcast({ v: 1, type: 'questRevoked', payload: { questId: pendingId } });
      }
    }
  }

  return {
    onSessionEvent,
    tick,
    onClientMessage,
    getPostAuthFrames,
    init,
    shutdownClearField,
  };
}

/** Last path segment only (privacy §12-3: relatedCwd is pushed as a basename). */
function basenameOf(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter((p) => p !== '');
  const last = parts[parts.length - 1];
  return last !== undefined ? last : cwd;
}
