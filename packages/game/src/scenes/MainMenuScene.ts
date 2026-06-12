/**
 * MainMenuScene — the §6.7 主菜单, inserted between Preload and World (US84).
 *
 * Five entries:
 *   继续        — save summary from the registry sim + boot bundle; clicking it is the
 *                 §2.4「回到农场」gesture (REGISTRY_KEYS.menuEntry releases boot_gate);
 *   新游戏      — second confirm over the existing save with an export-first entry
 *                 (boot-machine.startNewGame writes the fresh doc immediately, §10.4);
 *   导入存档    — same parse → validate → write → re-run-boot-machine pipeline as the
 *                 PreloadScene recovery import (storage/export-import, US93);
 *   设置        — the in-game SettingsPanel on a minimal menu UiHost (no live clock);
 *   关于与许可  — CREDITS summary + the assets/manifest.json per-file list (red line 5).
 *
 * The scene is re-entered from the pause menu's 回主菜单 (WorldScene injects
 * returnToMainMenu into the UiContext); all per-run state is rebuilt in create().
 */
import Phaser from 'phaser';

import { ASSET_PATHS } from '../AssetKeys';
import { BOOT_BUNDLE_REGISTRY_KEY, type BootBundle } from '../boot/bundle';
import { runBootLoad, startNewGame, type BootDeps, type BootOutcome } from '../boot/boot-machine';
import { detectAppVersion, generateSeed } from '../boot/new-game';
import { GAME_HEIGHT, GAME_WIDTH } from '../scale';
import { effectiveLevel } from '../sim/leveling';
import { createSim, newGameSim, type SimApi } from '../sim/sim';
import { timeView } from '../sim/time';
import type { MapMeta } from '../sim/types';
import { applyImportedSave, downloadSaveDoc, parseImportedSave } from '../storage/export-import';
import { composeSaveDoc, toRestorable, validateSaveDoc } from '../storage/save-codec';
import { IdbSaveStorage } from '../storage/save-storage';
import type { SaveTransfer, UiContext } from '../ui/context';
import { PALETTE } from '../ui/palette';
import type { Panel, UiHost } from '../ui/panels/host';
import { SettingsPanel } from '../ui/panels/settings-panel';
import { SettingsStore } from '../ui/settings-store';
import { t } from '../ui/strings';
import { TextButton } from '../ui/widgets/button';
import { uiText } from '../ui/widgets/text';
import { REGISTRY_KEYS } from '../world/events';
import { FALLBACK_MAP_META } from '../world/map-meta';

const TITLE_Y = 64;
const BUTTON_WIDTH = 176;
const BUTTON_STEP = 24;
const STATUS_Y = GAME_HEIGHT - 24;

/** Shape of assets/manifest.json entries rendered on the about screen (red line 5). */
interface ManifestFile {
  path?: string;
  license?: string;
}

export class MainMenuScene extends Phaser.Scene {
  private settingsStore = new SettingsStore();
  private activePanel: Panel | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;
  private fileInput: HTMLInputElement | null = null;
  private busy = false;
  /** Bumped on every view switch so stale async renders (manifest fetch) drop out. */
  private viewToken = 0;

  constructor() {
    super('MainMenu');
  }

