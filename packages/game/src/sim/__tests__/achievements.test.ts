/**
 * Achievement engine tests (M1.5, PRD 02; authority GDD §5.6).
 *
 * Covers: per-row unlock thresholds (table-driven against the §5.6 numbers, not the
 * implementation), joint predicates (#12 gilded / #13 six_crops), reward delivery
 * (instant wallet gold + unified XP pipeline incl. level-ups), strict idempotence
 * (repeat sweeps / reloads / imports), append-only + unknown-id preservation, the
 * milestone gate (M3 rows live, M4 rows inert in the M3 build), the §5.6 budget
 * invariants incl. the #21/#22 zero-XP rule,
 * and the B-3 decoupling contract (script R untouched by default; achievements-on
 * mode keeps red line 1).
 */
import { describe, expect, it } from 'vitest';

import { checkAchievements, pendingUnlocks, progressView } from '../achievements.js';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  M1_5_ACHIEVEMENTS,
  type AchievementId,
} from '../data/achievements.js';
import { XP_CAP } from '../data/constants.js';
import { createSim, newGameSim } from '../sim.js';
import type { CounterId, SimEvent, ToolTiers, WorldState } from '../types.js';
import { deepFreeze, makeSave, makeWorldState, TEST_MAP } from './fixtures.js';
import { runScriptR } from './script-r.js';

// ---- helpers ----

function stateWith(overrides: {
  counters?: Partial<Record<CounterId, number>>;
  tools?: ToolTiers;
  xp?: number;
  achievements?: string[];
  gold?: number;
}): WorldState {
  return makeWorldState({
    tools: overrides.tools ?? { hoe: 1, wateringCan: 1 },
    economy: {
      gold: overrides.gold ?? 100,
      shippingBin: [],
      collectionLog: {},
      newEntriesSeenDay: {},
    },
    progress: {
      xp: overrides.xp ?? 0,
      profession: null,
      counters: overrides.counters ?? {},
      achievements: overrides.achievements ?? [],
      xpHistory: [],
    },
  });
}

function unlockEvents(events: SimEvent[]): Extract<SimEvent, { type: 'AchievementUnlocked' }>[] {
  return events.filter(
    (e): e is Extract<SimEvent, { type: 'AchievementUnlocked' }> =>
      e.type === 'AchievementUnlocked',
  );
}

const TILLABLE_A = { x: 22, y: 14 }; // first tile of field A (fixtures FIELD_A)
const TILLABLE_B = { x: 23, y: 14 };

// ---- §5.6 single-counter rows, table-driven (thresholds transcribed from the GDD) ----

const COUNTER_CASES: {
  id: AchievementId;
  counter: CounterId;
  threshold: number;
  xp: number;
  gold: number;
}[] = [
  { id: 'first_till', counter: 'tillCount', threshold: 1, xp: 5, gold: 0 },
  { id: 'first_seed', counter: 'plantCount', threshold: 1, xp: 5, gold: 0 },
  { id: 'first_harvest', counter: 'harvestCount', threshold: 1, xp: 10, gold: 20 },
  { id: 'first_sale', counter: 'sellCount', threshold: 1, xp: 10, gold: 20 },
  { id: 'rain_blessing', counter: 'rainDaysSeen', threshold: 1, xp: 10, gold: 0 },
  { id: 'first_sunrise', counter: 'sleepCount', threshold: 1, xp: 5, gold: 0 },
  { id: 'nest_egg', counter: 'goldEarned', threshold: 1_000, xp: 25, gold: 0 },
  { id: 'moneybags', counter: 'goldEarned', threshold: 10_000, xp: 50, gold: 200 },
  { id: 'hundred_harvests', counter: 'harvestCount', threshold: 100, xp: 30, gold: 0 },
  { id: 'steady_hands', counter: 'waterCount', threshold: 200, xp: 20, gold: 0 },
  { id: 'tooled_up', counter: 'toolUpgrades', threshold: 1, xp: 20, gold: 0 },
  { id: 'regrow_expert', counter: 'regrowChainMax', threshold: 4, xp: 25, gold: 0 },
];

