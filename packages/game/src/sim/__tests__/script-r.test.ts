/**
 * Income-curve & pacing acceptance — baseline script R day-by-day replay
 * (GDD §4.6 验收带宽 / §5.4 红线 1 复验 / §4.8 V4 zero-op regression / §2.2 determinism).
 * Gated on TODO(M1) skeletons; runs headless in milliseconds once the sim lands.
 */
import { describe, expect, it } from 'vitest';

import { createSim, newGameSim } from '../sim.js';
import { TEST_MAP, makeSave, moduleReady } from './fixtures.js';
import { runScriptR, type ScriptRDayRecord } from './script-r.js';

const FACADE_READY = moduleReady(() => {
  const sim = newGameSim('script-r-probe', TEST_MAP);
  sim.queryAction({ x: 22, y: 14 }, 'hoe');
  sim.dispatch({ type: 'interact', tile: { x: 22, y: 14 }, itemId: 'hoe' });
  sim.dispatch({ type: 'buyShopEntry', entryId: 'seed_radish_quick', requested: 1 });
  sim.dispatch({ type: 'depositAllToBin' });
  sim.sleep();
  sim.serialize();
});

function at(records: ScriptRDayRecord[], day: number): ScriptRDayRecord {
  const rec = records.find((r) => r.day === day);
  if (!rec) throw new Error(`script R record for day ${day} missing`);
  return rec;
}

// Lazily memoized so the (possibly TODO-throwing) sim is never built at collection time.
let cached28: ScriptRDayRecord[] | null = null;
function records28(): ScriptRDayRecord[] {
  cached28 ??= runScriptR(newGameSim('script-r-bandwidth', TEST_MAP), 28);
  return cached28;
}

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(FACADE_READY).toBe(true);
});

describe('script R 28-day bandwidth (GDD §4.6 验收带宽表)', () => {
  it('D1 is the fixed investment day: zero income, Lv1, all cash into seeds', () => {
    const records = records28();
    const d1 = at(records, 1);
    expect(d1.cumulativeGross).toBe(0);
    expect(d1.levelAfterMorning).toBe(1);
    // 锄 12 格、买 10 小萝卜花光 100g (§4.6 D1 row)
    expect(d1.goldAfterSettlement).toBe(0);
    expect(d1.xpAfterMorning).toBe(50); // 10 plantings × 5 XP
  });

  it('D3: first payday — cumulative gross 180g, inside [150,300]', () => {
    const d3 = at(records28(), 3);
    expect(d3.cumulativeGross).toBeGreaterThanOrEqual(150);
    expect(d3.cumulativeGross).toBeLessThanOrEqual(300);
    expect(d3.summary.goldEarned).toBe(180); // 10 radish × 18g (§4.6 baseline)
  });

  it('红线 1: Lv2 on the morning of D3 — without any achievement XP (§5.4)', () => {
    const records = records28();
    expect(at(records, 3).levelAfterMorning).toBe(2);
    expect(at(records, 3).xpAfterMorning).toBeGreaterThanOrEqual(100); // 110 in the baseline
    expect(at(records, 2).levelAfterMorning).toBe(1); // not earlier
  });

  it('D7: cumulative gross within [320,600], still Lv2', () => {
    const d7 = at(records28(), 7);
    expect(d7.cumulativeGross).toBeGreaterThanOrEqual(320);
    expect(d7.cumulativeGross).toBeLessThanOrEqual(600);
    expect(d7.levelAfterMorning).toBe(2);
  });

  it('D14: cumulative gross within [1000,1800]; Lv3 reached during D10~12 (§5.4)', () => {
    const records = records28();
    const d14 = at(records, 14);
    expect(d14.cumulativeGross).toBeGreaterThanOrEqual(1000);
    expect(d14.cumulativeGross).toBeLessThanOrEqual(1800);
    // §5.4 互洽: Lv3 ≈ D10~12 — the Lv3 morning must land in that window.
    const lv3Day = records.find((r) => r.levelAfterMorning >= 3)?.day;
    expect(lv3Day).toBeGreaterThanOrEqual(10);
    expect(lv3Day).toBeLessThanOrEqual(12);
    // The §4.6 bandwidth table prints Lv3 at D14, but the strict §4.6 step-③ replant
    // (fill EVERY empty tilled tile) reaches Lv4 by ≈D14 — recorded as an open
    // question for the owner; until ruled, both readings are accepted here.
    expect(d14.levelAfterMorning).toBeGreaterThanOrEqual(3);
    expect(d14.levelAfterMorning).toBeLessThanOrEqual(4);
  });

  it('D28: cumulative gross within [3300,6000]; Lv5 reached during D24~27', () => {
    const records = records28();
    const d28 = at(records, 28);
    expect(d28.cumulativeGross).toBeGreaterThanOrEqual(3300);
    expect(d28.cumulativeGross).toBeLessThanOrEqual(6000);
    expect(d28.levelAfterMorning).toBe(5);
    const lv5Day = records.find((r) => r.levelAfterMorning >= 5)?.day;
    expect(lv5Day).toBeGreaterThanOrEqual(24);
    expect(lv5Day).toBeLessThanOrEqual(27);
  });

  it('the soft-lock relief is NEVER triggerable under script R (§4.8 sim 断言)', () => {
    expect(records28().every((r) => !r.reliefEligibleAtWake)).toBe(true);
  });

  it('every settlement reconciles: goldBalance equals the post-settlement wallet', () => {
    for (const r of records28()) {
      expect(r.summary.goldBalance).toBe(r.goldAfterSettlement);
    }
  });
});

