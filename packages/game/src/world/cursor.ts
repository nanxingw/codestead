/**
 * cursor.ts — the 16×16 tile cursor (GDD §1.7 table, depth 90: above farmland,
 * below entities).
 *
 * | valid   | white frame + 12% white fill, 0.8s alpha breathing 0.7↔1.0 |
 * | none    | grey frame, alpha 0.4                                       |
 * | too far | grey frame single 120ms flash (mouse outside 3×3)           |
 * | hidden  | not rendered (menu / dialog / summary / sleeping)           |
 * No text ever hangs next to the cursor (low cognitive load).
 */
import Phaser from 'phaser';

import type { TilePos } from '../sim/types';
import { CURSOR_COLORS } from './palette';

const TILE = 16;
const CURSOR_DEPTH = 90;
const FLASH_MS = 120;
const BREATH_MS = 400; // half-cycle: 0.8s full breath (GDD §1.7)

export type CursorState = 'valid' | 'none' | 'hidden';

export class TileCursor {
  private readonly box: Phaser.GameObjects.Graphics;
  private readonly flashBox: Phaser.GameObjects.Graphics;
  private state: CursorState = 'hidden';
  private breath: Phaser.Tweens.Tween | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.box = scene.add.graphics().setDepth(CURSOR_DEPTH).setVisible(false);
    this.flashBox = scene.add.graphics().setDepth(CURSOR_DEPTH).setVisible(false);
    this.drawFrame(this.flashBox, CURSOR_COLORS.invalid, 0);
    this.flashBox.setAlpha(0.9);
  }

  /** Per-frame update from the resolved target + queryAction result. */
  set(state: CursorState, tile: TilePos | null): void {
    if (tile === null) state = 'hidden';
    if (state !== this.state) {
      this.state = state;
      this.applyState();
    }
    if (tile !== null && state !== 'hidden') {
      this.box.setPosition(tile.x * TILE, tile.y * TILE);
    }
  }

  /** Single 120ms grey flash at the clicked tile (mouse beyond reach, GDD §1.7). */
  flashTooFar(tile: TilePos): void {
    this.flashBox.setPosition(tile.x * TILE, tile.y * TILE).setVisible(true);
    this.scene.time.delayedCall(FLASH_MS, () => this.flashBox.setVisible(false));
  }

  private applyState(): void {
    this.breath?.remove();
    this.breath = null;
    this.box.clear();
    if (this.state === 'hidden') {
      this.box.setVisible(false);
      return;
    }
    this.box.setVisible(true);
    if (this.state === 'valid') {
      this.drawFrame(this.box, CURSOR_COLORS.valid, 0.12);
      this.box.setAlpha(1);
      this.breath = this.scene.tweens.add({
        targets: this.box,
        alpha: { from: 1, to: 0.7 },
        duration: BREATH_MS,
        yoyo: true,
        repeat: -1,
      });
    } else {
      this.drawFrame(this.box, CURSOR_COLORS.invalid, 0);
      this.box.setAlpha(0.4);
    }
  }

  private drawFrame(g: Phaser.GameObjects.Graphics, color: number, fillAlpha: number): void {
    g.clear();
    if (fillAlpha > 0) {
      g.fillStyle(color, fillAlpha);
      g.fillRect(0, 0, TILE, TILE);
    }
    g.lineStyle(1, color, 1);
    g.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  }
}
