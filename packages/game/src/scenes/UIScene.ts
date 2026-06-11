import Phaser from 'phaser';

import { SFX, type SfxKey } from '../AssetKeys';
import { INVENTORY } from '../sim/data/constants';
import { tilledCapForLevel } from '../sim/tiles';
import type { DaySummary, PauseSource, SimCommand, SimEvent, WorldState } from '../sim/types';
import { resolveUiContext, type UiContext } from '../ui/context';
import { FeedbackView } from '../ui/hud/feedback-view';
import { Hotbar } from '../ui/hud/hotbar';
import { NotificationsView } from '../ui/hud/notifications-view';
import { TopRightPanel } from '../ui/hud/top-right-panel';
import { NotificationsModel } from '../ui/notifications';
import type { Panel, UiHost } from '../ui/panels/host';
import { SleepConfirmPanel } from '../ui/panels/confirm-dialog';
import { DaySummaryPanel } from '../ui/panels/day-summary-panel';
import { InventoryPanel } from '../ui/panels/inventory-panel';
import { PauseMenuPanel } from '../ui/panels/pause-menu';
import { ReadingPanel } from '../ui/panels/reading-panel';
import { SettingsPanel } from '../ui/panels/settings-panel';
import { ShippingBinPanel } from '../ui/panels/shipping-bin-panel';
import { ShopPanel } from '../ui/panels/shop-panel';
import { safe } from '../ui/safe';
import { SettingsStore } from '../ui/settings-store';
import { t } from '../ui/strings';
import { UiStackModel, type UiPanelId } from '../ui/ui-stack';
import { WORLD_EVENTS, type DaySummaryPayload, type InteractablePayload } from '../world/events';

/** Keys are swallowed for this long after a panel opens so the same world-layer E
 * keydown that opened a panel cannot immediately activate/close it. */
const PANEL_KEY_GRACE_MS = 150;

/**
 * Narrow surface WorldScene uses to route fixed-interactable interactions (shop
 * counter / shipping bin / house door / porch letter / bulletin board, GDD §1.7) and
 * to gate world input while any panel is open. Obtain via
 * `this.scene.get('UI') as unknown as UiSceneApi` after the UI scene is ready.
 */
export interface UiSceneApi {
  isUiOpen(): boolean;
  openInventory(): void;
  openShop(): void;
  openShippingBin(): void;
  openSleepConfirm(): void;
  openLetter(): void;
  openBoard(): void;
  /** Blocked-reason toast from the world layer (e.g. 背包已满 on harvest). */
  toastText(text: string): void;
}

/**
 * UIScene — persistent overlay scene running in parallel with WorldScene.
 *
 * Renders ONLY from SimApi snapshots; acts ONLY through SimCommands (GDD §12 one-way
 * flow). Owns the UI stack with the invariant `stack.length > 0 ⇔ sim paused via a
 * UI pause source` (GDD §6.5; sources mapped onto the §2.4 vocabulary, see
 * ui/ui-stack.ts). The day-summary screen is the only auto-opened modal (on DayEnded).
 *
 * HARD RULE (ruling A-9): the top-left rect (4,4)–(156,150) is the M2 session-HUD
 * reserve — zero pixels drawn there, including modal scrims (ui/widgets/scrim.ts).
 */
export class UIScene extends Phaser.Scene implements UiSceneApi {
  private ctx: UiContext | null = null;
  private settingsStore = new SettingsStore();
  private stack = new UiStackModel();
  private panels: Panel[] = [];
  private notifications = new NotificationsModel();
  private topRight: TopRightPanel | null = null;
  private hotbar: Hotbar | null = null;
  private notificationsView: NotificationsView | null = null;
  private feedbackView: FeedbackView | null = null;
  private unsubscribeSim: (() => void) | null = null;
  private topOpenedAt = -Infinity;
  private host!: UiHost;
  /** True between DayEnded and the world's post-fade day-summary handoff: global
   *  play-mode keys are swallowed so nothing opens over the night transition. */
  private nightTransition = false;

  constructor() {
    super('UI');
  }

