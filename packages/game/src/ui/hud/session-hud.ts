/**
 * session-hud.ts — the ONE integration point for the M2 session HUD inside
 * UIScene. Wires the pure layer (src/hud/**: HudStore + createWsClient) to the
 * render shell (session-panel.ts), the tab badge (document.title — the single
 * allowed out-of-game cue, §6.1), the visibility handler (§11-15) and the
 * optional sound seam.
 *
 * Boundary notes:
 * - the HUD never reads or writes sim state (ESLint-enforced in src/hud/**;
 *   this file passes only plain rects/callbacks across);
 * - WS keeps running while the tab is hidden and while menus/summary are open
 *   (§8.3 — the HUD shows reality, not the simulation);
 * - probing starts unconditionally and silently: a player without the daemon
 *   sees nothing (everConnected gate, §8.2), and installing the daemon makes
 *   the panel appear WITHOUT a page refresh (US41).
 */
import type Phaser from 'phaser';

import { HudStore } from '../../hud/hud-store';
import { computeTabTitle } from '../../hud/tab-badge';
import type { HudSettings } from '../../hud/settings';
import type { HudState } from '../../hud/types';
import {
  createFetchHandshakeProber,
  createWsClient,
  type WsClient,
  type WsLike,
} from '../../hud/ws-client';
import { SessionPanel } from './session-panel';

export interface SessionHudDeps {
  /** Player sprite screen rect for autoFade; null when unavailable. */
  playerScreenRect: () => { x: number; y: number; width: number; height: number } | null;
  reducedMotion: () => boolean;
  /**
   * Optional sound seam (§3.4): the store stamps cooldowns (40%-volume soft
   * click is an assets-subsystem deliverable; until then the integrator maps
   * to an existing soft SFX). Default OFF in settings either way.
   */
  playSound?: () => void;
}

export class SessionHud {
  readonly store: HudStore;
  private readonly panel: SessionPanel;
  private readonly client: WsClient;
  private readonly unsubscribe: () => void;
  private lastSoundStampSeen: number;
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) this.panel.onTabVisible();
    this.applyTabBadge();
  };

  constructor(
    scene: Phaser.Scene,
    private readonly deps: SessionHudDeps,
  ) {
    this.store = new HudStore(safeLocalStorage());
    this.panel = new SessionPanel(scene, this.store, {
      now: () => Date.now(),
      playerScreenRect: deps.playerScreenRect,
      reducedMotion: deps.reducedMotion,
    });

    this.client = createWsClient({
      prober: createFetchHandshakeProber((url, init) => fetch(url, init)),
      createSocket: (url) => new WebSocket(url) as unknown as WsLike,
      timers: {
        set: (ms, fn) => window.setTimeout(fn, ms),
        clear: (id) => window.clearTimeout(id),
      },
      rand01: () => Math.random(),
      dispatch: (event) => this.store.dispatchConnection(event),
      onServerMessage: (message, at) => this.store.applyMessage(message, at),
    });

    this.lastSoundStampSeen = Date.now();
    this.unsubscribe = this.store.subscribe(() => {
      this.applyTabBadge();
      this.maybePlaySound();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.client.start();
  }

  /** Per-frame driver from UIScene.update(); near-zero work while hidden. */
  update(): void {
    this.panel.update();
  }

  /** H key (game-design §6.8): expanded → collapsed → hidden, with receipt (§6.1). */
  cycleDisplayMode(): void {
    const next = this.store.cycleDisplayMode();
    if (next === 'hidden' && this.store.getState().everConnected) {
      this.panel.showHiddenReceipt();
    }
  }

  /** Day-summary screen open/close (§4.6: panel hides; store keeps updating). */
  setSuppressed(suppressed: boolean): void {
    this.panel.setSuppressed(suppressed);
  }

  /** Settings page surface (D6): current settings + connection line data. */
  settings(): Readonly<HudSettings> {
    return this.store.getState().settings;
  }

  updateSettings(patch: Partial<HudSettings>): void {
    this.store.updateSettings(patch);
  }

  /**
   * Read-only state for the settings page (connection status/version lines,
   * US39/US40 — NOT gated by everConnected) and the day-summary 会话一行
   * (§4.6 stateCounts feed). Render-side consumers READ only.
   */
  hudState(): Readonly<HudState> {
    return this.store.getState();
  }

  destroy(): void {
    this.unsubscribe();
    this.client.stop();
    this.panel.destroy();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.title = computeTabTitle(document.title, {
        hasBlocked: false,
        tabBadgeEnabled: false,
        documentHidden: false,
      });
    }
  }

  /** §6.1 tabBadge: `● ` title prefix while blocked exists AND the tab is hidden. */
  private applyTabBadge(): void {
    if (typeof document === 'undefined') return;
    const state = this.store.getState();
    let hasBlocked = false;
    for (const session of state.sessions.values()) {
      if (session.state === 'blocked') {
        hasBlocked = true;
        break;
      }
    }
    document.title = computeTabTitle(document.title, {
      hasBlocked,
      tabBadgeEnabled: state.settings.tabBadge,
      documentHidden: document.hidden,
    });
  }

  /**
   * §3.4 sound: the store stamps `lastSoundAt` (tier + global 20s cooldown
   * already applied); the shell just plays on a fresh stamp. Background tabs
   * stay silent unless soundInBackground (M2-end key; default false).
   */
  private maybePlaySound(): void {
    if (!this.deps.playSound) return;
    const state = this.store.getState();
    let latest = -Infinity;
    for (const cd of state.cooldowns.values()) {
      if (cd.lastSoundAt !== null && cd.lastSoundAt > latest) latest = cd.lastSoundAt;
    }
    if (latest <= this.lastSoundStampSeen) return;
    this.lastSoundStampSeen = latest;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden && !state.settings.soundInBackground) return;
    this.deps.playSound();
  }
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
