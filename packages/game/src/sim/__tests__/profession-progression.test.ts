/**
 * M3 progression — Lv6~10 unlock ladder, retro catch-up, the Lv5 profession choice and
 * the pricing single-entry proof (GDD §5.1/§5.3/§4.5; PRD 04 §F36~39, US37).
 *
 * Mixed gating: pure data/derivation tests run NOW; tests against the cap lift and the
 * profession/retro reducers gate on their probes (m3-probe.ts) and arm automatically.
 *
 * Note on the task wording "horticulturist vs rancher": the GDD enum (ruling A-13) is
 * 'horticulturist' | 'artisan' — there is no rancher profession; the comparison here
 * is horticulturist vs artisan, the two §5.3 signatures.
 */
import { describe, expect, it } from 'vitest';

import { unitSalePrice, settleShipping, type PriceCtx } from '../economy.js';
import { getBlueprint } from '../data/buildings.js';
import { cropItemId, getItemDef, jamItemId } from '../data/items.js';
import { M1_CROP_IDS } from '../data/crops.js';
import { effectiveLevel, grantXp, levelForXp } from '../leveling.js';
import {
  canChooseProfession,
  chooseProfession,
  LEVEL_CAP_M3,
  PROFESSION_MIN_LEVEL,
  retroLevelUpEvents,
} from '../profession.js';
import { rollQuality, type Quality } from '../quality.js';
import { rngNext } from '../time.js';
import { tilledCapForLevel } from '../tiles.js';
import { makeWorldState, TEST_RNG_STATE, xpForLevel } from './fixtures.js';
import { m3Implemented } from './m3-probe.js';

// ---- ungated: the §5.1/§5.3 ladder is pure data ----

describe('Lv6~10 ladder (GDD §5.1 thresholds × §5.3 unlock table)', () => {
  it.each([
    [2_150, 6],
    [3_300, 7],
    [4_800, 8],
    [6_900, 9],
    [10_000, 10],
    [15_000, 10], // XP cap — Lv10 is terminal
  ] as const)('xp %d derives Lv%d', (xp, level) => {
    expect(levelForXp(xp)).toBe(level);
    expect(levelForXp(xp - 1)).toBe(level === 10 && xp === 15_000 ? 10 : level - 1);
  });

  it('M3 constants: cap 10, certificate desk opens at Lv5 (§5.3)', () => {
    expect(LEVEL_CAP_M3).toBe(10);
    expect(PROFESSION_MIN_LEVEL).toBe(5);
  });

  it('blueprint unlock levels follow the §5.3 rows not already pinned elsewhere', () => {
    expect(getBlueprint('storage_chest').unlock.farmLevel).toBe(3); // Lv3 教学件
    expect(getBlueprint('fence').unlock.farmLevel).toBe(3);
    expect(getBlueprint('stone_path').unlock.farmLevel).toBe(3);
    expect(getBlueprint('drying_rack').unlock.farmLevel).toBe(4); // Lv4
    expect(getBlueprint('flower_bed').unlock.farmLevel).toBe(4);
    expect(getBlueprint('bench').unlock.farmLevel).toBe(4);
    expect(getBlueprint('lamp_post').unlock.farmLevel).toBe(4);
    const statue = getBlueprint('memorial_statue'); // Lv10 / #21 reward (provisional)
    expect(statue.unlock.farmLevel).toBe(10);
    expect(statue.limit).toBe(1);
    expect(statue.cost.gold).toBe(0);
  });

  it('tilled caps for the M3 levels: Lv7=32, Lv9=42, intermediates inherit (§1.4)', () => {
    expect(tilledCapForLevel(6)).toBe(24);
    expect(tilledCapForLevel(7)).toBe(32);
    expect(tilledCapForLevel(8)).toBe(32);
    expect(tilledCapForLevel(9)).toBe(42);
    expect(tilledCapForLevel(10)).toBe(42);
  });
});

// ---- gated: the M1 min(·,5) clamp must fall (task: cap lift) ----

const CAP_LIFTED = effectiveLevel(xpForLevel(6)) === 6;

