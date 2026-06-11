/**
 * ASCII-template pixel sprite helpers for the procedural (self-drawn, CC0)
 * atlas generators. Templates are arrays of equal-width strings; each char maps
 * to an RGBA color via a char map ('.' / ' ' = transparent).
 */
import { Canvas } from './png.mjs';
import { PAL } from './palette.mjs';

/** Render an ASCII template into a canvas of exactly w×h (template centered). */
export function sprite(rows, map, w = 16, h = 16) {
  const c = new Canvas(w, h);
  const ox = Math.floor((w - rows[0].length) / 2);
  const oy = h - rows.length; // bottom-aligned (anchor 0.5,1 convention)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const col = map[ch];
      if (!col) throw new Error(`sprite: unmapped char '${ch}'`);
      c.set(ox + x, oy + y, col);
    }
  });
  return c;
}

/** Horizontal mirror (for left-facing frames from right-facing art). */
export function mirrorH(src) {
  const c = new Canvas(src.width, src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) c.set(src.width - 1 - x, y, src.get(x, y));
  return c;
}

/** 1px ink outline around all opaque pixels (transparent neighbors only). */
export function outline(src, color = PAL.ink) {
  const c = new Canvas(src.width, src.height);
  c.blit(src, 0, 0, src.width, src.height, 0, 0);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.get(x, y)[3] !== 0) continue;
      const solid = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(
        ([nx, ny]) =>
          nx >= 0 && ny >= 0 && nx < src.width && ny < src.height && src.get(nx, ny)[3] !== 0,
      );
      if (solid) c.set(x, y, color);
    }
  }
  return c;
}

/** Shelf-pack named frames (Canvas values) into one atlas; returns {canvas, frames}. */
export function packAtlas(entries, maxWidth = 256) {
  // sort by height desc for tighter shelves, stable by name for determinism
  const sorted = [...entries].sort((a, b) => b[1].height - a[1].height || (a[0] < b[0] ? -1 : 1));
  const placed = [];
  let x = 0;
  let y = 0;
  let shelfH = 0;
  let width = 0;
  for (const [name, cv] of sorted) {
    if (x + cv.width > maxWidth) {
      x = 0;
      y += shelfH;
      shelfH = 0;
    }
    placed.push([name, cv, x, y]);
    x += cv.width;
    shelfH = Math.max(shelfH, cv.height);
    width = Math.max(width, x);
  }
  const height = y + shelfH;
  const atlas = new Canvas(width, height);
  const frames = {};
  for (const [name, cv, fx, fy] of placed) {
    atlas.blit(cv, 0, 0, cv.width, cv.height, fx, fy, false);
    frames[name] = {
      frame: { x: fx, y: fy, w: cv.width, h: cv.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cv.width, h: cv.height },
      sourceSize: { w: cv.width, h: cv.height },
    };
  }
  return { atlas, frames };
}

/** Phaser JSONHash atlas descriptor. */
export function atlasJson(frames, imageFile, size) {
  return {
    frames,
    meta: {
      app: 'codestead assets-src/tools (procedural)',
      image: imageFile,
      format: 'RGBA8888',
      size: { w: size.w, h: size.h },
      scale: '1',
    },
  };
}
