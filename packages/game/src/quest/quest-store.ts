/**
 * QuestStore — game-side quest state (PRD 05 §D / §I), modelled on HudStore: pure
 * reducers (this file) wrapped by a thin subscription class (quest-store-host.ts).
 * ZERO Phaser, ZERO sim — the dialogue UI subscribes and READS; reward granting
 * goes through the sim facade, not here.
 *
 * Single source of the client view: at most one OFFERED quest (global ≤1, T2),
 * the answer-flow screen the dialogue UI is on, and the local quest preferences
 * (enabled + frequency档) that get merged with the daemon via clientPrefs (§4.7 /
 * GDD §10.7).
 *
 * Zero-disturbance discipline (§3.5 / A4): applying a `questOffer` here MUST NOT
 * touch the time system pause source, move the camera, or push a UI panel — it
 * only sets `pending` so the world layer can float a 💬 bubble. The unit test for
 * §3.5 asserts exactly this (offer in ⇒ no pause-source mutation, no UI-stack push).
 *
 * SKELETON: the state shape, event alphabet, reducer + merge signatures, and the
 * initial-state factory are fixed (load-bearing). The reducer bodies are the
 * quest-store sub-task.
 */
import type { Quest, QuestReward, ServerMessage } from '@codestead/shared';

/** Frequency档 (§6.4): two levels only, no higher frequency (structurally un-spammy). */
export type QuestFrequency = 'low' | 'normal'; // low=≥30min (default), normal=≥15min

/** Local quest preferences persisted to localStorage (GDD §10.7; NOT the save). */
export interface QuestPrefs {
  /** Villager-tasks master switch on the game side (§6.4). */
  readonly enabled: boolean;
  /** Out-frequency档 → clientPrefs.minIntervalRealMinutes (low→30, normal→15). */
  readonly frequency: QuestFrequency;
}

export const DEFAULT_QUEST_PREFS: QuestPrefs = { enabled: true, frequency: 'low' };

/** Map a frequency档 to the wire interval minutes (§4.7). */
export function frequencyToInterval(freq: QuestFrequency): 15 | 30 {
  return freq === 'normal' ? 15 : 30;
}

/** Which dialogue screen the answer flow is on (§6.2 four-屏 decision; reflection skips选项). */
export type QuestScreen =
  | 'none' // not in a quest dialogue
  | 'opener' // 第1屏: NPC opening line
  | 'question' // 第2屏: body + options (decision) / textarea (reflection)
  | 'compose' // 第3屏: optional 补充 (decision only)
  | 'closer'; // 第4屏: closer + reward

export interface QuestState {
  /** The single OFFERED quest, or null (global ≤1, T2). */
  readonly pending: Quest | null;
  /** Which dialogue screen is active (drives the panel; 'none' = world bubble only). */
  readonly screen: QuestScreen;
  /** Selected option id during the question screen (decision); null until chosen. */
  readonly selectedOption: 'a' | 'b' | 'c' | 'd' | null;
  /** Local prefs (merged with daemon via clientPrefs). */
  readonly prefs: QuestPrefs;
  /** Reward to celebrate on the closer screen once questReward arrives; null until then. */
  readonly pendingReward: QuestReward | null;
}

/** Client-driven UI events (open dialogue, choose, advance屏, dismiss, submit). */
export type QuestUiEvent =
  | { readonly kind: 'openDialogue' } // E / click on the 💬 villager → opener屏
  | { readonly kind: 'advance' } // any-key / E page turn
  | { readonly kind: 'selectOption'; readonly optionId: 'a' | 'b' | 'c' | 'd' }
  | { readonly kind: 'confirmOption' } // decision: option → compose屏
  | { readonly kind: 'submitAnswer'; readonly note?: string } // → closer屏 (emits questAnswer upstream)
  | { readonly kind: 'dismiss' } // Esc / 先不聊 (emits questDismiss upstream)
  | { readonly kind: 'closeDialogue' }; // 第4屏 E 回去干活

/** Factory: a fresh store view with the given (persisted) prefs. */
export function createInitialQuestState(prefs: QuestPrefs = DEFAULT_QUEST_PREFS): QuestState {
  return { pending: null, screen: 'none', selectedOption: null, prefs, pendingReward: null };
}

/**
 * Apply a validated daemon frame to the quest state (§4.7). PURE. Handles:
 *  - questSnapshot → set pending to quests[0] ?? null (0 or 1; never touches time/UI);
 *  - questOffer    → set pending (ditto — A4 zero-disturbance: NO pause/camera/panel);
 *  - questRevoked  → if it matches pending, clear it + leave any open dialogue gracefully;
 *  - questReward   → stash pendingReward for the closer屏 (the actual grant is sim-side).
 * Non-quest frames are ignored (return SAME reference). When `prefs.enabled` is
 * false, a questOffer is DROPPED locally (the daemon-不识别-clientPrefs fallback,
 * §4.7 / GDD §10.7).
 *
 * Zero-disturbance discipline (§3.5 / A4): the offer/snapshot branches ONLY set
 * `pending` — they never advance `screen` (it stays whatever it was, normally
 * 'none' = world bubble only) and never select an option. The world layer reads
 * `pending` to float the 💬 bubble; nothing here pauses time, moves the camera, or
 * pushes a panel.
 */
