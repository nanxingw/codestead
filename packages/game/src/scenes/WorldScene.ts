/**
 * WorldScene — the farm: tilemap render, player, camera, input translation, sim driver.
 *
 * Thin render shell over sim/ (strict one-way event flow, GDD §12): scenes translate
 * input into SimCommands and subscribe to SimEvents; render never calls back into
 * game rules. Layer stack per GDD §1.5 (ground 0 / farmland 10 / ground_detail 20 /
 * buildings 30 / cursor 90 / entities 100+footY / above 1000 / fx 1100; the invisible
 * `collision` layer is the ONLY collision truth).
 *
 * Parallel-workstream tolerance: when maps/farm.tmj or the sim implementation has not
 * landed yet, the scene degrades (generated ground, FALLBACK_MAP_META, movement-only
 * mode) instead of crashing — every degradation logs a console warning.
 */
import type { RestorableSaveDocV2 } from '@codestead/shared';
import Phaser from 'phaser';

import { MAPS, SFX, SFX_M3, TEXTURES } from '../AssetKeys';
import { BOOT_BUNDLE_REGISTRY_KEY, type BootBundle } from '../boot/bundle';
import { detectAppVersion } from '../boot/new-game';
import { makeSaveTransfer } from '../boot/save-transfer';
import { bindVisibilityPause } from '../boot/visibility';
import { ACTION_TIMING, INVENTORY, TIME } from '../sim/data/constants';
import { cropItemId, type ItemId } from '../sim/data/items';
import { isOldVine } from '../sim/farming';
import { canAdd } from '../sim/inventory';
import { effectiveLevel } from '../sim/leveling';
import type { SimApi } from '../sim/sim';
import { newGameSim } from '../sim/sim';
import { getTile, nextCapLevel, tillBlockedByCap } from '../sim/tiles';
import type { ActionQuery, DaySummary, Facing, MapMeta, SimEvent, TilePos } from '../sim/types';
import { SaveManager } from '../storage/save-manager';
import { UI_CONTEXT_REGISTRY_KEY, type UiContext } from '../ui/context';
import { structureAt } from '../ui/panels/build-model';
import { SettingsStore } from '../ui/settings-store';
import { t } from '../ui/strings';
import { facingToward, resolveTargetTile, MOUSE_TAKEOVER_PX, type AimMode } from '../world/aim';
import { ActionBuffer, HoldCharge, HoldRepeater } from '../world/action-timing';
import { AmbienceView } from '../world/ambience-view';
import { attachWorldSfx } from '../world/audio';
import { AudioShell } from '../world/audio-shell';
import { BUILD_EVENTS, type StructureInteractPayload } from '../world/build-bridge';
import { BuildController } from '../world/build-controller';
import { CropsView } from '../world/crops-view';
import { TileCursor } from '../world/cursor';
import { REGISTRY_KEYS, WORLD_EVENTS, type InteractablePayload } from '../world/events';
import { FarmlandView } from '../world/farmland-view';
import { InputStack, type Dir } from '../world/input-stack';
import { buildMapMeta, FALLBACK_MAP_META, type TiledMapData } from '../world/map-meta';
import { PALETTE } from '../world/palette';
import { PickupsView } from '../world/pickups-view';
import { PlayerController } from '../world/player';
import { RangePreview } from '../world/range-preview';
import { StructuresView } from '../world/structures-view';
import {
  FALLBACK_GROUND_TEXTURE,
  PARTICLE_TEXTURE,
  ensureGeneratedTextures,
} from '../world/textures';
import { TimeDriver } from '../world/time-driver';
import { expandToolRange, toolTierFor } from '../world/tool-range';
import { UpgradeFx } from '../world/upgrade-fx';
import type { UiSceneApi } from './UIScene';

const TILE = 16;
/** Dev fallback seed; real new-game seeding belongs to the storage/boot layer. */
const DEV_SEED = 'codestead-dev';
/** Day-summary input grace after it opens (GDD §6.5: any key after 400ms closes). */
const SUMMARY_GRACE_MS = 400;
/** Unlock fx covers a 6–8 tile pre-till focus area, not the whole field (GDD §1.4). */
const UNLOCK_FOCUS_TILES = 8;

interface DirKeys {
  keys: Phaser.Input.Keyboard.Key[];
  held: boolean;
}

export class WorldScene extends Phaser.Scene {
  private sim: SimApi | null = null;
  private mapMeta: MapMeta = FALLBACK_MAP_META;
  private driver!: TimeDriver;
  private player!: PlayerController;
  private cursor!: TileCursor;
  private farmland!: FarmlandView;
  private crops!: CropsView;
  private pickupsView!: PickupsView;
  private ambience!: AmbienceView;
  /** M3 placed structures & sprinkler markers (GDD §8; PRD 04 §B). */
  private structuresView!: StructuresView;
  /** M3 PLACING controller (§8.3) — registered on the registry for the UI panels. */
  private buildController!: BuildController;

  private readonly inputStack = new InputStack();
  private readonly repeater = new HoldRepeater();
  /** Copper/gold hoe hold-to-charge (A-16); the repeater drives everything else. */
  private readonly charge = new HoldCharge();
  private readonly buffer = new ActionBuffer();
  private rangePreview!: RangePreview;
  /** Tool-upgrade visual trio (§3.5 / PRD 02 US22): water arc / afterimage / wet spread. */
  private upgradeFx!: UpgradeFx;
  /** Last seen ToolTiers — upgrade toast edge detection (no ToolUpgraded SimEvent). */
  private lastToolTiers: { hoe: number; wateringCan: number } | null = null;
  private aimMode: AimMode = 'keyboard';
  private mouseAccum = 0;
  private lastPointer = { x: 0, y: 0 };

  private dirKeys: Record<Dir, DirKeys> | null = null;
  private interactKeys: Phaser.Input.Keyboard.Key[] = [];
  private runKeys: Phaser.Input.Keyboard.Key[] = [];
  private digitKeys: Phaser.Input.Keyboard.Key[] = [];
  private menuKey: Phaser.Input.Keyboard.Key | null = null;
  private inventoryKeys: Phaser.Input.Keyboard.Key[] = [];

  private collisionSolid = new Uint8Array(0);
  private buildingsLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private collisionLayerData: Phaser.Tilemaps.LayerData | null = null;

  private readonly interactableByTile = new Map<string, { id: string; kind: string }>();
  private readonly pickupSpotByTile = new Map<string, string>();
  /** M3 §8.1 clearable trees/boulders by tile key (axe → wood, pickaxe → stone). */
  private readonly resourceNodeByTile = new Map<string, { id: string; kind: 'tree' | 'boulder' }>();

  private nightPending = false;
  private nightActive = false;
  private pendingSummary: DaySummary | null = null;
  private summaryShownAt = Number.POSITIVE_INFINITY;
  private queryBroken = false;
  private unsubSim: (() => void) | null = null;
  private readonly windowCleanups: (() => void)[] = [];
  /** Zone unlock fx deferred from the night settlement to the morning fade-in (A-7). */
  private pendingUnlockFx: string[] = [];
  /** Porch-letter highlight while unread (US86 / backlog A-4). */
  private letterGlow: Phaser.GameObjects.Rectangle | null = null;

  /** True once UIScene was launched with a live UiContext — it then owns the
   *  Esc/Tab/I/1-9/wheel keys and the day-summary dismissal (apiDrift contract). */
  private uiLive = false;
  private saves: SaveManager | null = null;
  private sfx: AudioShell | null = null;
  private unsubWorldSfx: (() => void) | null = null;
  /** Guards the night-settlement side effects (events arrive via both channels). */
  private lastNightHandledDay = 0;

  constructor() {
    super('World');
  }

