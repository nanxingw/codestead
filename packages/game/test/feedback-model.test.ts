/**
 * Feedback-model tests (GDD §6.4 harvest timeline / §5.8 floater merge / §10.8
 * reducedMotion constants / ruling A-9 HUD-reserve clamp): the pure helpers behind
 * ui/hud/feedback-view.ts — same-frame batch merging (PRD 01 US68), the quadratic
 * bezier flight path (US80), hotbar slot geometry, and the (4,4)–(156,150) clamp.
 */
import { describe, expect, it } from 'vitest';

import {
  clampOutsideHudReserve,
  FLY_DELAY_MS,
  FLY_MS,
  flightControlPoint,
  hotbarSlotCenter,
  mergeHarvests,
  mergePickups,
  quadBezier,
  REDUCED_FADE_MS,
} from '../src/ui/hud/feedback-model';
import { HOTBAR, HUD_RESERVED, SLOT_GAP, SLOT_SIZE } from '../src/ui/layout';

describe('mergeHarvests (US68 same-frame batch)', () => {
  it('collapses counts per crop and ALL xp into one total', () => {
    const { groups, totalXp } = mergeHarvests([
      { cropId: 'turnip', count: 1, xp: 14, tile: { x: 3, y: 4 } },
      { cropId: 'turnip', count: 1, xp: 14, tile: { x: 4, y: 4 } },
      { cropId: 'radish_quick', count: 1, xp: 7, tile: { x: 5, y: 4 } },
    ]);
    expect(totalXp).toBe(35);
    expect(groups).toHaveLength(2);
    const turnip = groups.find((g) => g.cropId === 'turnip');
    expect(turnip?.count).toBe(2);
    // First tile is kept as the visual anchor.
    expect(turnip?.tile).toEqual({ x: 3, y: 4 });
  });

  it('passes a single event through unchanged', () => {
    const { groups, totalXp } = mergeHarvests([
      { cropId: 'turnip', count: 1, xp: 14, tile: { x: 1, y: 2 } },
    ]);
    expect(groups).toEqual([{ cropId: 'turnip', count: 1, tile: { x: 1, y: 2 } }]);
    expect(totalXp).toBe(14);
  });
});

describe('mergePickups', () => {
  it('collapses per itemId, preserving first-seen order', () => {
    const merged = mergePickups([
      { itemId: 'material_wood', count: 1 },
      { itemId: 'forage_wildflower', count: 1 },
      { itemId: 'material_wood', count: 2 },
    ]);
    expect(merged).toEqual([
      { itemId: 'material_wood', count: 3 },
      { itemId: 'forage_wildflower', count: 1 },
    ]);
  });
});

describe('flight path (§6.4 二次贝塞尔)', () => {
  it('lands on the §6.4 300ms mark (60ms pop beat + 240ms flight)', () => {
    expect(FLY_DELAY_MS + FLY_MS).toBe(300);
  });

  it('reducedMotion swaps the parabola for a 200ms fade (§10.8)', () => {
    expect(REDUCED_FADE_MS).toBe(200);
  });

  it('quadBezier hits both endpoints and arcs through the control influence', () => {
    const p0 = { x: 0, y: 100 };
    const p1 = { x: 100, y: 100 };
    const c = flightControlPoint(p0, p1);
    expect(quadBezier(p0, c, p1, 0)).toEqual(p0);
    expect(quadBezier(p0, c, p1, 1)).toEqual(p1);
    // Midpoint rises above the chord — that is the visible arc.
    expect(quadBezier(p0, c, p1, 0.5).y).toBeLessThan(100);
    expect(c.y).toBeLessThan(Math.min(p0.y, p1.y));
  });
});

describe('hotbarSlotCenter (GDD §6.6 geometry)', () => {
  it('centers on slot 0 and steps by SLOT_SIZE + SLOT_GAP', () => {
    const s0 = hotbarSlotCenter(0);
    expect(s0).toEqual({ x: HOTBAR.x + SLOT_SIZE / 2, y: HOTBAR.y + SLOT_SIZE / 2 });
    const s1 = hotbarSlotCenter(1);
    expect(s1.x - s0.x).toBe(SLOT_SIZE + SLOT_GAP);
  });

  it('falls back to the hotbar midpoint when the stack has no hotbar slot', () => {
    expect(hotbarSlotCenter(null).x).toBe(HOTBAR.x + HOTBAR.width / 2);
  });
});

describe('clampOutsideHudReserve (ruling A-9)', () => {
  const right = HUD_RESERVED.x + HUD_RESERVED.width;

  it('pushes points inside the reserve to its right edge (y preserved)', () => {
    const p = clampOutsideHudReserve({ x: 40, y: 40 });
    expect(p.x).toBeGreaterThanOrEqual(right);
    expect(p.y).toBe(40);
  });

  it('leaves points clear of the reserve untouched', () => {
    expect(clampOutsideHudReserve({ x: 320, y: 180 })).toEqual({ x: 320, y: 180 });
    expect(clampOutsideHudReserve({ x: 40, y: 300 })).toEqual({ x: 40, y: 300 });
  });
});