it.skipIf(CAP_LIFTED)('cap-lift tests pending — arm when effectiveLevel loses min(·,5)', () => {
  expect(CAP_LIFTED).toBe(false);
});

describe.skipIf(!CAP_LIFTED)('level cap lifted to 10 (GDD §5.3 M3 迁移)', () => {
  it('effectiveLevel tracks levelForXp through Lv10', () => {
    for (const level of [6, 7, 8, 9, 10] as const) {
      expect(effectiveLevel(xpForLevel(level))).toBe(level);
    }
    expect(effectiveLevel(15_000)).toBe(10);
  });

  it('a multi-level XP grant emits one FarmLevelUp PER level with §1.4 caps', () => {
    const state = makeWorldState({
      progress: {
        xp: xpForLevel(5),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    const { events } = grantXp(state, xpForLevel(7) - xpForLevel(5));
    const ups = events.filter((e) => e.type === 'FarmLevelUp');
    expect(ups).toEqual([
      { type: 'FarmLevelUp', level: 6, tilledCap: 24 },
      { type: 'FarmLevelUp', level: 7, tilledCap: 32 },
    ]);
  });
});

// ---- gated: retro catch-up (§5.5 acceptance; PRD 04 US37) ----

const RETRO_READY = m3Implemented(() => retroLevelUpEvents(2_400, 5));

it.skipIf(RETRO_READY)('retro catch-up tests pending — arm when retroLevelUpEvents lands', () => {
  expect(RETRO_READY).toBe(false);
});

describe.skipIf(!RETRO_READY)('retroLevelUpEvents (load-time catch-up, §5.3/§5.5)', () => {
  it('canonical fixture: xp 2,400 from Lv5 ⇒ exactly [Lv6]', () => {
    expect(retroLevelUpEvents(2_400, 5)).toEqual([
      { type: 'FarmLevelUp', level: 6, tilledCap: tilledCapForLevel(6) },
    ]);
  });

  it('a maxed save replays Lv6..Lv10 in ascending order', () => {
    const events = retroLevelUpEvents(xpForLevel(10), 5);
    expect(events.map((e) => (e.type === 'FarmLevelUp' ? e.level : -1))).toEqual([6, 7, 8, 9, 10]);
    for (const e of events) {
      if (e.type === 'FarmLevelUp') expect(e.tilledCap).toBe(tilledCapForLevel(e.level));
    }
  });

  it('no catch-up needed ⇒ no events (xp within the old cap)', () => {
    expect(retroLevelUpEvents(1_300, 5)).toEqual([]);
    expect(retroLevelUpEvents(2_149, 5)).toEqual([]);
  });
});

// ---- gated: the irreversible Lv5 choice (§5.3; ruling A-13) ----

const PROFESSION_READY = m3Implemented(() => canChooseProfession(makeWorldState()));

function levelState(level: number, profession: 'horticulturist' | 'artisan' | null = null) {
  return makeWorldState({
    progress: {
      xp: xpForLevel(level),
      profession,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
  });
}

it.skipIf(PROFESSION_READY)('profession tests pending — arm when sim/profession.ts lands', () => {
  expect(PROFESSION_READY).toBe(false);
});

describe.skipIf(!PROFESSION_READY)('certificate desk (GDD §5.3; PRD 04 §F38)', () => {
  it('below Lv5: not allowed, reason LEVEL_TOO_LOW; never blocks leveling itself', () => {
    expect(canChooseProfession(levelState(4))).toMatchObject({
      allowed: false,
      current: null,
      reason: 'LEVEL_TOO_LOW',
    });
    expect(chooseProfession(levelState(4), 'horticulturist')).toEqual({
      ok: false,
      error: 'LEVEL_TOO_LOW',
    });
  });

  it('Lv5+: choosing sets the profession and emits ProfessionChosen', () => {
    const result = chooseProfession(levelState(5), 'artisan');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.progress.profession).toBe('artisan');
    expect(result.events).toContainEqual({ type: 'ProfessionChosen', profession: 'artisan' });
  });

  it('irreversible forever: a second choice is impossible, even to the same one', () => {
    expect(canChooseProfession(levelState(7, 'horticulturist'))).toMatchObject({
      allowed: false,
      current: 'horticulturist',
      reason: 'ALREADY_CHOSEN',
    });
    expect(chooseProfession(levelState(7, 'horticulturist'), 'artisan')).toEqual({
      ok: false,
      error: 'ALREADY_CHOSEN',
    });
    expect(chooseProfession(levelState(7, 'artisan'), 'artisan')).toEqual({
      ok: false,
      error: 'ALREADY_CHOSEN',
    });
  });
});

// ---- ungated: profession multipliers live ONLY in the pricing single entry (§4.5) ----

describe('pricing single entry — horticulturist vs artisan (GDD §4.5/§5.3)', () => {
  const none: PriceCtx = { profession: null };
  const horti: PriceCtx = { profession: 'horticulturist' };
  const artisan: PriceCtx = { profession: 'artisan' };

  it.each(M1_CROP_IDS.map((id) => [id] as const))(
    '%s: horticulturist ×1.10 on the crop; artisan ×1.25 on its jam — never crossed',
    (cropId) => {
      const crop = getItemDef(cropItemId(cropId));
      const jam = getItemDef(jamItemId(cropId));
      expect(unitSalePrice(crop, 'normal', horti)).toBe(Math.floor(crop.sellPrice! * 1.1));
      expect(unitSalePrice(crop, 'normal', artisan)).toBe(crop.sellPrice);
      expect(unitSalePrice(jam, 'normal', artisan)).toBe(Math.floor(jam.sellPrice! * 1.25));
      expect(unitSalePrice(jam, 'normal', horti)).toBe(jam.sellPrice);
      expect(unitSalePrice(crop, 'normal', none)).toBe(crop.sellPrice);
    },
  );

  it('settlement walks through the SAME entry: profession changes shipping income', () => {
    const base = makeWorldState({
      economy: {
        gold: 0,
        shippingBin: [{ itemId: 'crop_turnip', count: 10 }],
        collectionLog: {},
        newEntriesSeenDay: {},
      },
    });
    const plain = settleShipping(base);
    expect(plain.shipped).toEqual([{ itemId: 'crop_turnip', count: 10, gold: 380 }]);

    const blessed = structuredClone(base);
    blessed.progress.profession = 'horticulturist';
    const boosted = settleShipping(blessed);
    // floor PER UNIT then ×count: floor(38 × 1.1) = 41 → 410 (single entry, A-12)
    expect(boosted.shipped).toEqual([{ itemId: 'crop_turnip', count: 10, gold: 410 }]);
  });
});

// ---- ungated: quality probability determinism (seeded sfc32) + pricing法则 ----

describe('quality roll determinism (PRD 04 待裁决 1 — distribution PROVISIONAL)', () => {
  function rollSequence(seed: string, n: number): Quality[] {
    const out: Quality[] = [];
    let rngState = seed;
    for (let i = 0; i < n; i++) {
      const draw = rngNext(rngState);
      rngState = draw.rngState;
      out.push(rollQuality(draw.value));
    }
    return out;
  }

  it('same rngState seed ⇒ identical 200-roll sequence (replay determinism, §2.2)', () => {
    const a = rollSequence(TEST_RNG_STATE, 200);
    const b = rollSequence(TEST_RNG_STATE, 200);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(1); // the stream actually varies
  });

  it('different seeds may diverge but stay inside the three-grade domain', () => {
    const other = rollSequence('fedcba9876543210fedcba9876543210', 200);
    for (const q of other) expect(['normal', 'silver', 'gold']).toContain(q);
  });

  it('rolled qualities price monotonically through the single entry (§4.5)', () => {
    const turnip = getItemDef('crop_turnip');
    const ctx: PriceCtx = { profession: 'horticulturist' };
    const prices = (['normal', 'silver', 'gold'] as const).map((q) =>
      unitSalePrice(turnip, q, ctx),
    );
    expect(prices[0]).toBeLessThan(prices[1]);
    expect(prices[1]).toBeLessThan(prices[2]);
    expect(prices[2]).toBe(62); // §4.5 canonical
  });
});
