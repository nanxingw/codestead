import Phaser from 'phaser';

/**
 * BootScene — first scene in the chain Boot → Preload → World (+UI overlay).
 *
 * M1 responsibilities:
 * - register the Fusion Pixel faces (latin + zh_hans woff2 subsets, OFL) under the
 *   css family name agreed with the UI layer (ui/widgets/text.ts UI_FONT_FAMILY) and
 *   wait for them before continuing (GDD §11.3) — with a timeout so a missing font
 *   degrades to the monospace fallback instead of dead-ending the boot;
 * - settings are read synchronously from localStorage by the UI layer's
 *   SettingsStore on first use (GDD §10.1) — nothing to do here;
 * - the §10.4 save-loading state machine runs in PreloadScene (it needs farm.tmj
 *   for MapMeta before a sim can be built); the 'boot_gate' pause source until the
 *   first user gesture is owned by WorldScene's driver.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    void this.boot();
  }

  private async boot(): Promise<void> {
    await loadPixelFont();
    this.scene.start('Preload');
  }
}

/** Family name must match ui/widgets/text.ts UI_FONT_FAMILY (apiDrift contract). */
const FONT_FAMILY = 'fusion-pixel-12px-proportional';
const FONT_DIR = 'assets/fonts/fusion-pixel-12px';
/**
 * zh_hans first (no unicode-range: covers the full table), latin added after with an
 * explicit range so ASCII/Latin glyphs resolve to the latin subset (later face wins
 * for overlapping ranges in the font-matching cascade).
 */
const FONT_SOURCES: { file: string; unicodeRange?: string }[] = [
  { file: 'fusion-pixel-12px-proportional-zh_hans.otf.woff2' },
  { file: 'fusion-pixel-12px-proportional-latin.otf.woff2', unicodeRange: 'U+0000-024F' },
];
/** Never block boot on a font: past this we continue on the monospace fallback. */
const FONT_TIMEOUT_MS = 3_000;

async function loadPixelFont(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  try {
    const loadAll = Promise.allSettled(
      FONT_SOURCES.map(async ({ file, unicodeRange }) => {
        const face = new FontFace(
          FONT_FAMILY,
          `url(${FONT_DIR}/${file}) format('woff2')`,
          unicodeRange !== undefined ? { unicodeRange } : undefined,
        );
        await face.load();
        document.fonts.add(face);
      }),
    );
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, FONT_TIMEOUT_MS);
    });
    await Promise.race([loadAll, timeout]);
  } catch (error) {
    console.warn('[boot] pixel font unavailable — monospace fallback in effect:', error);
  }
}