describe('achievement unlock conditions (§5.6 rows, table-driven)', () => {
  it.each(COUNTER_CASES)(
    '$id stays locked below $threshold and unlocks at it with +$xp XP / +$gold g',
    ({ id, counter, threshold, xp, gold }) => {
      const below = checkAchievements(stateWith({ counters: { [counter]: threshold - 1 } }));
      expect(below.state.progress.achievements).not.toContain(id);

      const at = checkAchievements(stateWith({ counters: { [counter]: threshold } }));
      expect(at.state.progress.achievements).toContain(id);
      const event = unlockEvents(at.events).find((e) => e.id === id);
      expect(event).toEqual({ type: 'AchievementUnlocked', id, xp, gold });
    },
  );

  it('#12 gilded needs BOTH tools at the gold tier', () => {
    const oneGold = checkAchievements(stateWith({ tools: { hoe: 3, wateringCan: 2 } }));
    expect(oneGold.state.progress.achievements).not.toContain('gilded');

    const bothGold = checkAchievements(stateWith({ tools: { hoe: 3, wateringCan: 3 } }));
    expect(bothGold.state.progress.achievements).toContain('gilded');
    expect(unlockEvents(bothGold.events).find((e) => e.id === 'gilded')).toEqual({
      type: 'AchievementUnlocked',
      id: 'gilded',
      xp: 40,
      gold: 0,
    });
  });

  it('#13 six_crops needs all six M1 starter crops sold at least once', () => {
    const fiveKinds = checkAchievements(
      stateWith({
        counters: {
          'soldCrops:radish_quick': 3,
          'soldCrops:turnip': 1,
          'soldCrops:potato': 1,
          'soldCrops:bean_vine': 1,
          'soldCrops:cabbage': 1,
        },
      }),
    );
    expect(fiveKinds.state.progress.achievements).not.toContain('six_crops');

    const sixKinds = checkAchievements(
      stateWith({
        counters: {
          'soldCrops:radish_quick': 1,
          'soldCrops:turnip': 1,
          'soldCrops:potato': 1,
          'soldCrops:bean_vine': 1,
          'soldCrops:cabbage': 1,
          'soldCrops:berry': 1,
        },
      }),
    );
    expect(sixKinds.state.progress.achievements).toContain('six_crops');
    expect(unlockEvents(sixKinds.events).find((e) => e.id === 'six_crops')).toEqual({
      type: 'AchievementUnlocked',
      id: 'six_crops',
      xp: 50,
      gold: 100,
    });
    // Instant wallet gold — never via the shipping bin (§4.7 faucet).
    expect(sixKinds.state.economy.gold).toBe(200);
    expect(sixKinds.state.economy.shippingBin).toEqual([]);
  });

  it('unlock result is independent of how counters reached the threshold (order-free)', () => {
    const all = checkAchievements(
      stateWith({
        counters: {
          tillCount: 1,
          plantCount: 1,
          harvestCount: 100,
          sellCount: 1,
          waterCount: 200,
        },
      }),
    );
    // Deterministic sweep order = §5.6 table order (replay-stable).
    expect(all.state.progress.achievements).toEqual([
      'first_till',
      'first_seed',
      'first_harvest',
      'first_sale',
      'hundred_harvests',
      'steady_hands',
    ]);
  });

  it('does not mutate its input (pure contract)', () => {
    const frozen = deepFreeze(stateWith({ counters: { tillCount: 1 } }));
    const result = checkAchievements(frozen);
    expect(result.state.progress.achievements).toContain('first_till');
    expect(frozen.progress.achievements).toEqual([]);
  });
});

describe('rewards ride the unified pipelines (§5.2/§4.7)', () => {
  it('achievement XP goes through grantXp — crossing a threshold emits FarmLevelUp', () => {
    // 95 xp + first_till(+5) = 100 ⇒ Lv2 (§5.1).
    const result = checkAchievements(stateWith({ xp: 95, counters: { tillCount: 1 } }));
    expect(result.state.progress.xp).toBe(100);
    expect(result.events).toContainEqual({ type: 'FarmLevelUp', level: 2, tilledCap: 12 });
    // dayLog carries the xpGained entry like any other XP source.
    expect(result.state.dayLog).toContainEqual({ kind: 'xpGained', amount: 5 });
  });

  it('achievement gold lands in the wallet instantly and emits GoldChanged', () => {
    const result = checkAchievements(stateWith({ gold: 100, counters: { harvestCount: 1 } }));
    expect(result.state.economy.gold).toBe(120);
    expect(result.events).toContainEqual({ type: 'GoldChanged', gold: 120, delta: 20 });
  });

  it('achievement gold does NOT feed the goldEarned counter (no self-feeding #7/#8)', () => {
    const result = checkAchievements(stateWith({ counters: { harvestCount: 1, goldEarned: 999 } }));
    expect(result.state.progress.counters.goldEarned).toBe(999);
    expect(result.state.progress.achievements).not.toContain('nest_egg');
  });
});

