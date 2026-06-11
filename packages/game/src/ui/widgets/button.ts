/**
 * button.ts — pixel text button (GDD §11.3 rule 5: hover swaps outline to gold.light,
 * pressed shifts content down 1px). Pure Phaser, palette tokens only.
 */
import Phaser from 'phaser';

import { hexToNum, PALETTE } from '../palette';
import { uiText } from './text';

export interface TextButtonOptions {
  width: number;
  height?: number;
  disabled?: boolean;
  onClick: () => void;
}

export class TextButton extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private btnWidth: number;
  private btnHeight: number;
  private disabled: boolean;
  private hovered = false;

  constructor(scene: Phaser.Scene, x: number, y: number, text: string, opts: TextButtonOptions) {
    super(scene, x, y);
    this.btnWidth = opts.width;
    this.btnHeight = opts.height ?? 16;
    this.disabled = opts.disabled ?? false;

    this.bg = scene.add.graphics();
    this.label = uiText(scene, this.btnWidth / 2, 2, text, {
      color: this.disabled ? PALETTE.ui.textDim : PALETTE.ui.text,
    }).setOrigin(0.5, 0);
    // A Zone child avoids the Container hit-area origin gotcha (reliable local rect).
    const zone = scene.add
      .zone(0, 0, this.btnWidth, this.btnHeight)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.add([this.bg, this.label, zone]);
    this.redraw(false);

    zone.on('pointerover', () => {
      this.hovered = true;
      this.redraw(false);
    });
    zone.on('pointerout', () => {
      this.hovered = false;
      this.redraw(false);
    });
    zone.on('pointerdown', () => {
      if (!this.disabled) this.redraw(true);
    });
    zone.on('pointerup', () => {
      this.redraw(false);
      if (!this.disabled) opts.onClick();
    });
    scene.add.existing(this);
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.label.setColor(disabled ? PALETTE.ui.textDim : PALETTE.ui.text);
    this.redraw(false);
    return this;
  }

  setLabel(text: string): this {
    this.label.setText(text);
    return this;
  }

  private redraw(pressed: boolean): void {
    const outline = !this.disabled && this.hovered ? PALETTE.gold.light : PALETTE.ink;
    this.bg.clear();
    this.bg.fillStyle(hexToNum(PALETTE.ui.panelLight), this.disabled ? 0.5 : 1);
    this.bg.fillRect(0, 0, this.btnWidth, this.btnHeight);
    this.bg.lineStyle(1, hexToNum(outline), 1);
    this.bg.strokeRect(0.5, 0.5, this.btnWidth - 1, this.btnHeight - 1);
    this.label.setY(pressed ? 3 : 2); // pressed: content shifts down 1px (§11.3)
  }
}
