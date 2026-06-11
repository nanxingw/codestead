/**
 * pickups-view.ts — daily forage spots (GDD §1.3: 6 fallen logs + 4 stones on the
 * tree-wall edge, 3 wildflowers; refreshed every night by NightUpdate #6).
 *
 * Render-only: one image per map pickup spot, shown while the sim says the spot is
 * still available today. Picking dispatches `{type:'pickup', spotId}` (scene side);
 * this view just mirrors `sim.state.pickups`.
 */
import Phaser from 'phaser';

import type { MapMeta, PickupState } from '../sim/types';
import { PICKUP_FRAMES, TEXTURES } from '../AssetKeys';
import { setSafeFrame } from './textures';

const TILE = 16;

export class PickupsView {
  private readonly sprites = new Map<string, Phaser.GameObjects.Image>();

  constructor(
    private readonly scene: Phaser.Scene,
    spots: MapMeta['pickupSpots'],
  ) {
    for (const spot of spots) {
      const footY = spot.tile.y * TILE + TILE;
      const img = scene.add
        .image(spot.tile.x * TILE + TILE / 2, footY, '__DEFAULT')
        .setOrigin(0.5, 1)
        .setDepth(100 + footY) // entities y-sort (GDD §1.5)
        .setVisible(false);
      setSafeFrame(img, TEXTURES.items, PICKUP_FRAMES[spot.kind]);
      this.sprites.set(spot.id, img);
    }
  }

  /** Mirror availability from sim state (after pickup dispatch / DayStarted). */
  sync(pickups: readonly PickupState[]): void {
    const available = new Set(pickups.filter((p) => p.available).map((p) => p.spotId));
    for (const [spotId, img] of this.sprites) {
      img.setVisible(available.has(spotId));
    }
  }
}
