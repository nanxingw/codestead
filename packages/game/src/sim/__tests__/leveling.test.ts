/**
 * leveling.ts contract tests — threshold derivation, the M3 Lv10 cap (PRD 04 US36),
 * multi-level grant events incl. Lv6~10, XP hard cap, counters, and the §5.3 unlock
 * table view (GDD §5.1 / §5.3 / §5.5 / §5.6).
 */
import { describe, expect, it } from 'vitest';

import { bumpCounter, effectiveLevel, grantXp, levelForXp, unlocksForLevel } from '../leveling.js';
import { XP_CAP, XP_THRESHOLDS } from '../data/constants.js';
import { LEVEL_CAP_M3 } from '../profession.js';
import { makeWorldState, moduleReady } from './fixtures.js';

const DERIVE_READY = moduleReady(() => effectiveLevel(levelForXp(0)));
const GRANT_READY = moduleReady(() => grantXp(makeWorldState(), 1));
const COUNTER_READY = moduleReady(() => bumpCounter(makeWorldState(), 'tillCount', 1));

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(DERIVE_READY).toBe(true);
  expect(GRANT_READY).toBe(true);
  expect(COUNTER_READY).toBe(true);
});

describe('level derivation (GDD §5.1, ruling B-1 — never stored)', () => {
  // Boundary table: threshold k = cumulative XP to REACH Lv(k+1).
  it.each([
    [0, 1],
    [99, 1],
    [100, 2], // red line 1 target
    [379, 2],
    [380, 3],
    [769, 3],
    [770, 4],
    [1299, 4],
    [1300, 5],
    [2149, 5],
    [2150, 6],
    [3300, 7],
    [4800, 8],
    [6900, 9],
    [9999, 9],
    [10_000, 10],
    [15_000, 10], // mastery band — still Lv10
  ])('levelForXp(%i) === %i', (xp, level) => {
    expect(levelForXp(xp)).toBe(level);
  });

  it('M3 cap lift: effectiveLevel reaches Lv10, mastery band stays Lv10 (§5.3 / PRD 04 US36)', () => {
    expect(effectiveLevel(0)).toBe(1);
    expect(effectiveLevel(XP_THRESHOLDS[4])).toBe(5); // 1,300 → Lv5
    expect(effectiveLevel(XP_THRESHOLDS[5])).toBe(6); // 2,150 → Lv6 — M1 min(·,5) clamp is GONE
    expect(effectiveLevel(XP_THRESHOLDS[9])).toBe(10); // 10,000 → Lv10
    expect(effectiveLevel(XP_CAP)).toBe(10); // 15,000 mastery band — still Lv10 (LEVEL_CAP_M3)
    expect(effectiveLevel(XP_CAP)).toBe(LEVEL_CAP_M3);
    expect(levelForXp(XP_CAP)).toBe(10); // raw derivation agrees at the table maximum
  });
});

