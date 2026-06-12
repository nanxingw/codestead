/**
 * quest-hud.ts — the ONE integration point for the M4 villager-quest client inside
 * UIScene, mirroring ui/hud/session-hud.ts. Wires the pure quest layer
 * (src/quest/**: QuestStore + reducers) to a daemon WS connection (reusing the M2
 * WsClient), to localStorage prefs, and to the render/sim seams the scene owns.
 *
 * Boundary notes (ai-quests §12 / §13):
 * - the quest layer never reads or writes sim state directly; reward granting goes
 *   through the injected `grantReward` seam (UIScene → SimApi.applyQuestReward) so
 *   the economy stays the sim's authority;
 * - a SECOND WsClient (not the HUD's) keeps M2 untouched: the daemon broadcasts
 *   quest frames to every authed client and accepts client frames from any, so two
 *   loopback sockets from one tab is the same multi-client case §11-E7 already
 *   handles. Each store ignores the other's frames (reducers return SAME ref);
 * - on every LIVE edge the store re-emits `clientPrefs` so the daemon's stricter-of
 *   merge always has the current 出题间隔档 (§4.7);
 * - zero-disturbance (§3.5 / A4): an offer ONLY sets `pending` (→ the world 💬
 *   bubble); nothing here pauses time, moves the camera, or pushes a panel — that
 *   is the player's E-interaction, owned by the scene.
 */
import {
  createFetchHandshakeProber,
  createWsClient,
  type TimerHost,
  type WsClient,
  type WsClientDeps,
  type WsLike,
} from '../../hud/ws-client';
import { QuestStore } from '../../quest/quest-store-host';
import type { QuestPrefs, QuestState, QuestUiEvent } from '../../quest/quest-store';
import {
  loadArrivalSound,
  saveArrivalSound,
  type QuestPrefsStorage,
} from '../../quest/quest-prefs';

export interface QuestHudDeps {
  /**
   * Reward grant seam (§K / A9): the scene routes this to SimApi.applyQuestReward,
   * which idempotently credits gold/XP keyed on questId and lights #19. Called when
   * a `questReward` frame lands for the pending quest. Returns nothing — the sim
   * emits its own GoldChanged/level/achievement events the UI already handles.
   */
  grantReward: (questId: string, reward: QuestState['pendingReward']) => void;
  /** Note record seam (§K / #20): scene → SimApi.recordQuestNote. */
  recordNote?: (noteRef: string) => void;
  /** Optional ≤0.3s soft arrival cue (§3.5); default OFF unless the player opts in. */
  playArrivalSound?: () => void;
  // ---- additive test seams (the real scene omits them all) ----
  /** WS plumbing override (prober/createSocket/timers/rand01) — tests inject fakes,
   *  production defaults to fetch/WebSocket/window timers. */
  readonly wsOverride?: Pick<WsClientDeps, 'prober' | 'createSocket' | 'timers' | 'rand01'>;
  /** localStorage override; production reads the real `localStorage`. */
  readonly storageOverride?: QuestPrefsStorage | null;
}

/**
 * The quest client lifecycle owner. UIScene constructs it once, drives `update`
 * (none needed — the store is event-driven), reads `store` for the dialogue panel
 * and the world bubble, and `destroy`s it on shutdown.
 */
export class QuestHud {
  readonly store: QuestStore;
  private readonly client: WsClient;
  private readonly storage: QuestPrefsStorage | null;
  private readonly unsubscribe: () => void;
  private lastPendingQuestId: string | null = null;
  private grantedThisSession = new Set<string>();