describe('idempotence & repeat-unlock protection (PRD 02 US16)', () => {
  it('a second sweep over an unlocked state is a no-op (same reference, no events)', () => {
    const first = checkAchievements(stateWith({ counters: { tillCount: 1 } }));
    const second = checkAchievements(first.state);
    expect(second.events).toEqual([]);
    expect(second.state).toBe(first.state); // fast path: no clone, no re-grant
  });

  it('already-recorded ids never re-reward, however far the counter has moved', () => {
    const state = stateWith({
      counters: { tillCount: 9_999 },
      achievements: ['first_till'],
      xp: 5,
    });
    const result = checkAchievements(state);
    expect(result.events).toEqual([]);
    expect(result.state.progress.xp).toBe(5);
    expect(result.state.progress.achievements.filter((id) => id === 'first_till')).toHaveLength(1);
  });

  it('unknown (future-version) achievement ids are preserved, never re-judged (§5.8)', () => {
    const result = checkAchievements(
      stateWith({ achievements: ['mystery_from_v9'], counters: { tillCount: 1 } }),
    );
    expect(result.state.progress.achievements).toEqual(['mystery_from_v9', 'first_till']);
  });
});

describe('milestone gate — M3 AND M4 rows are live in the M4 build (§0.4 / PRD 05 US75)', () => {
  it('fully-satisfied M3+M4 predicates fire in §5.6 order; #19/#20 now light up', () => {
    const state = stateWith({
      xp: XP_CAP, // satisfies #21 farm_master AND #22 mastery predicates
      counters: {
        buildingsBuilt: 3,
        'built:coop': 1,
        'built:workshop': 1,
        'built:greenhouse': 1,
        sprinklersPlaced: 1,
        questsCompleted: 5, // satisfies #19 first_quest — NOW unlocks (M4 build)
        notesWritten: 10, // satisfies #20 notebook — NOW unlocks (M4 build)
      },
    });
    state.progress.profession = 'horticulturist'; // satisfies #18 signed_papers
    // §5.6 table order: #18 signed_papers, #19 first_quest, #20 notebook, then the
    // M3 long-line #21/#22; the M3 rows (#15~#17) precede #18 in the table.
    expect(pendingUnlocks(state).map((d) => d.id)).toEqual([
      'homestead',
      'tycoon',
      'automation_dream',
      'signed_papers',
      'first_quest',
      'notebook',
      'farm_master',
      'mastery',
    ]);
    const result = checkAchievements(state);
    expect(result.state.progress.achievements).toContain('first_quest');
    expect(result.state.progress.achievements).toContain('notebook');
  });

  it('#21/#22 unlock with ZERO XP movement at the cap; gold lands instantly (§5.6 不变量)', () => {
    const state = stateWith({ xp: XP_CAP, gold: 100 });
    const result = checkAchievements(state);
    expect(unlockEvents(result.events).map((e) => e.id)).toEqual(['farm_master', 'mastery']);
    expect(result.state.progress.xp).toBe(XP_CAP); // no feedback loop: xp untouched
    // #21 +1,000g instant to the wallet; #22 is purely commemorative (0/0).
    expect(result.state.economy.gold).toBe(1_100);
    expect(unlockEvents(result.events).find((e) => e.id === 'farm_master')).toEqual({
      type: 'AchievementUnlocked',
      id: 'farm_master',
      xp: 0,
      gold: 1_000,
    });
    expect(unlockEvents(result.events).find((e) => e.id === 'mastery')).toEqual({
      type: 'AchievementUnlocked',
      id: 'mastery',
      xp: 0,
      gold: 0,
    });
  });

  it('#16 tycoon needs all three of coop/workshop/greenhouse (B-6 口径)', () => {
    const two = checkAchievements(
      stateWith({ counters: { 'built:coop': 1, 'built:workshop': 1, buildingsBuilt: 2 } }),
    );
    expect(two.state.progress.achievements).not.toContain('tycoon');

    const three = checkAchievements(
      stateWith({
        counters: {
          'built:coop': 1,
          'built:workshop': 1,
          'built:greenhouse': 1,
          buildingsBuilt: 3,
        },
      }),
    );
    expect(three.state.progress.achievements).toContain('tycoon');
    expect(unlockEvents(three.events).find((e) => e.id === 'tycoon')).toEqual({
      type: 'AchievementUnlocked',
      id: 'tycoon',
      xp: 100,
      gold: 500,
    });
  });

  it('#18 signed_papers unlocks through the regular sweep once a profession is held', () => {
    const state = stateWith({});
    state.progress.profession = 'artisan';
    const result = checkAchievements(state);
    expect(unlockEvents(result.events).map((e) => e.id)).toEqual(['signed_papers']);
    expect(result.state.progress.xp).toBe(0); // commemorative: 0 XP (§5.6)
  });
});

