/**
 * Crop data table — 15 crops, transcribed row-by-row from game-design.md §3.6.
 *
 * Authority: GDD §3.6 is the ONLY source for these numbers. Do not edit values here
 * without first amending the GDD (doc-first rule, PRD 01 US113).
 *
 * M1 gameplay exposes only the first 6 (spring) crops; the other 9 are M3 data,
 * present from day one so M3 crop rollout is pure data unlocking (PRD 01 US47).
 *
 * Data admission tests required (GDD §3.6 / §4.4, to be written by the implementer):
 * ① sum(stageDays) === growthDays; ② single-harvest gpd within tier band;
 * ③ regrow full-season gpd ≤ T2 9.0 / T3 12.0; ④ M3 crop XP === ⌊16×ln(0.018×sellPrice+1)⌋;
 * ⑤ economy admission checklist I1~I7 (crop-pricing.test.ts).
 */
import type { Season } from '@codestead/shared';

export interface CropDef {
  readonly id: string;
  /** i18n key; display strings never live in sim. Convention: `crop.<id>`. */
  readonly nameKey: string;
  readonly tier: 1 | 2 | 3;
  readonly seasons: readonly Season[]; // sunflower: ['summer','fall']
  readonly seedPrice: number;
  readonly sellPrice: number; // per harvest for regrow crops
  /** === sum(stageDays); asserted by unit test. */
  readonly growthDays: number;
  readonly stageDays: readonly number[];
  readonly regrowDays?: number;
  /** Regrow harvest cap (bean_vine 8 / berry 6); initializes CropState.harvestsLeft.
   * M3 regrow crops have no cap (season change bounds them naturally, GDD §3.6). */
  readonly regrowLimit?: number;
  readonly xpHarvest: number; // per harvest
  readonly unlockLevel: number;
  /** Atlas row, table order. Frame keys (`crop_{id}_s{n}`, §11.4) are the binding art
   * contract; spriteRow values are not specified in the GDD table — see openQuestions. */
  readonly spriteRow: number;
}

