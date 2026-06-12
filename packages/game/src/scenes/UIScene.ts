import Phaser from 'phaser';

import { SFX, type SfxKey, type SfxM3Key } from '../AssetKeys';
import { UI_CUES } from '../audio/sfx-map';
import { BLUEPRINTS } from '../sim/data/buildings';
import { INVENTORY, M1_LEVEL_CAP } from '../sim/data/constants';
import { effectiveLevel } from '../sim/leveling';
import { retroLevelUpEvents } from '../sim/profession';
import { tilledCapForLevel } from '../sim/tiles';
import type { DaySummary, PauseSource, SimCommand, SimEvent, WorldState } from '../sim/types';
import { resolveUiContext, type UiContext } from '../ui/context';
import { FeedbackView } from '../ui/hud/feedback-view';
import { Hotbar } from '../ui/hud/hotbar';
import { NotificationsView } from '../ui/hud/notifications-view';
import { SessionHud } from '../ui/hud/session-hud';
import { TopRightPanel } from '../ui/hud/top-right-panel';
import { NotificationsModel } from '../ui/notifications';
import type { Panel, UiHost } from '../ui/panels/host';
import { AchievementsPanel } from '../ui/panels/achievements-panel';
import { BuildCatalogPanel, type BuildTab } from '../ui/panels/build-catalog-panel';
import { BuildConfirmPanel } from '../ui/panels/build-confirm-panel';
import type { BuildConfirmRequest } from '../ui/panels/build-model';
import { CodexPanel } from '../ui/panels/codex-panel';
import { SleepConfirmPanel } from '../ui/panels/confirm-dialog';
import { CoopPanel } from '../ui/panels/coop-panel';
import { DaySummaryPanel } from '../ui/panels/day-summary-panel';
import { InventoryPanel } from '../ui/panels/inventory-panel';
import { PauseMenuPanel } from '../ui/panels/pause-menu';
import { ProcessingPanel } from '../ui/panels/processing-panel';
import { ProfessionPanel } from '../ui/panels/profession-panel';
import { ReadingPanel } from '../ui/panels/reading-panel';
import { SessionSettingsPanel } from '../ui/panels/session-settings-panel';
import { SettingsPanel } from '../ui/panels/settings-panel';
import { ShippingBinPanel } from '../ui/panels/shipping-bin-panel';
import { ShopPanel } from '../ui/panels/shop-panel';
import { safe } from '../ui/safe';
import { SettingsStore } from '../ui/settings-store';
import { t } from '../ui/strings';
import { UiStackModel, type UiPanelId } from '../ui/ui-stack';
import {
  BUILD_EVENTS,
  getBuildController,
  type CatalogReturnPayload,
  type ConfirmRequestPayload,
  type StructureInteractPayload,
} from '../world/build-bridge';
import {
  REGISTRY_KEYS,
  WORLD_EVENTS,
  type DaySummaryPayload,
  type InteractablePayload,
} from '../world/events';

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
  /** Readable signposts (US5 / backlog A-3): signpost_junction / gate_sign. */
  openSign(signId: string): void;
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
  /** M2 session HUD (ruling A-9 rect (4,4)–(156,150)); independent of the sim. */
  private sessionHud: SessionHud | null = null;
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

    const reducedMotion = (): boolean => this.settingsStore.reducedMotionActive();
    // M2 session HUD: lives in the reserved top-left rect; reads ONLY its own
    // store (zero sim coupling — hud-sessions §13-5). The sound cue is the
    // Kenney UI Audio soft click at 40% volume (hud-sessions §3.4; assets D5).
    this.sessionHud = new SessionHud(this, {
      playerScreenRect: () => this.playerScreenRect(),
      reducedMotion,
      playSound: () => this.ctx?.audio?.play(SFX.sessionChime, { volume: 0.4 }),
    });

    this.host = {
      scene: this,
      ctx,
      settings: this.settingsStore,
      // Settings page / day-summary surface of the session HUD (D6, US32/33/39/40).
      sessionHud: this.sessionHud,
      state: () => ctx.sim.state,
      dispatch: (command) => this.dispatch(command),
      toast: (key, params) => this.toastText(t(key, params)),
      closeTop: () => this.closeTop(),
      openChild: (id, data) => this.openPanel(id, data),
      closeAll: () => this.closeAll(),
      reducedMotion: () => this.settingsStore.reducedMotionActive(),
      playSfx: (key) => this.playSfx(key),
    };
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

    // Push persisted volumes into the audio system at boot (GDD §10.7 sync read).
    // M3: the four-channel push (master/muted/bgm/sfx/ui — PRD 04 US56) supersedes
    // setMasterVolume where implemented; the master-only call stays as the fallback.
    const audio = this.settingsStore.get().audio;
    const pushAudio = (s: typeof audio): void => {
      if (ctx.audio?.setChannelVolumes) ctx.audio.setChannelVolumes(s);
      else ctx.audio?.setMasterVolume(s.master, s.muted);
    };
    pushAudio(audio);
    this.settingsStore.onChange((s) => pushAudio(s.audio));

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
    // M3 build bridge (world/build-bridge.ts): PLACING lives world-side, the
    // CATALOG/CONFIRM panels live here (§8.3 machine spans both scenes).
    this.game.events.on(BUILD_EVENTS.confirmRequest, this.onBuildConfirmRequest);
    this.game.events.on(BUILD_EVENTS.catalogReturn, this.onBuildCatalogReturn);
    this.game.events.on(BUILD_EVENTS.structureInteract, this.onStructureInteract);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off(WORLD_EVENTS.interactable, this.onWorldInteractable);
      this.game.events.off(WORLD_EVENTS.daySummary, this.onWorldDaySummary);
      this.game.events.off(BUILD_EVENTS.confirmRequest, this.onBuildConfirmRequest);
      this.game.events.off(BUILD_EVENTS.catalogReturn, this.onBuildCatalogReturn);
      this.game.events.off(BUILD_EVENTS.structureInteract, this.onStructureInteract);
      this.unsubscribeSim?.();
      this.feedbackView?.clear();
      this.sessionHud?.destroy();
      this.sessionHud = null;
      this.closeAll();
    });

    this.consumeRetroLevelUps();
  }

  /**
   * US37 retro catch-up (GDD §5.3 M1→M3 迁移; §8.2 「一次性回溯解锁」): when the
   * boot/import path migrated a v1 save it leaves the source schemaVersion on the
   * registry (one-shot, menuEntry precedent). A v1 save displayed at most Lv5
   * (M1_LEVEL_CAP), so banners replay Lv6..N through the regular FarmLevelUp
   * handler — same copy, same FIFO queue (打扰预算: ≤5 banners + 1 toast ≤ 8) —
   * plus the quiet 「木匠服务已开通」 line once build mode (lowest blueprint
   * unlock, Lv3) is already open. Presentation only: zone fences/blueprints/shop
   * rows all derive from xp at hydrate, so skipping this changes no rules.
   */
  private consumeRetroLevelUps(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const fromVersion = this.registry.get(REGISTRY_KEYS.retroFromVersion) as number | undefined;
    if (typeof fromVersion !== 'number') return;
    this.registry.remove(REGISTRY_KEYS.retroFromVersion);
    if (fromVersion > 1) return; // only v1 had a lower visible level cap (M1 min(·,5))
    const xp = ctx.sim.state.progress.xp;
    for (const event of retroLevelUpEvents(xp, M1_LEVEL_CAP)) {
      this.onSimEvent(event);
    }
    const buildModeLevel = Math.min(...BLUEPRINTS.map((b) => b.unlock.farmLevel));
    if (effectiveLevel(xp) >= buildModeLevel) {
      this.notifications.toast(t('toast.carpenter_service'), this.time.now);
    }
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
      case 'sign': // US5 / backlog A-3: signposts are readable
        this.openSign(payload.id);
        break;
      default:
        break; // well: ambience only in M1 (GDD §1.3 — 喷壶无限水，水井留作氛围)
    }
  };

  private readonly onWorldDaySummary = (payload: DaySummaryPayload): void => {
    if (!this.ctx) return;
    this.nightTransition = false;
    this.closeAll();
    this.openPanel('daySummary', payload.summary);
  };

  // ---- M3 build bridge (world/build-bridge.ts; GDD §8.3) ----

  /** Building/farmhouse order reached the CONFIRM arrow — dialog, tick stops (US8). */
  private readonly onBuildConfirmRequest = (payload: ConfirmRequestPayload): void => {
    if (!this.ctx || this.nightTransition) return;
    this.closeAll(); // PLACING has an empty stack; be defensive about stragglers
    this.openPanel('buildConfirm', payload.request);
  };

  /** PLACING backed out (Esc/right-click) or exhausted materials (§8.3/§8.5). */
  private readonly onBuildCatalogReturn = (payload: CatalogReturnPayload): void => {
    if (!this.ctx || this.nightTransition) return;
    if (payload.toastKey !== undefined) this.toastText(t(payload.toastKey));
    if (this.stack.depth() === 0) this.openPanel('buildCatalog', payload.tab);
  };

  /** E on a built structure: route to its facility panel (PRD 04 US15/US16/US19/US21). */
  private readonly onStructureInteract = (payload: StructureInteractPayload): void => {
    if (!this.ctx || this.nightTransition || this.stack.depth() > 0) return;
    switch (payload.defId) {
      case 'coop':
        this.openPanel('coop', payload.instanceId);
        return;
      case 'workshop':
      case 'drying_rack':
        this.openPanel('processing', payload.instanceId);
        return;
      case 'bench': // 「候车室」彩蛋 (§8.2): sit and idle for a moment
        this.toastText(t('toast.bench_sit'));
        return;
      case 'storage_chest': // storage UI is not in this batch — recorded openQuestion
        this.toastText(t('toast.chest_hint'));
        return;
      case 'greenhouse': // interior scenes land with the interiors batch
        this.toastText(t('toast.greenhouse_hint'));
        return;
      default:
        return; // fence/path/lamp/statue: pure scenery
    }
  };

  override update(time: number): void {
    if (!this.ctx) return;
    const state = this.ctx.sim.state;
    this.topRight?.update(state, time);
    this.hotbar?.update(state);
    this.notificationsView?.update(time);
    this.feedbackView?.update(); // flush AFTER hotbar.update so landings target fresh slots
    this.sessionHud?.update(); // M2 session HUD (no-op while hidden, US23)
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
    // US86 / backlog A-4: the first read pins the one-time semantics (idempotent
    // counter; the world layer drops the porch highlight off this state).
    this.ctx?.sim.markIntroLetterRead();
  }

  openBoard(): void {
    this.openPanel('board');
  }

  openSign(signId: string): void {
    this.openPanel('sign', signId);
  }

  toastText(text: string): void {
    this.notifications.toast(text, this.time.now);
  }

  // ---- stack management (invariant: depth > 0 ⇔ UI pause sources active) ----

  private openPanel(id: UiPanelId, data?: unknown): void {
    if (!this.ctx) return;
    if (!this.stack.push(id)) return; // mutual exclusion (GDD §6.5)
    // Hide the covered parent (panels share DEPTH tokens, so a visible parent's
    // depth-(panel+1) widgets would bleed through the child's panel background).
    this.panels.at(-1)?.setCovered?.(true);
    this.panels.push(this.buildPanel(id, data));
    this.topOpenedAt = this.time.now;
    this.syncPauseSources();
  }

  private closeTop(): void {
    const removed = this.stack.pop();
    if (removed === null) return;
    this.panels.pop()?.destroy();
    const top = this.panels.at(-1);
    if (top !== undefined) {
      top.setCovered?.(false);
      top.refresh();
    }
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
    // Day-summary screen showing ⇒ session panel hides; its store keeps
    // updating over WS (hud-sessions §4.6/§11-19 — HUD reflects reality).
    this.sessionHud?.setSuppressed(this.panels.some((p) => p.id === 'daySummary'));
  }

  private buildPanel(id: UiPanelId, data?: unknown): Panel {
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
      case 'sessionSettings': // 设置 → 会话面板 (M2, hud-sessions §9/§12-D6)
        return new SessionSettingsPanel(this.host);
      case 'achievements':
        return new AchievementsPanel(this.host); // M1.5 成就 tab + M3 paging (PRD 04 §I)
      case 'keysHelp':
      case 'letter':
      case 'board':
        return new ReadingPanel(this.host, id);
      case 'sign':
        return new ReadingPanel(this.host, 'sign', data as string | undefined); // US5 / A-3
      case 'sleepConfirm':
        return new SleepConfirmPanel(this.host);
      case 'daySummary': {
        if (!data) throw new Error('daySummary requires a DaySummary payload');
        return new DaySummaryPanel(this.host, data as DaySummary);
      }
      // ---- M3 build & facility panels (GDD §8.3/§5.3/§5.8; PRD 04) ----
      case 'buildCatalog':
        return new BuildCatalogPanel(this.host, data as BuildTab | undefined);
      case 'buildConfirm': {
        if (!data) throw new Error('buildConfirm requires a BuildConfirmRequest payload');
        return new BuildConfirmPanel(this.host, data as BuildConfirmRequest);
      }
      case 'coop': {
        if (typeof data !== 'string') throw new Error('coop requires an instanceId payload');
        return new CoopPanel(this.host, data);
      }
      case 'processing': {
        if (typeof data !== 'string') throw new Error('processing requires an instanceId payload');
        return new ProcessingPanel(this.host, data);
      }
      case 'profession':
        return new ProfessionPanel(this.host);
      case 'codex':
        return new CodexPanel(this.host);
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
      case 'AchievementUnlocked':
        // Bottom-right 2.5s non-modal toast (GDD §5.8; PRD 02 US2). M3 graduates the
        // SFX from the reused item_get to the dedicated collect jingle (§11.5).
        this.notifications.achievement(
          t('achievement.toast', { name: t(`achv.${event.id}.name`) }),
          now,
        );
        this.playSfx(UI_CUES.achievementUnlocked.key);
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
        // The US39 certificate-desk hint lives on the settlement screen (the
        // day-summary panel shows it once via professionHintPending and burns the
        // sim-side flag) — no duplicate toast here (GDD §5.3 「只温和提示一次」).
        break;
      }
      case 'zoneUnlocked':
        this.notifications.banner(
          t('banner.zone_unlocked', { zone: t(`zone.${event.zoneId}`) }),
          now,
        );
        break;
      case 'ConstructionCompleted':
        // 竣工无弹窗: confetti is world-side; here only the banner line (§8.3, US11).
        this.notifications.banner(
          t('banner.construction_done', { name: t(`blueprint.${event.defId}`) }),
          now,
        );
        this.playSfx(SFX.jingleLevelup); // build_complete beat lands with the audio pass
        break;
      case 'ProfessionChosen':
        this.notifications.banner(
          t('banner.profession', { name: t(`profession.${event.profession}`) }),
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

  private playSfx(key: SfxKey | SfxM3Key): void {
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

  /**
   * Player sprite screen rect for the session HUD's autoFade (hud-sessions
   * §3.2). The camera follows the player sprite (WorldScene startFollow), so
   * the follow target IS the player's smooth world position; null when the
   * world is not running or Phaser's internal follow slot is unavailable —
   * autoFade then simply never triggers (graceful degrade, flagged apiDrift:
   * a public WorldScene accessor would be cleaner).
   */
  private playerScreenRect(): { x: number; y: number; width: number; height: number } | null {
    const cam = this.worldCamera();
    if (!cam) return null;
    const follow = (cam as unknown as { _follow?: { x?: unknown; y?: unknown } })._follow;
    if (!follow || typeof follow.x !== 'number' || typeof follow.y !== 'number') return null;
    // Foot-center origin (0.5, 1), body ≈ 16×24 px (world/player.ts).
    const sx = Math.round((follow.x - cam.worldView.x) * cam.zoom);
    const sy = Math.round((follow.y - cam.worldView.y) * cam.zoom);
    return { x: sx - 8, y: sy - 24, width: 16, height: 24 };
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
    const placing = getBuildController(this)?.isActive() === true;
    switch (event.key) {
      case 'Escape':
        if (placing) {
          // PLACING → back to CATALOG (§8.3 Esc/右键取消; uncommitted = 未扣费).
          getBuildController(this)?.cancelToCatalog();
          return;
        }
        this.openPanel('pauseMenu');
        return;
      case 'b':
      case 'B':
        // B = 建造目录 (GDD §6.8 keymap; appendix B-5; PRD 04 US1).
        if (!placing) this.openPanel('buildCatalog');
        return;
      case 'Tab':
      case 'i':
      case 'I':
        event.preventDefault();
        this.openPanel('inventory');
        return;
      case 'h':
      case 'H':
        // M2 session HUD display cycle: expanded → collapsed → hidden (GDD §6.8).
        this.sessionHud?.cycleDisplayMode();
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
