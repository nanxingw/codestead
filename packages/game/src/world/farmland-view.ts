/**
 * farmland-view.ts — the runtime `farmland` layer (GDD §1.5 layer #2, depth 10):
 * tilled / watered overlay tiles, generated at runtime (never part of farm.tmj).
 *
 * Wet soil uses a DARK VARIANT TILE, not an alpha overlay (GDD §1.5). M1 ships the
 * generated CODE-28 soil textures from textures.ts; when the art stream tags real
 * dry/wet variants in the terrain tileset this view is the single swap point.
 */
import Phaser from 'phaser';

import type { TilePos, TileState } from '../sim/types';
import { FARMLAND_DRY_TEXTURE, FARMLAND_WET_TEXTURE } from './textures';

const TILE = 16;
const FARMLAND_DEPTH = 10;

export class FarmlandView {
  private readonly images = new Map<string, Phaser.GameObjects.Image>();

  constructor(private readonly scene: Phaser.Scene) {}

  /** Apply a single tile state (null = not tilled → remove). */
  setTile(tile: TilePos, state: Pick<TileState, 'wateredToday'> | null): void {
    const key = `${tile.x},${tile.y}`;
    const existing = this.images.get(key);
    if (state === null) {
      existing?.destroy();
      this.images.delete(key);
      return;
    }
    const texture = state.wateredToday ? FARMLAND_WET_TEXTURE : FARMLAND_DRY_TEXTURE;
    if (existing) {
      existing.setTexture(texture);
      return;
    }
    const img = this.scene.add
      .image(tile.x * TILE, tile.y * TILE, texture)
      .setOrigin(0, 0)
      .setDepth(FARMLAND_DEPTH);
    this.images.set(key, img);
  }

  /** Full refresh from the sparse sim table (create / DayStarted). */
  refreshAll(tiles: Readonly<Record<string, Pick<TileState, 'wateredToday'>>>): void {
    for (const [key, img] of this.images) {
      if (!(key in tiles)) {
        img.destroy();
        this.images.delete(key);
      }
    }
    for (const [key, state] of Object.entries(tiles)) {
      const [xs, ys] = key.split(',');
      this.setTile({ x: Number(xs), y: Number(ys) }, state);
    }
  }
}
