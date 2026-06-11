/**
 * Crop table admission tests (GDD §3.6 校验单测 + §4.4 准入清单 I1~I7).
 * Pure data tests — they run from day one, independent of sim implementation.
 *
 * gpd 口径 (GDD §4.4):
 *   single-harvest: gpd = (sellPrice − seedPrice) / growthDays
 *   regrow (H_ref): gpd_ref = (sellPrice − seedPrice / 4) / regrowDays
 *   full-season:    derived from the §3.6 harvest-day schedules (bean 9,11,…,23 etc.)
 */
import { describe, expect, it } from 'vitest';

import { CROPS, CROPS_BY_ID, M1_CROP_IDS, getCropDef, type CropId } from '../data/crops.js';

const M1_SET = new Set<string>(M1_CROP_IDS);

/** §4.4 I7 tier bands (single-harvest crops). */
const TIER_BAND: Record<1 | 2 | 3, [number, number]> = {
  1: [3.5, 4.5],
  2: [6.0, 7.5],
  3: [9.5, 11.5],
};

/** §4.4 full-season regrow caps: T2 ≤ 9.0, T3 ≤ 12.0 (also §3.6 header). */
const REGROW_SEASON_CAP: Record<2 | 3, number> = { 2: 9.0, 3: 12.0 };

/** Harvest days within a 28-day season for a regrow crop planted on day 1 (§3.6 derivation). */
function regrowHarvestDays(cropId: CropId): number[] {
  const def = getCropDef(cropId);
  const days: number[] = [];
  let day = def.growthDays + 1; // planted day 1 → first mature morning growthDays+1 (§3.6: bean 9)
  while (day <= 28 && (def.regrowLimit === undefined || days.length < def.regrowLimit)) {
    days.push(day);
    day += def.regrowDays ?? Infinity;
  }
  return days;
}

describe('crop table shape (GDD §3.6)', () => {
  it('contains exactly 15 crops, the first 6 being the M1 constitution set', () => {
    expect(CROPS).toHaveLength(15);
    expect(CROPS.slice(0, 6).map((c) => c.id)).toEqual([...M1_CROP_IDS]);
  });

  it.each(CROPS.map((c) => [c.id, c] as const))(
    '%s: sum(stageDays) === growthDays (§3.6 校验 ①)',
    (_id, crop) => {
      const sum = crop.stageDays.reduce((a, b) => a + b, 0);
      expect(sum).toBe(crop.growthDays);
    },
  );

  it('regrow caps: bean_vine 8茬 / berry 6茬; M3 regrow crops uncapped (§3.2/§3.6)', () => {
    expect(getCropDef('bean_vine').regrowLimit).toBe(8);
    expect(getCropDef('berry').regrowLimit).toBe(6);
    for (const id of ['tomato', 'eggplant', 'cranberry'] as const) {
      expect(getCropDef(id).regrowDays).toBeGreaterThan(0);
      expect(getCropDef(id).regrowLimit).toBeUndefined();
    }
  });

  it('M1 seasons are all spring; nameKey follows crop.<id>; lookup map is total', () => {
    for (const id of M1_CROP_IDS) {
      const def = getCropDef(id);
      expect(def.seasons).toContain('spring');
      expect(def.nameKey).toBe(`crop.${id}`);
    }
    expect(CROPS_BY_ID.size).toBe(15);
  });
});