  create(data?: unknown): void {
    this.ctx = resolveUiContext(this, data);
    if (!this.ctx) {
      // Passive shell (M0-compatible): the integrator has not provided a UiContext —
      // see ui/context.ts for the registry/scene-data wiring contract.
      return;
    }
    const ctx = this.ctx;

    this.host = {
      scene: this,
      ctx,
      settings: this.settingsStore,
      state: () => ctx.sim.state,
      dispatch: (command) => this.dispatch(command),
      toast: (key, params) => this.toastText(t(key, params)),
      closeTop: () => this.closeTop(),
      openChild: (id) => this.openPanel(id),
      closeAll: () => this.closeAll(),
      reducedMotion: () => this.settingsStore.reducedMotionActive(),
      playSfx: (key) => this.playSfx(key),
    };

    const reducedMotion = (): boolean => this.settingsStore.reducedMotionActive();
    this.topRight = new TopRightPanel(this, reducedMotion);
    this.hotbar = new Hotbar(this, (slot) => this.dispatch({ type: 'selectSlot', slot }));
    this.notificationsView = new NotificationsView(this, this.notifications, reducedMotion);
    // In-place success feedback: harvest fly-to-slot, slot bounce, +1/+xp floaters,
    // gold delta floaters (US80/US68/US103; GDD §6.4/§5.8, reducedMotion §10.8).
    this.feedbackView = new FeedbackView(this, {
      state: () => ctx.sim.state,
      worldCamera: () => this.worldCamera(),
      reducedMotion,
      playSfx: (key) => this.playSfx(key),
      bounceSlot: (slot) => this.hotbar?.bounce(slot),
    });

    this.unsubscribeSim = safe<(() => void) | null>(
      'sim.on',
      () => ctx.sim.on((event) => this.onSimEvent(event)),
      null,
    );

    // Push persisted volume into the audio system at boot (GDD §10.7 sync read).
    const audio = this.settingsStore.get().audio;
    ctx.audio?.setMasterVolume(audio.master, audio.muted);
    this.settingsStore.onChange((s) => ctx.audio?.setMasterVolume(s.audio.master, s.audio.muted));

    this.input.keyboard?.addCapture('TAB');
    this.input.mouse?.disableContextMenu(); // right-click = ×5 in shop (GDD §6.8)
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => this.onKeyDown(event));
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown[], _dx: number, dy: number) =>
      this.onWheel(dy),
    );

    // World-scene bridge (world/events.ts contract): fixed interactables route to
    // panels here; the day summary opens only after the world's night fade-out.
    this.game.events.on(WORLD_EVENTS.interactable, this.onWorldInteractable);
    this.game.events.on(WORLD_EVENTS.daySummary, this.onWorldDaySummary);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off(WORLD_EVENTS.interactable, this.onWorldInteractable);
      this.game.events.off(WORLD_EVENTS.daySummary, this.onWorldDaySummary);
      this.unsubscribeSim?.();
      this.feedbackView?.clear();
      this.closeAll();
    });
  }

  // ---- world-scene bridge (GDD §1.7: fixed interactables never enter the sim) ----

  private readonly onWorldInteractable = (payload: InteractablePayload): void => {
    if (!this.ctx || this.nightTransition || this.stack.depth() > 0) return;
    // Canonical kind vocabulary (farm.tmj `kind` property, mirrored by
    // FALLBACK_MAP_META): door / shipping_bin / well / shop / bulletin_board /
    // sign / letter.
    switch (payload.kind) {
      case 'door': // ruling A-20: door = sleep confirm
        this.openSleepConfirm();
        break;
      case 'shipping_bin':
        this.openShippingBin();
        break;
      case 'shop':
        this.openShop();
        break;
      case 'bulletin_board':
        this.openBoard();
        break;
      case 'letter':
        this.openLetter();
        break;
      default:
        break; // well / signs: ambience only in M1 (GDD §1.3 — 喷壶无限水，水井留作氛围)
    }
  };

  private readonly onWorldDaySummary = (payload: DaySummaryPayload): void => {
    if (!this.ctx) return;
    this.nightTransition = false;
    this.closeAll();
    this.openPanel('daySummary', payload.summary);
  };

  override update(time: number): void {
    if (!this.ctx) return;
    const state = this.ctx.sim.state;
    this.topRight?.update(state, time);
    this.hotbar?.update(state);
    this.notificationsView?.update(time);
    this.feedbackView?.update(); // flush AFTER hotbar.update so landings target fresh slots
  }

  // ---- UiSceneApi (world-layer routing surface) ----

  isUiOpen(): boolean {
    return this.stack.depth() > 0;
  }

  openInventory(): void {
    this.openPanel('inventory');
  }

  openShop(): void {
    this.openPanel('shop');
  }

  openShippingBin(): void {
    this.openPanel('shippingBin');
  }

  openSleepConfirm(): void {
    this.openPanel('sleepConfirm');
  }

  openLetter(): void {
    this.openPanel('letter');
  }

  openBoard(): void {
    this.openPanel('board');
  }

  toastText(text: string): void {
    this.notifications.toast(text, this.time.now);
  }

  // ---- stack management (invariant: depth > 0 ⇔ UI pause sources active) ----

  private openPanel(id: UiPanelId, summary?: DaySummary): void {
    if (!this.ctx) return;
    if (!this.stack.push(id)) return; // mutual exclusion (GDD §6.5)
    this.panels.push(this.buildPanel(id, summary));
    this.topOpenedAt = this.time.now;
    this.syncPauseSources();
  }

  private closeTop(): void {
    const removed = this.stack.pop();
    if (removed === null) return;
    this.panels.pop()?.destroy();
    this.topOpenedAt = this.time.now;
    this.syncPauseSources();
    // Dismissing the summary hands control back to the world (fade-in + resume).
    if (removed === 'daySummary') {
      this.game.events.emit(WORLD_EVENTS.daySummaryDismissed);
    }
  }

  private closeAll(): void {
    while (this.stack.depth() > 0) {
      this.stack.pop();
      this.panels.pop()?.destroy();
    }
    this.syncPauseSources();
  }

  private activeSources = new Set<PauseSource>();

  private syncPauseSources(): void {
    if (!this.ctx) return;
    const next = this.stack.sources();
    for (const source of this.activeSources) {
      if (!next.has(source)) this.ctx.pause.remove(source);
    }
    for (const source of next) {
      if (!this.activeSources.has(source)) this.ctx.pause.add(source);
    }
    this.activeSources = new Set(next);
    this.notifications.setModalOpen(this.stack.depth() > 0); // §5.8 queue discipline
  }

  private buildPanel(id: UiPanelId, summary?: DaySummary): Panel {
    switch (id) {
      case 'inventory':
        return new InventoryPanel(this.host);
      case 'shop':
        return new ShopPanel(this.host);
      case 'shippingBin':
        return new ShippingBinPanel(this.host);
      case 'pauseMenu':
        return new PauseMenuPanel(this.host);
      case 'settings':
        return new SettingsPanel(this.host);
      case 'keysHelp':
      case 'letter':
      case 'board':
        return new ReadingPanel(this.host, id);
      case 'sleepConfirm':
        return new SleepConfirmPanel(this.host);
      case 'daySummary': {
        if (!summary) throw new Error('daySummary requires a DaySummary payload');
        return new DaySummaryPanel(this.host, summary);
      }
    }
  }

  // ---- sim plumbing ----

  private dispatch(command: SimCommand): SimEvent[] {
    if (!this.ctx) return [];
    try {
      const events = this.ctx.sim.dispatch(command);
      this.refreshTopPanel();
      return events;
    } catch (err) {
      console.warn('[ui] sim.dispatch failed (stream not merged yet?):', command, err);
      return [];
    }
  }

  private onSimEvent(event: SimEvent): void {
    const now = this.time.now;
    // Buffered per frame inside the view so same-frame batches merge (US68).
    this.feedbackView?.onEvent(event);
    switch (event.type) {
      case 'GoldChanged':
        this.playSfx(SFX.coins);
        break;
      case 'CropHarvested': {
        // The pick that exhausts a regrow crop's pod season leaves the old vine behind
        // (harvestsLeft === 0) — gentle one-time hint via the notification queue
        // (GDD §3.2 「这茬藤老了，换新种吧」). Old vines never mature again, so this
        // fires at most once per vine.
        const key = `${event.tile.x},${event.tile.y}`;
        const cropNow = this.ctx?.sim.state.farm.tiles[key]?.crop;
        if (cropNow && cropNow.harvestsLeft === 0 && !cropNow.withered) {
          this.notifications.toast(t('hint.old_vine'), now);
        }
        break;
      }
      case 'FarmLevelUp': {
        const prev = safe(
          'prevCap',
          () => tilledCapForLevel(event.level - 1),
          null as number | null,
        );
        this.notifications.banner(
          t('banner.level_up', {
            level: event.level,
            prev: prev === null ? '?' : prev,
            cap: event.tilledCap,
          }),
          now,
        );
        this.playSfx(SFX.jingleLevelup);
        break;
      }
      case 'zoneUnlocked':
        this.notifications.banner(
          t('banner.zone_unlocked', { zone: t(`zone.${event.zoneId}`) }),
          now,
        );
        break;
      case 'DayEnded':
        // The summary is the ONLY auto-opened modal (GDD §6.5) — but it opens on the
        // world's post-fade `world:day_summary` handoff, not here. Anything still
        // open yields to the night transition immediately. In-flight feedback fx
        // (including the just-buffered settlement gold delta — the summary screen
        // presents those numbers) are dropped with the fade.
        this.nightTransition = true;
        this.feedbackView?.clear();
        this.closeAll();
        break;
      default:
        break;
    }
    this.refreshTopPanel();
  }

  private refreshTopPanel(): void {
    this.panels[this.panels.length - 1]?.refresh();
  }

  private playSfx(key: SfxKey): void {
    this.ctx?.audio?.play(key);
  }

  /** WorldScene main camera for the feedback layer's world→screen mapping; null in
   *  the degraded shell or while the world scene is not running (no import cycle —
   *  WorldScene already imports UiSceneApi from here, so we go through the key). */
  private worldCamera(): Phaser.Cameras.Scene2D.Camera | null {
    if (!this.scene.isActive('World')) return null;
    const world = this.scene.get('World');
    return world?.cameras?.main ?? null;
  }

  // ---- input routing (keymap GDD §6.8) ----

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.ctx) return;
    const top = this.panels[this.panels.length - 1];
    if (top) {
      if (this.time.now - this.topOpenedAt < PANEL_KEY_GRACE_MS) return;
      const handled = top.handleKey(event);
      if (!handled && event.key === 'Escape') this.closeTop();
      return;
    }
    // Stack empty — play-mode UI keys only (world movement/actions live in WorldScene).
    if (this.nightTransition) return; // nothing opens over the night fade (GDD §6.5)
    switch (event.key) {
      case 'Escape':
        this.openPanel('pauseMenu');
        return;
      case 'Tab':
      case 'i':
      case 'I':
        event.preventDefault();
        this.openPanel('inventory');
        return;
      default: {
        const digit = Number.parseInt(event.key, 10);
        if (digit >= 1 && digit <= INVENTORY.HOTBAR_SIZE) {
          this.dispatch({ type: 'selectSlot', slot: digit - 1 });
        }
      }
    }
  }

  /** Wheel cycles the hotbar 1↔9 while no panel is open (GDD §6.2/§6.8). */
  private onWheel(deltaY: number): void {
    if (!this.ctx || this.stack.depth() > 0 || deltaY === 0 || this.nightTransition) return;
    const state: Readonly<WorldState> = this.ctx.sim.state;
    const dir = deltaY > 0 ? 1 : -1;
    const next = (state.inventory.selected + dir + INVENTORY.HOTBAR_SIZE) % INVENTORY.HOTBAR_SIZE;
    this.dispatch({ type: 'selectSlot', slot: next });
  }
}
