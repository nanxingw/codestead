/**
 * slot-view.ts — one 20×20 item slot (hotbar / inventory / bin lists; GDD §6.2, §11.3).
 *
 * Icons come from the `items` atlas via ItemDef.iconFrame (tools swap tier frames from
 * ToolTiers, GDD §6.1). While the atlas is not loaded yet a 1-character glyph fallback
 * keeps every screen testable.
 */
import type { Quality } from '@codestead/shared';
import Phaser from 'phaser';

import { TEXTURES, toolFrame } from '../../AssetKeys';
import { getItemDef } from '../../sim/data/items';
import type { ItemStack, ToolTiers } from '../../sim/types';
import { SLOT_SIZE } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { qualityOf } from '../quality-view';
import { addSlotBg, hasFrame } from './panel';
import { uiText } from './text';

export class SlotView extends Phaser.GameObjects.Container {
  private icon: Phaser.GameObjects.Image | null = null;
  private glyph: Phaser.GameObjects.Text;
  private countText: Phaser.GameObjects.Text;
  private selection: Phaser.GameObjects.Graphics;
  private lockIcon: Phaser.GameObjects.Text;
  /** Tool tier corner badge (copper/gold; GDD §3.5 升级视觉反馈, M1.5). */
  private tierBadge: Phaser.GameObjects.Graphics;
  /** M3 quality corner badge — DOUBLE coded: shape + colour (GDD §4.5; PRD 04 US45). */
  private qualityBadge: Phaser.GameObjects.Graphics;
  private badgeQuality: Quality = 'normal';
  /** Lazy drop-target hover ring (M1.5 drag, GDD §6.7). */
  private highlightRing: Phaser.GameObjects.Graphics | null = null;
  readonly zone: Phaser.GameObjects.Zone;
  private currentFrame = '';
  private badgeTier: 1 | 2 | 3 = 1;

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
    this.tierBadge = scene.add.graphics();
    this.qualityBadge = scene.add.graphics();
    this.zone = scene.add
      .zone(0, 0, SLOT_SIZE, SLOT_SIZE)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.add([
      bg,
      this.selection,
      this.glyph,
      this.countText,
      this.lockIcon,
      this.tierBadge,
      this.qualityBadge,
      this.zone,
    ]);
    scene.add.existing(this);
  }

  setStack(stack: ItemStack | null, tools?: ToolTiers): this {
    this.setQualityBadge(qualityOf(stack));
    if (!stack) {
      this.clearIcon();
      this.glyph.setText('');
      this.countText.setText('');
      this.setTierBadge(1);
      return this;
    }
    const def = getItemDef(stack.itemId);
    let frame = def.iconFrame;
    let tier: 1 | 2 | 3 = 1;
    if (tools && stack.itemId === 'hoe') {
      frame = toolFrame('hoe', tools.hoe);
      tier = tools.hoe;
    }
    if (tools && stack.itemId === 'watering_can') {
      frame = toolFrame('can', tools.wateringCan);
      tier = tools.wateringCan;
    }
    this.setTierBadge(tier);
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

  /** 4px bottom-left corner badge: copper = amber, gold = gold.light; tier 1 = none. */
  private setTierBadge(tier: 1 | 2 | 3): void {
    if (tier === this.badgeTier) return;
    this.badgeTier = tier;
    this.tierBadge.clear();
    if (tier < 2) return;
    const color = hexToNum(tier === 2 ? PALETTE.amber : PALETTE.gold.light);
    this.tierBadge.fillStyle(hexToNum(PALETTE.ink), 1);
    this.tierBadge.fillRect(0, SLOT_SIZE - 6, 6, 6);
    this.tierBadge.fillStyle(color, 1);
    this.tierBadge.fillRect(1, SLOT_SIZE - 5, 4, 4);
  }

  /**
   * 6px bottom-right quality badge (M3, GDD §4.5; PRD 04 US45). Double-encoded by
   * contract: silver = DIAMOND in the dim-grey token, gold = PLUS/star in gold.light —
   * distinct shapes keep the grades apart in grayscale (§10.8). Normal draws nothing.
   */
  private setQualityBadge(quality: Quality): void {
    if (quality === this.badgeQuality) return;
    this.badgeQuality = quality;
    const g = this.qualityBadge;
    g.clear();
    if (quality === 'normal') return;
    const cx = SLOT_SIZE - 4;
    const cy = SLOT_SIZE - 4;
    g.fillStyle(hexToNum(PALETTE.ink), 1);
    g.fillRect(cx - 4, cy - 4, 8, 8);
    if (quality === 'silver') {
      g.fillStyle(hexToNum(PALETTE.ui.textDim), 1);
      g.fillPoints(
        [
          { x: cx, y: cy - 3 },
          { x: cx + 3, y: cy },
          { x: cx, y: cy + 3 },
          { x: cx - 3, y: cy },
        ],
        true,
      );
    } else {
      g.fillStyle(hexToNum(PALETTE.gold.light), 1);
      g.fillRect(cx - 1, cy - 3, 2, 7); // vertical bar
      g.fillRect(cx - 3, cy - 1, 7, 2); // horizontal bar → plus/star shape
    }
  }

  setSelected(selected: boolean): this {
    this.selection.setVisible(selected);
    this.setY(this.y); // y handled by owner (lift 2px on select per §6.2)
    return this;
  }

  /** Drop-target hover highlight while dragging (M1.5, GDD §6.7 悬停高亮). */
  setHighlight(on: boolean): this {
    if (on && this.highlightRing === null) {
      this.highlightRing = this.scene.add.graphics();
      this.highlightRing.lineStyle(1, hexToNum(PALETTE.sand), 1);
      this.highlightRing.strokeRect(0.5, 0.5, SLOT_SIZE - 1, SLOT_SIZE - 1);
      this.addAt(this.highlightRing, 1);
    }
    this.highlightRing?.setVisible(on);
    return this;
  }

  /** Locked reserve placeholder (GDD §6.2 row-2 lock slots). */
  setLocked(locked: boolean): this {
    this.lockIcon.setText(locked ? '🔒' : '');
    if (locked) {
      this.clearIcon();
      this.glyph.setText('');
      this.countText.setText('');
      this.setTierBadge(1);
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
