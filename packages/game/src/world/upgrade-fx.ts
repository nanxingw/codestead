/**
 * upgrade-fx.ts — tool-upgrade visual feedback (GDD §3.5 「升级视觉反馈」; PRD 02
 * US22, implementation decision 8): the three "肉眼可辨" effects that make the first
 * swing after a 350g/2,650g purchase confirm itself:
 *
 *   1. waterArc — watering splash whose width follows the tier range (wood: a single
 *      tile splash / copper: a 3-tile line / gold: a 3×3 shower) with denser, arcing
 *      droplets on copper/gold (更宽水弧);
 *   2. swingAfterimage — copper/gold swings leave a fading gold-tinted echo of the
 *      player sprite (挥动残影; skipped under reducedMotion, §10.8 spirit);
 *   3. wetSpread — a range watering floods the wet tint outward from the action
 *      center in one short staggered tween (湿土瞬间扩散; skipped under
 *      reducedMotion — the farmland tiles flip to the wet variant instantly anyway).
 *
 * License red line (§11.1 / PRD 02 Further Notes): everything here is drawn with the
 * program-generated PARTICLE_TEXTURE / plain rectangles — zero new asset files.
 * Pure render layer: WorldScene passes pre-computed tile lists; no game rules live
 * here and no unit tests are owed (tech-stack §1) — coverage is the PRD's manual
 * acceptance checklist (testing decision 11; walkthrough record pending, backlog D-2).
 */
import Phaser from 'phaser';

import type { TilePos } from '../sim/types';
import { PALETTE } from './palette';
import { PARTICLE_TEXTURE } from './textures';

const TILE = 16;
/** GDD §1.5 fx layer depth. */
const FX_DEPTH = 1100;
/** Wet-spread overlay sits just above the farmland layer (10). */
const SPREAD_DEPTH = 11;
const SPREAD_WAVE_MS_PER_TILE = 45;

export class UpgradeFx {
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly reducedMotion: () => boolean,
  ) {}

  /**
   * Watering splash over the watered tiles. The width IS the tier range (the caller
   * passes the same legal subset it dispatches); droplet density also steps up per
   * tier so copper/gold read wider AND fuller from the very first pour.
   */
  waterArc(tiles: TilePos[], tier: 1 | 2 | 3): void {
    if (tiles.length === 0) return;
    const perTile = this.reducedMotion() ? 2 : tier >= 3 ? 6 : tier === 2 ? 5 : 3;
    const emitter = this.scene.add.particles(0, 0, PARTICLE_TEXTURE, {
      lifespan: { min: 220, max: 380 },
      speedY: { min: -46, max: -18 }, // launched upward; gravity arcs the fall
      speedX: { min: -24, max: 24 },
      gravityY: 260,
      alpha: { start: 0.9, end: 0 },
      scale: { start: 1, end: 0.4 },
      tint: [PALETTE.waterLight, PALETTE.waterPale],
      emitting: false,
    });
    emitter.setDepth(FX_DEPTH);
    for (const t of tiles) {
      emitter.explode(perTile, t.x * TILE + TILE / 2, t.y * TILE + TILE / 2 - 2);
    }
    this.scene.time.delayedCall(600, () => emitter.destroy());
  }

  /** Copper/gold swing echo: one fading copy of the player sprite (挥动残影). */
  swingAfterimage(sprite: Phaser.GameObjects.Sprite): void {
    if (this.reducedMotion()) return; // §10.8: motion garnish is skippable by contract
    const ghost = this.scene.add
      .image(sprite.x, sprite.y, sprite.texture.key, sprite.frame.name)
      .setOrigin(sprite.originX, sprite.originY)
      .setAlpha(0.45)
      .setTint(PALETTE.goldLight)
      .setDepth(sprite.depth - 1);
    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      duration: 220,
      onComplete: () => ghost.destroy(),
    });
  }

  /**
   * Range watering: the wet tint visibly floods outward from the action center,
   * staggered by Chebyshev distance — one short wave, then gone (湿土瞬间扩散).
   */
  wetSpread(tiles: TilePos[], center: TilePos): void {
    if (tiles.length < 2 || this.reducedMotion()) return;
    for (const t of tiles) {
      const dist = Math.max(Math.abs(t.x - center.x), Math.abs(t.y - center.y));
      const rect = this.scene.add
        .rectangle(t.x * TILE + TILE / 2, t.y * TILE + TILE / 2, TILE, TILE)
        .setFillStyle(PALETTE.waterLight, 1)
        .setAlpha(0)
        .setScale(0.25)
        .setDepth(SPREAD_DEPTH);
      this.scene.tweens.add({
        targets: rect,
        alpha: { from: 0.5, to: 0 },
        scaleX: 1,
        scaleY: 1,
        delay: dist * SPREAD_WAVE_MS_PER_TILE,
        duration: 240,
        onComplete: () => rect.destroy(),
      });
    }
  }
}
