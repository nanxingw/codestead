/**
 * Script C — 28-day construction extension of the §4.6 income harness (GDD §8.2 回本
 * 估算; §4.7 M3 sink ledger; PRD 04 seam a "快进推演"). Script R/B pin the M1 economy
 * bandwidth (their suites ARE the zero-regression proof — they run unchanged on the M3
 * build); this script pins the M3 claim that BUILDING IS A SINK, NOT A FAUCET:
 *
 *   - every gold the building system moves is accounted: place/hen purchases are the
 *     only outflows, egg settlement the only inflow — the wallet reconciles exactly;
 *   - the §8.2 coop payback estimate holds: 满 4 鸡 160g/日 ⇒ the 2,750g-equivalent
 *     investment pays back in 17~34 days;
 *   - 28 days of construction never mint gold out of thin air (ledger identity).
 *
 * Gated on the NightUpdate #4/#5 wiring probe (same seam as m3-night-integration);
 * arms automatically when the building-sim implementer wires the night phases.
 */
import { describe, expect, it } from 'vitest';

import { collectEggs, buyHen } from '../coop.js';
import { placeStructure } from '../building.js';
import { COOP, MATERIAL_SHOP_BUY_PRICE } from '../data/buildings.js';
import { runNight } from '../night-update.js';
import type { SimEvent, WorldState } from '../types.js';
import { countItem, makeWorldState, stack, TEST_MAP, xpForLevel } from './fixtures.js';
import { m3Implemented } from './m3-probe.js';

const COOP_EQUIV_PRICE = 2_000 + 150 * MATERIAL_SHOP_BUY_PRICE.wood; // 2,750g (§8.2)

