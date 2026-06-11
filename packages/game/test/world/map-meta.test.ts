import { describe, expect, it } from 'vitest';

import { buildMapMeta, FALLBACK_MAP_META, type TiledMapData } from '../../src/world/map-meta';

/** Minimal synthetic farm.tmj object layers (GDD §1.5 names). */
const tmj: TiledMapData = {
  width: 64,
  height: 48,
  layers: [
    {
      name: 'spawn',
      type: 'objectgroup',
      objects: [
        {
          name: 'player_spawn',
          x: 27 * 16,
          y: 11 * 16,
          properties: [{ name: 'facing', value: 'down' }],
        },
      ],
    },
    {
      name: 'zones',
      type: 'objectgroup',
      objects: [
        { name: 'field_a', x: 22 * 16, y: 14 * 16, width: 8 * 16, height: 6 * 16 },
        {
          name: 'field_b',
          x: 10 * 16,
          y: 14 * 16,
          width: 10 * 16,
          height: 6 * 16,
          properties: [{ name: 'unlockLevel', value: 3 }],
        },
        {
          name: 'field_c',
          x: 18 * 16,
          y: 23 * 16,
          width: 12 * 16,
          height: 6 * 16,
          properties: [{ name: 'unlockLevel', value: 5 }],
        },
        { name: 'build_coop', x: 42 * 16, y: 32 * 16, width: 6 * 16, height: 4 * 16 },
      ],
    },
    {
      name: 'interactables',
      type: 'objectgroup',
      objects: [
        {
          name: 'shipping_bin',
          x: 33 * 16,
          y: 10 * 16,
          width: 2 * 16,
          height: 16,
          properties: [{ name: 'kind', value: 'shipping_bin' }],
        },
      ],
    },
    {
      name: 'pickups',
      type: 'objectgroup',
      objects: [
        { name: 'wood_1', x: 6 * 16, y: 3 * 16, properties: [{ name: 'kind', value: 'wood' }] },
        { name: 'bogus', x: 0, y: 0, properties: [{ name: 'kind', value: 'gold_bar' }] },
      ],
    },
  ],
};

describe('buildMapMeta (GDD §1.5 contract shape)', () => {
  const meta = buildMapMeta(tmj);

  it('extracts the three tillable field rects (180 tiles total)', () => {
    expect(meta.tillable).toHaveLength(3);
    const total = meta.tillable.reduce((n, r) => n + r.w * r.h, 0);
    expect(total).toBe(180);
  });

  it('builds unlock groups for field_b (Lv3) and field_c (Lv5) only', () => {
    expect(meta.unlockGroups.map((g) => [g.zoneId, g.farmLevel])).toEqual([
      ['field_b', 3],
      ['field_c', 5],
    ]);
  });

  it('reads spawn tile + facing', () => {
    expect(meta.spawn).toEqual({ tile: { x: 27, y: 11 }, facing: 'down' });
  });

  it('expands multi-tile interactables into tile lists', () => {
    const bin = meta.interactables.find((i) => i.id === 'shipping_bin');
    expect(bin?.kind).toBe('shipping_bin');
    expect(bin?.tiles).toEqual([
      { x: 33, y: 10 },
      { x: 34, y: 10 },
    ]);
  });

  it('keeps only valid pickup kinds', () => {
    expect(meta.pickupSpots).toEqual([{ id: 'wood_1', kind: 'wood', tile: { x: 6, y: 3 } }]);
  });

  it('collects build plots from zones', () => {
    expect(meta.buildPlots).toEqual([{ id: 'build_coop', rect: { x: 42, y: 32, w: 6, h: 4 } }]);
  });
});

describe('FALLBACK_MAP_META (dev fallback, GDD §1.3 transcription)', () => {
  it('matches the §1.3 field sizes (48 + 60 + 72 = 180)', () => {
    const total = FALLBACK_MAP_META.tillable.reduce((n, r) => n + r.w * r.h, 0);
    expect(total).toBe(180);
  });
  it('spawns at (27,11) facing down (GDD §1.1)', () => {
    expect(FALLBACK_MAP_META.spawn).toEqual({ tile: { x: 27, y: 11 }, facing: 'down' });
  });
  it('has 6 wood + 4 stone + 3 wildflower spots (GDD §1.3 daily quantities)', () => {
    const count = (kind: string) =>
      FALLBACK_MAP_META.pickupSpots.filter((s) => s.kind === kind).length;
    expect(count('wood')).toBe(6);
    expect(count('stone')).toBe(4);
    expect(count('wildflower')).toBe(3);
  });
});
