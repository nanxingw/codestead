/**
 * PreloadScene — loads every asset declared in AssetKeys.ts, then runs the §10.4
 * save-loading state machine and hands off to the main menu (US84).
 *
 * Loading contract (GDD §11.7 / AssetKeys): terrain tileset, farm.tmj, the four
 * atlases (crops/items/ui/characters) and the 8 M1 SFX (.ogg only). Paths are the
 * ASSET_PATHS strings relative to packages/game/ — Vite's dev server serves the
 * package root, so they resolve as-is in dev; production builds copy assets/ and
 * maps/ into dist/ (vite.config.ts copyGameData plugin).
 *
 * Boot machine (GDD §10.4, M1 cut): the slot is read AFTER the map loads because
 * MapMeta (derived from farm.tmj) is required to build a sim. Outcomes:
 *   running  → pre-seed registry with SimApi + MapMeta + BootBundle, start MainMenu
 *              (its 继续/「回到农场」click is the §2.4 boot-gate gesture);
 *   recovery → low-pressure two-option screen [导入 JSON] [开新农场], slot untouched;
 *   too_new  → read-only screen, raw JSON export only (never writes the slot).
 *
 * Parallel-workstream tolerance: missing files only log warnings; generated fallback
 * textures guarantee WorldScene always boots. Budget gate: first load ≤8MB, cold
 * start interactive ≤3s (GDD §11.7, CI-checked via asset budgets, not here).
 */
import Phaser from 'phaser';

import { ASSET_PATHS, AUDIO_PATHS, MAPS, SFX, TEXTURES } from '../AssetKeys';
import { BOOT_BUNDLE_REGISTRY_KEY, type BootBundle } from '../boot/bundle';
import { runBootLoad, startNewGame, type BootDeps, type BootOutcome } from '../boot/boot-machine';
import { detectAppVersion, generateSeed } from '../boot/new-game';
import { GAME_WIDTH } from '../scale';
import { createSim, newGameSim } from '../sim/sim';
import type { MapMeta } from '../sim/types';
import { applyImportedSave, parseImportedSave } from '../storage/export-import';
import { toRestorable } from '../storage/save-codec';
import { IdbSaveStorage } from '../storage/save-storage';
import { PALETTE as UI_PALETTE } from '../ui/palette';
import { t } from '../ui/strings';
import { uiText } from '../ui/widgets/text';
import { REGISTRY_KEYS } from '../world/events';
import { buildMapMeta, FALLBACK_MAP_META, type TiledMapData } from '../world/map-meta';
import { PALETTE } from '../world/palette';
import { ensureGeneratedTextures } from '../world/textures';

// Progress bar geometry — multiples of 4 per the pixel UI hard rules (GDD §11.3).
const BAR_X = 220;
const BAR_Y = 176;
const BAR_W = 200;
const BAR_H = 8;

