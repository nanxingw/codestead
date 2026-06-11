/**
 * panel.ts — 9-slice pixel panel (GDD §11.3 rule 5: `ui_panel` 24×24 with 8px slices,
 * 1px ink outline, right-down 1px shadow only).
 *
 * Falls back to a Graphics rectangle in the same palette while the ui atlas is not
 * yet loaded (asset stream lands independently) — identical metrics either way.
 */
import Phaser from 'phaser';

import { TEXTURES, UI_FRAMES } from '../../AssetKeys';
import { hexToNum, PALETTE } from '../palette';

type PixelPanel = Phaser.GameObjects.GameObject &
  Phaser.GameObjects.Components.Transform &
  Phaser.GameObjects.Components.Depth;

export function addPanel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
): PixelPanel {
  if (hasFrame(scene, TEXTURES.ui, UI_FRAMES.panel)) {
    return scene.add
      .nineslice(x, y, TEXTURES.ui, UI_FRAMES.panel, width, height, 8, 8, 8, 8)
      .setOrigin(0, 0);
  }
  const g = scene.add.graphics({ x, y });
  // 1px right-down shadow (35% ink), then fill, then 1px ink outline (§11.3).
  g.fillStyle(hexToNum(PALETTE.ink), 0.35);
  g.fillRect(1, 1, width, height);
  g.fillStyle(hexToNum(PALETTE.ui.panel), 1);
  g.fillRect(0, 0, width, height);
  g.lineStyle(1, hexToNum(PALETTE.ink), 1);
  g.strokeRect(0.5, 0.5, width - 1, height - 1);
  return g;
}

/** Inner slot well (`ui_slot` 20×20 when the atlas is loaded; flat fallback). */
export function addSlotBg(scene: Phaser.Scene, x: number, y: number, size: number): PixelPanel {
  if (hasFrame(scene, TEXTURES.ui, UI_FRAMES.slot)) {
    return scene.add
      .image(x, y, TEXTURES.ui, UI_FRAMES.slot)
      .setOrigin(0, 0)
      .setDisplaySize(size, size);
  }
  const g = scene.add.graphics({ x, y });
  g.fillStyle(hexToNum(PALETTE.ui.panelLight), 1);
  g.fillRect(0, 0, size, size);
  g.lineStyle(1, hexToNum(PALETTE.ink), 1);
  g.strokeRect(0.5, 0.5, size - 1, size - 1);
  return g;
}

export function hasFrame(scene: Phaser.Scene, texture: string, frame: string): boolean {
  return scene.textures.exists(texture) && scene.textures.get(texture).has(frame);
}

/** Selection outline (+2px gold.light, GDD §11.3 rule 5) drawn as a Graphics rect. */
export function addSelectionOutline(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size: number,
): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics({ x, y });
  g.lineStyle(2, hexToNum(PALETTE.gold.light), 1);
  g.strokeRect(-1, -1, size + 2, size + 2);
  return g;
}

export type PanelObject = ReturnType<typeof addPanel>;