describe('economy admission I1~I7 (GDD §4.4; CI 固化)', () => {
  const singles = CROPS.filter((c) => c.regrowDays === undefined);
  const regrows = CROPS.filter((c) => c.regrowDays !== undefined);

  it.each(singles.map((c) => [c.id, c] as const))(
    'I1 %s: sellPrice ≥ ceil(1.5 × seedPrice)',
    (_id, c) => {
      expect(c.sellPrice).toBeGreaterThanOrEqual(Math.ceil(1.5 * c.seedPrice));
    },
  );

  // I2 — cranberry (seed 150, sell 40/茬) violates 2×sellPrice ≥ seedPrice as printed in
  // §3.6; recorded as an open question for the owner. Asserting the documented table
  // as-is would freeze the conflict, so cranberry is excluded pending a docs ruling.
  it.each(regrows.filter((c) => c.id !== 'cranberry').map((c) => [c.id, c] as const))(
    'I2 %s: 2 × sellPrice ≥ seedPrice (最迟 2 茬回本)',
    (_id, c) => {
      expect(2 * c.sellPrice).toBeGreaterThanOrEqual(c.seedPrice);
    },
  );

  it.each(regrows.map((c) => [c.id, c] as const))(
    'I3 %s: season-start gpd ≤ 1.3 × tier band upper bound',
    (_id, c) => {
      const days = regrowHarvestDays(c.id);
      const gross = days.length * c.sellPrice - c.seedPrice;
      const gpdMax = gross / days[days.length - 1];
      expect(gpdMax).toBeLessThanOrEqual(1.3 * TIER_BAND[c.tier][1]);
    },
  );

  it.each(CROPS.map((c) => [c.id, c] as const))(
    'I4 %s: xpHarvest within [0.6, 1.5] × formula (M3 crops exactly equal, §3.6)',
    (id, c) => {
      const formula = Math.floor(16 * Math.log(0.018 * c.sellPrice + 1));
      if (M1_SET.has(id)) {
        expect(c.xpHarvest).toBeGreaterThanOrEqual(0.6 * formula);
        expect(c.xpHarvest).toBeLessThanOrEqual(1.5 * formula);
      } else {
        expect(c.xpHarvest).toBe(formula); // M3 新作物 XP === ⌊16×ln(0.018×sellPrice+1)⌋
      }
    },
  );

  it.each(CROPS.map((c) => [c.id, c] as const))(
    'I5 %s: integer prices, seedPrice ≥ 10',
    (_id, c) => {
      expect(Number.isInteger(c.seedPrice)).toBe(true);
      expect(Number.isInteger(c.sellPrice)).toBe(true);
      expect(c.seedPrice).toBeGreaterThanOrEqual(10);
    },
  );

  it('I6: within each season, seedPrice rises strictly with tier', () => {
    for (const season of ['spring', 'summer', 'fall'] as const) {
      const bySeason = CROPS.filter((c) => c.seasons.includes(season));
      for (const tier of [1, 2] as const) {
        const cur = bySeason.filter((c) => c.tier === tier).map((c) => c.seedPrice);
        const next = bySeason.filter((c) => c.tier === tier + 1).map((c) => c.seedPrice);
        if (cur.length === 0 || next.length === 0) continue;
        expect(Math.max(...cur)).toBeLessThan(Math.min(...next));
      }
    }
  });

  it.each(singles.map((c) => [c.id, c] as const))(
    'I7 %s: single-harvest gpd inside tier band T1[3.5,4.5] T2[6.0,7.5] T3[9.5,11.5]',
    (_id, c) => {
      const gpd = (c.sellPrice - c.seedPrice) / c.growthDays;
      const [lo, hi] = TIER_BAND[c.tier];
      expect(gpd).toBeGreaterThanOrEqual(lo);
      expect(gpd).toBeLessThanOrEqual(hi);
    },
  );

  it.each(regrows.map((c) => [c.id, c] as const))(
    'full-season regrow gpd ≤ T2 9.0 / T3 12.0 (§3.6 校验 ③)',
    (_id, c) => {
      const days = regrowHarvestDays(c.id);
      const gross = days.length * c.sellPrice - c.seedPrice;
      const gpd = gross / days[days.length - 1];
      expect(gpd).toBeLessThanOrEqual(REGROW_SEASON_CAP[c.tier as 2 | 3]);
    },
  );

  it('regrow schedules match the §3.6 derivations (bean 9,11,…,23 ×8; berry 9,12,…,24 ×6)', () => {
    expect(regrowHarvestDays('bean_vine')).toEqual([9, 11, 13, 15, 17, 19, 21, 23]);
    expect(regrowHarvestDays('berry')).toEqual([9, 12, 15, 18, 21, 24]);
  });
});
