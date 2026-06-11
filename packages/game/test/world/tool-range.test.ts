import { describe, expect, it } from 'vitest';

import type { Facing, TilePos, ToolTiers } from '../../src/sim/types';
import { expandToolRange, toolTierFor } from '../../src/world/tool-range';

const keys = (tiles: TilePos[]): string[] => tiles.map((t) => `${t.x},${t.y}`);

describe('toolTierFor (GDD §3.5: only hoe & can have tiers)', () => {
  const tools: ToolTiers = { hoe: 2, wateringCan: 3 };

  it('maps the two upgradable tools to their ToolTiers entry', () => {
    expect(toolTierFor('hoe', tools)).toBe(2);
    expect(toolTierFor('watering_can', tools)).toBe(3);
  });

  it('everything else (seeds, crops, bare hand) is tier 1', () => {
    expect(toolTierFor('seed_radish_quick', tools)).toBe(1);
    expect(toolTierFor('crop_potato', tools)).toBe(1);
    expect(toolTierFor(null, tools)).toBe(1);
  });
});

describe('expandToolRange (GDD §3.5 range definitions, deterministic order)', () => {
  const origin: TilePos = { x: 10, y: 10 };

  it('tier 1 = the target tile only (wood semantics, no regression)', () => {
    expect(expandToolRange(origin, 'down', 1)).toEqual([{ x: 10, y: 10 }]);
  });

  it('tier 2 = 直线 3 格: facing tile + 2 in the same direction, near → far', () => {
    expect(keys(expandToolRange(origin, 'right', 2))).toEqual(['10,10', '11,10', '12,10']);
    expect(keys(expandToolRange(origin, 'left', 2))).toEqual(['10,10', '9,10', '8,10']);
    expect(keys(expandToolRange(origin, 'up', 2))).toEqual(['10,10', '10,9', '10,8']);
    expect(keys(expandToolRange(origin, 'down', 2))).toEqual(['10,10', '10,11', '10,12']);
  });

  it('tier 3 = 3×3 centered on the facing tile, row-major (facing-independent)', () => {
    const expected = ['9,9', '10,9', '11,9', '9,10', '10,10', '11,10', '9,11', '10,11', '11,11'];
    for (const facing of ['up', 'down', 'left', 'right'] as Facing[]) {
      expect(keys(expandToolRange(origin, facing, 3))).toEqual(expected);
    }
  });

  it('returns fresh TilePos objects (no aliasing of the origin)', () => {
    const tiles = expandToolRange(origin, 'down', 1);
    tiles[0].x = 99;
    expect(origin.x).toBe(10);
  });

  it('drops out-of-bounds tiles when bounds are given (64×48 map edges)', () => {
    const bounds = { width: 64, height: 48 };
    expect(keys(expandToolRange({ x: 0, y: 0 }, 'left', 2, bounds))).toEqual(['0,0']);
    expect(keys(expandToolRange({ x: 0, y: 0 }, 'up', 3, bounds))).toEqual([
      '0,0',
      '1,0',
      '0,1',
      '1,1',
    ]);
    expect(keys(expandToolRange({ x: 63, y: 47 }, 'right', 2, bounds))).toEqual(['63,47']);
    expect(expandToolRange({ x: 62, y: 10 }, 'right', 2, bounds)).toHaveLength(2);
  });

  it('keeps every tile when no bounds are given', () => {
    expect(expandToolRange({ x: 0, y: 0 }, 'up', 3)).toHaveLength(9);
  });

  it('expansion is pure: same inputs, same sequence (replay determinism)', () => {
    const a = expandToolRange(origin, 'right', 3, { width: 64, height: 48 });
    const b = expandToolRange(origin, 'right', 3, { width: 64, height: 48 });
    expect(a).toEqual(b);
  });
});