const CROP_TABLE = [
  // ---- M1 (spring, constitution-designated six) ----
  // id, season, tier, unlock Lv, seed, sell, growth, regrow, stageDays, xp
  {
    id: 'radish_quick',
    nameKey: 'crop.radish_quick',
    tier: 1,
    seasons: ['spring'],
    seedPrice: 10,
    sellPrice: 18,
    growthDays: 2,
    stageDays: [1, 1],
    xpHarvest: 6,
    unlockLevel: 1,
    spriteRow: 0,
  },
  {
    id: 'turnip',
    nameKey: 'crop.turnip',
    tier: 1,
    seasons: ['spring'],
    seedPrice: 20,
    sellPrice: 38,
    growthDays: 4,
    stageDays: [1, 1, 2],
    xpHarvest: 9,
    unlockLevel: 1,
    spriteRow: 1,
  },
  {
    id: 'potato',
    nameKey: 'crop.potato',
    tier: 2,
    seasons: ['spring'],
    seedPrice: 50,
    sellPrice: 89,
    growthDays: 6,
    stageDays: [1, 1, 2, 2],
    xpHarvest: 14,
    unlockLevel: 2,
    spriteRow: 2,
  },
  {
    id: 'bean_vine',
    nameKey: 'crop.bean_vine',
    tier: 2,
    seasons: ['spring'],
    seedPrice: 60,
    sellPrice: 30, // per harvest
    growthDays: 8,
    stageDays: [1, 2, 2, 3],
    regrowDays: 2,
    regrowLimit: 8,
    xpHarvest: 9,
    unlockLevel: 3,
    spriteRow: 3,
  },
  {
    id: 'cabbage',
    nameKey: 'crop.cabbage',
    tier: 3,
    seasons: ['spring'],
    seedPrice: 80,
    sellPrice: 178,
    growthDays: 10,
    stageDays: [1, 2, 3, 4],
    xpHarvest: 22,
    unlockLevel: 4,
    spriteRow: 4,
  },
  {
    id: 'berry',
    nameKey: 'crop.berry',
    tier: 3,
    seasons: ['spring'],
    seedPrice: 100,
    sellPrice: 60, // per harvest
    growthDays: 8,
    stageDays: [1, 2, 2, 3],
    regrowDays: 3,
    regrowLimit: 6,
    xpHarvest: 16,
    unlockLevel: 5,
    spriteRow: 5,
  },
  // ---- M3 (summer/fall; data only in M1) ----
  {
    id: 'chili',
    nameKey: 'crop.chili',
    tier: 1,
    seasons: ['summer'],
    seedPrice: 15,
    sellPrice: 27,
    growthDays: 3,
    stageDays: [1, 1, 1],
    xpHarvest: 6,
    unlockLevel: 1,
    spriteRow: 6,
  },
  {
    id: 'sunflower',
    nameKey: 'crop.sunflower',
    tier: 1,
    seasons: ['summer', 'fall'],
    seedPrice: 30,
    sellPrice: 54,
    growthDays: 6,
    stageDays: [1, 2, 3],
    xpHarvest: 10,
    unlockLevel: 2,
    spriteRow: 7,
  },
  {
    id: 'tomato',
    nameKey: 'crop.tomato',
    tier: 2,
    seasons: ['summer'],
    seedPrice: 60,
    sellPrice: 40, // per harvest
    growthDays: 7,
    stageDays: [1, 2, 2, 2],
    regrowDays: 3,
    xpHarvest: 8,
    unlockLevel: 5,
    spriteRow: 8,
  },
  {
    id: 'corn',
    nameKey: 'crop.corn',
    tier: 2,
    seasons: ['summer'],
    seedPrice: 75,
    sellPrice: 125,
    growthDays: 7,
    stageDays: [1, 2, 2, 2],
    xpHarvest: 18,
    unlockLevel: 6,
    spriteRow: 9,
  },
  {
    id: 'melon',
    nameKey: 'crop.melon',
    tier: 3,
    seasons: ['summer'],
    seedPrice: 120,
    sellPrice: 250,
    growthDays: 12,
    stageDays: [1, 2, 3, 3, 3],
    xpHarvest: 27,
    unlockLevel: 7,
    spriteRow: 10,
  },
  {
    id: 'wheat',
    nameKey: 'crop.wheat',
    tier: 1,
    seasons: ['fall'],
    seedPrice: 12,
    sellPrice: 24,
    growthDays: 3,
    stageDays: [1, 1, 1],
    xpHarvest: 5,
    unlockLevel: 1,
    spriteRow: 11,
  },
  {
    id: 'eggplant',
    nameKey: 'crop.eggplant',
    tier: 2,
    seasons: ['fall'],
    seedPrice: 50,
    sellPrice: 36, // per harvest
    growthDays: 6,
    stageDays: [1, 2, 3],
    regrowDays: 3,
    xpHarvest: 7,
    unlockLevel: 6,
    spriteRow: 12,
  },
  {
    id: 'cranberry',
    nameKey: 'crop.cranberry',
    tier: 3,
    seasons: ['fall'],
    seedPrice: 150,
    sellPrice: 40, // per harvest
    growthDays: 7,
    stageDays: [1, 2, 2, 2],
    regrowDays: 2,
    xpHarvest: 8,
    unlockLevel: 8,
    spriteRow: 13,
  },
  {
    id: 'pumpkin',
    nameKey: 'crop.pumpkin',
    tier: 3,
    seasons: ['fall'],
    seedPrice: 140,
    sellPrice: 280,
    growthDays: 13,
    stageDays: [1, 2, 3, 3, 4],
    xpHarvest: 28,
    unlockLevel: 9,
    spriteRow: 14,
  },
] as const satisfies readonly CropDef[];

/** Narrow union of all crop ids — the type other modules should use. */
export type CropId = (typeof CROP_TABLE)[number]['id'];

/**
 * The 15-crop table, exposed with the uniform CropDef shape (so optional fields like
 * regrowDays/regrowLimit are accessible on every row) while keeping ids narrowed to
 * the CropId union. The literal table above stays the type-checked source.
 */
export const CROPS: readonly (CropDef & { readonly id: CropId })[] = CROP_TABLE;

/** The six crops obtainable in M1 gameplay (GDD §3.6 "M1 = 前 6 种，宪法钦定"). */
export const M1_CROP_IDS = [
  'radish_quick',
  'turnip',
  'potato',
  'bean_vine',
  'cabbage',
  'berry',
] as const satisfies readonly CropId[];

export const CROPS_BY_ID: ReadonlyMap<CropId, CropDef> = new Map(CROPS.map((c) => [c.id, c]));

export function getCropDef(cropId: CropId): CropDef {
  const def = CROPS_BY_ID.get(cropId);
  if (!def) throw new Error(`Unknown cropId: ${cropId}`);
  return def;
}