describe('grantXp (GDD §5.5 — one FarmLevelUp event per level)', () => {
  it('accumulates XP without level events below the next threshold', () => {
    const { state, events } = grantXp(makeWorldState(), 50);
    expect(state.progress.xp).toBe(50);
    expect(events.filter((e) => e.type === 'FarmLevelUp')).toHaveLength(0);
  });

  it('emits exactly one FarmLevelUp on crossing a single threshold', () => {
    const start = makeWorldState({
      progress: { xp: 95, profession: null, counters: {}, achievements: [], xpHistory: [] },
    });
    const { state, events } = grantXp(start, 10);
    expect(state.progress.xp).toBe(105);
    const ups = events.filter((e) => e.type === 'FarmLevelUp');
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({ level: 2 });
  });

  it('multi-level jump emits one event PER level, ascending (§5.5/§5.8)', () => {
    const { state, events } = grantXp(makeWorldState(), 500); // 0 → 500 crosses Lv2 & Lv3
    expect(state.progress.xp).toBe(500);
    const levels = events.flatMap((e) => (e.type === 'FarmLevelUp' ? [e.level] : []));
    expect(levels).toEqual([2, 3]);
  });

  it('one giant grant crosses past Lv5 with no cap stop (§5.8 acceptance, M3 lift)', () => {
    // §5.8's prose example says "grant 2,000 XP ⇒ Lv2..Lv6", but the §5.1 threshold
    // table (the numeric authority) puts Lv6 at 2,150 — so 2,000 stops at Lv5 and
    // 2,150 is the first amount that reaches Lv6 (discrepancy recorded for GDD
    // backfill; the table wins per the single-source discipline).
    const at2000 = grantXp(makeWorldState(), 2_000);
    expect(at2000.events.flatMap((e) => (e.type === 'FarmLevelUp' ? [e.level] : []))).toEqual([
      2, 3, 4, 5,
    ]);

    const toLv6 = grantXp(makeWorldState(), 2_150);
    expect(toLv6.events.flatMap((e) => (e.type === 'FarmLevelUp' ? [e.level] : []))).toEqual([
      2, 3, 4, 5, 6,
    ]); // the M1 build stopped this list at 5 — M3 keeps going
  });

  it('Lv6~10 events carry the §1.4 tilled caps (Lv7→32, Lv9→42; in-between inherit)', () => {
    const { events } = grantXp(makeWorldState(), XP_CAP); // one giant grant: Lv2..Lv10
    const ups = events.flatMap((e) => (e.type === 'FarmLevelUp' ? [e] : []));
    expect(ups.map((e) => e.level)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const capByLevel = Object.fromEntries(ups.map((e) => [e.level, e.tilledCap]));
    expect(capByLevel[6]).toBe(24); // inherits the Lv5 bracket
    expect(capByLevel[7]).toBe(32); // PRD 04 US42
    expect(capByLevel[8]).toBe(32);
    expect(capByLevel[9]).toBe(42);
    expect(capByLevel[10]).toBe(42);
  });

  it('clamps at the 15,000 XP hard cap (§5.1 mastery bar)', () => {
    const nearCap = makeWorldState({
      progress: {
        xp: XP_CAP - 10,
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    const { state } = grantXp(nearCap, 100);
    expect(state.progress.xp).toBe(XP_CAP);
    const atCap = grantXp(state, 50);
    expect(atCap.state.progress.xp).toBe(XP_CAP); // monotone, never exceeds
  });

  it('does not mutate the input state (pure)', () => {
    const start = makeWorldState();
    grantXp(start, 200);
    expect(start.progress.xp).toBe(0);
  });
});

describe('unlocksForLevel — §5.3 table as a pure join over the authority tables', () => {
  it('Lv6 row: sprinkler recipe + coop blueprint + farmhouse renovation I (§5.3)', () => {
    const lv6 = unlocksForLevel(6);
    expect(lv6.blueprintIds.sort()).toEqual(['coop', 'farmhouse_1', 'sprinkler']);
    expect(lv6.tilledCap).toBe(24);
    expect(lv6.capRaised).toBe(false);
    expect(lv6.professionChoice).toBe(false);
    expect(lv6.masteryBar).toBe(false);
  });

  it('Lv7/Lv9 rows raise the tilled cap to 32/42 alongside workshop/greenhouse (§5.3/§1.4)', () => {
    const lv7 = unlocksForLevel(7);
    expect(lv7.blueprintIds).toEqual(['workshop']);
    expect(lv7).toMatchObject({ tilledCap: 32, capRaised: true });

    const lv9 = unlocksForLevel(9);
    expect(lv9.blueprintIds).toEqual(['greenhouse']);
    expect(lv9).toMatchObject({ tilledCap: 42, capRaised: true });
  });

  it('Lv8 row: advanced sprinkler only — T4 crops are NOT in the table (B-11 out of scope)', () => {
    expect(unlocksForLevel(8).blueprintIds).toEqual(['sprinkler_advanced']);
  });

  it('Lv5 opens the certificate desk; Lv10 flips the mastery bar + memorial statue (§5.3)', () => {
    expect(unlocksForLevel(5).professionChoice).toBe(true);
    const lv10 = unlocksForLevel(10);
    expect(lv10.masteryBar).toBe(true);
    expect(lv10.blueprintIds.sort()).toEqual(['farmhouse_2', 'memorial_statue']);
  });

  it('M1 shop rows still join in (Lv2 = potato seeds + copper tools, §4.3)', () => {
    expect(unlocksForLevel(2).shopEntryIds.sort()).toEqual([
      'seed_potato',
      'tool_can_copper',
      'tool_hoe_copper',
    ]);
  });
});

describe('counters (GDD §5.6 — M1-core instrumentation only)', () => {
  it('bumps a fresh counter from absent → delta and accumulates further bumps', () => {
    const s1 = bumpCounter(makeWorldState(), 'harvestCount', 1);
    expect(s1.progress.counters.harvestCount).toBe(1);
    const s2 = bumpCounter(s1, 'harvestCount', 3);
    expect(s2.progress.counters.harvestCount).toBe(4);
  });

  it('supports the dynamic soldCrops:<cropId> ids (§5.6)', () => {
    const s = bumpCounter(makeWorldState(), 'soldCrops:radish_quick', 10);
    expect(s.progress.counters['soldCrops:radish_quick']).toBe(10);
  });
});