  constructor(private readonly deps: QuestHudDeps) {
    this.storage = deps.storageOverride !== undefined ? deps.storageOverride : safeLocalStorage();
    this.store = new QuestStore(this.storage);

    const ws: Pick<WsClientDeps, 'prober' | 'createSocket' | 'timers' | 'rand01'> =
      deps.wsOverride ?? {
        prober: createFetchHandshakeProber((url, init) => fetch(url, init)),
        createSocket: (url) => new WebSocket(url) as unknown as WsLike,
        timers: browserTimers(),
        rand01: () => Math.random(),
      };

    this.client = createWsClient({
      prober: ws.prober,
      createSocket: ws.createSocket,
      timers: ws.timers,
      rand01: ws.rand01,
      dispatch: () => {
        // Connection edges are the HUD's concern; the quest store has no connection
        // state of its own (it shows reality via questSnapshot on each LIVE edge).
      },
      onServerMessage: (message) => this.onServerMessage(message),
      onLive: () => {
        // Re-assert the current prefs on every (re)connect so the daemon's
        // stricter-of merge is always current (§4.7). The daemon answers with a
        // fresh questSnapshot, restoring the single pending quest (§5 / §11-E3).
        this.store.emitClientPrefs();
      },
    });

    // The store's outgoing frames (questAnswer / questDismiss / clientPrefs) ride
    // the same socket (buffered until LIVE — ws-client §4.7).
    this.store.setSend((message) => this.client.send(message));

    this.unsubscribe = this.store.subscribe((state) => this.onStoreChange(state));
    this.client.start();
  }

  /**
   * Drive a dialogue UI event into the store (the panel calls this via the scene).
   * A `submitAnswer` that advances the flow to the closer屏 means an answer was
   * accepted — the daemon will write the thinking note (§7). The game records that
   * note locally keyed on questId (one note per answered quest) so #20 思考的痕迹
   * bumps even when the daemon withholds the reward (§11-E11 decoupling). The note
   * record is idempotent on the ref (sim-side), so a re-submit can never inflate it.
   */
  dispatchUi(event: QuestUiEvent): void {
    const before = this.store.getState();
    this.store.dispatchUi(event);
    const after = this.store.getState();
    if (
      event.kind === 'submitAnswer' &&
      before.screen !== 'closer' &&
      after.screen === 'closer' &&
      before.pending !== null
    ) {
      this.deps.recordNote?.(before.pending.questId);
    }
  }

  /** §6.4 settings surface: current prefs (read) + patch (persist + re-emit prefs). */
  prefs(): Readonly<QuestPrefs> {
    return this.store.getState().prefs;
  }

  updatePrefs(patch: Partial<QuestPrefs>): void {
    this.store.updatePrefs(patch);
  }

  /** Arrival-sound toggle (§3.5) — a separate game-side preference. */
  arrivalSoundOn(): boolean {
    return loadArrivalSound(this.storage);
  }

  setArrivalSound(on: boolean): void {
    saveArrivalSound(this.storage, on);
  }

  /** The single OFFERED quest, or null (§6.3 day-summary 预告 reads it via the host). */
  pendingQuest(): QuestState['pending'] {
    return this.store.getState().pending;
  }

  destroy(): void {
    this.unsubscribe();
    this.client.stop();
  }

  // ---- internals ----

  private onServerMessage(message: Parameters<QuestStore['applyMessage']>[0]): void {
    // A questReward for the pending quest must reach the sim ONCE (A9). The store
    // stashes the reward for the closer屏; the actual credit is sim-side. We grant
    // here (idempotent at the sim via grantedQuestIds) the moment the reward lands.
    if (message.type === 'questReward') {
      this.grantReward(message.payload.questId, message.payload.reward);
    }
    this.store.applyMessage(message);
  }

  /** Route a reward to the sim once per questId per session (the sim is the final guard). */
  private grantReward(questId: string, reward: QuestState['pendingReward']): void {
    if (reward === null || this.grantedThisSession.has(questId)) return;
    this.grantedThisSession.add(questId);
    this.deps.grantReward(questId, reward);
  }

  private onStoreChange(state: QuestState): void {
    // Arrival cue (§3.5): one soft ≤0.3s sound on a fresh offer, opt-in only. Never
    // on snapshot re-sync of an already-known quest.
    const id = state.pending?.questId ?? null;
    if (id !== null && id !== this.lastPendingQuestId && state.screen === 'none') {
      if (this.arrivalSoundOn()) this.deps.playArrivalSound?.();
    }
    this.lastPendingQuestId = id;
  }
}

function safeLocalStorage(): QuestPrefsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Real-browser timer host for the WS client (production default). */
function browserTimers(): TimerHost {
  return {
    set: (ms, fn) => window.setTimeout(fn, ms),
    clear: (id) => window.clearTimeout(id),
  };
}
