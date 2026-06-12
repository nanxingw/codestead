/**
 * quality-view.test.ts — render-side quality helpers (M3, GDD §4.5; PRD 04 US43~45).
 */
import { describe, expect, it } from 'vitest';

import type { ItemStack, WorldState } from '../src/sim/types';
import {
  qualityMark,
  qualityOf,
  stackUnitSalePrice,
  withQualityMark,
} from '../src/ui/quality-view';

function makeState(profession: WorldState['progress']['profession']): WorldState {
  const slots: (ItemStack | null)[] = Array.from({ length: 12 }, () => null);
  return {
    time: {
      day: 1,
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: '0'.repeat(32),
    },
    player: { tileX: 5, tileY: 5, facing: 'down' },
    farm: { tiles: {}, unlockedZones: ['field_a'] },
    inventory: { slots, capacity: 12, selected: 0 },
    tools: { hoe: 1, wateringCan: 1 },
    economy: { gold: 100, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    progress: { xp: 0, profession, counters: {}, achievements: [], xpHistory: [] },
    pickups: [],
    dayLog: [],
  };
}

function stack(itemId: string, quality?: 'silver' | 'gold'): ItemStack {
  // Runtime ItemStack now carries optional quality (v2 shape) — no cast needed.
  return quality ? { itemId, count: 1, quality } : { itemId, count: 1 };
}

describe('qualityOf (tolerant accessor over v1/v2 stacks)', () => {
  it('reads absent / silver / gold; garbage degrades to normal', () => {
    expect(qualityOf(null)).toBe('normal');
    expect(qualityOf(stack('crop_turnip'))).toBe('normal');
    expect(qualityOf(stack('crop_turnip', 'silver'))).toBe('silver');
    expect(qualityOf(stack('crop_turnip', 'gold'))).toBe('gold');
    expect(qualityOf({ itemId: 'x', count: 1, quality: 'mystery' } as unknown as ItemStack)).toBe(
      'normal',
    );
  });
});

describe('quality marks (double encoding: shape + word, PRD 04 US45)', () => {
  it('normal is unmarked; silver/gold get distinct shape glyphs', () => {
    expect(qualityMark('normal')).toBe('');
    expect(qualityMark('silver')).not.toBe(qualityMark('gold'));
    expect(withQualityMark('芜菁', 'normal')).toBe('芜菁');
    expect(withQualityMark('芜菁', 'gold')).toContain('芜菁');
  });
});

describe('stackUnitSalePrice (single §4.5 pricing entry)', () => {
  it('gold turnip + horticulturist = 62 (§4.5 canonical example)', () => {
    expect(stackUnitSalePrice(makeState('horticulturist'), stack('crop_turnip', 'gold'))).toBe(62);
  });

  it('plain stacks price at base; non-sellables fall back to 0', () => {
    expect(stackUnitSalePrice(makeState(null), stack('crop_turnip'))).toBe(38);
    expect(stackUnitSalePrice(makeState(null), stack('hoe'))).toBe(0);
  });
});
