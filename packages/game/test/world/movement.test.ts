/**
 * movement.ts — anti-tunneling contract (backlog A-10) + corner forgiveness
 * regression (GDD §1.6). Pure displacement core, zero Phaser.
 *
 * Geometry mirrors PlayerController.bodyCollides: 12×8 foot AABB (MOVEMENT.COLLIDER)
 * around the foot-center position, tested against a 16px tile grid.
 */
import { describe, expect, it } from 'vitest';

import { MOVEMENT } from '../../src/sim/data/constants';
import {
  MAX_MOVE_DELTA_MS,
  MAX_MOVE_STEP_PX,
  moveAxisOnce,
  moveSliced,
  type BodyCollides,
} from '../../src/world/movement';

const TILE = 16;
const SPRITE_W = 16;
const SPRITE_H = 16;

/** PlayerController.bodyCollides transcription over a solid-tile predicate. */
function bodyCollides(isSolid: (tx: number, ty: number) => boolean): BodyCollides {
  const { width, height, offsetX, offsetY } = MOVEMENT.COLLIDER;
  return (x, y) => {
    const left = x - SPRITE_W / 2 + offsetX;
    const top = y - SPRITE_H + offsetY;
    const right = left + width;
    const bottom = top + height;
    if (left < 0 || top < 0 || right > 64 * TILE || bottom > 48 * TILE) return true;
    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((right - 0.001) / TILE);
    const y0 = Math.floor(top / TILE);
    const y1 = Math.floor((bottom - 0.001) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (isSolid(tx, ty)) return true;
      }
    }
    return false;
  };
}

/** A single solid wall column at tileX = 12 (one tile thick, full height). */
const WALL_X = 12;
const wallGrid = bodyCollides((tx) => tx === WALL_X);

describe('moveSliced — anti-tunneling (backlog A-10)', () => {
  it('a huge frame delta (sleep/throttle wake-up) never crosses a 1-tile wall', () => {
    // Start two tiles left of the wall, run right with a 10-second delta.
    const start = { x: 10 * TILE + 8, y: 20 * TILE + 12 };
    const end = moveSliced(start, 'right', MOVEMENT.RUN_SPEED_PX_PER_S, 10_000, wallGrid, 0);
    // Body right edge must stop at the wall face, never beyond it.
    expect(end.x).toBeLessThan(WALL_X * TILE + TILE);
    expect(wallGrid(end.x, end.y)).toBe(false); // final position is collision-free
  });

  it.each([50, 100, 250, 1000, 5000] as const)(
    'delta %dms: every landing position is collision-free and monotonic',
    (delta) => {
      const start = { x: 10 * TILE + 8, y: 20 * TILE + 12 };
      const end = moveSliced(start, 'right', MOVEMENT.RUN_SPEED_PX_PER_S, delta, wallGrid, 0);
      expect(end.x).toBeGreaterThanOrEqual(start.x);
      expect(wallGrid(end.x, end.y)).toBe(false);
      expect(end.x).toBeLessThan(WALL_X * TILE + TILE);
    },
  );

  it('clamps the effective delta to MAX_MOVE_DELTA_MS on open ground', () => {
    const open = bodyCollides(() => false);
    const start = { x: 320, y: 320 };
    const far = moveSliced(start, 'right', MOVEMENT.RUN_SPEED_PX_PER_S, 60_000, open, 0);
    const clamped = moveSliced(
      start,
      'right',
      MOVEMENT.RUN_SPEED_PX_PER_S,
      MAX_MOVE_DELTA_MS,
      open,
      0,
    );
    expect(far.x).toBeCloseTo(clamped.x, 6); // a wake-up delta moves like a 100ms frame
    expect(far.x - start.x).toBeCloseTo((MOVEMENT.RUN_SPEED_PX_PER_S * MAX_MOVE_DELTA_MS) / 1000);
  });

  it('normal 60fps walking is byte-identical to the unsliced single step', () => {
    // 16.7ms walking = ~1.2px < MAX_MOVE_STEP_PX ⇒ exactly one slice (no regression).
    const open = bodyCollides(() => false);
    const start = { x: 320, y: 320 };
    const dist = (MOVEMENT.WALK_SPEED_PX_PER_S * 16.7) / 1000;
    expect(dist).toBeLessThan(MAX_MOVE_STEP_PX);
    const sliced = moveSliced(start, 'down', MOVEMENT.WALK_SPEED_PX_PER_S, 16.7, open, 3);
    const single = moveAxisOnce(start, 0, dist, open, 3);
    expect(sliced).toEqual(single);
  });
});

describe('moveAxisOnce — corner forgiveness regression (GDD §1.6)', () => {
  it('slides 1px toward the clear side when the overlap is within forgiveness', () => {
    // Single wall tile at (12,20) → pixel rect [192,208)×[320,336). Body spans
    // [y−8, y]; foot-center y=342 pokes the body's top edge 2px into the wall row.
    const grid = bodyCollides((tx, ty) => tx === WALL_X && ty === 20);
    const start = { x: 185, y: 342 };
    // Moving right by 2px puts the body's right edge (x+6) past the wall face (192):
    const blocked = moveAxisOnce(start, 2, 0, grid, 0);
    expect(blocked).toEqual(start); // without forgiveness: dead stop
    const nudged = moveAxisOnce(start, 2, 0, grid, MOVEMENT.CORNER_FORGIVENESS_PX);
    expect(nudged).toEqual({ x: start.x, y: start.y + 1 }); // 1px slide toward clear side
  });

  it('a fully blocked move returns the original position unchanged', () => {
    const grid = bodyCollides((tx) => tx === WALL_X);
    const start = { x: WALL_X * TILE - 6, y: 20 * TILE + 12 };
    expect(moveAxisOnce(start, 4, 0, grid, MOVEMENT.CORNER_FORGIVENESS_PX)).toEqual(start);
  });
});
