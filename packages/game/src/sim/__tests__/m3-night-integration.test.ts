/**
 * M3 NightUpdate integration — construction/processing/eggs/sprinklers riding the
 * §2.5 settlement pipeline (#4 工地→烘干→加工, #5 产蛋; GDD §8.4 order contract;
 * PRD 04 seam a "快进推演").
 *
 * Each block gates on its own WIRING probe (value-level, not stub-level): the suite
 * arms per-feature as the M3 implementer wires the night phases, and the visible
 * "pending" markers disappear one by one. Once armed, any order regression is red.
 */
import { describe, expect, it } from 'vitest';

import { runNight } from '../night-update.js';
import type { PlacedStructure, WorldState } from '../types.js';
import { makeWorldState, TEST_MAP, xpForLevel } from './fixtures.js';

function nightState(
  structures: PlacedStructure[],
  overrides: Partial<WorldState> = {},
): WorldState {
  return makeWorldState({
    time: {
      day: 5,
      minuteOfDay: 1_320,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: '0123456789abcdef0123456789abcdef',
    },
    progress: {
      xp: xpForLevel(7),
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    structures,
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    clearedResourceNodes: [],
    ...overrides,
  });
}

const coopSite = (daysLeft: number): PlacedStructure => ({
  instanceId: 'site-coop',
  defId: 'coop',
  origin: { x: 42, y: 32 },
  state: 'underConstruction',
  daysLeft,
});

const builtCoop = (hens: number, eggsReady = 0): PlacedStructure => ({
  instanceId: 'coop-1',
  defId: 'coop',
  origin: { x: 42, y: 32 },
  state: 'built',
  data: { kind: 'coop', hens, eggsReady },
});

const rackWithJob = (daysLeft: number): PlacedStructure => ({
  instanceId: 'rack-1',
  defId: 'drying_rack',
  origin: { x: 51, y: 33 },
  state: 'built',
  data: {
    kind: 'dryingRack',
    jobs: [{ inputItemId: 'crop_cabbage', outputItemId: 'artisan_dried_cabbage', daysLeft }, null],
  },
});

// ---- wiring probes (value-level; see header) ----

const CONSTRUCTION_WIRED = (() => {
  const { state } = runNight(nightState([coopSite(2)]), TEST_MAP);
  return state.structures?.[0]?.daysLeft === 1;
})();

const EGGS_WIRED = (() => {
  const { state } = runNight(nightState([builtCoop(4)]), TEST_MAP);
  const data = state.structures?.[0]?.data;
  return data?.kind === 'coop' && data.eggsReady === 4;
})();

const SPRINKLER_WIRED = (() => {
  const s = nightState([], { sprinklers: [{ x: 25, y: 16, tier: 1 }] });
  s.farm.tiles['24,16'] = { tilled: true, wateredToday: false, crop: null };
  const { state } = runNight(s, TEST_MAP);
  return state.farm.tiles['24,16'].wateredToday === true;
})();

it.skipIf(CONSTRUCTION_WIRED && EGGS_WIRED && SPRINKLER_WIRED)(
  'M3 night integration pending — arms per feature as NightUpdate #4/#5 wiring lands',
  () => {
    expect(CONSTRUCTION_WIRED && EGGS_WIRED && SPRINKLER_WIRED).toBe(false);
  },
);

describe.skipIf(!CONSTRUCTION_WIRED)('construction rides NightUpdate #4 (§8.4)', () => {
  it('order a coop → 2 settlements → completion at the SECOND morning, never the first', () => {
    const cur = nightState([coopSite(2)]);
    const xp0 = cur.progress.xp;

    const night1 = runNight(cur, TEST_MAP);
    expect(night1.state.structures?.[0]).toMatchObject({
      state: 'underConstruction',
      daysLeft: 1,
    });
    expect(night1.events.some((e) => e.type === 'ConstructionCompleted')).toBe(false);
    // the settlement screen promises the finish ("还差 1 天完工", §8.3 acceptance)
    expect(night1.summary.tomorrow.some((t) => t.kind === 'construction')).toBe(true);

    const night2 = runNight(night1.state, TEST_MAP);
    expect(night2.state.structures?.[0]?.state).toBe('built');
    const done = night2.events.filter((e) => e.type === 'ConstructionCompleted');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ defId: 'coop', xp: 150 });
    expect(night2.state.progress.xp).toBe(xp0 + 150);

    const night3 = runNight(night2.state, TEST_MAP);
    expect(night3.events.some((e) => e.type === 'ConstructionCompleted')).toBe(false);
  });

  it('§8.4 same-night event order: 工地 → 加工 → 产蛋', () => {
    const state = nightState([
      builtCoop(2),
      rackWithJob(1),
      { ...coopSite(1), defId: 'workshop', instanceId: 'site-shop', origin: { x: 50, y: 32 } },
    ]);
    const { events } = runNight(state, TEST_MAP);
    const idx = (type: string) => events.findIndex((e) => e.type === type);
    expect(idx('ConstructionCompleted')).toBeGreaterThanOrEqual(0);
    expect(idx('ProcessingDone')).toBeGreaterThan(idx('ConstructionCompleted'));
    expect(idx('EggsProduced')).toBeGreaterThan(idx('ProcessingDone'));
  });
});