export function applyQuestServerMessage(state: QuestState, message: ServerMessage): QuestState {
  switch (message.type) {
    case 'questSnapshot': {
      // Full re-sync (connect / reconnect): 0 or 1 quest (global ≤1, T2). A
      // snapshot is authoritative — it replaces the pending field. If the snapshot
      // clears a quest the player was mid-dialogue on (e.g. revoked while
      // disconnected), gracefully return to the world bubble state.
      const next = message.payload.quests[0] ?? null;
      if (next === null) return clearPending(state);
      // enabled=false fallback: drop the offer locally (§4.7 / GDD §10.7).
      if (!state.prefs.enabled) return clearPending(state);
      // Same quest already pending ⇒ no observable change; keep dialogue progress.
      if (state.pending && state.pending.questId === next.questId) return state;
      return { ...state, pending: next, screen: 'none', selectedOption: null, pendingReward: null };
    }
    case 'questOffer': {
      const offered = message.payload.quest;
      // enabled=false fallback: drop the offer locally (the承诺 does not depend on
      // the daemon honouring clientPrefs, §4.7 / GDD §10.7).
      if (!state.prefs.enabled) return state;
      // Global ≤1 (T2): an offer never displaces a quest already being answered.
      if (state.pending && state.pending.questId === offered.questId) return state;
      if (state.pending) return state;
      // A4: ONLY set pending — screen stays 'none', no pause/camera/panel.
      return { ...state, pending: offered };
    }
    case 'questRevoked': {
      if (!state.pending || state.pending.questId !== message.payload.questId) return state;
      // Player dismiss or 总开关关闭 clearing the field (§3.5) — leave any open
      // dialogue gracefully back to the world bubble state.
      return clearPending(state);
    }
    case 'questReward': {
      // Stash the reward to celebrate on the closer屏 (the actual grant is sim-side
      // via grantQuestReward). Only relevant for the pending quest being answered.
      if (!state.pending || state.pending.questId !== message.payload.questId) return state;
      return { ...state, pendingReward: message.payload.reward };
    }
    default:
      // Non-quest frames (hello/snapshot/sessionUpsert/sessionRemoved/heartbeat)
      // are the HUD's concern — return the SAME reference (zero coupling, §13).
      return state;
  }
}

/** Reset to "no pending quest" (world bubble gone, dialogue closed). */
function clearPending(state: QuestState): QuestState {
  if (state.pending === null && state.screen === 'none') return state;
  return { ...state, pending: null, screen: 'none', selectedOption: null, pendingReward: null };
}

/**
 * Apply a UI event to drive the four-屏 answer flow (§6.2). PURE. The reducer only
 * moves `screen`/`selectedOption`; the host translates `submitAnswer`/`dismiss`
 * into the outgoing questAnswer/questDismiss frames. It enforces: reflection skips
 * 'compose'; 'confirmOption' requires a selectedOption; dialogue never opens when
 * `pending` is null.
 */
export function applyQuestUiEvent(state: QuestState, event: QuestUiEvent): QuestState {
  // No quest ⇒ there is no dialogue to drive (dialogue never opens when pending is
  // null). The closeDialogue/dismiss no-ops are also covered by this guard.
  if (state.pending === null) return state;
  const isDecision = state.pending.kind === 'decision';

  switch (event.kind) {
    case 'openDialogue':
      // E / click on the 💬 villager → opener屏 (only from the world bubble state).
      if (state.screen !== 'none') return state;
      return { ...state, screen: 'opener' };

    case 'advance':
      // Any-key / E page turn. Only the opener屏 advances (to the question屏); the
      // other transitions are driven by their explicit events (confirm/submit/close).
      if (state.screen === 'opener') return { ...state, screen: 'question' };
      return state;

    case 'selectOption':
      // Decision question屏 选项 highlight (↑↓ / 1~4). No effect elsewhere.
      if (state.screen !== 'question' || !isDecision) return state;
      return { ...state, selectedOption: event.optionId };

    case 'confirmOption':
      // Decision: 选项 confirmed (E) → compose屏. Requires a selectedOption.
      if (state.screen !== 'question' || !isDecision) return state;
      if (state.selectedOption === null) return state;
      return { ...state, screen: 'compose' };

    case 'submitAnswer':
      // → closer屏 (the host emits the outgoing questAnswer frame). decision submits
      // from compose屏; reflection submits straight from the question屏 (skips
      // 'compose'). reflection requires a non-empty note (提交需非空, §2.2).
      if (isDecision) {
        if (state.screen !== 'compose') return state;
      } else {
        if (state.screen !== 'question') return state;
        if (!event.note || event.note.trim().length === 0) return state;
      }
      return { ...state, screen: 'closer' };

    case 'dismiss':
      // Esc / 先不聊 (zero-cost). The host emits questDismiss; the daemon answers with
      // questRevoked which clears pending. Locally close the dialogue back to the
      // world bubble (the bubble persists until the revoke lands — at worst a frame).
      // Never valid from the closer屏 (already answered).
      if (state.screen === 'none' || state.screen === 'closer') return state;
      return { ...state, screen: 'none', selectedOption: null };

    case 'closeDialogue':
      // 第4屏 E 回去干活 → back to world (the quest is answered; pending stays until
      // the daemon archives it, but the dialogue closes).
      if (state.screen !== 'closer') return state;
      return { ...state, screen: 'none', selectedOption: null };

    default:
      return state;
  }
}

/**
 * Update local prefs (§6.4 settings). PURE — returns the new state; the host
 * persists to localStorage and emits a fresh clientPrefs frame. Turning the master
 * switch OFF (enabled=false) drops any pending offer locally (the承诺 is a game-side
 * fact, §4.7 / GDD §10.7); turning it back ON leaves it to the next questSnapshot to
 * restore (the daemon owns the pending quest).
 */
export function applyQuestPrefs(state: QuestState, patch: Partial<QuestPrefs>): QuestState {
  const prefs: QuestPrefs = { ...state.prefs, ...patch };
  if (prefs.enabled === state.prefs.enabled && prefs.frequency === state.prefs.frequency) {
    return state; // no observable change
  }
  if (!prefs.enabled && state.pending !== null) {
    return { ...clearPending(state), prefs };
  }
  return { ...state, prefs };
}
