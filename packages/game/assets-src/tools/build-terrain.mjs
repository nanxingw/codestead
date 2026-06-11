/**
 * Builds assets/tilesets/terrain.png from the Kenney Roguelike/RPG spritesheet
 * plus a few self-drawn tiles (tilled soil, well, collision marker).
 *
 * Layout: margin 1 / spacing 2 with 1px extrude (GDD §1.1 / §11.4 bleed guard).
 * Vendor sheet is NOT committed; set VENDOR_DIR (default /tmp/kenney) to the
 * directory holding the unzipped packs (see assets-src/recipes.json5).
 *
 * Usage: node assets-src/tools/build-terrain.mjs
 */
/* global console, process */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Canvas, canvasFromPng } from './png.mjs';
import { PAL } from './palette.mjs';
import { TILES, TILESET_COLUMNS } from './terrain-def.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(here, '..', '..');
const VENDOR = process.env.VENDOR_DIR ?? '/tmp/kenney';
const SHEET = join(VENDOR, 'roguelike-rpg-pack/Spritesheet/roguelikeSheet_transparent.png');
const PITCH = 17; // 16px tiles + 1px spacing in the Kenney sheet

// ---- self-drawn 16×16 tiles (CODE-28 palette) ----

function drawTile(painter) {
  const c = new Canvas(16, 16);
  painter(c);
  return c;
}

function tilledBase(c, soil, furrow) {
  c.fillRect(0, 0, 16, 16, soil);
  // rounded ink-ish corners to read as a worked plot
  for (const [x, y] of [
    [0, 0],
    [15, 0],
    [0, 15],
    [15, 15],
  ])
    c.set(x, y, furrow);
  // three horizontal furrows
  for (const fy of [3, 8, 13]) {
    for (let x = 1; x < 15; x++) c.set(x, fy, furrow);
  }
  // light speckles between furrows (deterministic)
  for (let i = 0; i < 10; i++) {
    const x = ((i * 7 + 3) % 14) + 1;
    const y = [1, 5, 6, 10, 11][i % 5];
    c.set(x, y, i % 2 ? furrow : soil);
  }
}

const SELF_TILES = {
  tilled_dry: drawTile((c) => tilledBase(c, PAL.soilMid, PAL.soilDark)),
  tilled_wet: drawTile((c) => tilledBase(c, PAL.soilDark, PAL.ink)),
  well_nw: drawTile((c) => wellQuad(c, 0, 0)),
  well_ne: drawTile((c) => wellQuad(c, 1, 0)),
  well_sw: drawTile((c) => wellQuad(c, 0, 1)),
  well_se: drawTile((c) => wellQuad(c, 1, 1)),
  collision: drawTile((c) => {
    // visible only in Tiled (layer is invisible at runtime): magenta cross
    c.fillRect(0, 0, 16, 16, [255, 0, 255, 96]);
    for (let i = 0; i < 16; i++) {
      c.set(i, i, [255, 0, 255, 255]);
      c.set(i, 15 - i, [255, 0, 255, 255]);
    }
  }),
};

/** One quadrant of a 2×2 stone well: gray ring, dark water, wooden crossbar. */
function wellQuad(c, qx, qy) {
  const stoneL = PAL.uiTextDim;
  const stoneD = [120, 126, 133, 255];
  // draw the full 32×32 well into a quadrant-offset, clipped by the 16×16 canvas
  const ox = -qx * 16;
  const oy = -qy * 16;
  const set = (x, y, col) => c.set(x + ox, y + oy, col);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 13.5 && d > 9.5) set(x, y, (x + y) % 5 < 2 ? stoneD : stoneL);
      else if (d <= 9.5) set(x, y, d <= 8 ? PAL.waterDeep : PAL.waterMid);
      if (d > 13.5 && d <= 14.5) set(x, y, PAL.ink);
    }
  }
  // wooden crossbar + post
  for (let x = 2; x < 30; x++) set(x, 15, PAL.woodMid);
  for (let x = 2; x < 30; x++) set(x, 16, PAL.soilLight);
  for (let y = 4; y < 28; y++) set(15, y, PAL.woodLight);
}

// ---- compose tileset ----

const sheet = canvasFromPng(readFileSync(SHEET));
const cols = TILESET_COLUMNS;
const rows = Math.ceil(TILES.length / cols);
const MARGIN = 1;
const SPACING = 2;
const out = new Canvas(
  2 * MARGIN + cols * 16 + (cols - 1) * SPACING,
  2 * MARGIN + rows * 16 + (rows - 1) * SPACING,
);

TILES.forEach((tile, i) => {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const dx = MARGIN + col * (16 + SPACING);
  const dy = MARGIN + row * (16 + SPACING);
  let src;
  let sx = 0;
  let sy = 0;
  if (tile.src === 'self') {
    src = SELF_TILES[tile.name];
    if (!src) throw new Error(`missing self-drawn tile: ${tile.name}`);
  } else {
    src = sheet;
    sx = tile.src[0] * PITCH;
    sy = tile.src[1] * PITCH;
  }
  out.blit(src, sx, sy, 16, 16, dx, dy, false);
  // 1px extrude: duplicate edge pixels into the surrounding gutter
  for (let x = 0; x < 16; x++) {
    out.set(dx + x, dy - 1, src.get(sx + x, sy));
    out.set(dx + x, dy + 16, src.get(sx + x, sy + 15));
  }
  for (let y = 0; y < 16; y++) {
    out.set(dx - 1, dy + y, src.get(sx, sy + y));
    out.set(dx + 16, dy + y, src.get(sx + 15, sy + y));
  }
  out.set(dx - 1, dy - 1, src.get(sx, sy));
  out.set(dx + 16, dy - 1, src.get(sx + 15, sy));
  out.set(dx - 1, dy + 16, src.get(sx, sy + 15));
  out.set(dx + 16, dy + 16, src.get(sx + 15, sy + 15));
});

const dest = join(gameRoot, 'assets/tilesets/terrain.png');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, out.toPng());
console.log(
  `terrain.png: ${out.width}×${out.height}, ${TILES.length} tiles (${cols}×${rows}) -> ${dest}`,
);