  create(): void {
    this.activePanel = null;
    this.statusText = null;
    this.busy = false;
    this.viewToken += 1;

    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const panel = this.activePanel;
      if (!panel) return;
      if (!panel.handleKey(event) && event.key === 'Escape') this.closePanel();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      // Destroy without re-rendering the menu (the scene is going away).
      this.activePanel?.destroy();
      this.activePanel = null;
      this.fileInput?.remove();
      this.fileInput = null;
    });

    this.showMenu();
  }

  // ---- registry accessors ---------------------------------------------------

  private currentSim(): SimApi | null {
    return (this.registry.get(REGISTRY_KEYS.sim) as SimApi | undefined) ?? null;
  }

  private currentBundle(): BootBundle | undefined {
    return this.registry.get(BOOT_BUNDLE_REGISTRY_KEY) as BootBundle | undefined;
  }

  private mapMeta(): MapMeta {
    return (this.registry.get(REGISTRY_KEYS.mapMeta) as MapMeta | undefined) ?? FALLBACK_MAP_META;
  }

  private bootDeps(): BootDeps {
    const mapMeta = this.mapMeta();
    return {
      storage: this.currentBundle()?.storage ?? new IdbSaveStorage(),
      appVersion: detectAppVersion(),
      createNewGame: () => newGameSim(generateSeed(), mapMeta).serialize(),
    };
  }

  // ---- main view --------------------------------------------------------------

  private showMenu(): void {
    this.viewToken += 1;
    this.clearScreen();
    const sim = this.currentSim();

    uiText(this, GAME_WIDTH / 2, TITLE_Y, 'Codestead', {
      color: PALETTE.gold.light,
      size: 24,
      align: 'center',
    }).setOrigin(0.5, 0);
    uiText(this, GAME_WIDTH / 2, TITLE_Y + 32, `v${detectAppVersion()}`, {
      color: PALETTE.ui.textDim,
      align: 'center',
    }).setOrigin(0.5, 0);

    // 继续 carries the save summary (US84: 带存档摘要).
    uiText(this, GAME_WIDTH / 2, TITLE_Y + 56, this.saveSummary(sim), {
      color: PALETTE.ui.text,
      align: 'center',
    }).setOrigin(0.5, 0);

    const bx = (GAME_WIDTH - BUTTON_WIDTH) / 2;
    let by = TITLE_Y + 80;
    const addButton = (label: string, onClick: () => void, disabled = false): void => {
      new TextButton(this, bx, by, label, { width: BUTTON_WIDTH, onClick, disabled });
      by += BUTTON_STEP;
    };

    addButton(t('mainmenu.continue'), () => this.enterFarm(), sim === null);
    addButton(t('mainmenu.new_game'), () => this.showNewGameConfirm());
    addButton(t('mainmenu.import'), () => this.pickImportFile());
    addButton(t('mainmenu.settings'), () => this.openSettings(), sim === null);
    addButton(t('mainmenu.about'), () => this.showAbout());

    this.statusText = uiText(this, GAME_WIDTH / 2, STATUS_Y, '', {
      color: PALETTE.ui.textDim,
      align: 'center',
    }).setOrigin(0.5, 0);
  }

  private saveSummary(sim: SimApi | null): string {
    if (sim === null) return t('mainmenu.no_save');
    const s = sim.state;
    // Season is a derived view, never stored on TimeState (GDD §2.2).
    return t('mainmenu.summary', {
      day: s.time.day,
      season: t(`season.${timeView(s.time).season}`),
      gold: s.economy.gold,
      level: effectiveLevel(s.progress.xp),
    });
  }

  /** The §2.4「回到农场」gesture: flag the gate release and enter the farm. */
  private enterFarm(): void {
    if (this.currentSim() === null) return;
    this.registry.set(REGISTRY_KEYS.menuEntry, true);
    this.scene.start('World');
  }

  // ---- 新游戏 (second confirm + export-first entry, US84) ----------------------

  private showNewGameConfirm(): void {
    this.viewToken += 1;
    this.clearScreen();
    this.heading(t('mainmenu.new_title'), t('mainmenu.new_body'));
    this.option(192, t('mainmenu.export_current'), () => this.exportCurrentSave());
    this.option(216, t('mainmenu.new_confirm'), () => this.confirmNewGame());
    this.option(240, t('mainmenu.back'), () => this.showMenu());
    this.statusText = uiText(this, GAME_WIDTH / 2, STATUS_Y, '', {
      color: PALETTE.ui.textDim,
      align: 'center',
    }).setOrigin(0.5, 0);
  }

  /** Export the slot as it stands (registry sim + boot-time meta; GDD §10.6). */
  private exportCurrentSave(): void {
    const sim = this.currentSim();
    const bundle = this.currentBundle();
    if (!sim || !bundle) {
      this.setStatus(t('settings.import_failed'));
      return;
    }
    const validated = validateSaveDoc(composeSaveDoc(sim.serialize(), bundle.meta));
    if (!validated.ok) {
      console.warn('[menu] export self-check failed:', validated.issues);
      return;
    }
    downloadSaveDoc(validated.doc);
  }

  private confirmNewGame(): void {
    if (this.busy) return;
    this.busy = true;
    const deps = this.bootDeps();
    startNewGame(deps, Date.now())
      .then((outcome) => {
        this.busy = false;
        if (!this.adoptRunningOutcome(outcome, deps)) {
          this.setStatus(t('mainmenu.new_failed'));
          return;
        }
        this.enterFarm();
      })
      .catch((error: unknown) => {
        this.busy = false;
        console.warn('[menu] new game failed:', error);
        this.setStatus(t('mainmenu.new_failed'));
      });
  }

  /** Seed the registry exactly like PreloadScene.routeOutcome's running branch. */
  private adoptRunningOutcome(outcome: BootOutcome, deps: BootDeps): boolean {
    if (outcome.state !== 'running') return false;
    for (const warning of outcome.warnings) {
      console.warn('[menu] tolerant load (§10.9):', warning);
    }
    // Achievements engine ON for the real game session (GDD §4.6 / B-3: deduction
    // and test entry points stay on the default-off mode).
    const sim = createSim(toRestorable(outcome.doc), this.mapMeta(), { achievements: true });
    this.registry.set(REGISTRY_KEYS.sim, sim);
    // US37 retro seam: a fresh adoption invalidates any boot-time retro pending
    // for the PREVIOUS sim (e.g. v1 slot booted, then 新游戏 before entering);
    // re-arm only when this outcome itself was migrated. The import path re-sets
    // the key from its parse step (applyImport below).
    this.registry.remove(REGISTRY_KEYS.retroFromVersion);
    if (outcome.migratedFromVersion !== undefined) {
      this.registry.set(REGISTRY_KEYS.retroFromVersion, outcome.migratedFromVersion);
    }
    const bundle: BootBundle = {
      storage: deps.storage,
      meta: outcome.doc.meta,
      isNewGame: outcome.isNewGame,
      persisted: outcome.persisted,
    };
    this.registry.set(BOOT_BUNDLE_REGISTRY_KEY, bundle);
    return true;
  }

  // ---- 导入存档 (PreloadScene recovery-import pipeline, US93) -------------------

  /** DOM file input — the GDD-sanctioned exception for import (§10.6). */
  private pickImportFile(): void {
    if (!this.fileInput) {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.accept = 'application/json,.json';
      this.fileInput.style.display = 'none';
      document.body.appendChild(this.fileInput);
      this.fileInput.addEventListener('change', () => {
        const file = this.fileInput?.files?.[0];
        if (file) void this.applyImport(file);
      });
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  /** On ANY failure the existing save stays byte-identical (US93). */
  private async applyImport(file: File): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const parsed = parseImportedSave(await file.text());
      if (!parsed.ok) {
        console.warn(`[menu] import rejected at ${parsed.stage}:`, parsed.issues);
        this.setStatus(t('settings.import_failed'));
        return false;
      }
      const deps = this.bootDeps();
      try {
        await applyImportedSave(deps.storage, parsed.doc);
      } catch (error) {
        console.warn('[menu] import write failed; existing save untouched:', error);
        this.setStatus(t('settings.import_failed'));
        return false;
      }
      // Slot replaced — run the §10.4 machine again so the menu reflects the import.
      // The slot holds the MIGRATED doc ('current' on re-read); US37 retro
      // provenance therefore comes from the parse step, set after adoption.
      const next = await runBootLoad(deps);
      if (!this.adoptRunningOutcome(next, deps)) {
        this.setStatus(t('settings.import_failed'));
        return false;
      }
      if (parsed.migratedFromVersion !== undefined) {
        this.registry.set(REGISTRY_KEYS.retroFromVersion, parsed.migratedFromVersion);
      }
      if (!this.activePanel) this.showMenu(); // refresh the save summary
      this.setStatus(t('settings.import_ok'));
      return true;
    } finally {
      this.busy = false;
    }
  }

  // ---- 设置 (SettingsPanel on a minimal menu host) ------------------------------

  private openSettings(): void {
    const sim = this.currentSim();
    if (!sim || this.activePanel) return;
    const ctx: UiContext = {
      sim,
      // The menu has no running clock — pause sources are accepted and ignored.
      pause: { add: () => undefined, remove: () => undefined },
      saveTransfer: this.menuSaveTransfer(),
    };
    const host: UiHost = {
      scene: this,
      ctx,
      settings: this.settingsStore,
      state: () => sim.state,
      dispatch: () => [], // no live sim commands from the menu
      toast: (key, params) => this.setStatus(t(key, params)),
      closeTop: () => this.closePanel(),
      openChild: () => undefined,
      closeAll: () => this.closePanel(),
      reducedMotion: () => this.settingsStore.reducedMotionActive(),
      playSfx: () => undefined, // audio autoplay may not be unlocked before the farm
    };
    this.activePanel = new SettingsPanel(host);
  }

  private closePanel(): void {
    const panel = this.activePanel;
    if (!panel) return;
    this.activePanel = null;
    panel.destroy();
    this.showMenu(); // re-render: an import inside settings may have swapped the save
  }

  /** Export/import surface for the settings panel while on the menu (GDD §10.6). */
  private menuSaveTransfer(): SaveTransfer {
    return {
      exportSave: () => {
        this.exportCurrentSave();
        return Promise.resolve();
      },
      importSave: async (file: File) => ({ ok: await this.applyImport(file) }),
      // Nothing is live on the menu; only the pause menu uses manualSave.
      manualSave: () => Promise.resolve(false),
      storageStatusText: () => t('settings.storage_ok'),
    };
  }

  // ---- 关于与许可 (CREDITS + manifest list, red line 5) --------------------------

  private showAbout(): void {
    this.viewToken += 1;
    const token = this.viewToken;
    this.clearScreen();
    this.heading(t('about.title'), `${t('about.licenses')}\n${t('about.credits')}`);
    uiText(this, GAME_WIDTH / 2, 188, t('about.manifest_pointer'), {
      color: PALETTE.ui.textDim,
      align: 'center',
    }).setOrigin(0.5, 0);
    const loading = uiText(this, GAME_WIDTH / 2, 212, t('about.manifest_loading'), {
      color: PALETTE.ui.textDim,
      align: 'center',
    }).setOrigin(0.5, 0);
    this.option(STATUS_Y, t('mainmenu.back'), () => this.showMenu());
    void this.renderManifest(token, loading);
  }

  /** Two-column per-file list from assets/manifest.json (same-origin asset fetch). */
  private async renderManifest(token: number, loading: Phaser.GameObjects.Text): Promise<void> {
    let files: ManifestFile[];
    try {
      const res = await fetch(ASSET_PATHS.manifest);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { files?: ManifestFile[] };
      files = Array.isArray(json.files) ? json.files : [];
    } catch (error) {
      console.warn('[menu] manifest unavailable:', error);
      if (token === this.viewToken) loading.setText(t('about.manifest_failed'));
      return;
    }
    if (token !== this.viewToken) return; // user already left the about screen
    loading.destroy();

    const lines = files.map((f) => `${f.path ?? '?'} · ${f.license ?? '?'}`);
    const perColumn = 7;
    const columns: [number, string[]][] = [
      [48, lines.slice(0, perColumn)],
      [344, lines.slice(perColumn, perColumn * 2)],
    ];
    for (const [x, chunk] of columns) {
      if (chunk.length === 0) continue;
      uiText(this, x, 208, chunk.join('\n'), { color: PALETTE.ui.text, wrapWidth: 288 });
    }
    const overflow = lines.length - perColumn * 2;
    if (overflow > 0) {
      uiText(this, GAME_WIDTH / 2, STATUS_Y - 16, t('about.more_files', { n: overflow }), {
        color: PALETTE.ui.textDim,
        align: 'center',
      }).setOrigin(0.5, 0);
    }
  }

  // ---- shared visuals (mirrors the PreloadScene recovery screens) ---------------

  private clearScreen(): void {
    this.children.removeAll(true);
    this.statusText = null;
  }

  private setStatus(text: string): void {
    this.statusText?.setText(text);
  }

  private heading(title: string, body: string): void {
    uiText(this, GAME_WIDTH / 2, 96, title, {
      color: PALETTE.gold.light,
      size: 24,
      align: 'center',
    }).setOrigin(0.5, 0);
    uiText(this, GAME_WIDTH / 2, 132, body, {
      color: PALETTE.ui.text,
      align: 'center',
      wrapWidth: 480,
    }).setOrigin(0.5, 0);
  }

  private option(y: number, label: string, onClick: () => void): void {
    const text = uiText(this, GAME_WIDTH / 2, y, label, {
      color: PALETTE.gold.mid,
      align: 'center',
    }).setOrigin(0.5, 0);
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setColor(PALETTE.gold.light));
    text.on('pointerout', () => text.setColor(PALETTE.gold.mid));
    text.on('pointerdown', onClick);
  }
}