export class PreloadScene extends Phaser.Scene {
  private statusText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('Preload');
  }

  preload(): void {
    ensureGeneratedTextures(this);
    this.buildProgressBar();

    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.warn(`[preload] missing asset: ${file.key} (${file.url as string})`);
    });

    this.load.image(TEXTURES.terrain, ASSET_PATHS.tilesetTerrain);
    this.load.tilemapTiledJSON(MAPS.farm, ASSET_PATHS.mapFarm);
    this.load.atlas(TEXTURES.crops, ASSET_PATHS.atlasCropsPng, ASSET_PATHS.atlasCropsJson);
    this.load.atlas(TEXTURES.items, ASSET_PATHS.atlasItemsPng, ASSET_PATHS.atlasItemsJson);
    this.load.atlas(TEXTURES.ui, ASSET_PATHS.atlasUiPng, ASSET_PATHS.atlasUiJson);
    this.load.atlas(
      TEXTURES.characters,
      ASSET_PATHS.atlasCharactersPng,
      ASSET_PATHS.atlasCharactersJson,
    );
    for (const key of Object.values(SFX)) {
      this.load.audio(key, [AUDIO_PATHS[key]]);
    }
  }

  create(): void {
    void this.bootstrap();
  }

  // ---- §10.4 boot machine orchestration -----------------------------------

  private async bootstrap(): Promise<void> {
    const mapMeta = this.resolveMapMeta();
    this.registry.set(REGISTRY_KEYS.mapMeta, mapMeta);

    const deps: BootDeps = {
      storage: new IdbSaveStorage(),
      appVersion: detectAppVersion(),
      createNewGame: () => newGameSim(generateSeed(), mapMeta).serialize(),
    };

    let outcome: BootOutcome;
    try {
      outcome = await runBootLoad(deps);
    } catch (error) {
      // IDB completely unavailable: degrade to an unsaved session (WorldScene falls
      // back to newGameSim) instead of dead-ending the boot.
      console.warn('[boot] load machine failed — starting an unsaved session:', error);
      this.scene.start('World');
      return;
    }
    this.routeOutcome(outcome, deps, mapMeta);
  }

  private routeOutcome(outcome: BootOutcome, deps: BootDeps, mapMeta: MapMeta): void {
    switch (outcome.state) {
      case 'running': {
        for (const warning of outcome.warnings) {
          console.warn('[boot] tolerant load (§10.9):', warning);
        }
        const sim = createSim(toRestorable(outcome.doc), mapMeta);
        this.registry.set(REGISTRY_KEYS.sim, sim);
        const bundle: BootBundle = {
          storage: deps.storage,
          meta: outcome.doc.meta,
          isNewGame: outcome.isNewGame,
          persisted: outcome.persisted,
        };
        this.registry.set(BOOT_BUNDLE_REGISTRY_KEY, bundle);
        this.scene.start('MainMenu');
        return;
      }
      case 'recovery':
        this.showRecovery(outcome, deps, mapMeta);
        return;
      case 'too_new':
        this.showTooNew(outcome);
        return;
    }
  }

  private resolveMapMeta(): MapMeta {
    const pre = this.registry.get(REGISTRY_KEYS.mapMeta) as MapMeta | undefined;
    if (pre) return pre;
    const cacheEntry = this.cache.tilemap.get(MAPS.farm) as { data?: TiledMapData } | undefined;
    if (cacheEntry?.data) return buildMapMeta(cacheEntry.data);
    console.warn('[boot] maps/farm.tmj missing — FALLBACK_MAP_META in effect');
    return FALLBACK_MAP_META;
  }

  // ---- recovery / too-new screens (GDD §10.4, M1 minimal) ------------------

  private showRecovery(
    outcome: Extract<BootOutcome, { state: 'recovery' }>,
    deps: BootDeps,
    mapMeta: MapMeta,
  ): void {
    console.warn(`[boot] save recovery (${outcome.reason}):`, outcome.issues);
    this.clearScreen();
    this.heading(t('boot.recovery_title'), t('boot.recovery_body'));
    this.option(196, t('boot.recovery_import'), () => this.pickRecoveryImport(deps, mapMeta));
    this.option(216, t('boot.recovery_new'), () => {
      void startNewGame(deps, Date.now()).then((next) => this.routeOutcome(next, deps, mapMeta));
    });
    this.statusText = uiText(this, GAME_WIDTH / 2, 244, '', {
      color: UI_PALETTE.red.mid,
      align: 'center',
    }).setOrigin(0.5, 0);
  }

  private showTooNew(outcome: Extract<BootOutcome, { state: 'too_new' }>): void {
    this.clearScreen();
    this.heading(
      t('boot.too_new_title'),
      t('boot.too_new_body', { version: outcome.foundVersion }),
    );
    this.option(216, t('boot.too_new_export'), () => {
      downloadRawJson(outcome.raw, `codestead-save-v${outcome.foundVersion}-export.json`);
    });
  }

  /** DOM file input — the GDD-sanctioned exception for import (§10.6). */
  private pickRecoveryImport(deps: BootDeps, mapMeta: MapMeta): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void this.applyRecoveryImport(file, deps, mapMeta);
    });
    input.click();
  }

  private async applyRecoveryImport(file: File, deps: BootDeps, mapMeta: MapMeta): Promise<void> {
    const parsed = parseImportedSave(await file.text());
    if (!parsed.ok) {
      console.warn(`[boot] recovery import rejected at ${parsed.stage}:`, parsed.issues);
      this.statusText?.setText(t('settings.import_failed'));
      return;
    }
    try {
      await applyImportedSave(deps.storage, parsed.doc);
    } catch (error) {
      console.warn('[boot] recovery import write failed:', error);
      this.statusText?.setText(t('settings.import_failed'));
      return;
    }
    // Slot now holds a valid doc — run the machine again and enter the game.
    const next = await runBootLoad(deps);
    this.routeOutcome(next, deps, mapMeta);
  }

  // ---- visuals --------------------------------------------------------------

  private clearScreen(): void {
    this.children.removeAll(true);
    this.statusText = null;
  }

  private heading(title: string, body: string): void {
    uiText(this, GAME_WIDTH / 2, 120, title, {
      color: UI_PALETTE.gold.light,
      size: 24,
      align: 'center',
    }).setOrigin(0.5, 0);
    uiText(this, GAME_WIDTH / 2, 152, body, {
      color: UI_PALETTE.ui.text,
      align: 'center',
      wrapWidth: 480,
    }).setOrigin(0.5, 0);
  }

  private option(y: number, label: string, onClick: () => void): void {
    const text = uiText(this, GAME_WIDTH / 2, y, label, {
      color: UI_PALETTE.gold.mid,
      align: 'center',
    }).setOrigin(0.5, 0);
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setColor(UI_PALETTE.gold.light));
    text.on('pointerout', () => text.setColor(UI_PALETTE.gold.mid));
    text.on('pointerdown', onClick);
  }

  private buildProgressBar(): void {
    const track = this.add.rectangle(BAR_X, BAR_Y, BAR_W, BAR_H, PALETTE.uiPanelLight);
    track.setOrigin(0, 0);
    track.setStrokeStyle(1, PALETTE.ink);
    const fill = this.add.rectangle(BAR_X, BAR_Y, 0, BAR_H, PALETTE.goldMid).setOrigin(0, 0);
    this.load.on(Phaser.Loader.Events.PROGRESS, (value: number) => {
      fill.width = Math.round((BAR_W * value) / 4) * 4; // 4px steps, no AA creep
    });
    this.add
      .text(GAME_WIDTH / 2, BAR_Y - 16, 'Codestead', {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#f4e3c2', // ui.text token (PALETTE.uiText) — Phaser text style wants a string
      })
      .setOrigin(0.5, 1);
  }
}

/** Raw export for the TOO_NEW screen — the doc cannot pass this build's schema. */
function downloadRawJson(raw: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
