import { describe, expect, it } from 'vitest';

import { chebyshev, facingToward, resolveTargetTile } from '../../src/world/aim';
import type { TilePos } from '../../src/sim/types';

const player: TilePos = { x: 10, y: 10 };

describe('resolveTargetTile (GDD §1.7)', () => {
  it('keyboard aim targets the facing tile', () => {
    const res = resolveTargetTile({
      playerTile: player,
      facing: 'right',
      aimMode: 'keyboard',
      hoverTile: null,
      isValid: () => true,
    });
    expect(res.tile).toEqual({ x: 11, y: 10 });
    expect(res.tooFar).toBe(false);
  });

  it('keyboard aim falls back to the foot tile when ahead is invalid but foot is valid', () => {
    const res = resolveTargetTile({
      playerTile: player,
      facing: 'up',
      aimMode: 'keyboard',
      hoverTile: null,
      isValid: (t) => t.x === player.x && t.y === player.y, // standing on a mature crop
    });
    expect(res.tile).toEqual(player);
  });

  it('keyboard aim keeps the (invalid) facing tile when foot is also invalid', () => {
    const res = resolveTargetTile({
      playerTile: player,
      facing: 'down',
      aimMode: 'keyboard',
      hoverTile: null,
      isValid: () => false,
    });
    expect(res.tile).toEqual({ x: 10, y: 11 });
  });

  it('mouse aim accepts hover tiles within the 3×3 reach', () => {
    const res = resolveTargetTile({
      playerTile: player,
      facing: 'down',
      aimMode: 'mouse',
      hoverTile: { x: 9, y: 9 },
      isValid: () => true,
    });
    expect(res.tile).toEqual({ x: 9, y: 9 });
  });

  it('mouse aim outside the 3×3 reach: no target, tooFar flag (no pathing)', () => {
    const res = resolveTargetTile({
      playerTile: player,
      facing: 'down',
      aimMode: 'mouse',
      hoverTile: { x: 13, y: 10 },
      isValid: () => true,
    });
    expect(res.tile).toBeNull();
    expect(res.tooFar).toBe(true);
  });
});

describe('facingToward (GDD §1.7 click turns the player)', () => {
  it('turns toward the dominant axis', () => {
    expect(facingToward(player, { x: 11, y: 10 }, 'up')).toBe('right');
    expect(facingToward(player, { x: 10, y: 9 }, 'down')).toBe('up');
  });
  it('keeps current facing on the player tile itself', () => {
    expect(facingToward(player, player, 'left')).toBe('left');
  });
  it('exact diagonals resolve horizontally (deterministic)', () => {
    expect(facingToward(player, { x: 9, y: 11 }, 'up')).toBe('left');
  });
});

describe('chebyshev', () => {
  it('measures the 3×3 reach correctly', () => {
    expect(chebyshev(player, { x: 11, y: 11 })).toBe(1);
    expect(chebyshev(player, { x: 12, y: 10 })).toBe(2);
  });
});