describe('§5.6 data-table invariants (budget guards)', () => {
  it('all 22 ids are present, unique, and numbered 1..22', () => {
    expect(ACHIEVEMENTS).toHaveLength(22);
    expect(new Set(ACHIEVEMENTS.map((d) => d.id)).size).toBe(22);
    expect([...ACHIEVEMENTS].map((d) => d.num).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
  });

  it('the M1.5 slice is exactly #1~#14', () => {
    expect(M1_5_ACHIEVEMENTS.map((d) => d.id)).toEqual([
      'first_till',
      'first_seed',
      'first_harvest',
      'first_sale',
      'rain_blessing',
      'first_sunrise',
      'nest_egg',
      'moneybags',
      'hundred_harvests',
      'steady_hands',
      'tooled_up',
      'gilded',
      'six_crops',
      'regrow_expert',
    ]);
  });

  it('#1~#14 XP totals exactly 305 and gold totals exactly 340 (§5.6 预算)', () => {
    expect(M1_5_ACHIEVEMENTS.reduce((sum, d) => sum + d.reward.xp, 0)).toBe(305);
    expect(M1_5_ACHIEVEMENTS.reduce((sum, d) => sum + d.reward.gold, 0)).toBe(340);
  });

  it('level/XP-dependent achievements (#21/#22) MUST grant 0 XP (anti feedback loop)', () => {
    expect(ACHIEVEMENTS_BY_ID.get('farm_master')?.reward.xp).toBe(0);
    expect(ACHIEVEMENTS_BY_ID.get('mastery')?.reward.xp).toBe(0);
  });

  it('M3/M4 rows total 210 XP (§5.6 budget note)', () => {
    expect(
      ACHIEVEMENTS.filter((d) => d.milestone !== 'M1.5').reduce((s, d) => s + d.reward.xp, 0),
    ).toBe(210);
  });

  it('progress() targets match predicate thresholds at the boundary', () => {
    for (const { id, counter, threshold } of COUNTER_CASES) {
      const def = ACHIEVEMENTS_BY_ID.get(id);
      expect(def).toBeDefined();
      const at = progressView(stateWith({ counters: { [counter]: threshold } }));
      const below = progressView(stateWith({ counters: { [counter]: threshold - 1 } }));
      expect(def?.progress(at)).toEqual({ current: threshold, target: threshold });
      expect(def?.predicate(below)).toBe(false);
      // Over-threshold counters clamp to the target (page shows "100/100", §5.8).
      const over = progressView(stateWith({ counters: { [counter]: threshold + 7 } }));
      expect(def?.progress(over).current).toBe(threshold);
    }
  });
});

describe('facade integration (sim.ts sweep + persistence)', () => {
  it('unlocks ride the dispatch that caused them (achievements: true)', () => {
    const sim = createSim(makeSave(), TEST_MAP, { achievements: true });
    const events = sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' });
    expect(unlockEvents(events).map((e) => e.id)).toEqual(['first_till']);
    expect(sim.state.progress.achievements).toEqual(['first_till']);
    expect(sim.state.progress.xp).toBe(5);
  });

  it('default mode keeps the engine OFF — zero perturbation (B-3 / §4.6)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    const events = sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' });
    expect(unlockEvents(events)).toEqual([]);
    expect(sim.state.progress.achievements).toEqual([]);
    expect(sim.state.progress.xp).toBe(0);
    expect(sim.state.progress.counters.tillCount).toBe(1); // counters still instrumented
  });

  it('manual sleep unlocks 过夜 through the same sweep (counter bumps at night)', () => {
    const sim = createSim(makeSave(), TEST_MAP, { achievements: true });
    sim.sleep();
    expect(sim.state.progress.achievements).toContain('first_sunrise');
  });

  it('settlement unlocks ride the day summary and goldBalance equals the wallet (US11/§2.5)', () => {
    const sim = newGameSim('summary-gold-probe', TEST_MAP, { achievements: true });
    // D1: till + buy 1 radish seed + plant + water (first_till/first_seed unlock
    // on their dispatches, NOT at night — they must not appear in the summary).
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' });
    sim.dispatch({ type: 'buyShopEntry', entryId: 'seed_radish_quick', requested: 1 });
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'seed_radish_quick' });
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'watering_can' });
    const d1 = sim.sleep(); // sleepCount bumps INSIDE the settlement → unlocks here
    expect(d1.achievementsUnlocked).toContain('first_sunrise');
    expect(d1.achievementsUnlocked).not.toContain('first_till');
    expect(d1.goldBalance).toBe(sim.state.economy.gold);

    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'watering_can' });
    sim.sleep(); // D2 watered → mature on the D3 morning (radish 2 days)
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' }); // harvest
    sim.dispatch({ type: 'depositAllToBin' });
    const payday = sim.sleep(); // sale settles → first_sale (+10 XP, +20g instant)
    expect(payday.achievementsUnlocked).toContain('first_sale');
    // GDD §2.5 contract: the summary balance must equal the wallet the night
    // autosave persists — INCLUDING the instant achievement gold from this sweep.
    expect(payday.goldBalance).toBe(sim.state.economy.gold);
  });

  it('default-off deduction mode reports an empty summary achievements list (B-3)', () => {
    const sim = newGameSim('summary-gold-probe', TEST_MAP);
    const summary = sim.sleep();
    expect(summary.achievementsUnlocked).toEqual([]);
    expect(summary.goldBalance).toBe(sim.state.economy.gold);
  });

  it('save → load → replay never double-rewards (read/import idempotence)', () => {
    const sim = createSim(makeSave(), TEST_MAP, { achievements: true });
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' });
    const xpAfterUnlock = sim.state.progress.xp;

    const restored = createSim(sim.serialize(), TEST_MAP, { achievements: true });
    const tickEvents = restored.advanceMinutes(1);
    expect(unlockEvents(tickEvents)).toEqual([]);
    const more = restored.dispatch({ type: 'interact', tile: TILLABLE_B, itemId: 'hoe' });
    expect(unlockEvents(more)).toEqual([]);
    expect(restored.state.progress.achievements.filter((id) => id === 'first_till')).toHaveLength(
      1,
    );
    expect(restored.state.progress.xp).toBe(xpAfterUnlock);
  });

  it('importing an old (pre-M1.5) save retro-unlocks on the first tick (US10/US14)', () => {
    const oldSave = makeSave({
      progress: {
        xp: 0,
        profession: null,
        counters: { tillCount: 3, harvestCount: 2, sellCount: 1 },
        achievements: [],
        xpHistory: [],
        collectionLog: {},
        stats: { totalGoldEarned: 0, totalHarvests: 2, harvestsByCrop: {} },
      },
    });
    const sim = createSim(oldSave, TEST_MAP, { achievements: true });
    const events = sim.advanceMinutes(1);
    expect(unlockEvents(events).map((e) => e.id)).toEqual([
      'first_till',
      'first_harvest',
      'first_sale',
    ]);
    expect(sim.state.economy.gold).toBe(100 + 20 + 20); // both gold rewards instant
  });

  it('achievements & counters round-trip through serialize (zero schema change)', () => {
    const sim = createSim(makeSave(), TEST_MAP, { achievements: true });
    sim.dispatch({ type: 'interact', tile: TILLABLE_A, itemId: 'hoe' });
    const doc = sim.serialize();
    expect(doc.progress.achievements).toEqual(['first_till']);
    const restored = createSim(doc, TEST_MAP, { achievements: true });
    expect(restored.serialize().progress.achievements).toEqual(['first_till']);
  });

  it('unknown achievement ids survive a save round-trip (§5.8 forward-compat)', () => {
    const save = makeSave({
      progress: {
        xp: 0,
        profession: null,
        counters: {},
        achievements: ['mystery_from_v9'],
        xpHistory: [],
        collectionLog: {},
        stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
      },
    });
    const sim = createSim(save, TEST_MAP, { achievements: true });
    sim.advanceMinutes(1);
    expect(sim.serialize().progress.achievements).toContain('mystery_from_v9');
  });
});

describe('script R decoupling (ruling B-3 / §4.6 deduction mode)', () => {
  it('the default-off deduction mode never unlocks anything across 28 days', () => {
    const sim = newGameSim('achv-decouple', TEST_MAP);
    runScriptR(sim, 28);
    expect(sim.state.progress.achievements).toEqual([]);
  }, 30_000);

  it('achievements-on diligent run still meets red line 1 (Lv2 ≤ D3.5) and unlocks fire', () => {
    const sim = newGameSim('achv-decouple', TEST_MAP, { achievements: true });
    const records = runScriptR(sim, 28);
    const lv2Day = records.find((r) => r.levelAfterMorning >= 2)?.day;
    expect(lv2Day).toBeDefined();
    expect(lv2Day as number).toBeLessThanOrEqual(3);
    // The engine actually ran: the early firsts are all unlocked by D28.
    for (const id of ['first_till', 'first_seed', 'first_harvest', 'first_sale']) {
      expect(sim.state.progress.achievements).toContain(id);
    }
  }, 30_000);
});