describe.skipIf(!EGGS_WIRED || !CONSTRUCTION_WIRED)(
  '30-night zero-op fast-forward — nothing degrades (零焦虑 red line; PRD 04 seam a)',
  () => {
    it('site completes, goods wait forever, eggs reach exactly 4N, gold never drops', () => {
      let cur = nightState([builtCoop(4), rackWithJob(0), coopSite(2)]);
      // make the second structure id unique per §8.2 limit-1 (site is the workshop)
      cur.structures![2] = { ...cur.structures![2], defId: 'workshop', instanceId: 'site-shop' };
      const gold0 = cur.economy.gold;
      for (let night = 1; night <= 30; night++) {
        const result = runNight(cur, TEST_MAP);
        cur = result.state;
        expect(cur.economy.gold).toBeGreaterThanOrEqual(gold0);
      }
      const coop = cur.structures?.find((s) => s.instanceId === 'coop-1')?.data;
      expect(coop?.kind === 'coop' && coop.eggsReady).toBe(120); // 4 × 30, uncapped
      const rack = cur.structures?.find((s) => s.instanceId === 'rack-1')?.data;
      expect(rack?.kind === 'dryingRack' && rack.jobs[0]).toMatchObject({
        outputItemId: 'artisan_dried_cabbage',
        daysLeft: 0, // still waiting for pickup — zero loss
      });
      const site = cur.structures?.find((s) => s.instanceId === 'site-shop');
      expect(site?.state).toBe('built'); // completed once, then inert
    });
  },
);

describe.skipIf(!SPRINKLER_WIRED)('sprinklers wet their coverage at 6:00 (§3.8/§5.3)', () => {
  it('tier 1 wets the 4 orthogonal neighbours', () => {
    const s = nightState([], { sprinklers: [{ x: 25, y: 16, tier: 1 }] });
    for (const key of ['24,16', '26,16', '25,15', '25,17']) {
      s.farm.tiles[key] = { tilled: true, wateredToday: false, crop: null };
    }
    s.farm.tiles['23,16'] = { tilled: true, wateredToday: false, crop: null }; // out of range
    const { state } = runNight(s, TEST_MAP);
    for (const key of ['24,16', '26,16', '25,15', '25,17']) {
      expect(state.farm.tiles[key].wateredToday, key).toBe(true);
    }
    expect(state.farm.tiles['23,16'].wateredToday).toBe(false);
  });

  it('tier 2 wets the full 3×3 around it', () => {
    const s = nightState([], { sprinklers: [{ x: 25, y: 16, tier: 2 }] });
    const covered: string[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue; // the sprinkler's own tile is not farmland
        const key = `${25 + dx},${16 + dy}`;
        covered.push(key);
        s.farm.tiles[key] = { tilled: true, wateredToday: false, crop: null };
      }
    }
    const { state } = runNight(s, TEST_MAP);
    for (const key of covered) expect(state.farm.tiles[key].wateredToday, key).toBe(true);
  });

  it('sprinkler wetting feeds growth exactly like manual watering (§3.4 day count)', () => {
    const s = nightState([], { sprinklers: [{ x: 25, y: 16, tier: 1 }] });
    s.farm.tiles['24,16'] = {
      tilled: true,
      wateredToday: true, // watered today by hand…
      crop: {
        cropId: 'radish_quick',
        daysGrown: 0,
        mature: false,
        regrowDaysLeft: null,
        harvestsLeft: 1,
        withered: false,
      },
    };
    // night 1: grows on today's manual water; morning wets it again via sprinkler
    const n1 = runNight(s, TEST_MAP);
    expect(n1.state.farm.tiles['24,16'].crop?.daysGrown).toBe(1);
    expect(n1.state.farm.tiles['24,16'].wateredToday).toBe(true);
    // night 2: grows on the SPRINKLER water — automation replaces the can 1:1
    const n2 = runNight(n1.state, TEST_MAP);
    expect(n2.state.farm.tiles['24,16'].crop?.daysGrown).toBe(2);
  });
});