describe('determinism (GDD §2.2 — same seed + same script ⇒ same bytes)', () => {
  it('two 7-day script R runs from the same seed serialize byte-identically', () => {
    const a = newGameSim('determinism-seed', TEST_MAP);
    const b = newGameSim('determinism-seed', TEST_MAP);
    runScriptR(a, 7);
    runScriptR(b, 7);
    expect(JSON.stringify(a.serialize())).toBe(JSON.stringify(b.serialize()));
  });

  it('different seeds may diverge (weather), but restore→serialize is the identity', () => {
    const sim = newGameSim('roundtrip-seed', TEST_MAP);
    runScriptR(sim, 7);
    const doc = sim.serialize();
    const restored = createSim(doc, TEST_MAP);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(doc));
  });

  it('restored sims continue identically to the uninterrupted run (replay seam)', () => {
    const straight = newGameSim('replay-seed', TEST_MAP);
    runScriptR(straight, 16);

    // Seam AFTER the Lv3 morning (D10~12 per §5.4) so the field_b unlock has been
    // applied by a night settlement before the save/load — pins the US10/§1.4
    // regression where hydrate() re-fenced xp-earned zones on reload.
    const interrupted = newGameSim('replay-seed', TEST_MAP);
    runScriptR(interrupted, 12);
    expect(interrupted.state.farm.unlockedZones).toContain('field_b'); // seam precondition
    const resumed = createSim(interrupted.serialize(), TEST_MAP); // save/load mid-run
    expect([...resumed.state.farm.unlockedZones].sort()).toEqual(
      [...interrupted.state.farm.unlockedZones].sort(), // reload never shrinks reachable area
    );
    runScriptR(resumed, 4);

    expect(JSON.stringify(resumed.serialize())).toBe(JSON.stringify(straight.serialize()));
  });
});

describe('zero-anxiety regression V4 (GDD §4.8 — 28 idle days)', () => {
  it('28 days of doing nothing: gold stays 100, nothing decays, no relief, day advances', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    for (let n = 0; n < 28; n++) {
      const summary = sim.sleep();
      expect(summary.goldEarned).toBe(0);
      expect(summary.tomorrow.length).toBeGreaterThanOrEqual(1); // promise never empty
    }
    expect(sim.state.time.day).toBe(29);
    expect(sim.state.economy.gold).toBe(100);
    expect(sim.state.progress.xp).toBe(0);
    expect(Object.keys(sim.state.farm.tiles)).toHaveLength(0);
    // inventory untouched: the two starting tools and nothing else
    const items = sim.state.inventory.slots.filter((s) => s !== null);
    expect(items).toEqual([
      { itemId: 'hoe', count: 1 },
      { itemId: 'watering_can', count: 1 },
    ]);
  });

  it('weather statistics over the idle month respect day-1 forced sunny (§2.1)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    expect(sim.state.time.weatherToday).toBe('sunny'); // new save day 1
    let consecutiveRain = 0;
    for (let n = 0; n < 28; n++) {
      sim.sleep();
      if (sim.state.time.weatherToday === 'rain') consecutiveRain++;
      else consecutiveRain = 0;
      expect(consecutiveRain).toBeLessThanOrEqual(2); // 连雨 ≤2 (§2.1)
    }
  });
});
