/**
 * range-preview.ts — copper/gold tool range overlay (GDD §3.5 / §6.4; thin render,
 * no game rules — the scene passes in pre-computed tile lists every frame).
 *
 * Two modes:
 * - frame: the always-on translucent range frame while a copper/gold tool is selected
 *   (§6.4 「面朝方向常显一个半透明范围框」) — faint white outline per tile;
 * - charge: the hoe hold-≥400ms ghost preview (§1.6/A-16) — the LEGAL subset gets a
 *   bright ghost fill (these tiles will be tilled on release), illegal tiles in the
 *   range keep a faint grey outline so the range shape still reads (§3.9 #3 legal
 *   subset semantics made visible before the player commits).
 *
 * Depth 89: just under the tile cursor (90), above farmland (10).
 */
import Phaser from 'phaser';

import type { TilePos } from '../sim/types';
import { CURSOR_COLORS } from './palette';

const TILE = 16;
const PREVIEW_DEPTH = 89;

const FRAME_ALPHA = 0.35;
const CHARGE_FILL_ALPHA = 0.25;
const CHARGE_STROKE_ALPHA = 0.9;
const ILLEGAL_STROKE_ALPHA = 0.25;

export class RangePreview {
  private readonly gfx: Phaser.GameObjects.Graphics;
  /** Redraw key — skips re-stroking identical frames (called every frame). */
  private drawnKey = '';

  constructor(scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setDepth(PREVIEW_DEPTH).setVisible(false);
  }

  /** Always-on translucent range frame (§6.4). */
  showFrame(tiles: TilePos[]): void {
    this.draw(`f:${keyOf(tiles)}`, () => {
      this.gfx.lineStyle(1, CURSOR_COLORS.valid, FRAME_ALPHA);
      for (const t of tiles) this.strokeTile(t);
    });
  }

  /** Hoe charge ghost (§1.6/A-16): bright legal subset + faint full-range outline. */
  showCharge(tiles: TilePos[], legal: TilePos[]): void {
    this.draw(`c:${keyOf(tiles)}|${keyOf(legal)}`, () => {
      const legalKeys = new Set(legal.map((t) => `${t.x},${t.y}`));
      this.gfx.lineStyle(1, CURSOR_COLORS.invalid, ILLEGAL_STROKE_ALPHA);
      for (const t of tiles) {
        if (!legalKeys.has(`${t.x},${t.y}`)) this.strokeTile(t);
      }
      this.gfx.fillStyle(CURSOR_COLORS.valid, CHARGE_FILL_ALPHA);
      this.gfx.lineStyle(1, CURSOR_COLORS.valid, CHARGE_STROKE_ALPHA);
      for (const t of legal) {
        this.gfx.fillRect(t.x * TILE, t.y * TILE, TILE, TILE);
        this.strokeTile(t);
      }
    });
  }

  hide(): void {
    if (this.drawnKey === '') return;
    this.drawnKey = '';
    this.gfx.clear();
    this.gfx.setVisible(false);
  }

  private draw(key: string, paint: () => void): void {
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.gfx.clear();
    this.gfx.setVisible(true);
    paint();
  }

  private strokeTile(t: TilePos): void {
    this.gfx.strokeRect(t.x * TILE + 0.5, t.y * TILE + 0.5, TILE - 1, TILE - 1);
  }
}

function keyOf(tiles: TilePos[]): string {
  return tiles.map((t) => `${t.x},${t.y}`).join(';');
}
