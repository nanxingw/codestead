/**
 * Builds the four atlases (crops / items / ui / characters) into
 * assets/atlases/*.{png,json} (Phaser JSONHash format).
 *
 * All frames here are self-drawn procedural pixel art (CC0-1.0, CODE-28
 * palette, 1px ink outline — GDD §11.2/§11.4 S5 “自绘缺口”), except
 * item_wood / item_stone / item_wildflower which are lifted from the Kenney
 * Roguelike/RPG pack (CC0-1.0). Frame keys follow game/src/AssetKeys.ts.
 *
 * Usage: node assets-src/tools/build-atlases.mjs   (VENDOR_DIR=/tmp/kenney)
 */
/* global console, process */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Canvas, canvasFromPng } from './png.mjs';
import { PAL } from './palette.mjs';
import { sprite, mirrorH, outline, packAtlas, atlasJson } from './sprite.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(here, '..', '..');
const VENDOR = process.env.VENDOR_DIR ?? '/tmp/kenney';
const PITCH = 17;

// ---------------------------------------------------------------------------
// crop table (ids + art recipe). Ids MUST equal sim/data/crops.ts CropDef.id.
// ---------------------------------------------------------------------------

const CROPS = [
  { id: 'radish_quick', kind: 'bulb', fruit: PAL.redMid, shade: PAL.redDark, leaf: PAL.greenLight },
  { id: 'turnip', kind: 'bulb', fruit: PAL.uiText, shade: PAL.sand, leaf: PAL.greenPale },
  { id: 'potato', kind: 'bush_root', fruit: PAL.sand, shade: PAL.soilLight, leaf: PAL.greenMid },
  {
    id: 'bean_vine',
    kind: 'vine',
    fruit: PAL.greenPale,
    shade: PAL.greenLight,
    leaf: PAL.greenDark,
    regrow: true,
  },
  { id: 'cabbage', kind: 'head', fruit: PAL.greenPale, shade: PAL.greenLight, leaf: PAL.greenMid },
  {
    id: 'berry',
    kind: 'berry_bush',
    fruit: PAL.berry,
    shade: PAL.redDark,
    leaf: PAL.greenDark,
    regrow: true,
  },
  { id: 'chili', kind: 'fruit_bush', fruit: PAL.redDark, shade: PAL.redMid, leaf: PAL.greenMid },
  {
    id: 'sunflower',
    kind: 'tall_flower',
    fruit: PAL.goldMid,
    shade: PAL.goldDeep,
    leaf: PAL.greenMid,
  },
  {
    id: 'tomato',
    kind: 'fruit_bush',
    fruit: PAL.redMid,
    shade: PAL.redDark,
    leaf: PAL.greenMid,
    regrow: true,
  },
  { id: 'corn', kind: 'tall', fruit: PAL.goldLight, shade: PAL.goldMid, leaf: PAL.greenLight },
  {
    id: 'melon',
    kind: 'ground_fruit',
    fruit: PAL.greenMid,
    shade: PAL.greenDark,
    leaf: PAL.greenMid,
  },
  { id: 'wheat', kind: 'tall_grain', fruit: PAL.goldDeep, shade: PAL.goldMid, leaf: PAL.greenPale },
  {
    id: 'eggplant',
    kind: 'fruit_bush',
    fruit: PAL.purpleMid,
    shade: PAL.purpleLight,
    leaf: PAL.greenMid,
    regrow: true,
  },
  {
    id: 'cranberry',
    kind: 'berry_bush',
    fruit: PAL.berry,
    shade: PAL.redDark,
    leaf: PAL.greenMid,
    regrow: true,
  },
  {
    id: 'pumpkin',
    kind: 'ground_fruit',
    fruit: PAL.amber,
    shade: PAL.goldDeep,
    leaf: PAL.greenDark,
  },
];

// ---------------------------------------------------------------------------
// drawing primitives
// ---------------------------------------------------------------------------

function disc(c, cx, cy, r, color) {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r + r * 0.5) c.set(cx + x, cy + y, color);
}

function ellipse(c, cx, cy, rx, ry, color) {
  for (let y = -ry; y <= ry; y++)
    for (let x = -rx; x <= rx; x++)
      if ((x * x) / (rx * rx + 0.4) + (y * y) / (ry * ry + 0.4) <= 1) c.set(cx + x, cy + y, color);
}

