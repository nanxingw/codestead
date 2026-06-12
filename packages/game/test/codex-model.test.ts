/**
 * codex-model.test.ts — 图鉴 pagination model (M3, GDD §4.8/§5.8; PRD 04 US49/US50).
 */
import { describe, expect, it } from 'vitest';

import { codexEligibleItems } from '../src/sim/codex';
import type { ItemStack, WorldState } from '../src/sim/types';
import { codexPages, cyclePage, CODEX_PAGE_CATEGORIES } from '../src/ui/panels/codex-model';

function makeState(collectionLog: Record<string, { firstSoldDay: number }> = {}): WorldState {
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
    economy: { gold: 100, shippingBin: [], collectionLog, newEntriesSeenDay: {} },
    progress: { xp: 0, profession: null, counters: {}, achievements: [], xpHistory: [] },
    pickups: [],
    dayLog: [],
  };
}

describe('codexPages (data: sim/codex collectionLog since M1)', () => {
  it('covers every codex-eligible item exactly once across the pages', () => {
    const view = codexPages(makeState());
    const pageItemCount = view.pages.reduce((sum, p) => sum + p.entries.length, 0);
    expect(pageItemCount).toBe(codexEligibleItems().length);
    expect(view.total).toBe(codexEligibleItems().length);
    expect(view.collected).toBe(0); // fresh save: all silhouettes
  });

  it('first-sold entries light up with their day; the rest stay silhouettes', () => {
    const view = codexPages(makeState({ crop_turnip: { firstSoldDay: 3 } }));
    const cropPage = view.pages.find((p) => p.category === 'crop');
    expect(cropPage?.entries.find((e) => e.itemId === 'crop_turnip')?.firstSoldDay).toBe(3);
    expect(cropPage?.collected).toBe(1);
    expect(view.collected).toBe(1);
  });

  it('unknown ids in the log are tolerated (forward compat, §5.8 rule)', () => {
    const view = codexPages(makeState({ future_item_v9: { firstSoldDay: 1 } }));
    expect(view.collected).toBe(0); // ignored, never crashes
  });

  it('page order follows the §6.1 category order', () => {
    const view = codexPages(makeState());
    const order = view.pages.map((p) => p.category);
    expect(order).toEqual(CODEX_PAGE_CATEGORIES.filter((category) => order.includes(category)));
  });
});

describe('cyclePage', () => {
  it('wraps in both directions and survives zero pages', () => {
    expect(cyclePage(0, 1, 3)).toBe(1);
    expect(cyclePage(2, 1, 3)).toBe(0);
    expect(cyclePage(0, -1, 3)).toBe(2);
    expect(cyclePage(0, 1, 0)).toBe(0);
  });
});