  create(): void {
    this.resetTransientState();
    ensureGeneratedTextures(this); // idempotent (PreloadScene normally did this)

    this.buildMap();
    this.buildSim();
    this.buildViews();
    this.buildPlayerAndCamera();
    this.buildDriver();
    this.buildPersistence();
    this.buildInput();
    this.indexStaticTargets();
    this.launchUi();

    if (this.sim) {
      this.refreshAllFromSim();
      for (const zoneId of this.sim.state.farm.unlockedZones) {
        this.applyZoneUnlock(zoneId, false);
      }
    }
    this.buildLetterGlow();
    this.cameras.main.fadeIn(this.fadeMs(TIME.NIGHT_FADE_IN_MS), 0, 0, 0);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  /** reducedMotion (§10.8): scene fades 0ms. Fresh read so a settings change applies
   *  without a scene restart (the store itself is owned by the UI layer). */
  private fadeMs(normalMs: number): number {
    return this.reducedMotionActive() ? 0 : normalMs;
  }

  private reducedMotionActive(): boolean {
    return new SettingsStore().reducedMotionActive();
  }

  /**
   * Static gold glow over the porch letter while unread (US86 / backlog A-4) —
   * visibility tracks the introLetterRead counter per frame. Static by design:
   * no pulsing, so it is reducedMotion-neutral and photosensitivity-safe (§11.7).
   */
  private buildLetterGlow(): void {
    const letter = this.mapMeta.interactables.find((i) => i.kind === 'letter');
    if (!letter || letter.tiles.length === 0 || !this.sim) return;
    const tile = letter.tiles[0];
    this.letterGlow = this.add
      .rectangle(tile.x * TILE + TILE / 2, tile.y * TILE + TILE / 2, TILE, TILE)
      .setFillStyle(PALETTE.goldLight, 0.3)
      .setStrokeStyle(1, PALETTE.goldLight, 0.8)
      .setDepth(40); // above buildings (30), below entities (100+)
  }

  // ---- construction -------------------------------------------------------

  /**
   * Phaser reuses scene instances across scene.start() round-trips (main menu ⇄ farm),
   * and class field initializers only run at construction — every per-run field must
   * be re-armed here or stale state leaks into the next visit (e.g. a direction stuck
   * in the input stack would auto-walk the player).
   */
  private resetTransientState(): void {
    this.inputStack.clear();
    this.repeater.release();
    this.charge.cancel();
    this.buffer.clear();
    this.lastToolTiers = null;
    this.aimMode = 'keyboard';
    this.mouseAccum = 0;
    this.dirKeys = null;
    this.buildingsLayer = null;
    this.collisionLayerData = null;
    this.interactableByTile.clear();
    this.pickupSpotByTile.clear();
    this.resourceNodeByTile.clear();
    this.nightPending = false;
    this.nightActive = false;
    this.pendingSummary = null;
    this.summaryShownAt = Number.POSITIVE_INFINITY;
    this.queryBroken = false;
    this.uiLive = false;
    this.saves = null;
    this.sfx = null;
    this.lastNightHandledDay = 0;
    this.pendingUnlockFx = [];
    this.letterGlow = null; // destroyed with the scene's display list on shutdown
  }

  private buildMap(): void {
    const hasMap = this.cache.tilemap.exists(MAPS.farm);
    if (!hasMap) {
      console.warn('[world] maps/farm.tmj not loaded — using generated fallback ground');
      this.add
        .tileSprite(
          0,
          0,
          FALLBACK_MAP_META.width * TILE,
          FALLBACK_MAP_META.height * TILE,
          FALLBACK_GROUND_TEXTURE,
        )
        .setOrigin(0, 0)
        .setDepth(0);
      this.mapMeta = this.preSeededMapMeta() ?? FALLBACK_MAP_META;
      this.collisionSolid = new Uint8Array(this.mapMeta.width * this.mapMeta.height);
      return;
    }

    const map = this.make.tilemap({ key: MAPS.farm });
    const cacheEntry = this.cache.tilemap.get(MAPS.farm) as { data?: TiledMapData } | undefined;
    this.mapMeta =
      this.preSeededMapMeta() ??
      (cacheEntry?.data ? buildMapMeta(cacheEntry.data) : FALLBACK_MAP_META);

    // Tileset name MUST be 'terrain' (GDD §1.1/§11.4).
    const tileset = this.textures.exists(TEXTURES.terrain)
      ? map.addTilesetImage('terrain', TEXTURES.terrain)
      : null;
    if (tileset) {
      const layerDepths: [string, number][] = [
        ['ground', 0],
        ['ground_detail', 20],
        ['buildings', 30],
        ['above', 1000],
      ];
      for (const [name, depth] of layerDepths) {
        const layer = map.createLayer(name, tileset, 0, 0);
        if (layer) {
          layer.setDepth(depth);
          if (name === 'buildings') this.buildingsLayer = layer;
        }
      }
    } else {
      console.warn('[world] terrain tileset missing — layers skipped, fallback ground shown');
      this.add
        .tileSprite(0, 0, map.widthInPixels, map.heightInPixels, FALLBACK_GROUND_TEXTURE)
        .setOrigin(0, 0)
        .setDepth(0);
    }

    // collision layer: parsed data only, never rendered (GDD §1.5 #8).
    const w = this.mapMeta.width;
    const h = this.mapMeta.height;
    this.collisionSolid = new Uint8Array(w * h);
    const collision = map.getLayer('collision');
    if (collision) {
      this.collisionLayerData = collision;
      for (let y = 0; y < Math.min(h, collision.data.length); y++) {
        const row = collision.data[y];
        for (let x = 0; x < Math.min(w, row.length); x++) {
          if (row[x] && row[x].index >= 0) this.collisionSolid[y * w + x] = 1;
        }
      }
    } else {
      console.warn('[world] collision layer missing from farm.tmj');
    }
  }

  private preSeededMapMeta(): MapMeta | null {
    const pre = this.registry.get(REGISTRY_KEYS.mapMeta) as MapMeta | undefined;
    return pre ?? null;
  }

  private buildSim(): void {
    const pre = this.registry.get(REGISTRY_KEYS.sim) as SimApi | undefined;
    if (pre) {
      this.sim = pre;
    } else {
      try {
        // Game entry point ⇒ achievements ON (B-3: only deduction/replay entry
        // points run the default rewards-off mode).
        this.sim = newGameSim(DEV_SEED, this.mapMeta, { achievements: true });
      } catch (err) {
        console.warn('[world] sim unavailable (movement-only mode):', err);
        this.sim = null;
      }
    }
    this.registry.set(REGISTRY_KEYS.sim, this.sim);
    this.registry.set(REGISTRY_KEYS.mapMeta, this.mapMeta);
    if (this.sim) {
      this.unsubSim = this.sim.on((ev) => this.onSimEvent(ev));
      // Seed from the loaded save so restoring a copper/gold save never toasts.
      this.lastToolTiers = { ...this.sim.state.tools };
    }
  }

  private buildViews(): void {
    this.farmland = new FarmlandView(this);
    this.crops = new CropsView(this);
    this.pickupsView = new PickupsView(this, this.mapMeta.pickupSpots);
    this.ambience = new AmbienceView(this, () => this.reducedMotionActive());
    this.cursor = new TileCursor(this);
    this.rangePreview = new RangePreview(this);
    this.upgradeFx = new UpgradeFx(this, () => this.reducedMotionActive());
    this.structuresView = new StructuresView(this, () => this.reducedMotionActive());
    // PLACING controller (§8.3): UI panels reach it via build-bridge; all closures
    // read live scene state, so construction order does not matter.
    this.buildController = new BuildController(this, {
      sim: () => this.sim,
      mapMeta: () => this.mapMeta,
      playerTile: () => this.player.currentTile,
      facing: () => this.player.facing,
      hoverTile: () => this.hoverTile(),
      aimMode: () => this.aimMode,
      isSolidTerrain: (tx, ty) => {
        const w = this.mapMeta.width;
        if (tx < 0 || ty < 0 || tx >= w || ty >= this.mapMeta.height) return true;
        return this.collisionSolid[ty * w + tx] === 1;
      },
      toast: (text) => this.uiToast(text),
      playError: () => this.sfx?.play(SFX.uiError),
      playCommit: () => this.sfx?.play(SFX.itemGet),
    });
  }

  private buildPlayerAndCamera(): void {
    const spawnTile: TilePos = this.sim
      ? { x: this.sim.state.player.tileX, y: this.sim.state.player.tileY }
      : this.mapMeta.spawn.tile;
    const facing: Facing = this.sim ? this.sim.state.player.facing : this.mapMeta.spawn.facing;
    const w = this.mapMeta.width;
    this.player = new PlayerController(
      this,
      spawnTile,
      facing,
      (tx, ty) => {
        if (tx < 0 || ty < 0 || tx >= w || ty >= this.mapMeta.height) return true;
        if (this.collisionSolid[ty * w + tx] === 1) return true;
        // M3 placed structures extend the collision truth (GDD §8.3; canPlace rule
        // ⑤ guarantees the player is never inside a footprint when it commits).
        return this.structuresView.isSolid(tx, ty);
      },
      this.mapMeta.width * TILE,
      this.mapMeta.height * TILE,
    );
    // Camera spec (GDD §1.8): follow lerp 0.12, hard bounds, no shake/zoom moves.
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.mapMeta.width * TILE, this.mapMeta.height * TILE);
    cam.startFollow(this.player.sprite, true, 0.12, 0.12);
  }