function leafPair(c, cx, y, leaf) {
  c.set(cx - 2, y, leaf);
  c.set(cx - 1, y - 1, leaf);
  c.set(cx + 1, y - 1, leaf);
  c.set(cx + 2, y, leaf);
  c.set(cx, y, leaf);
}

// ---------------------------------------------------------------------------
// crop stage painters — 16×16, ground line at y=14 (1px margin below)
// ---------------------------------------------------------------------------

const GROUND = 14;

function paintSprout(c, leaf) {
  c.set(8, GROUND, PAL.greenDark);
  c.set(8, GROUND - 1, PAL.greenDark);
  leafPair(c, 8, GROUND - 2, leaf);
}

const KIND_PAINTERS = {
  bulb: {
    s1(c, { leaf }) {
      c.set(8, GROUND, PAL.greenDark);
      leafPair(c, 8, GROUND - 1, leaf);
      leafPair(c, 8, GROUND - 3, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      ellipse(c, 8, GROUND - 1, 3, 2, fruit);
      c.set(7, GROUND - 1, shade);
      c.set(9, GROUND - 2, shade);
      leafPair(c, 6, GROUND - 4, leaf);
      leafPair(c, 10, GROUND - 4, leaf);
      c.set(8, GROUND - 3, PAL.greenDark);
      c.set(8, GROUND - 4, PAL.greenDark);
      leafPair(c, 8, GROUND - 5, leaf);
    },
  },
  head: {
    s1(c, { leaf, fruit }) {
      ellipse(c, 8, GROUND - 1, 3, 2, leaf);
      c.set(8, GROUND - 2, fruit);
    },
    s2(c, { leaf, fruit, shade }) {
      ellipse(c, 8, GROUND - 2, 5, 3, leaf);
      disc(c, 8, GROUND - 3, 3, fruit);
      ellipse(c, 8, GROUND - 4, 2, 1, shade);
    },
  },
  bush_root: {
    s1(c, { leaf }) {
      ellipse(c, 8, GROUND - 1, 3, 2, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      ellipse(c, 8, GROUND - 3, 4, 3, leaf);
      ellipse(c, 8, GROUND - 5, 2, 1, PAL.greenPale);
      ellipse(c, 4, GROUND, 1, 1, fruit);
      ellipse(c, 12, GROUND, 1, 1, fruit);
      c.set(4, GROUND, shade);
      c.set(12, GROUND, shade);
    },
  },
  vine: {
    pole(c) {
      for (let y = GROUND - 11; y <= GROUND; y++) c.set(8, y, PAL.woodMid);
      c.set(8, GROUND - 11, PAL.woodLight);
    },
    s1(c, { leaf }) {
      this.pole(c);
      for (let i = 0; i < 4; i++) c.set(8 + (i % 2 ? 1 : -1), GROUND - 1 - i, leaf);
      leafPair(c, 8, GROUND - 5, leaf);
    },
    s2(c, { leaf, fruit }) {
      this.pole(c);
      for (let i = 0; i < 10; i++) c.set(8 + (i % 2 ? 1 : -1), GROUND - 1 - i, leaf);
      leafPair(c, 7, GROUND - 9, leaf);
      leafPair(c, 9, GROUND - 5, leaf);
      for (const [px, py] of [
        [6, GROUND - 7],
        [10, GROUND - 4],
        [10, GROUND - 8],
      ]) {
        c.set(px, py, fruit);
        c.set(px, py + 1, fruit);
        c.set(px, py + 2, fruit);
      }
    },
    picked(c, { leaf }) {
      this.pole(c);
      for (let i = 0; i < 10; i++) c.set(8 + (i % 2 ? 1 : -1), GROUND - 1 - i, leaf);
      leafPair(c, 7, GROUND - 9, leaf);
      leafPair(c, 9, GROUND - 5, leaf);
    },
    old(c) {
      this.pole(c);
      for (let i = 0; i < 8; i++) c.set(8 + (i % 2 ? 1 : -1), GROUND - 1 - i, PAL.soilLight);
      leafPair(c, 7, GROUND - 7, PAL.soilMid);
    },
  },
  berry_bush: {
    s1(c, { leaf }) {
      ellipse(c, 8, GROUND - 1, 3, 2, leaf);
    },
    s2(c, { leaf, fruit }) {
      ellipse(c, 8, GROUND - 3, 5, 4, leaf);
      ellipse(c, 8, GROUND - 5, 3, 2, PAL.greenMid);
      for (const [px, py] of [
        [5, GROUND - 3],
        [8, GROUND - 2],
        [11, GROUND - 4],
        [7, GROUND - 5],
        [10, GROUND - 6],
      ]) {
        c.set(px, py, fruit);
        c.set(px + 1, py, fruit);
        c.set(px, py + 1, fruit);
        c.set(px + 1, py + 1, fruit);
      }
    },
    picked(c, { leaf }) {
      ellipse(c, 8, GROUND - 3, 5, 4, leaf);
      ellipse(c, 8, GROUND - 5, 3, 2, PAL.greenMid);
    },
    old(c) {
      ellipse(c, 8, GROUND - 2, 5, 3, PAL.soilLight);
      ellipse(c, 8, GROUND - 4, 3, 1, PAL.soilMid);
    },
  },
  fruit_bush: {
    s1(c, { leaf }) {
      c.set(8, GROUND, PAL.greenDark);
      c.set(8, GROUND - 1, PAL.greenDark);
      ellipse(c, 8, GROUND - 3, 3, 2, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      c.set(8, GROUND, PAL.greenDark);
      ellipse(c, 8, GROUND - 5, 4, 3, leaf);
      ellipse(c, 8, GROUND - 7, 2, 1, PAL.greenLight);
      for (const [px, py] of [
        [5, GROUND - 2],
        [8, GROUND - 1],
        [11, GROUND - 3],
      ]) {
        disc(c, px, py, 1, fruit);
        c.set(px + 1, py - 1, shade);
      }
    },
    picked(c, { leaf }) {
      c.set(8, GROUND, PAL.greenDark);
      ellipse(c, 8, GROUND - 5, 4, 3, leaf);
      ellipse(c, 8, GROUND - 7, 2, 1, PAL.greenLight);
    },
    old(c) {
      c.set(8, GROUND, PAL.soilMid);
      ellipse(c, 8, GROUND - 4, 4, 2, PAL.soilLight);
    },
  },
  tall: {
    s1(c, { leaf }) {
      for (let y = GROUND - 5; y <= GROUND; y++) c.set(8, y, PAL.greenMid);
      c.set(6, GROUND - 3, leaf);
      c.set(7, GROUND - 4, leaf);
      c.set(10, GROUND - 2, leaf);
      c.set(9, GROUND - 3, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      for (let y = GROUND - 12; y <= GROUND; y++) c.set(8, y, PAL.greenMid);
      for (const [lx, ly] of [
        [6, GROUND - 4],
        [10, GROUND - 7],
        [6, GROUND - 9],
      ]) {
        c.set(lx, ly, leaf);
        c.set(lx + (lx < 8 ? 1 : -1), ly - 1, leaf);
      }
      ellipse(c, 6, GROUND - 6, 1, 2, fruit);
      ellipse(c, 10, GROUND - 9, 1, 2, fruit);
      c.set(6, GROUND - 7, shade);
      c.set(10, GROUND - 10, shade);
    },
  },
  tall_grain: {
    s1(c, { leaf }) {
      for (const dx of [-2, 0, 2]) {
        c.set(8 + dx, GROUND, leaf);
        c.set(8 + dx, GROUND - 1, leaf);
        c.set(8 + dx, GROUND - 2, leaf);
      }
    },
    s2(c, { fruit, shade }) {
      for (const dx of [-3, -1, 1, 3]) {
        for (let y = GROUND - 7; y <= GROUND; y++) c.set(8 + dx, y, shade);
        c.set(8 + dx, GROUND - 8, fruit);
        c.set(8 + dx, GROUND - 9, fruit);
        c.set(8 + dx - (dx > 0 ? 1 : -1) * 0, GROUND - 10, fruit);
      }
    },
  },
  tall_flower: {
    s1(c, { leaf }) {
      for (let y = GROUND - 5; y <= GROUND; y++) c.set(8, y, PAL.greenMid);
      leafPair(c, 8, GROUND - 3, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      for (let y = GROUND - 9; y <= GROUND; y++) c.set(8, y, PAL.greenMid);
      leafPair(c, 7, GROUND - 4, leaf);
      leafPair(c, 9, GROUND - 6, leaf);
      disc(c, 8, GROUND - 11, 3, fruit);
      disc(c, 8, GROUND - 11, 1, PAL.soilMid);
      c.set(5, GROUND - 11, shade);
      c.set(11, GROUND - 11, shade);
      c.set(8, GROUND - 14, shade);
      c.set(8, GROUND - 8, shade);
    },
  },
  ground_fruit: {
    s1(c, { leaf }) {
      for (let x = 5; x <= 11; x++) c.set(x, GROUND - ((x + 1) % 2), PAL.greenMid);
      leafPair(c, 6, GROUND - 2, leaf);
      leafPair(c, 10, GROUND - 2, leaf);
    },
    s2(c, { leaf, fruit, shade }) {
      for (let x = 3; x <= 12; x++) c.set(x, GROUND - 4 - (x % 2), PAL.greenMid);
      leafPair(c, 4, GROUND - 6, leaf);
      leafPair(c, 12, GROUND - 6, leaf);
      ellipse(c, 8, GROUND - 2, 4, 3, fruit);
      for (let y = GROUND - 5; y <= GROUND + 1; y++) {
        c.set(6, y, shade);
        c.set(10, y, shade);
      }
      c.set(8, GROUND - 5, PAL.greenDark); // stem nub
    },
  },
};

// ---------------------------------------------------------------------------
// crops atlas
// ---------------------------------------------------------------------------

function buildCrops() {
  const frames = new Map();

  // shared stage-0 seeded mound (GDD §3.7)
  const seeded = new Canvas(16, 16);
  ellipse(seeded, 8, GROUND, 3, 1, PAL.soilLight);
  seeded.set(7, GROUND - 1, PAL.soilLight);
  seeded.set(9, GROUND - 1, PAL.soilMid);
  frames.set('crop_common_seeded', outline(seeded));

  for (const crop of CROPS) {
    const painter = KIND_PAINTERS[crop.kind];
    const s0 = new Canvas(16, 16);
    paintSprout(s0, crop.leaf);
    frames.set(`crop_${crop.id}_s0`, outline(s0));

    const s1 = new Canvas(16, 16);
    painter.s1(s1, crop);
    frames.set(`crop_${crop.id}_s1`, outline(s1));

    const s2 = new Canvas(16, 16);
    painter.s2(s2, crop);
    frames.set(`crop_${crop.id}_s2`, outline(s2));

    if (crop.regrow) {
      const picked = new Canvas(16, 16);
      (painter.picked ?? painter.s1).call(painter, picked, crop);
      frames.set(`crop_${crop.id}_picked`, outline(picked));
      const old = new Canvas(16, 16);
      (painter.old ?? painter.s1).call(painter, old, crop);
      frames.set(`crop_${crop.id}_old_vine`, outline(old));
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// items atlas
// ---------------------------------------------------------------------------

function produceIcon(crop) {
  const c = new Canvas(16, 16);
  const { kind, fruit, shade, leaf } = crop;
  if (kind === 'bulb') {
    ellipse(c, 8, 10, 3, 3, fruit);
    c.set(7, 9, shade);
    c.set(8, 14, fruit);
    c.set(8, 5, leaf);
    c.set(7, 4, leaf);
    c.set(9, 4, leaf);
  } else if (kind === 'head') {
    disc(c, 8, 9, 4, fruit);
    ellipse(c, 8, 8, 2, 1, shade);
    c.set(4, 10, leaf);
    c.set(12, 10, leaf);
  } else if (kind === 'bush_root') {
    ellipse(c, 8, 10, 4, 3, fruit);
    c.set(6, 9, shade);
    c.set(10, 11, shade);
    c.set(9, 8, shade);
  } else if (kind === 'vine') {
    for (const [px, py] of [
      [5, 6],
      [8, 5],
      [11, 6],
    ]) {
      for (let i = 0; i < 5; i++) c.set(px + (i > 2 ? 1 : 0), py + i, fruit);
      c.set(px, py - 1, leaf);
    }
  } else if (kind === 'berry_bush') {
    for (const [px, py] of [
      [6, 8],
      [10, 8],
      [8, 11],
    ]) {
      disc(c, px, py, 1, fruit);
      c.set(px - 1, py - 1, shade);
    }
    c.set(8, 6, leaf);
    c.set(7, 5, leaf);
  } else if (kind === 'fruit_bush') {
    ellipse(c, 8, 10, 3, 3, fruit);
    c.set(7, 8, shade);
    c.set(8, 6, leaf);
    c.set(9, 5, leaf);
  } else if (kind === 'tall') {
    ellipse(c, 8, 9, 2, 4, fruit);
    c.set(7, 7, shade);
    c.set(6, 12, leaf);
    c.set(10, 12, leaf);
    c.set(8, 4, leaf);
  } else if (kind === 'tall_grain') {
    for (const dx of [-2, 0, 2]) {
      for (let y = 8; y <= 13; y++) c.set(8 + dx, y, shade);
      c.set(8 + dx, 6, fruit);
      c.set(8 + dx, 7, fruit);
    }
  } else if (kind === 'tall_flower') {
    disc(c, 8, 8, 3, fruit);
    disc(c, 8, 8, 1, PAL.soilMid);
    c.set(8, 12, leaf);
    c.set(8, 13, leaf);
  } else if (kind === 'ground_fruit') {
    disc(c, 8, 9, 4, fruit);
    for (let y = 6; y <= 12; y++) c.set(8, y, shade);
    c.set(8, 4, leaf);
  }
  return outline(c);
}

function seedPacket(crop) {
  const c = new Canvas(16, 16);
  c.fillRect(4, 3, 8, 11, PAL.sand);
  c.fillRect(4, 5, 8, 3, crop.fruit);
  c.set(6, 10, PAL.soilMid);
  c.set(9, 11, PAL.soilMid);
  c.set(7, 12, PAL.soilMid);
  c.fillRect(4, 3, 8, 1, PAL.uiText);
  return outline(c);
}

function toolFrameArt(tool, tier) {
  const c = new Canvas(16, 16);
  const metal = tier === 1 ? PAL.uiTextDim : tier === 2 ? PAL.amber : PAL.goldMid;
  const metalShade = tier === 1 ? PAL.soilMid : tier === 2 ? PAL.goldDeep : PAL.goldLight;
  if (tool === 'hoe') {
    for (let i = 0; i < 9; i++) c.set(4 + i, 13 - i, PAL.woodMid); // handle
    c.set(12, 5, PAL.woodLight);
    c.fillRect(2, 12, 4, 2, metal); // blade
    c.set(2, 14, metalShade);
    c.set(3, 14, metalShade);
  } else {
    ellipse(c, 8, 10, 4, 3, metal); // body
    ellipse(c, 7, 9, 1, 1, metalShade);
    c.fillRect(12, 9, 2, 1, metal); // spout
    c.set(14, 8, metal);
    for (let x = 6; x <= 10; x++) c.set(x, 5, metalShade); // handle arc
    c.set(5, 6, metalShade);
    c.set(11, 6, metalShade);
  }
  return outline(c);
}

function icon(name) {
  const c = new Canvas(16, 16);
  if (name === 'gold') {
    disc(c, 8, 8, 5, PAL.goldMid);
    disc(c, 8, 8, 3, PAL.goldLight);
    c.fillRect(7, 6, 2, 5, PAL.goldDeep);
    c.fillRect(6, 6, 4, 1, PAL.goldDeep);
  } else if (name === 'xp') {
    // 4-point star
    for (let i = 0; i < 4; i++) {
      c.set(8, 3 + i, PAL.goldMid);
      c.set(8, 12 - i, PAL.goldMid);
      c.set(3 + i, 8, PAL.goldMid);
      c.set(12 - i, 8, PAL.goldMid);
    }
    disc(c, 8, 8, 2, PAL.goldLight);
  } else if (name === 'level') {
    // upward chevron badge
    for (let i = 0; i < 6; i++) {
      c.set(8 - i, 8 + i, PAL.goldMid);
      c.set(8 + i, 8 + i, PAL.goldMid);
      c.set(8 - i, 9 + i, PAL.goldDeep);
      c.set(8 + i, 9 + i, PAL.goldDeep);
    }
    c.set(8, 7, PAL.goldLight);
  } else if (name === 'sun') {
    disc(c, 8, 8, 4, PAL.goldMid);
    disc(c, 7, 7, 1, PAL.goldLight);
    for (const [x, y] of [
      [8, 1],
      [8, 15],
      [1, 8],
      [15, 8],
      [3, 3],
      [13, 3],
      [3, 13],
      [13, 13],
    ])
      c.set(x, y, PAL.goldDeep);
  } else if (name === 'rain') {
    ellipse(c, 8, 6, 5, 2, PAL.uiTextDim);
    ellipse(c, 6, 5, 2, 2, PAL.uiTextDim);
    for (const [x, y] of [
      [5, 10],
      [8, 11],
      [11, 10],
      [6, 13],
      [10, 13],
    ]) {
      c.set(x, y, PAL.waterLight);
      c.set(x, y + 1, PAL.waterLight);
    }
  }
  return outline(c);
}

function kenneyTile(sheet, col, row) {
  const c = new Canvas(16, 16);
  c.blit(sheet, col * PITCH, row * PITCH, 16, 16, 0, 0, false);
  return c;
}

function buildItems() {
  const frames = new Map();
  for (const crop of CROPS) {
    frames.set(`item_${crop.id}`, produceIcon(crop));
    frames.set(`seed_${crop.id}`, seedPacket(crop));
  }
  for (const tool of ['hoe', 'can']) {
    for (const tier of [1, 2, 3]) frames.set(`tool_${tool}_t${tier}`, toolFrameArt(tool, tier));
  }
  for (const name of ['gold', 'xp', 'level', 'sun', 'rain']) frames.set(`icon_${name}`, icon(name));

  // forage pickups from Kenney Roguelike/RPG pack (CC0)
  const sheet = canvasFromPng(
    readFileSync(join(VENDOR, 'roguelike-rpg-pack/Spritesheet/roguelikeSheet_transparent.png')),
  );
  frames.set('item_wood', kenneyTile(sheet, 13, 8)); // log pile
  frames.set('item_stone', kenneyTile(sheet, 54, 21)); // gray rock pile
  frames.set('item_wildflower', kenneyTile(sheet, 42, 23)); // gold flower
  return frames;
}

// ---------------------------------------------------------------------------
// ui atlas
// ---------------------------------------------------------------------------

/** 9-slice panel: stepped 2px pixel corners, 1px ink edge, wood.light inner border. */
function panel(size, fill, border, edge = PAL.ink) {
  const c = new Canvas(size, size);
  c.fillRect(0, 0, size, size, fill);
  // ink frame
  c.fillRect(0, 0, size, 1, edge);
  c.fillRect(0, size - 1, size, 1, edge);
  c.fillRect(0, 0, 1, size, edge);
  c.fillRect(size - 1, 0, 1, size, edge);
  // inner light border
  c.fillRect(1, 1, size - 2, 1, border);
  c.fillRect(1, size - 2, size - 2, 1, border);
  c.fillRect(1, 1, 1, size - 2, border);
  c.fillRect(size - 2, 1, 1, size - 2, border);
  // 2px stepped corners (transparent notches)
  for (const [cx, cy] of [
    [0, 0],
    [size - 2, 0],
    [0, size - 2],
    [size - 2, size - 2],
  ]) {
    c.fillRect(cx, cy, 2, 2, [0, 0, 0, 0]);
  }
  // re-ink the corner steps
  for (const [x, y] of [
    [2, 1],
    [1, 2],
    [size - 3, 1],
    [size - 2, 2],
    [1, size - 3],
    [2, size - 2],
    [size - 2, size - 3],
    [size - 3, size - 2],
  ])
    c.set(x, y, edge);
  return c;
}

function hudStateIcon(state) {
  const c = new Canvas(16, 16);
  // colors follow shared/src/theme.ts five-state tokens (water.light/amber/green.light/textDim)
  if (state === 'working') {
    // play triangle
    for (let x = 0; x < 7; x++)
      for (let y = x; y < 14 - x; y++) c.set(5 + x, 1 + y + 0, PAL.waterLight);
  } else if (state === 'blocked') {
    c.fillRect(7, 3, 2, 7, PAL.amber); // exclamation
    c.fillRect(7, 12, 2, 2, PAL.amber);
  } else if (state === 'done') {
    for (let i = 0; i < 3; i++) c.set(4 + i, 8 + i, PAL.greenLight);
    for (let i = 0; i < 6; i++) {
      c.set(6 + i, 10 - i, PAL.greenLight);
      c.set(6 + i, 11 - i, PAL.greenLight);
    }
    c.set(4, 9, PAL.greenLight);
  } else if (state === 'idle') {
    disc(c, 8, 8, 4, PAL.uiTextDim);
    disc(c, 8, 8, 2, [0, 0, 0, 0]);
  } else {
    // unknown: question mark
    c.fillRect(6, 3, 4, 2, PAL.uiTextDim);
    c.fillRect(9, 5, 2, 2, PAL.uiTextDim);
    c.fillRect(7, 7, 2, 2, PAL.uiTextDim);
    c.fillRect(7, 11, 2, 2, PAL.uiTextDim);
  }
  return outline(c);
}

function buildUi() {
  const frames = new Map();
  frames.set('ui_panel', panel(24, PAL.uiPanel, PAL.woodLight));
  frames.set('ui_button', panel(24, PAL.uiPanelLight, PAL.woodLight));
  frames.set('ui_button_hover', panel(24, PAL.uiPanelLight, PAL.goldLight));
  frames.set('ui_button_pressed', panel(24, PAL.uiPanel, PAL.woodMid));
  frames.set('ui_slot', panel(20, PAL.uiPanelLight, PAL.soilMid));
  for (const s of ['working', 'blocked', 'done', 'idle', 'unknown'])
    frames.set(`hud_state_${s}`, hudStateIcon(s));

  // rain streak frames (two phases)
  for (const phase of [0, 1]) {
    const c = new Canvas(16, 16);
    for (const [x, y] of [
      [2, 1],
      [9, 4],
      [5, 9],
      [13, 11],
      [1, 13],
    ]) {
      const ox = (x + phase * 2) % 16;
      const oy = (y + phase * 7) % 16;
      for (let i = 0; i < 3; i++) c.set((ox + i) % 16, (oy + i * 2) % 16, PAL.waterPale);
    }
    frames.set(`fx_rain_${phase}`, c);
  }
  // splash ripple frames
  for (const phase of [0, 1]) {
    const c = new Canvas(16, 16);
    ellipse(c, 8, 12, 2 + phase * 3, 1 + phase, [0, 0, 0, 0]);
    // ring: draw filled then hollow it
    const r = 2 + phase * 3;
    for (let x = -r; x <= r; x++) {
      for (let y = -2 - phase; y <= 2 + phase; y++) {
        const v = (x * x) / (r * r + 0.4) + (y * y) / ((1 + phase) * (1 + phase) + 0.4);
        if (v <= 1 && v > 0.5) c.set(8 + x, 12 + y, PAL.waterPale);
      }
    }
    frames.set(`fx_splash_${phase}`, c);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// characters atlas — self-drawn farmer (S4 fallback per GDD §11.1)
// ---------------------------------------------------------------------------

const CH = {
  K: PAL.ink,
  H: PAL.goldMid, // straw hat
  h: PAL.goldDeep,
  F: PAL.sand, // skin
  S: PAL.waterMid, // shirt
  s: PAL.waterDeep,
  P: PAL.soilMid, // pants
  B: PAL.soilDark, // boots
  A: PAL.sand, // hands
  W: PAL.woodMid, // tool stick
  M: PAL.uiTextDim, // tool metal
};

// 12-wide bodies, bottom-anchored. Legs vary by walk frame.
const DOWN_HEAD = [
  '...KKKKKK...',
  '..KHHHHHHK..',
  '.KHHHHHHHHK.',
  'KhhhhhhhhhhK',
  '.KFFFFFFFFK.',
  '.KFKFFFFKFK.',
  '.KFFFFFFFFK.',
];
const UP_HEAD = [
  '...KKKKKK...',
  '..KHHHHHHK..',
  '.KHHHHHHHHK.',
  'KhhhhhhhhhhK',
  '.KhhhhhhhhK.',
  '.KhhhhhhhhK.',
  '.KFFFFFFFFK.',
];
const SIDE_HEAD = [
  '...KKKKKK...',
  '..KHHHHHHK..',
  '.KHHHHHHHHK.',
  'KhhhhhhhhhhK',
  '..KFFFFFFK..',
  '..KFFFFKFK..',
  '..KFFFFFFK..',
];

function torso(front) {
  return front
    ? ['..KSSSSSSK..', '.KASSSSSSAK.', '.KASssssSAK.']
    : ['..KSSSSSSK..', '.KSSSSSSSAK.', '.KSssssSSAK.'];
}

const LEGS = {
  stand: ['..KPPPPPPK..', '..KPPKKPPK..', '..KBK..KBK..'],
  stepA: ['..KPPPPPPK..', '..KPPKKPPK..', '..KBK...KBK.'], // right foot fwd
  stepB: ['..KPPPPPPK..', '..KPPKKPPK..', '.KBK...KBK..'], // left foot fwd
  side0: ['...KPPPPK...', '...KPKPPK...', '...KBKKBK...'],
  side1: ['...KPPPPK...', '..KPK.KPK...', '..KBK..KBK..'],
  side2: ['...KPPPPK...', '...KPPKK....', '...KBKKBK...'],
};

function frame(head, legs, front = true) {
  return sprite([...head, ...torso(front), ...legs], CH, 16, 16);
}

function swingFrames(dir) {
  // tool overlay drawn into a copy of the standing frame
  const heads = { down: DOWN_HEAD, up: UP_HEAD, right: SIDE_HEAD, left: SIDE_HEAD };
  const out = [];
  for (let i = 0; i < 3; i++) {
    const base = frame(
      heads[dir],
      LEGS[dir === 'up' || dir === 'down' ? 'stand' : 'side0'],
      dir !== 'up',
    );
    const c = dir === 'left' ? mirrorH(base) : base;
    // tool stick positions: raised → mid → struck
    const stick = [
      [
        [13, 4],
        [13, 5],
        [14, 3],
      ],
      [
        [13, 8],
        [14, 7],
        [14, 6],
      ],
      [
        [13, 12],
        [14, 12],
        [12, 12],
      ],
    ][i];
    for (const [x, y] of stick) c.set(dir === 'left' ? 15 - x : x, y, i === 2 ? CH.M : CH.W);
    out.push(c);
  }
  return out;
}

function buildCharacters() {
  const frames = new Map();
  const walkLegs = {
    down: ['stand', 'stepA', 'stand', 'stepB'],
    up: ['stand', 'stepA', 'stand', 'stepB'],
    right: ['side0', 'side1', 'side0', 'side2'],
    left: ['side0', 'side1', 'side0', 'side2'],
  };
  const heads = { down: DOWN_HEAD, up: UP_HEAD, right: SIDE_HEAD, left: SIDE_HEAD };
  for (const dir of ['down', 'up', 'left', 'right']) {
    for (let f = 0; f < 4; f++) {
      let cv = frame(heads[dir], LEGS[walkLegs[dir][f]], dir !== 'up');
      if (dir === 'left') cv = mirrorH(cv);
      frames.set(`player_walk_${dir}_${f}`, cv);
    }
    let idle = frame(
      heads[dir],
      LEGS[dir === 'up' || dir === 'down' ? 'stand' : 'side0'],
      dir !== 'up',
    );
    if (dir === 'left') idle = mirrorH(idle);
    frames.set(`player_idle_${dir}_0`, idle);
    swingFrames(dir).forEach((cv, i) => frames.set(`player_swing_${dir}_${i}`, cv));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// write atlases
// ---------------------------------------------------------------------------

function writeAtlas(name, framesMap) {
  const { atlas, frames } = packAtlas([...framesMap.entries()], 256);
  const dir = join(gameRoot, 'assets/atlases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), atlas.toPng());
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(atlasJson(frames, `${name}.png`, { w: atlas.width, h: atlas.height }), null, 2) +
      '\n',
  );
  console.log(`${name}: ${framesMap.size} frames, ${atlas.width}×${atlas.height}`);
}

writeAtlas('crops', buildCrops());
writeAtlas('items', buildItems());
writeAtlas('ui', buildUi());
writeAtlas('characters', buildCharacters());
