/**
 * textures.ts — generated fallback textures + safe frame helpers.
 *
 * Parallel-workstream safety net: the art/map stream delivers the real atlases
 * (AssetKeys contract); until every file exists this module guarantees the world
 * still boots by synthesizing 16×16 placeholder textures, and `setSafeFrame`
 * guards every frame lookup so a missing frame can never crash a scene.
 * All placeholder colors come from the CODE-28 palette module.
 */
import Phaser from 'phaser';

import { PALETTE } from './palette';

/** Generic "missing frame" placeholder key. */
export const PLACEHOLDER_TEXTURE = 'gen_placeholder';
/** Runtime farmland variant tiles (dark variant for wet soil — no alpha, GDD §1.5). */
export const FARMLAND_DRY_TEXTURE = 'gen_farmland_dry';
export const FARMLAND_WET_TEXTURE = 'gen_farmland_wet';
/** 2×2 white square for particles (unlock sparkle, rain fallback). */
export const PARTICLE_TEXTURE = 'gen_particle';
/** Fallback ground tile + player marker for map-less dev boots. */
export const FALLBACK_GROUND_TEXTURE = 'gen_ground';
export const FALLBACK_PLAYER_TEXTURE = 'gen_player';

function fillTexture(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): void {
  if (scene.textures.exists(key)) return;
  const canvas = scene.textures.createCanvas(key, w, h);
  if (!canvas) return;
  draw(canvas.context);
  canvas.refresh();
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Create every generated texture (idempotent). Call from PreloadScene. */
export function ensureGeneratedTextures(scene: Phaser.Scene): void {
  fillTexture(scene, PLACEHOLDER_TEXTURE, 16, 16, (ctx) => {
    ctx.fillStyle = cssColor(PALETTE.uiPanelLight);
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = cssColor(PALETTE.uiTextDim);
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    ctx.strokeStyle = cssColor(PALETTE.ink);
    ctx.strokeRect(0.5, 0.5, 15, 15);
  });
  const soil = (key: string, fill: number) =>
    fillTexture(scene, key, 16, 16, (ctx) => {
      ctx.fillStyle = cssColor(fill);
      ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = cssColor(PALETTE.ink);
      // sparse furrow specks so dry/wet read as soil, not flat color
      ctx.globalAlpha = 0.25;
      for (let i = 0; i < 4; i++) ctx.fillRect(2 + i * 4, 5 + (i % 2) * 6, 2, 1);
      ctx.globalAlpha = 1;
    });
  soil(FARMLAND_DRY_TEXTURE, PALETTE.soilMid);
  soil(FARMLAND_WET_TEXTURE, PALETTE.soilDark);
  fillTexture(scene, PARTICLE_TEXTURE, 2, 2, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2, 2);
  });
  fillTexture(scene, FALLBACK_GROUND_TEXTURE, 16, 16, (ctx) => {
    ctx.fillStyle = cssColor(PALETTE.greenMid);
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = cssColor(PALETTE.greenLight);
    ctx.fillRect(3, 4, 1, 2);
    ctx.fillRect(11, 9, 1, 2);
  });
  fillTexture(scene, FALLBACK_PLAYER_TEXTURE, 16, 16, (ctx) => {
    ctx.fillStyle = cssColor(PALETTE.uiText);
    ctx.fillRect(4, 2, 8, 12);
    ctx.strokeStyle = cssColor(PALETTE.ink);
    ctx.strokeRect(4.5, 2.5, 7, 11);
  });
}

/** Does `frame` exist on texture `key`? */
export function hasFrame(scene: Phaser.Scene, key: string, frame: string): boolean {
  return scene.textures.exists(key) && scene.textures.get(key).has(frame);
}

/** Set texture+frame, falling back to the placeholder when the frame is missing. */
export function setSafeFrame(
  img: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
  key: string,
  frame: string,
): void {
  if (hasFrame(img.scene, key, frame)) {
    img.setTexture(key, frame);
  } else {
    img.setTexture(PLACEHOLDER_TEXTURE);
  }
}