  private buildDriver(): void {
    this.driver = new TimeDriver({
      step: () => {
        if (!this.sim) return 'halt';
        this.sim.advanceMinutes(1); // events arrive via the on() subscription (A-7)
        return this.nightPending ? 'halt' : 'continue';
      },
      isAtDayEnd: () =>
        this.sim !== null && this.sim.state.time.minuteOfDay >= TIME.DAY_END_MINUTE - 1,
      shouldHoldDayEnd: () => this.player.isActing, // GDD §1.10 #7
      onPause: () => this.game.events.emit(WORLD_EVENTS.paused),
      onResume: () => this.game.events.emit(WORLD_EVENTS.resumed),
    });
    this.registry.set(REGISTRY_KEYS.timeDriver, this.driver);

    // tab_hidden / window_blur pause sources + hidden/blur autosaves (GDD §2.4/§10.4;
    // pauseOnBlur default true, B-8). bindVisibilityPause re-queries state before
    // releasing a source (rAF vs visibilitychange ordering, GDD §2.9).
    this.windowCleanups.push(
      bindVisibilityPause({
        addPauseSource: (source) => this.driver.add(source),
        removePauseSource: (source) => this.driver.remove(source),
        requestAutosave: (mode) => {
          if (!this.saves) return;
          if (mode === 'immediate') void this.saves.flushImmediate();
          else this.saves.requestDebouncedSave();
        },
      }),
    );

    // §2.4/§10.4/§11.6 boot gate: time holds until the「回到农场」gesture. Entering
    // through the main menu, the menu click IS that gesture (it already unlocked
    // audio autoplay), so the gate releases on the next tick — late enough that the
    // entering click never performs a world action. The first-input fallback only
    // remains for the degraded boot path that skips the menu (movement-only mode).
    this.driver.add('boot_gate');
    const releaseBootGate = (): void => {
      this.time.delayedCall(0, () => this.driver.remove('boot_gate'));
    };
    if (this.registry.get(REGISTRY_KEYS.menuEntry) === true) {
      this.registry.remove(REGISTRY_KEYS.menuEntry);
      releaseBootGate();
    } else {
      this.input.once(Phaser.Input.Events.POINTER_DOWN, releaseBootGate);
      this.input.keyboard?.once('keydown', releaseBootGate);
    }

    this.game.events.on(WORLD_EVENTS.sleepConfirmed, this.onSleepConfirmed);
    this.game.events.on(WORLD_EVENTS.daySummaryDismissed, this.onSummaryDismissed);
  }

  /** SaveManager from the boot handoff (PreloadScene); absent in degraded mode. */
  private buildPersistence(): void {
    const bundle = this.registry.get(BOOT_BUNDLE_REGISTRY_KEY) as BootBundle | undefined;
    if (!bundle || !this.sim) return;
    this.saves = new SaveManager({
      storage: bundle.storage,
      snapshot: () => this.snapshotForSave(),
      meta: bundle.meta,
      appVersion: detectAppVersion(),
      onSaveFailed: ({ trigger, failure }) => {
        // Gentle by contract (§10.9): never block play, suggest the JSON backstop.
        console.warn(`[save] ${trigger} write failed:`, failure);
        this.uiToast(t('toast.save_failed'));
      },
    });
    if (!bundle.persisted) {
      // New-game first write failed (§10.1): same gentle export hint, keep playing.
      this.time.delayedCall(1_000, () => this.uiToast(t('toast.save_failed')));
    }
  }

  /**
   * Live save snapshot: push the render-side player into the sim first (GDD §1.6 —
   * movement is render-owned). During the night flow the sim already holds the
   * §1.3 wake-at-spawn position; do not overwrite it with the pre-sleep position.
   */
  private snapshotForSave(): RestorableSaveDocV2 {
    const sim = this.sim;
    if (!sim) throw new Error('[world] snapshot requested without a sim');
    if (!this.nightActive && !this.nightPending) {
      const tile = this.player.currentTile;
      sim.syncPlayer({ tileX: tile.x, tileY: tile.y, facing: this.player.facing });
    }
    return sim.serialize();
  }

  /** Launch the UI overlay with its context (ui/context.ts wiring contract). */
  private launchUi(): void {
    if (!this.sim) {
      this.scene.launch('UI'); // passive M0-compatible shell (movement-only mode)
      return;
    }
    // AudioShell = pure AudioDirector (audio/audio-director.ts) + Phaser playback
    // (BGM/ambience loops, first-gesture lazy load, four-channel volumes — GDD §11.6).
    const audio = new AudioShell(this, {
      pauseSources: () => this.driver.pauseSources,
      playerPos: () => ({ x: this.player.sprite.x, y: this.player.sprite.y }),
      surfaceAt: () =>
        this.sim && getTile(this.sim.state, this.player.currentTile) !== null ? 'dirt' : 'grass',
    });
    this.sfx = audio;
    this.unsubWorldSfx = attachWorldSfx(this.sim, audio.sfx);
    audio.attach(this.sim);
    const bundle = this.registry.get(BOOT_BUNDLE_REGISTRY_KEY) as BootBundle | undefined;
    const ctx: UiContext = {
      sim: this.sim,
      map: this.mapMeta,
      pause: {
        add: (source) => this.driver.add(source),
        remove: (source) => this.driver.remove(source),
      },
      audio,
      saveTransfer:
        this.saves && bundle
          ? makeSaveTransfer({
              storage: bundle.storage,
              saves: this.saves,
              snapshot: () => this.snapshotForSave(),
            })
          : undefined,
      returnToMainMenu: () => this.returnToMainMenu(),
    };
    this.registry.set(UI_CONTEXT_REGISTRY_KEY, ctx);
    this.scene.launch('UI', ctx);
    this.uiLive = true;
  }

  /** Toast on the UI overlay (blocked reasons / save hints); no-op in degraded mode. */
  private uiToast(text: string): void {
    if (!this.uiLive) return;
    const ui = this.scene.get('UI') as unknown as UiSceneApi | null;
    ui?.toastText(text);
  }

