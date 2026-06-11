/**
 * leveling.ts contract tests — threshold derivation, M1 cap, multi-level grant events,
 * XP hard cap, counters (GDD §5.1 / §5.3 / §5.5 / §5.6). Gated on TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import { bumpCounter, effectiveLevel, grantXp, levelForXp } from '../leveling.js';
import { XP_CAP, XP_THRESHOLDS } from '../data/constants.js';
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

  it('effectiveLevel caps at 5 in M1 while raw level keeps deriving (§5.3)', () => {
    expect(effectiveLevel(0)).toBe(1);
    expect(effectiveLevel(XP_THRESHOLDS[4])).toBe(5); // 1,300 → Lv5
    expect(effectiveLevel(XP_THRESHOLDS[5])).toBe(5); // 2,150 → raw Lv6, capped
    expect(effectiveLevel(XP_CAP)).toBe(5);
    expect(levelForXp(XP_THRESHOLDS[5])).toBe(6); // raw derivation is NOT capped
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