function graduateState(): WorldState {
  return makeWorldState({
    time: {
      day: 1,
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: '0123456789abcdef0123456789abcdef',
    },
    economy: { gold: 6_000, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    inventory: {
      slots: [
        stack('hoe', 1),
        stack('watering_can', 1),
        stack('material_wood', 99),
        stack('material_wood', 51),
        ...Array.from({ length: 8 }, () => null),
      ],
      capacity: 12,
      selected: 0,
    },
    progress: {
      xp: xpForLevel(6), // a graduate Lv6 save — coop blueprint just unlocked (§5.3)
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    structures: [],
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    clearedResourceNodes: [],
  });
}

const REDUCERS_READY = m3Implemented(() => buyHen(makeWorldState(), 'nope'));

const WIRING_READY =
  REDUCERS_READY &&
  (() => {
    const placed = placeStructure(graduateState(), 'coop', { x: 42, y: 32 });
    if (!placed.ok) return false;
    const { state } = runNight(placed.state, TEST_MAP);
    return state.structures?.[0]?.daysLeft === 1;
  })();

it.skipIf(WIRING_READY)(
  'script C pending — arms when NightUpdate #4/#5 wiring lands (building-sim seam)',
  () => {
    expect(WIRING_READY).toBe(false);
  },
);

interface ScriptCRecord {
  day: number;
  goldAtWake: number;
  eggIncome: number;
}

/**
 * 28 mornings: D1 order the coop; at completion buy up to 2 extra hens (→4); every
 * morning collect all eggs and ship them; sleep. Returns the day ledger + final state.
 */
function runScriptC(days: number): {
  state: WorldState;
  records: ScriptCRecord[];
  outflows: number;
  eggIncome: number;
} {
  let cur = graduateState();
  let outflows = 0;
  let eggIncome = 0;
  const records: ScriptCRecord[] = [];

  const placed = placeStructure(cur, 'coop', { x: 42, y: 32 });
  if (!placed.ok) throw new Error(`coop order failed: ${placed.error}`);
  cur = placed.state;
  outflows += 2_000;

  for (let i = 0; i < days; i++) {
    const goldAtWake = cur.economy.gold;
    const coop = cur.structures?.find((s) => s.defId === 'coop');

    if (coop?.state === 'built' && coop.data?.kind === 'coop') {
      // top up to 4 hens, one purchase per morning (200g each, A-6)
      if (coop.data.hens < COOP.MAX_HENS && cur.economy.gold >= COOP.HEN_BUY_PRICE) {
        const bought = buyHen(cur, coop.instanceId);
        if (bought.ok) {
          cur = bought.state;
          outflows += COOP.HEN_BUY_PRICE;
        }
      }
      const withEggs = cur.structures?.find((s) => s.defId === 'coop');
      if (withEggs?.data?.kind === 'coop' && withEggs.data.eggsReady > 0) {
        const collected = collectEggs(cur, withEggs.instanceId);
        if (collected.ok) cur = collected.state;
      }
      // ship every egg in the bag (deliberate E-interactions; eggs never auto-sell)
      const eggs = countItem(cur.inventory, 'animal_egg');
      if (eggs > 0) {
        cur = structuredClone(cur);
        let left = eggs;
        for (const slot of cur.inventory.slots.keys()) {
          const s = cur.inventory.slots[slot];
          if (s?.itemId === 'animal_egg') {
            cur.economy.shippingBin.push({ itemId: 'animal_egg', count: s.count });
            left -= s.count;
            cur.inventory.slots[slot] = null;
          }
        }
        expect(left).toBe(0);
      }
    }

    const night = runNight(cur, TEST_MAP);
    cur = night.state;
    const earned = night.events
      .filter((e): e is Extract<SimEvent, { type: 'ItemSold' }> => e.type === 'ItemSold')
      .filter((e) => e.itemId === 'animal_egg')
      .reduce((sum, e) => sum + e.gold, 0);
    eggIncome += earned;
    records.push({ day: night.summary.day, goldAtWake, eggIncome: earned });
  }
  return { state: cur, records, outflows, eggIncome };
}

let cached: ReturnType<typeof runScriptC> | null = null;
function run28(): ReturnType<typeof runScriptC> {
  cached ??= runScriptC(28);
  return cached;
}

describe.skipIf(!WIRING_READY)('script C — 28 days of coop economics (GDD §8.2/§4.7)', () => {
  it('the wallet reconciles EXACTLY: 6,000 − outflows + egg income (sink, not faucet)', () => {
    const { state, outflows, eggIncome } = run28();
    expect(state.economy.gold).toBe(6_000 - outflows + eggIncome);
    // outflows: the 2,000g coop order + 2 hen top-ups (the build grants 2 free hens)
    expect(outflows).toBe(2_000 + 2 * COOP.HEN_BUY_PRICE);
  });

  it('§8.2 payback estimate: 4 hens ≈160g/day repay the 2,750g equivalent in 17~34 days', () => {
    const { eggIncome, records } = run28();
    // coop completes the morning of D3; hens reach 4 by D4 — steady state 160g/night.
    // 28 days of income must cross the equivalent price inside the §8.2 band.
    expect(eggIncome).toBeGreaterThanOrEqual(COOP_EQUIV_PRICE);
    const paybackDay = (() => {
      let acc = 0;
      for (const r of records) {
        acc += r.eggIncome;
        if (acc >= COOP_EQUIV_PRICE) return r.day;
      }
      return Infinity;
    })();
    expect(paybackDay).toBeGreaterThanOrEqual(17);
    expect(paybackDay).toBeLessThanOrEqual(34);
  });

  it('daily steady-state production is the §8.2 number: 4 eggs → 160g per settlement', () => {
    const { records } = run28();
    const steady = records.filter((r) => r.day >= 6 && r.day <= 27);
    for (const r of steady) {
      expect(r.eggIncome).toBe(4 * COOP.EGGS_PER_HEN_PER_NIGHT * 40);
    }
  });

  it('the run is deterministic: two replays serialize identically', () => {
    const a = runScriptC(10);
    const b = runScriptC(10);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('materials only ever flow OUT through building (no material faucet in script C)', () => {
    const { state } = run28();
    expect(countItem(state.inventory, 'material_wood')).toBe(0); // 150 consumed by the coop
  });
});
