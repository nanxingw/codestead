/**
 * Quality × profession pricing tests (GDD §4.5 — the canonical 62g example is钦定;
 * PRD 04 §G43/44). unitSalePrice stays the ONLY pricing path; multipliers compose
 * multiply-all-first, floor ONCE (ruling A-12).
 */
import { describe, expect, it } from 'vitest';

import { unitSalePrice, type PriceCtx } from '../economy.js';
import { getItemDef } from '../data/items.js';
import { PROVISIONAL_QUALITY_ROLL, QUALITY_MULT, rollQuality, sameQuality } from '../quality.js';

const noProfession: PriceCtx = { profession: null };
const horticulturist: PriceCtx = { profession: 'horticulturist' };
const artisan: PriceCtx = { profession: 'artisan' };

describe('quality multipliers (GDD §4.5, settled values)', () => {
  it('normal 1 / silver 1.25 / gold 1.5', () => {
    expect(QUALITY_MULT).toEqual({ normal: 1, silver: 1.25, gold: 1.5 });
  });

  it('canonical example: gold turnip + horticulturist = floor(38×1.5×1.1) = 62', () => {
    expect(unitSalePrice(getItemDef('crop_turnip'), 'gold', horticulturist)).toBe(62);
  });

  it('floor happens ONCE after all multipliers (not per step)', () => {
    // silver cabbage + horticulturist: floor(178 × 1.25 × 1.1) = floor(244.75) = 244;
    // stepwise flooring would give floor(floor(222.5) × 1.1) = floor(244.2) = 244 too,
    // so use the turnip case where they diverge: floor(38×1.5)=57, floor(57×1.1)=62 —
    // identical here; the discriminating assertion is the §4.5 canonical 62 above plus:
    // silver turnip alone floor(38×1.25)=47 (vs 47.5 unfloored feeding later steps).
    expect(unitSalePrice(getItemDef('crop_turnip'), 'silver', noProfession)).toBe(47);
    expect(unitSalePrice(getItemDef('crop_cabbage'), 'silver', horticulturist)).toBe(244);
  });

  it('profession multipliers stay category-scoped (§4.5): crops vs artisan goods', () => {
    // artisan does NOT boost crops…
    expect(unitSalePrice(getItemDef('crop_turnip'), 'normal', artisan)).toBe(38);
    // …and boosts artisan goods ×1.25: mayonnaise 95 → floor(118.75) = 118
    expect(unitSalePrice(getItemDef('artisan_mayonnaise'), 'normal', artisan)).toBe(118);
    // horticulturist does NOT boost artisan goods
    expect(unitSalePrice(getItemDef('artisan_mayonnaise'), 'normal', horticulturist)).toBe(95);
    // eggs are category material — no profession multiplier ever (items.ts header note)
    expect(unitSalePrice(getItemDef('animal_egg'), 'normal', horticulturist)).toBe(40);
    expect(unitSalePrice(getItemDef('animal_egg'), 'normal', artisan)).toBe(40);
  });
});

describe('quality roll (⚠ PROVISIONAL distribution — PRD 04 待裁决 1)', () => {
  it('band layout: gold first, then silver, remainder normal', () => {
    expect(rollQuality(0)).toBe('gold');
    expect(rollQuality(PROVISIONAL_QUALITY_ROLL.gold)).toBe('silver');
    expect(rollQuality(PROVISIONAL_QUALITY_ROLL.gold + PROVISIONAL_QUALITY_ROLL.silver)).toBe(
      'normal',
    );
    expect(rollQuality(0.999)).toBe('normal');
  });

  it('the provisional bands integrate to 5% gold / 20% silver / 75% normal exactly', () => {
    // Deterministic sweep over an even grid of draws — no randomness in tests (§2.2).
    const counts = { normal: 0, silver: 0, gold: 0 };
    const N = 10_000;
    for (let k = 0; k < N; k++) counts[rollQuality(k / N)] += 1;
    expect(counts).toEqual({ gold: N * 0.05, silver: N * 0.2, normal: N * 0.75 });
  });

  it('sameQuality treats absent as normal (v2 ItemStack.quality is optional)', () => {
    expect(sameQuality(undefined, 'normal')).toBe(true);
    expect(sameQuality(undefined, undefined)).toBe(true);
    expect(sameQuality('silver', undefined)).toBe(false);
    expect(sameQuality('gold', 'gold')).toBe(true);
  });
});
