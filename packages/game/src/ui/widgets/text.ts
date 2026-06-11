/**
 * text.ts — pixel text factory (GDD §11.3: Fusion Pixel 12px is the single game font,
 * sizes 12/24 only, line heights 16/28, no anti-aliased system fonts as primary).
 *
 * Integration note: the boot stream must register the Fusion Pixel face under the
 * css family name below (document.fonts.load before BootScene advances). Until it
 * does, the fallback chain renders monospace — layout constants already budget for it.
 */
import type Phaser from 'phaser';

import { FONT_SIZE, LINE_HEIGHT } from '../layout';
import { PALETTE } from '../palette';

/** Agreed family name for the Fusion Pixel @font-face (apiDrift: boot stream). */
export const UI_FONT_FAMILY = '"fusion-pixel-12px-proportional", "Fusion Pixel 12px", monospace';

export interface UiTextOptions {
  size?: 12 | 24;
  color?: string;
  align?: 'left' | 'center' | 'right';
  wrapWidth?: number;
}

export function uiText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  opts: UiTextOptions = {},
): Phaser.GameObjects.Text {
  const size = opts.size ?? FONT_SIZE.body;
  const obj = scene.add.text(x, y, text, {
    fontFamily: UI_FONT_FAMILY,
    fontSize: `${size}px`,
    color: opts.color ?? PALETTE.ui.text,
    align: opts.align ?? 'left',
    resolution: 1, // same integer zoom as the world — no separate hi-res layer (§11.3)
  });
  obj.setLineSpacing((size === FONT_SIZE.body ? LINE_HEIGHT.body : LINE_HEIGHT.title) - size);
  if (opts.wrapWidth !== undefined) obj.setWordWrapWidth(opts.wrapWidth, true);
  return obj;
}
