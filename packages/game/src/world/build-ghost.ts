/**
 * build-ghost.ts — the PLACING ghost preview (M3, GDD §8.3; PRD 04 US5/US6).
 *
 * Pure render: per-footprint-tile green (placeable) / red (violating) fills that
 * follow the cursor, the door-front reach tile for buildings, sprinkler coverage in
 * pale blue, and a one-line violation readout naming the offended §8.3 rule so the
 * player can fix the spot instead of guessing (US6). No text hangs on valid ghosts.
 */
import Phaser from 'phaser';

import type { CanPlaceResult } from '../sim/building';
import type { BlueprintDef } from '../sim/data/buildings';
import type { TilePos } from '../sim/types';
import { hexToNum, PALETTE as UI_PALETTE } from '../ui/palette';
import { t } from '../ui/strings';
import { PALETTE } from './palette';

const TILE = 16;
const GHOST_DEPTH = 92; // above the tile cursor (90), below entities (100+)
const GREEN = PALETTE.greenLight; // CODE-28 green.light
const RED = hexToNum(UI_PALETTE.red.mid); // CODE-28 red.mid (world token table has no red)

export class BuildGhost {
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private visible = false;

  constructor(private readonly scene: Phaser.Scene) {
    this.g = scene.add.graphics().setDepth(GHOST_DEPTH).setVisible(false);
    this.label = scene.add
      .text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#f4e3c2',
        backgroundColor: '#14100d',
      })
      .setResolution(1)
      .setDepth(GHOST_DEPTH + 1)
      .setVisible(false);
  }

  show(
    def: BlueprintDef,
    origin: TilePos,
    result: CanPlaceResult,
    coverage: readonly TilePos[] = [],
  ): void {
    this.visible = true;
    const g = this.g;
    g.clear().setVisible(true);

    // Sprinkler coverage halo first (pale blue, §3.8 preview).
    for (const tile of coverage) {
      g.fillStyle(PALETTE.waterPale, 0.2);
      g.fillRect(tile.x * TILE, tile.y * TILE, TILE, TILE);
      g.lineStyle(1, PALETTE.waterPale, 0.6);
      g.strokeRect(tile.x * TILE + 0.5, tile.y * TILE + 0.5, TILE - 1, TILE - 1);
    }

    // Per-tile reports: green = clear, red = violating (逐格标红, US5/US6).
    let firstViolation: string | null = null;
    for (const report of result.tiles) {
      const bad = report.violations.length > 0;
      if (bad && firstViolation === null) firstViolation = report.violations[0];
      const color = bad ? RED : GREEN;
      g.fillStyle(color, 0.35);
      g.fillRect(report.tile.x * TILE, report.tile.y * TILE, TILE, TILE);
      g.lineStyle(1, color, 1);
      g.strokeRect(report.tile.x * TILE + 0.5, report.tile.y * TILE + 0.5, TILE - 1, TILE - 1);
    }

    // Whole-footprint frame so the w×h silhouette reads at a glance.
    g.lineStyle(1, result.ok ? GREEN : RED, 1);
    g.strokeRect(
      origin.x * TILE + 0.5,
      origin.y * TILE + 0.5,
      def.size.w * TILE - 1,
      def.size.h * TILE - 1,
    );

    if (firstViolation !== null) {
      this.label
        .setText(t(`build.violation.${firstViolation}`))
        .setPosition(origin.x * TILE, (origin.y + def.size.h) * TILE + 2)
        .setVisible(true);
    } else {
      this.label.setVisible(false);
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.g.clear().setVisible(false);
    this.label.setVisible(false);
  }

  destroy(): void {
    this.g.destroy();
    this.label.destroy();
  }
}
