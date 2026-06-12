/**
 * quest-store-host.ts — the hand-rolled subscription wrapper around the pure quest
 * reducers (quest-store.ts), mirroring HudStore (tech-stack §1: no state lib). ZERO
 * Phaser, ZERO sim — the dialogue panel + world bubble subscribe and READ; the WS
 * client feeds server frames in; the panel feeds UI events in.
 *
 * Responsibilities:
 * - hold the single QuestState; route ServerMessages / QuestUiEvents through the
 *   pure reducers;
 * - persist QuestPrefs (`codestead.quests.v1`) on every prefs change and emit a
 *   fresh `clientPrefs` frame (§4.7);
 * - translate `submitAnswer` / `dismiss` UI events into outgoing `questAnswer` /
 *   `questDismiss` frames (§4.7) — the note flows IN here, never OUT (§12-3);
 * - notify subscribers synchronously after each change (renderer marks dirty).
 *
 * Outgoing frames are handed to an injected `send` callback (the WS client wires
 * it); in tests `send` is a spy, so the host is fully headless-testable.
 */
import type { ClientMessage, ServerMessage } from '@codestead/shared';

import { loadQuestPrefs, saveQuestPrefs, type QuestPrefsStorage } from './quest-prefs.js';
import {
  applyQuestPrefs,
  applyQuestServerMessage,
  applyQuestUiEvent,
  createInitialQuestState,
  frequencyToInterval,
  type QuestPrefs,
  type QuestState,
  type QuestUiEvent,
} from './quest-store.js';

export type QuestListener = (state: QuestState) => void;
/** Sink for outgoing client→daemon frames (the WS client supplies it). */
export type QuestSend = (message: ClientMessage) => void;

export class QuestStore {
  private state: QuestState;
  private readonly listeners = new Set<QuestListener>();

  constructor(
    private readonly storage: QuestPrefsStorage | null,
    private send: QuestSend = () => {},
  ) {
    this.state = createInitialQuestState(loadQuestPrefs(storage));
  }

  getState(): QuestState {
    return this.state;
  }

  subscribe(listener: QuestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** (Re)bind the outgoing frame sink — called by the WS client when it connects. */
  setSend(send: QuestSend): void {
    this.send = send;
  }

  /** Validated server frames from the WS client (§4.7). */
  applyMessage(message: ServerMessage): void {
    this.commit(applyQuestServerMessage(this.state, message));
  }

  /**
   * Drive a dialogue UI event through the pure reducer, then emit any outgoing
   * frame the event implies (§4.7):
   *  - submitAnswer → questAnswer (optionId for decision, note for the 补充/正文);
   *  - dismiss     → questDismiss (zero-cost 先不聊).
   * The frame is emitted only when the reducer actually advanced (avoids spurious
   * answers from no-op events). The note flows IN — never OUT (§12-3).
   */
  dispatchUi(event: QuestUiEvent): void {
    const before = this.state;
    const after = applyQuestUiEvent(before, event);
    // Emit BEFORE committing so the outgoing frame reflects the answered quest.
    if (after !== before && before.pending) {
      const questId = before.pending.questId;
      if (event.kind === 'submitAnswer' && after.screen === 'closer') {
        const optionId = before.selectedOption ?? undefined;
        this.send({
          v: 1,
          type: 'questAnswer',
          payload: {
            questId,
            ...(optionId ? { optionId } : {}),
            ...(event.note ? { note: event.note } : {}),
          },
        });
      } else if (event.kind === 'dismiss') {
        this.send({ v: 1, type: 'questDismiss', payload: { questId } });
      }
    }
    this.commit(after);
  }

  /** Settings change (§6.4); persists immediately + re-emits clientPrefs (§4.7). */
  updatePrefs(patch: Partial<QuestPrefs>): void {
    const after = applyQuestPrefs(this.state, patch);
    if (after === this.state) return;
    saveQuestPrefs(this.storage, after.prefs);
    this.commit(after);
    this.emitClientPrefs();
  }

  /** Send the current prefs as a clientPrefs frame (on connect and on change, §4.7). */
  emitClientPrefs(): void {
    this.send({
      v: 1,
      type: 'clientPrefs',
      payload: {
        quests: {
          enabled: this.state.prefs.enabled,
          minIntervalRealMinutes: frequencyToInterval(this.state.prefs.frequency),
        },
      },
    });
  }

  private commit(next: QuestState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
