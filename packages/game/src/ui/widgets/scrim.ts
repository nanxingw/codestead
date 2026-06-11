/**
 * scrim.ts — modal dim layer composed AROUND the M2 session-HUD reserve.
 *
 * Ruling A-9 / GDD §6.9 acceptance: the rect (4,4)–(156,150) must have ZERO pixels
 * drawn by M1 UI — including modal scrims. The dim is therefore four rectangles
 * tiling the screen minus the reserve (visually a full-screen dim with a quiet
 * window where the session HUD will live from M2 on).
 */
import type Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../scale';
import { HUD_RESERVED } from '../layout';
import { hexToNum, PALETTE } from '../palette';

export function addScrim(scene: Phaser.Scene, alpha = 0.55): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  g.fillStyle(hexToNum(PALETTE.ink), alpha);
  const r = HUD_RESERVED;
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  g.fillRect(0, 0, GAME_WIDTH, r.y); // top band
  g.fillRect(0, bottom, GAME_WIDTH, GAME_HEIGHT - bottom); // bottom band
  g.fillRect(0, r.y, r.x, r.height); // left sliver
  g.fillRect(right, r.y, GAME_WIDTH - right, r.height); // right band
  return g;
}
