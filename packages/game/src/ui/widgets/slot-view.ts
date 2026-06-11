/**
 * slot-view.ts — one 20×20 item slot (hotbar / inventory / bin lists; GDD §6.2, §11.3).
 *
 * Icons come from the `items` atlas via ItemDef.iconFrame (tools swap tier frames from
 * ToolTiers, GDD §6.1). While the atlas is not loaded yet a 1-character glyph fallback
 * keeps every screen testable.
 */
import Phaser from 'phaser';

import { TEXTURES, toolFrame } from '../../AssetKeys';
import { getItemDef } from '../../sim/data/items';
import type { ItemStack, ToolTiers } from '../../sim/types';
import { SLOT_SIZE } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { addSlotBg, hasFrame } from './panel';
import { uiText } from './text';

export class SlotView extends Phaser.GameObjects.Container {
  private icon: Phaser.GameObjects.Image | null = null;
  private glyph: Phaser.GameObjects.Text;
  private countText: Phaser.GameObjects.Text;
  private selection: Phaser.GameObjects.Graphics;
  private lockIcon: Phaser.GameObjects.Text;
  readonly zone: Phaser.GameObjects.Zone;
  private currentFrame = '';

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    const bg = addSlotBg(scene, 0, 0, SLOT_SIZE);
    this.selection = scene.add.graphics();
    this.selection.lineStyle(2, hexToNum(PALETTE.gold.light), 1);
    this.selection.strokeRect(-1, -1, SLOT_SIZE + 2, SLOT_SIZE + 2);
    this.selection.setVisible(false);
    this.glyph = uiText(scene, SLOT_SIZE / 2, 4, '', { color: PALETTE.sand }).setOrigin(0.5, 0);
    this.countText = uiText(scene, SLOT_SIZE - 1, SLOT_SIZE - 13, '', {
      color: PALETTE.gold.light,
    }).setOrigin(1, 0);
    this.lockIcon = uiText(scene, SLOT_SIZE / 2, 4, '', { color: PALETTE.ui.textDim }).setOrigin(
      0.5,
      0,
    );
    this.zone = scene.add
      .zone(0, 0, SLOT_SIZE, SLOT_SIZE)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.add([bg, this.selection, this.glyph, this.countText, this.lockIcon, this.zone]);
    scene.add.existing(this);
  }

  setStack(stack: ItemStack | null, tools?: ToolTiers): this {
    if (!stack) {
      this.clearIcon();
      this.glyph.setText('');
      this.countText.setText('');
      return this;
    }
    const def = getItemDef(stack.itemId);
    let frame = def.iconFrame;
    if (tools && stack.itemId === 'hoe') frame = toolFrame('hoe', tools.hoe);
    if (tools && stack.itemId === 'watering_can') frame = toolFrame('can', tools.wateringCan);
    if (hasFrame(this.scene, TEXTURES.items, frame)) {
      this.showIcon(frame);
      this.glyph.setText('');
    } else {
      this.clearIcon();
      // Fallback glyph until the items atlas lands: first CJK char of the name key id.
      this.glyph.setText(glyphFor(def.category));
    }
    this.countText.setText(stack.count > 1 ? String(stack.count) : '');
    return this;
  }

  setSelected(selected: boolean): this {
    this.selection.setVisible(selected);
    this.setY(this.y); // y handled by owner (lift 2px on select per §6.2)
    return this;
  }

  /** Locked reserve placeholder (GDD §6.2 row-2 lock slots). */
  setLocked(locked: boolean): this {
    this.lockIcon.setText(locked ? '🔒' : '');
    if (locked) {
      this.clearIcon();
      this.glyph.setText('');
      this.countText.setText('');
    }
    return this;
  }

  /** Brief head-shake for rejected actions (e.g. discarding a tool, GDD §6.3). */
  shake(): void {
    const baseX = this.x;
    this.scene.tweens.add({
      targets: this,
      x: { from: baseX - 1, to: baseX + 1 },
      duration: 40,
      yoyo: true,
      repeat: 2,
      onComplete: () => this.setX(baseX),
    });
  }

  private showIcon(frame: string): void {
    if (this.icon && this.currentFrame === frame) return;
    this.clearIcon();
    this.icon = this.scene.add
      .image(SLOT_SIZE / 2, SLOT_SIZE / 2, TEXTURES.items, frame)
      .setOrigin(0.5);
    this.addAt(this.icon, 2);
    this.currentFrame = frame;
  }

  private clearIcon(): void {
    this.icon?.destroy();
    this.icon = null;
    this.currentFrame = '';
  }
}

/** Shared icon-fallback glyph (also used by the harvest fly-to-slot fx, feedback-view). */
export function glyphFor(category: string): string {
  switch (category) {
    case 'tool':
      return '⚒';
    case 'seed':
      return '·';
    case 'crop':
      return '✿';
    case 'material':
      return '▣';
    default:
      return '?';
  }
}
