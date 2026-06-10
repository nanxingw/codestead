import { describe, expect, it } from 'vitest';

import { computeIntegerZoom } from '../src/scale';

// Minimal pure-function smoke test: proves the game package's test wiring works
// and pins the integer-scaling rule from game-design §0.3.
describe('computeIntegerZoom', () => {
  it('returns the largest integer zoom that fits', () => {
    expect(computeIntegerZoom(1920, 1080)).toBe(3);
    expect(computeIntegerZoom(1280, 720)).toBe(2);
    expect(computeIntegerZoom(1279, 720)).toBe(1);
  });

  it('clamps to 1 for windows smaller than the logical resolution', () => {
    expect(computeIntegerZoom(500, 300)).toBe(1);
  });

  it('never returns a fractional zoom', () => {
    expect(Number.isInteger(computeIntegerZoom(1700, 1000))).toBe(true);
  });
});