  /**
   * 回主菜单 (GDD §6.5/§6.7): manual-save first, then swap to the MainMenu scene.
   * A failed save must not strand the player — the transition happens regardless
   * (the pause menu already surfaced the gentle export hint via onSaveFailed).
   */
  private returnToMainMenu(): void {
    const finish = (): void => {
      const bundle = this.registry.get(BOOT_BUNDLE_REGISTRY_KEY) as BootBundle | undefined;
      if (bundle && this.saves) {
        // Keep display-only meta advancing monotonically across menu round-trips.
        this.registry.set(BOOT_BUNDLE_REGISTRY_KEY, { ...bundle, meta: this.saves.meta });
      }
      this.scene.stop('UI');
      this.scene.start('MainMenu');
    };
    if (this.saves) void this.saves.saveNow('manual').finally(finish);
    else finish();
  }

  private readonly onSleepConfirmed = (): void => {
    this.performSleep();
  };

  private readonly onSummaryDismissed = (): void => {
    this.resumeDay();
  };

  private buildInput(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.addCapture(['TAB', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE']);
    const make = (codes: number[]): Phaser.Input.Keyboard.Key[] =>
      codes.map((c) => kb.addKey(c, false));
    const KC = Phaser.Input.Keyboard.KeyCodes;
    this.dirKeys = {
      up: { keys: make([KC.W, KC.UP]), held: false },
      down: { keys: make([KC.S, KC.DOWN]), held: false },
      left: { keys: make([KC.A, KC.LEFT]), held: false },
      right: { keys: make([KC.D, KC.RIGHT]), held: false },
    };
    this.interactKeys = make([KC.E, KC.ENTER]);
    this.runKeys = make([KC.SHIFT]);
    this.digitKeys = make([
      KC.ONE,
      KC.TWO,
      KC.THREE,
      KC.FOUR,
      KC.FIVE,
      KC.SIX,
      KC.SEVEN,
      KC.EIGHT,
      KC.NINE,
    ]);
    this.menuKey = kb.addKey(KC.ESC, false);
    this.inventoryKeys = make([KC.TAB, KC.I]);

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      this.mouseAccum += Math.abs(pointer.x - this.lastPointer.x);
      this.mouseAccum += Math.abs(pointer.y - this.lastPointer.y);
      this.lastPointer = { x: pointer.x, y: pointer.y };
      if (this.mouseAccum > MOUSE_TAKEOVER_PX) {
        this.aimMode = 'mouse';
        this.mouseAccum = 0;
      }
      this.driver.noteInput();
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      this.driver.noteInput();
      if (this.nightActive) {
        if (!this.uiLive) this.resumeDay(); // UI day-summary panel owns dismissal otherwise
        return;
      }
      // M3 PLACING (§8.3): left = commit at the ghost (any distance — the ghost IS
      // the selection), right = cancel back to the catalog. Both consume the click.
      if (this.buildController.isActive() && !this.isModalBlocked()) {
        if (pointer.rightButtonDown()) {
          this.buildController.cancelToCatalog();
        } else if (pointer.leftButtonDown()) {
          this.aimMode = 'mouse';
          this.buildController.commit();
        }
        return;
      }
      if (!pointer.leftButtonDown() || this.isModalBlocked()) return;
      this.aimMode = 'mouse';
      const hover = this.hoverTile(pointer);
      if (hover === null) return;
      const player = this.player.currentTile;
      if (Math.max(Math.abs(hover.x - player.x), Math.abs(hover.y - player.y)) > 1) {
        this.cursor.flashTooFar(hover); // outside 3×3: no pathing, no movement (§1.7)
        return;
      }
      this.player.facing = facingToward(player, hover, this.player.facing);
      this.pressInteract();
    });
    this.input.on(Phaser.Input.Events.POINTER_UP, () => {
      this.releaseInteractIfIdle();
    });
    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
        if (!this.sim || this.isModalBlocked() || dy === 0) return;
        this.driver.noteInput();
        if (this.uiLive) return; // UIScene owns hotbar cycling (single dispatch)
        const n = INVENTORY.HOTBAR_SIZE;
        const next = (this.sim.state.inventory.selected + (dy > 0 ? 1 : -1) + n) % n;
        this.sim.dispatch({ type: 'selectSlot', slot: next });
      },
    );
  }

  private indexStaticTargets(): void {
    for (const inter of this.mapMeta.interactables) {
      for (const t of inter.tiles) {
        this.interactableByTile.set(`${t.x},${t.y}`, { id: inter.id, kind: inter.kind });
      }
    }
    for (const spot of this.mapMeta.pickupSpots) {
      this.pickupSpotByTile.set(`${spot.tile.x},${spot.tile.y}`, spot.id);
    }
    for (const node of this.mapMeta.resourceNodes ?? []) {
      this.resourceNodeByTile.set(`${node.tile.x},${node.tile.y}`, {
        id: node.id,
        kind: node.kind,
      });
    }
  }

  // ---- per-frame ----------------------------------------------------------

  update(_time: number, delta: number): void {
    const blocked = this.isModalBlocked();
    // A modal / the night flow interrupts a hoe charge: preview cancelled, nothing
    // executes, zero penalty (GDD §3.9 #4) — must precede the release polling below.
    if (blocked || this.nightActive) this.charge.cancel();
    this.pollKeyboard(blocked);

    if (this.sim) this.driver.update(delta);
    if (this.nightPending && !this.nightActive) this.beginNight();

    const dir = blocked || this.nightActive ? null : this.inputStack.current;
    this.player.update(
      delta,
      dir,
      this.runKeys.some((k) => k.isDown),
    );

    // buffered follow-up action fires the moment the lock ends (GDD §1.6)
    if (!blocked && !this.nightActive && !this.player.isActing && this.buffer.take()) {
      this.tryAttempt();
    }
    if (!blocked && !this.nightActive && this.anyInteractHeld()) {
      if (this.repeater.update(this.time.now) > 0) this.tryAttempt();
    }

    this.updateCursor(blocked);
    this.updateRangeOverlays(blocked);
    // M3 PLACING ghost (§8.3): time keeps flowing; the ghost stays visible under the
    // CONFIRM dialog so the pending order keeps its spatial context.
    if (!this.nightActive) this.buildController.update();
    if (this.sim) this.structuresView.updateClock(this.sim.state.time.minuteOfDay);
    this.checkToolUpgrades();
    if (this.letterGlow && this.sim) {
      this.letterGlow.setVisible(
        !this.nightActive && (this.sim.state.progress.counters.introLetterRead ?? 0) === 0,
      );
    }
    if (this.sim) {
      this.ambience.update(this.sim.state.time.minuteOfDay, this.sim.state.time.weatherToday);
    }
  }

  private pollKeyboard(blocked: boolean): void {
    if (!this.dirKeys) return;
    // Direction edges: same-frame presses enter the stack in the fixed order
    // up > down > left > right (GDD §1.6 determinism).
    const pressed: Dir[] = [];
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      const entry = this.dirKeys[dir];
      const held = entry.keys.some((k) => k.isDown);
      if (held && !entry.held) pressed.push(dir);
      if (!held && entry.held) this.inputStack.release(dir);
      if (held !== entry.held) this.driver.noteInput();
      entry.held = held;
    }
    if (pressed.length > 0) {
      this.inputStack.pressSameFrame(pressed);
      this.aimMode = 'keyboard';
      this.mouseAccum = 0;
    }

    for (const key of this.interactKeys) {
      if (this.justPressed(key)) {
        this.driver.noteInput();
        this.aimMode = 'keyboard';
        this.mouseAccum = 0;
        if (this.nightActive) {
          if (!this.uiLive) this.resumeDay();
        } else if (!blocked) {
          this.pressInteract();
        }
      }
    }
    this.releaseInteractIfIdle();

    // With a live UI context, UIScene globally owns Esc/Tab/I/1-9 (and the wheel) —
    // re-dispatching here would double-fire commands (UI apiDrift contract). The
    // world keeps the keys only for AFK bookkeeping and the degraded fallback.
    this.digitKeys.forEach((key, i) => {
      if (this.justPressed(key)) {
        this.driver.noteInput();
        if (this.nightActive) {
          if (!this.uiLive) this.resumeDay();
        } else if (this.sim && !blocked && !this.uiLive) {
          this.sim.dispatch({ type: 'selectSlot', slot: i });
        }
      }
    });

    if (this.menuKey && this.justPressed(this.menuKey)) {
      this.driver.noteInput();
      if (this.nightActive) {
        if (!this.uiLive) this.resumeDay();
      } else if (!blocked && !this.uiLive) {
        this.game.events.emit(WORLD_EVENTS.openMenu);
      }
    }
    for (const key of this.inventoryKeys) {
      if (this.justPressed(key)) {
        this.driver.noteInput();
        if (this.nightActive) {
          if (!this.uiLive) this.resumeDay();
        } else if (!blocked && !this.uiLive) {
          this.game.events.emit(WORLD_EVENTS.openInventory);
        }
      }
    }
  }

  private anyInteractHeld(): boolean {
    return this.interactKeys.some((k) => k.isDown) || this.input.activePointer.leftButtonDown();
  }

  private readonly lastKeyDownTime = new WeakMap<Phaser.Input.Keyboard.Key, number>();

  /**
   * Edge-triggered press check that survives a down+up landing inside one frame.
   * Phaser's `JustDown` is cleared by `Key.onUp` (3.90), so a fast tap whose keydown
   * AND keyup are processed in the same input batch is silently dropped by polling.
   * `Key.timeDown` is stamped on every fresh press (not on auto-repeat), so comparing
   * it to the last observed value detects exactly one edge per physical press.
   */
  private justPressed(key: Phaser.Input.Keyboard.Key): boolean {
    const last = this.lastKeyDownTime.get(key) ?? 0;
    if (key.timeDown > last) {
      this.lastKeyDownTime.set(key, key.timeDown);
      return true;
    }
    return false;
  }

  /** Modal pause sources block world input (GDD §6.5; afk/hidden/blur do not). */
  private isModalBlocked(): boolean {
    return (
      this.driver.has('menu') ||
      this.driver.has('dialog') ||
      this.driver.has('day_summary') ||
      this.driver.has('boot_gate')
    );
  }

  // ---- aiming & actions ---------------------------------------------------

  private hoverTile(pointer?: Phaser.Input.Pointer): TilePos | null {
    const p = pointer ?? this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(p.x, p.y);
    const tx = Math.floor(world.x / TILE);
    const ty = Math.floor(world.y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.mapMeta.width || ty >= this.mapMeta.height) return null;
    return { x: tx, y: ty };
  }

  private selectedItemId(): ItemId | null {
    if (!this.sim) return null;
    const inv = this.sim.state.inventory;
    return (inv.slots[inv.selected]?.itemId as ItemId | undefined) ?? null;
  }

  private safeQuery(tile: TilePos, itemId: ItemId | null): ActionQuery {
    if (!this.sim || this.queryBroken) return { valid: false, verb: 'none' };
    try {
      return this.sim.queryAction(tile, itemId);
    } catch (err) {
      this.queryBroken = true; // sim skeleton not implemented yet — stop hammering it
      console.warn('[world] queryAction unavailable:', err);
      return { valid: false, verb: 'none' };
    }
  }

  /** Cursor/keyboard validity: fixed interactables and live pickups also count.
   *  null itemId = bare hand — the sim still answers (mature-crop harvest, §3.5). */
  private isActionableTile(tile: TilePos, itemId: ItemId | null): boolean {
    const key = `${tile.x},${tile.y}`;
    if (this.interactableByTile.has(key)) return true;
    const spotId = this.pickupSpotByTile.get(key);
    if (spotId !== undefined && this.isPickupAvailable(spotId)) return true;
    // M3 §8.1: a clearable tree/boulder with the matching tool selected is an E-target.
    if (this.clearableNodeAt(tile)) return true;
    // M3 built facilities are E-targets (coop egg spot / processing slots / bench).
    if (this.sim) {
      const structure = structureAt(this.sim.state, tile);
      if (
        structure &&
        structure.state === 'built' &&
        this.isInteractiveStructure(structure.defId)
      ) {
        return true;
      }
    }
    if (this.safeQuery(tile, itemId).valid) return true;
    // Copper/gold can: a tap waters the whole tier range, so the target counts as
    // actionable when ANY tile in its range is waterable (wet center, dry extension).
    return (
      itemId === 'watering_can' &&
      this.sim !== null &&
      this.sim.state.tools.wateringCan >= 2 &&
      this.waterRangeTiles(tile).length > 0
    );
  }

  private isPickupAvailable(spotId: string): boolean {
    return this.sim?.state.pickups.some((p) => p.spotId === spotId && p.available) ?? false;
  }

  /**
   * M3 §8.1 clearable node at `tile`: present in the map, not already cleared, and the
   * matching tool (axe for trees, pickaxe for boulders) is the selected hotbar item. The
   * sim re-validates (MISSING_TOOL / ALREADY_CLEARED / INVENTORY_FULL) on dispatch; this
   * UI gate only decides cursor/E targeting so an empty swing is never the response.
   */
  private clearableNodeAt(tile: TilePos): { id: string; kind: 'tree' | 'boulder' } | null {
    const node = this.resourceNodeByTile.get(`${tile.x},${tile.y}`);
    if (!node || !this.sim) return null;
    if (this.sim.state.clearedResourceNodes?.includes(node.id)) return null;
    const tool: ItemId = node.kind === 'tree' ? 'axe' : 'pickaxe';
    return this.selectedItemId() === tool ? node : null;
  }

  /** Built structures with an E-interaction (everything else is pure scenery). */
  private isInteractiveStructure(defId: string): boolean {
    return (
      defId === 'coop' ||
      defId === 'workshop' ||
      defId === 'drying_rack' ||
      defId === 'bench' ||
      defId === 'storage_chest' ||
      defId === 'greenhouse'
    );
  }

  /**
   * Mature-crop pick that cannot fit a single product unit: the whole pick is blocked
   * up-front (crop stays mature, regrow harvest not consumed — GDD §3.9 #1, US43).
   * This is the UI-side check the sim's harvest no-op defers to (farming.applyAction).
   */
  private harvestBlockedByFullPack(tile: TilePos): boolean {
    if (!this.sim) return false;
    const t = this.sim.state.farm.tiles[`${tile.x},${tile.y}`];
    const crop = t?.crop ?? null;
    if (!crop || !crop.mature || crop.withered || isOldVine(crop)) return false;
    return !canAdd(this.sim.state.inventory, cropItemId(crop.cropId), 1);
  }

  private resolveTarget(): { tile: TilePos | null; tooFar: boolean } {
    const itemId = this.selectedItemId();
    return resolveTargetTile({
      playerTile: this.player.currentTile,
      facing: this.player.facing,
      aimMode: this.aimMode,
      hoverTile: this.aimMode === 'mouse' ? this.hoverTile() : null,
      isValid: (t) => this.isActionableTile(t, itemId),
    });
  }

  private updateCursor(blocked: boolean): void {
    if (blocked || this.nightActive || this.buildController.isActive()) {
      this.cursor.set('hidden', null); // PLACING: the ghost replaces the tile cursor
      return;
    }
    const target = this.resolveTarget();
    if (target.tile === null) {
      // Mouse beyond the 3×3 reach: cursor hidden; the click handler does the
      // 120ms too-far flash (GDD §1.7).
      this.cursor.set('hidden', null);
      return;
    }
    const itemId = this.selectedItemId();
    // A mature crop with no backpack room shows the gray cursor (§3.9 #1 visibility);
    // clicking it still routes through tryAttempt for the 背包已满 toast.
    const valid =
      this.isActionableTile(target.tile, itemId) && !this.harvestBlockedByFullPack(target.tile);
    this.cursor.set(valid ? 'valid' : 'none', target.tile);
  }

  // ---- copper/gold tool ranges (GDD §3.5 / A-16 / §6.4; M1.5) -------------

  /**
   * One interact press edge (keyboard E / mouse left — identical routing, §1.7).
   * A copper/gold HOE press arms the hold-to-charge instead of firing (A-16: release
   * <400ms = single-tile tap, ≥400ms = previewed batch — 防误锄, the cap counter is
   * monotonic); every other press keeps M1-core fire-now + hold-to-repeat semantics.
   */
  private pressInteract(): void {
    // M3 PLACING (§8.3): E commits at the ghost — keyboard-only flow (US10).
    if (this.buildController.isActive()) {
      this.buildController.commit();
      return;
    }
    if (this.chargeEligible()) {
      this.charge.press(this.time.now);
      return;
    }
    this.repeater.press(this.time.now);
    this.tryAttempt();
  }

  /**
   * The hoe charge only arms when the press would otherwise be a hoe swing: fixed
   * interactables, pickups and the mature-crop harvest keep their immediate press
   * (§3.5 priority table — this also preserves the hold-E harvest sweep of §1.9).
   */
  private chargeEligible(): boolean {
    if (!this.sim) return false;
    if (this.selectedItemId() !== 'hoe' || this.sim.state.tools.hoe < 2) return false;
    const target = this.resolveTarget().tile;
    if (target === null) return false;
    const key = `${target.x},${target.y}`;
    if (this.interactableByTile.has(key)) return false;
    const spotId = this.pickupSpotByTile.get(key);
    if (spotId !== undefined && this.isPickupAvailable(spotId)) return false;
    const q = this.safeQuery(target, 'hoe');
    return !(q.valid && q.verb === 'harvest');
  }

  /** Release edge for both devices; idempotent (also polled once per frame). */
  private releaseInteractIfIdle(): void {
    if (this.anyInteractHeld()) return;
    this.repeater.release();
    if (this.isModalBlocked() || this.nightActive) {
      // Interrupted charge: preview cancelled, nothing executes (GDD §3.9 #4).
      this.charge.cancel();
      return;
    }
    const release = this.charge.release(this.time.now);
    if (release === 'tap') this.tryAttempt();
    else if (release === 'batch') this.executeHoeBatch();
  }

  /**
   * Hoe charge released past 400ms: batch-till the previewed range (A-16). Only the
   * legal subset is dispatched (§3.9 #3) and every tile re-runs the full sim T1
   * validation on dispatch — the tilled cap is re-checked per tile, so filling the
   * cap mid-batch rejects the remaining tiles (§1.4 cap discipline).
   */
  private executeHoeBatch(): void {
    if (!this.sim || this.player.isActing) return;
    const target = this.resolveTarget().tile;
    if (target === null) return;
    const legal = this.hoeRangeTiles(target);
    if (legal.length === 0) {
      // Whole range refused — when the cap is the reason, say so (US36 / A-2).
      if (tillBlockedByCap(this.sim.state, this.mapMeta, target)) this.toastTilledCap();
      return;
    }
    const facing = facingToward(this.player.currentTile, target, this.player.facing);
    this.player.beginActing('till', facing);
    this.upgradeFx.swingAfterimage(this.player.sprite); // batch ⇒ copper/gold (US22)
    this.time.delayedCall(ACTION_TIMING.EFFECT_AT_MS, () => {
      if (!this.sim) return;
      for (const bt of legal) {
        this.sim.dispatch({ type: 'interact', tile: bt, itemId: 'hoe' });
      }
    });
  }

  /** Legal hoe batch subset: till/clear targets only — never a range auto-harvest. */
  private hoeRangeTiles(target: TilePos): TilePos[] {
    if (!this.sim) return [];
    const facing = facingToward(this.player.currentTile, target, this.player.facing);
    const tiles = expandToolRange(target, facing, this.sim.state.tools.hoe, this.mapMeta);
    return tiles.filter((rt) => {
      const q = this.safeQuery(rt, 'hoe');
      return q.valid && q.verb === 'till';
    });
  }

  /** Cap-reached hint (GDD §1.4 「农场 Lv N 后可打理更多田地」; the notifications
   *  model dedupes the hold-repeat spam). Silent at the top bracket (no next level). */
  private toastTilledCap(): void {
    if (!this.sim) return;
    const level = nextCapLevel(effectiveLevel(this.sim.state.progress.xp));
    if (level !== null) this.uiToast(t('toast.tilled_cap', { level }));
  }

  /** Waterable tiles in the can's tier range around `target` (any tier; §3.5). */
  private waterRangeTiles(target: TilePos): TilePos[] {
    if (!this.sim) return [];
    const facing = facingToward(this.player.currentTile, target, this.player.facing);
    const tiles = expandToolRange(target, facing, this.sim.state.tools.wateringCan, this.mapMeta);
    return tiles.filter((rt) => {
      const q = this.safeQuery(rt, 'watering_can');
      return q.valid && q.verb === 'water';
    });
  }

  /**
   * Copper/gold range visuals: the always-on facing range frame while such a tool is
   * selected (§6.4) and the hoe charge ghost preview past 400ms (A-16). Pure render —
   * tiles and validity come from the same expansion the execution paths use.
   */
  private updateRangeOverlays(blocked: boolean): void {
    if (!this.sim || blocked || this.nightActive || this.buildController.isActive()) {
      this.rangePreview.hide();
      return;
    }
    const itemId = this.selectedItemId();
    // Hotbar switch mid-charge: drop the charge silently (防误锄 — nothing fires).
    if (this.charge.isHeld && itemId !== 'hoe') this.charge.cancel();
    const tier = toolTierFor(itemId, this.sim.state.tools);
    const target = this.resolveTarget().tile;
    if (tier < 2 || target === null) {
      this.rangePreview.hide();
      return;
    }
    const facing = facingToward(this.player.currentTile, target, this.player.facing);
    const tiles = expandToolRange(target, facing, tier, this.mapMeta);
    if (itemId === 'hoe' && this.charge.isCharging(this.time.now)) {
      this.rangePreview.showCharge(tiles, this.hoeRangeTiles(target));
    } else {
      this.rangePreview.showFrame(tiles);
    }
  }

  /**
   * Upgrade feedback (§3.5 / PRD 02 US22): no ToolUpgraded SimEvent exists, so the
   * scene edge-detects ToolTiers changes (recorded as apiDrift). The toast names the
   * new range, confirming the 350g/2,650g purchase before the first swing; the hotbar
   * icon swaps to the tier frame on its own (SlotView reads ToolTiers). The in-play
   * visual trio — tier-wide water arc, copper/gold swing afterimage, wet-tint spread —
   * lives in world/upgrade-fx.ts and fires on the action paths (US22 三件套).
   */
  private checkToolUpgrades(): void {
    if (!this.sim || !this.lastToolTiers) return;
    const tools = this.sim.state.tools;
    if (
      tools.hoe === this.lastToolTiers.hoe &&
      tools.wateringCan === this.lastToolTiers.wateringCan
    ) {
      return;
    }
    if (tools.hoe > this.lastToolTiers.hoe) {
      this.uiToast(
        t(tools.hoe >= 3 ? 'toast.tool_upgraded_hoe_gold' : 'toast.tool_upgraded_hoe_copper'),
      );
    }
    if (tools.wateringCan > this.lastToolTiers.wateringCan) {
      this.uiToast(
        t(
          tools.wateringCan >= 3
            ? 'toast.tool_upgraded_can_gold'
            : 'toast.tool_upgraded_can_copper',
        ),
      );
    }
    this.lastToolTiers = { hoe: tools.hoe, wateringCan: tools.wateringCan };
  }

  /**
   * One interaction attempt against the current target tile. Priority (GDD §3.5):
   * fixed interactable > pickup > farming verb via sim. Keyboard E and mouse click
   * both land here with identical routing (GDD §1.7 equivalence).
   */
  private tryAttempt(): void {
    if (this.nightActive) return;
    if (this.player.isActing) {
      this.buffer.offer(this.time.now, this.player.actingEndsAt);
      return;
    }
    const target = this.resolveTarget();
    if (target.tile === null) return;
    const tile = target.tile;
    const key = `${tile.x},${tile.y}`;

    const inter = this.interactableByTile.get(key);
    if (inter) {
      this.handleInteractable(inter, tile);
      return;
    }

    const spotId = this.pickupSpotByTile.get(key);
    if (spotId !== undefined && this.sim && this.isPickupAvailable(spotId)) {
      this.sim.dispatch({ type: 'pickup', spotId });
      this.pickupsView.sync(this.sim.state.pickups);
      return;
    }

    // M3 §8.1 labor path: clear a tree/boulder with the matching tool (5 wood / 3 stone,
    // permanent). The sim returns the right error (MISSING_TOOL/ALREADY_CLEARED/
    // INVENTORY_FULL) and emits ItemPicked (→ item_get SFX) on success; a full-pack
    // attempt is a silent no-op the player retries after making room (zero loss).
    const node = this.clearableNodeAt(tile);
    if (node && this.sim) {
      const facing = facingToward(this.player.currentTile, tile, this.player.facing);
      // Tool swing (generic swing anim + tool lock); 'till' selects the tool timing —
      // beginActing only reads the verb for lock duration, not a per-tool animation.
      this.player.beginActing('till', facing);
      this.time.delayedCall(ACTION_TIMING.EFFECT_AT_MS, () => {
        this.sim?.dispatch({ type: 'clearResourceNode', nodeId: node.id });
      });
      return;
    }

    // M3 built structures (GDD §8.2/§8.3): E routes to the facility interaction —
    // coop (hens/eggs), workshop/rack (processing), bench (sit), etc. Sites and pure
    // scenery fall through to the farming pipeline below.
    if (this.sim) {
      const structure = structureAt(this.sim.state, tile);
      if (
        structure &&
        structure.state === 'built' &&
        this.isInteractiveStructure(structure.defId)
      ) {
        const payload: StructureInteractPayload = {
          instanceId: structure.instanceId,
          defId: structure.defId,
          tile,
        };
        this.game.events.emit(BUILD_EVENTS.structureInteract, payload);
        return;
      }
    }

    const itemId = this.selectedItemId(); // null = bare-hand harvest (§3.5 空手 row)
    if (!this.sim) return;
    const q = this.safeQuery(tile, itemId);
    if (q.valid && q.verb === 'harvest' && this.harvestBlockedByFullPack(tile)) {
      // US43: full backpack blocks the whole pick — single-reason toast, no swing
      // (NotificationsModel dedupes the repeat-hold spam; SfxPlayer dedupes the SFX).
      this.uiToast(t('toast.inventory_full'));
      this.sfx?.play(SFX.uiError);
      return;
    }

    // Watering can, every tier (§3.5/A-16): one swing waters the whole tier range —
    // wet/non-tilled tiles no-op out of the legal subset, never resetting the hold
    // beat (§1.10 #8). The center-tile mature-crop harvest keeps priority above.
    // Tilled cap reached (GDD §1.4, US36 / backlog A-2): the one invalid-till case
    // with a spoken reason — the HUD counter flashes once on its own edge detection.
    if (itemId === 'hoe' && !q.valid && tillBlockedByCap(this.sim.state, this.mapMeta, tile)) {
      this.toastTilledCap();
      return;
    }

    if (itemId === 'watering_can' && (!q.valid || q.verb === 'water')) {
      const wet = this.waterRangeTiles(tile);
      if (wet.length === 0) return; // nothing waterable in range: skip, beat continues
      const facing = facingToward(this.player.currentTile, tile, this.player.facing);
      const tier = this.sim.state.tools.wateringCan;
      this.player.beginActing('water', facing);
      if (tier >= 2) this.upgradeFx.swingAfterimage(this.player.sprite); // US22 残影
      this.time.delayedCall(ACTION_TIMING.EFFECT_AT_MS, () => {
        if (!this.sim) return;
        for (const wt of wet) {
          this.sim.dispatch({ type: 'interact', tile: wt, itemId });
        }
        // US22 visual pair, at the moment the water lands (§3.5 升级视觉反馈):
        // the arc is as wide as the tier range; a range pour floods the wet tint
        // outward from the action center in one short wave.
        this.upgradeFx.waterArc(wet, tier);
        this.upgradeFx.wetSpread(wet, tile);
      });
      return;
    }
    if (!q.valid) {
      // §11.5 / US58: an empty swing — a SWINGABLE tool (hoe/axe/pickaxe) committed onto a
      // no-op target — gets the whiff cue so the action has feedback instead of dead silence.
      // Scoped to real tools (the bare hand harvest-sweep and the watering can's range no-op,
      // handled above, never whiff); the SfxPlayer's 50ms dedupe + pitch jitter keeps a held
      // swing from machine-gunning. Routed through the shared audio shell via sfx-map.
      if (itemId === 'hoe' || itemId === 'axe' || itemId === 'pickaxe') {
        const facing = facingToward(this.player.currentTile, tile, this.player.facing);
        this.player.beginActing('till', facing); // generic tool swing animation + lock
        this.sfx?.play(SFX_M3.whiff);
      }
      return; // invalid target: hold beat keeps running (§1.6)
    }

    const facing = facingToward(this.player.currentTile, tile, this.player.facing);
    this.player.beginActing(q.verb, facing);
    // Copper/gold single swings carry the upgrade echo too (first-swing feedback, US22).
    if (toolTierFor(itemId, this.sim.state.tools) >= 2) {
      this.upgradeFx.swingAfterimage(this.player.sprite);
    }
    // Effect lands 120ms into the swing (ruling A-16).
    this.time.delayedCall(ACTION_TIMING.EFFECT_AT_MS, () => {
      this.sim?.dispatch({ type: 'interact', tile, itemId });
    });
  }

  /** Fixed interactables route to UI events, never into the farming sim (GDD §1.7). */
  private handleInteractable(inter: { id: string; kind: string }, tile: TilePos): void {
    const payload: InteractablePayload = { id: inter.id, kind: inter.kind, tile };
    const hasUiListener = this.game.events.listenerCount(WORLD_EVENTS.interactable) > 0;
    this.game.events.emit(WORLD_EVENTS.interactable, payload);
    // Without the UI confirm dialog (ruling A-20), the door sleeps directly so the
    // day loop stays exercisable end to end. Canonical kind vocabulary (farm.tmj and
    // FALLBACK_MAP_META, enforced by scripts/export-map-meta.mjs): 'door'.
    if (inter.kind === 'door' && !hasUiListener) {
      this.performSleep();
    }
  }

  /**
   * Once-per-night side effects on DayEnded (NightUpdate #11, GDD §10.4 trigger A):
   * pin the §1.3 wake-at-spawn position into the sim, then write the night save.
   * The day stamp stays as a cheap idempotence guard even though events now arrive
   * on a single channel (backlog A-7).
   */
  private handleNightSettlement(): void {
    if (!this.sim) return;
    const day = this.sim.state.time.day; // already advanced to the new morning
    if (day === this.lastNightHandledDay) return;
    this.lastNightHandledDay = day;
    const spawn = this.mapMeta.spawn;
    this.sim.syncPlayer({ tileX: spawn.tile.x, tileY: spawn.tile.y, facing: spawn.facing });
    if (this.saves) void this.saves.saveNow('night');
  }

  // ---- sim events & night flow -------------------------------------------

  /**
   * SINGLE event channel (backlog A-7): the on() subscription is the only path into
   * this handler — dispatch()/advanceMinutes() return values are never re-processed,
   * so every SimEvent lands here exactly once.
   */
  private onSimEvent(ev: SimEvent): void {
    if (!this.sim) return;
    switch (ev.type) {
      case 'tileChanged':
        this.farmland.setTile(ev.tile, ev.state);
        this.crops.setTile(ev.tile, ev.state);
        break;
      case 'TileTilled':
      case 'CropPlanted':
      case 'CropHarvested':
        this.refreshTileFromState(ev.tile);
        break;
      case 'CropWatered':
        for (const t of ev.tiles) this.refreshTileFromState(t);
        break;
      case 'ItemPicked':
        this.pickupsView.sync(this.sim.state.pickups);
        break;
      case 'DayStarted':
        this.refreshAllFromSim(); // visual stages change at 6:00 (GDD §3.7)
        break;
      case 'DayEnded':
        this.pendingSummary = ev.summary;
        this.nightPending = true;
        this.handleNightSettlement();
        break;
      case 'zoneUnlocked':
        // Collision opens immediately; the unlock sparkle is deferred to the morning
        // fade-in (zoneUnlocked is emitted mid-night-settlement, when the screen is
        // fading to black — backlog A-7 second half).
        this.applyZoneUnlock(ev.zoneId, false);
        if (!this.pendingUnlockFx.includes(ev.zoneId)) this.pendingUnlockFx.push(ev.zoneId);
        break;
      // ---- M3 build events (GDD §8; renderer subscribes only, §12) ----
      case 'StructurePlaced':
      case 'StructureRemoved':
      case 'StructureMoved':
      case 'SprinklerPlaced':
        this.structuresView.sync(this.sim.state);
        break;
      case 'ConstructionCompleted': {
        // 竣工日清晨直接落成 + 彩带粒子，无弹窗 (§8.3, PRD 04 US11).
        this.structuresView.sync(this.sim.state);
        const done = this.sim.state.structures?.find((s) => s.instanceId === ev.instanceId);
        if (done) this.structuresView.confetti(done.origin, done.defId);
        break;
      }
      default:
        break; // gold/xp/level/weather events are UI & audio concerns
    }
  }

  private refreshTileFromState(tile: TilePos): void {
    if (!this.sim) return;
    const state = this.sim.state.farm.tiles[`${tile.x},${tile.y}`] ?? null;
    this.farmland.setTile(tile, state);
    this.crops.setTile(tile, state);
  }

  private refreshAllFromSim(): void {
    if (!this.sim) return;
    this.farmland.refreshAll(this.sim.state.farm.tiles);
    this.crops.refreshAll(this.sim.state.farm.tiles);
    this.pickupsView.sync(this.sim.state.pickups);
    this.structuresView.sync(this.sim.state); // M3 structures & sprinklers (§8.4)
  }

  private performSleep(): void {
    if (!this.sim || this.nightActive || this.nightPending) return;
    // Manual sleep (door) is the SAME settlement as 22:00 (ruling A-20).
    this.sim.dispatch({ type: 'sleep' });
    if (this.nightPending) this.beginNight();
  }

  private beginNight(): void {
    if (this.nightActive) return;
    this.nightActive = true;
    this.driver.add('day_summary');
    this.driver.discardAccumulator(); // GDD §2.8
    this.inputStack.clear();
    this.repeater.release();
    this.charge.cancel(); // 22:00 interrupts the hoe charge: cancelled, no batch (§3.9 #4)
    this.buffer.clear();
    this.cursor.set('hidden', null);
    this.rangePreview.hide();
    // 22:00 force-exits PLACING — uncommitted = 未扣费, zero loss (§8.3, PRD 04 US9).
    this.buildController.forceExit();
    this.summaryShownAt = Number.POSITIVE_INFINITY;
    this.cameras.main.fadeOut(this.fadeMs(TIME.NIGHT_FADE_OUT_MS), 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.summaryShownAt = this.time.now;
      if (this.pendingSummary) {
        this.game.events.emit(WORLD_EVENTS.daySummary, { summary: this.pendingSummary });
      }
    });
  }

  private resumeDay(): void {
    if (!this.nightActive) return;
    if (this.time.now - this.summaryShownAt < SUMMARY_GRACE_MS) return; // §6.5 grace
    this.nightActive = false;
    this.nightPending = false;
    this.pendingSummary = null;
    if (this.sim) {
      const p = this.sim.state.player;
      this.player.setTilePosition({ x: p.tileX, y: p.tileY }, p.facing); // wake at spawn
      this.refreshAllFromSim();
    }
    this.cameras.main.fadeIn(this.fadeMs(TIME.NIGHT_FADE_IN_MS), 0, 0, 0);
    this.driver.remove('day_summary');
    // Deferred unlock sparkle: played once, after daybreak, over the visible field
    // (backlog A-7; queue is deduped so the morning replay is idempotent).
    for (const zoneId of this.pendingUnlockFx) {
      const group = this.mapMeta.unlockGroups.find((g) => g.zoneId === zoneId);
      if (group && group.rects.length > 0) this.playUnlockSparkle(group.rects[0]);
    }
    this.pendingUnlockFx = [];
  }

  // ---- zone unlock --------------------------------------------------------

  /**
   * Unlocking only REMOVES collision, never adds (GDD §1.4): clear the fence ring
   * around the zone rects (and anything solid inside) from the collision truth and
   * the buildings layer; optionally play the one-shot focus-area sparkle.
   */
  private applyZoneUnlock(zoneId: string, withFx: boolean): void {
    const group = this.mapMeta.unlockGroups.find((g) => g.zoneId === zoneId);
    if (!group) return;
    const w = this.mapMeta.width;
    for (const rect of group.rects) {
      for (let y = rect.y - 1; y <= rect.y + rect.h; y++) {
        for (let x = rect.x - 1; x <= rect.x + rect.w; x++) {
          if (x < 0 || y < 0 || x >= w || y >= this.mapMeta.height) continue;
          if (this.collisionSolid[y * w + x] === 1) {
            this.collisionSolid[y * w + x] = 0;
            this.buildingsLayer?.removeTileAt(x, y);
            if (this.collisionLayerData) {
              const tile = this.collisionLayerData.data[y]?.[x];
              if (tile) tile.index = -1;
            }
          }
        }
      }
    }
    if (withFx && group.rects.length > 0) {
      this.playUnlockSparkle(group.rects[0]);
    }
  }

  /** One-shot sparkle over the 6–8 tile pre-till focus area only (GDD §1.4). */
  private playUnlockSparkle(rect: { x: number; y: number; w: number; h: number }): void {
    const tiles: TilePos[] = [];
    for (let i = 0; i < Math.min(UNLOCK_FOCUS_TILES, rect.w * rect.h); i++) {
      tiles.push({ x: rect.x + (i % rect.w), y: rect.y + Math.floor(i / rect.w) });
    }
    const emitter = this.add.particles(0, 0, PARTICLE_TEXTURE, {
      lifespan: 600,
      speed: { min: 8, max: 24 },
      alpha: { start: 1, end: 0 },
      tint: PALETTE.goldLight,
      emitting: false,
    });
    emitter.setDepth(95);
    for (const t of tiles) {
      emitter.explode(4, t.x * TILE + TILE / 2, t.y * TILE + TILE / 2);
    }
    this.time.delayedCall(1000, () => emitter.destroy());
  }

  // ---- teardown -----------------------------------------------------------

  private cleanup(): void {
    this.unsubSim?.();
    this.unsubSim = null;
    this.unsubWorldSfx?.();
    this.unsubWorldSfx = null;
    this.sfx?.destroy();
    this.sfx = null;
    this.buildController.destroy();
    this.structuresView.destroy();
    this.saves?.dispose();
    for (const fn of this.windowCleanups) fn();
    this.windowCleanups.length = 0;
    this.game.events.off(WORLD_EVENTS.sleepConfirmed, this.onSleepConfirmed);
    this.game.events.off(WORLD_EVENTS.daySummaryDismissed, this.onSummaryDismissed);
  }
}
