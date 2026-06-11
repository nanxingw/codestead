/**
 * crops-view.ts — crop sprites on the entities layer (GDD §1.5 #5, y-sorted).
 *
 * Frame contract (GDD §3.7/§11.4, AssetKeys): freshly planted shows the shared
 * `crop_common_seeded` mound; growing crops bucket into `crop_{id}_s{0..2}` via
 * sim/farming.visualStage; regrow crops use `crop_{id}_picked` while regrowing and
 * `crop_{id}_old_vine` when their harvest count is exhausted. Mature crops get a 1px
 * pale outline (WebGL glow FX; no-op on canvas). Stage changes land at 6:00 — the
 * scene calls refreshAll on DayStarted.
 */
import Phaser from 'phaser';

import { visualStage } from '../sim/farming';
import type { CropState, TilePos, TileState } from '../sim/types';
import { getCropDef } from '../sim/data/crops';
import {
  CROP_COMMON_SEEDED,
  cropOldVineFrame,
  cropPickedFrame,
  cropStageFrame,
  TEXTURES,
} from '../AssetKeys';
import { PALETTE } from './palette';
import { setSafeFrame } from './textures';

const TILE = 16;

function frameForCrop(crop: CropState): string {
  if (crop.harvestsLeft === 0) return cropOldVineFrame(crop.cropId); // old vine (§3.2)
  if (crop.mature) return cropStageFrame(crop.cropId, 2);
  if (crop.regrowDaysLeft !== null) return cropPickedFrame(crop.cropId); // regrowing
  if (crop.daysGrown <= 0) return CROP_COMMON_SEEDED;
  let stage: 0 | 1 | 2;
  try {
    stage = visualStage(crop.daysGrown, getCropDef(crop.cropId).growthDays);
  } catch {
    stage = 0; // sim stream not landed yet (skeleton throws) — show seedling
  }
  return cropStageFrame(crop.cropId, stage);
}

export class CropsView {
  private readonly sprites = new Map<string, Phaser.GameObjects.Image>();

  constructor(private readonly scene: Phaser.Scene) {}

  setTile(tile: TilePos, state: Pick<TileState, 'crop'> | null): void {
    const key = `${tile.x},${tile.y}`;
    const crop = state?.crop ?? null;
    const existing = this.sprites.get(key);
    if (crop === null) {
      existing?.destroy();
      this.sprites.delete(key);
      return;
    }
    const footY = tile.y * TILE + TILE;
    const img =
      existing ??
      this.scene.add
        .image(tile.x * TILE + TILE / 2, footY, '__DEFAULT')
        .setOrigin(0.5, 1)
        .setDepth(100 + footY); // entities y-sort (GDD §1.5)
    setSafeFrame(img, TEXTURES.crops, frameForCrop(crop));
    this.applyMatureOutline(img, crop.mature);
    this.sprites.set(key, img);
  }

  refreshAll(tiles: Readonly<Record<string, Pick<TileState, 'crop'>>>): void {
    for (const [key, img] of this.sprites) {
      if (!(key in tiles)) {
        img.destroy();
        this.sprites.delete(key);
      }
    }
    for (const [key, state] of Object.entries(tiles)) {
      const [xs, ys] = key.split(',');
      this.setTile({ x: Number(xs), y: Number(ys) }, state);
    }
  }

  /** 1px pale outline on mature crops (GDD §3.7) — WebGL only, canvas degrades. */
  private applyMatureOutline(img: Phaser.GameObjects.Image, mature: boolean): void {
    if (!img.postFX) return; // canvas renderer
    img.postFX.clear();
    if (mature) {
      img.postFX.addGlow(PALETTE.goldLight, 1, 0, false);
    }
  }
}
