/**
 * HudStore — the hand-rolled subscription wrapper around the pure reducers in
 * store.ts (tech-stack §1: no state lib). ZERO Phaser, ZERO sim — the render
 * shell (ui/hud/session-hud.ts) subscribes and READS, never writes sessions.
 *
 * Responsibilities:
 * - hold the single HudState; route ConnectionEvents / ServerMessages through
 *   the pure reducers;
 * - persist settings (`codestead.hud.v1`) on every update and flip the
 *   everConnected gate (`codestead.hud.v1.everConnected`) on first HELLO_OK
 *   (§8.2 — both localStorage, NEVER the farm save, appendix A-21);
 * - notify subscribers synchronously after each change (renderer marks dirty).
 */
import type { ServerMessage } from '@codestead/shared';

import type { HudSettings, HudStorage } from './settings.js';
import {
  loadEverConnected,
  loadHudSettings,
  saveEverConnected,
  saveHudSettings,
} from './settings.js';
import { applyConnectionEvent, applyServerMessage, createInitialHudState } from './store.js';
import type { ConnectionEvent, HudState } from './types.js';

export type HudListener = (state: HudState) => void;

export class HudStore {
  private state: HudState;
  private readonly listeners = new Set<HudListener>();

  constructor(private readonly storage: HudStorage | null) {
    this.state = createInitialHudState(loadHudSettings(storage), loadEverConnected(storage));
  }

  getState(): HudState {
    return this.state;
  }

  subscribe(listener: HudListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connection edges from the WS client (§8.1). */
  dispatchConnection(event: ConnectionEvent): void {
    this.commit(applyConnectionEvent(this.state, event));
  }

  /** Validated server frames from the WS client (§10.1). */
  applyMessage(message: ServerMessage, at: number): void {
    const before = this.state.everConnected;
    this.commit(applyServerMessage(this.state, message, at));
    if (!before && this.state.everConnected) saveEverConnected(this.storage); // §8.2 gate
  }

  /** Settings change (Esc menu / H key); persists immediately (§9). */
  updateSettings(patch: Partial<HudSettings>): void {
    const settings = { ...this.state.settings, ...patch };
    saveHudSettings(this.storage, settings);
    this.commit({ ...this.state, settings });
  }

  /** H key: expanded → collapsed → hidden → expanded (§9 / game-design §6.8). */
  cycleDisplayMode(): HudSettings['displayMode'] {
    const order = ['expanded', 'collapsed', 'hidden'] as const;
    const current = order.indexOf(this.state.settings.displayMode);
    const next = order[(current + 1) % order.length];
    this.updateSettings({ displayMode: next });
    return next;
  }

  private commit(next: HudState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
