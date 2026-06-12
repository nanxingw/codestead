/**
 * pickups.ts contract — daily forage refresh, bare-hand pickup, zero-loss semantics,
 * and the optional daily faucet (GDD §1.3 / §2.5 #6 / §4.7). Gated on TODO(M1).
 *
 * M3 (GDD §8.1 / PRD 04 US33): the edge regen rises to 10 wood + 6 stone per game day
 * (DAILY_MATERIAL_REGEN_M3) over the SAME §1.5 map spots (6/4/3 — per-spot unit counts
 * make up the difference), so the daily faucet cap becomes 10×5 + 6×3 + 3×8 = 92g.
 * The M1 §4.7 66g line is superseded by §8.1's merged material system.
 */
import { describe, expect, it } from 'vitest';

import { createSim, type SimApi } from '../sim.js';
import { TEST_MAP, countItem, makeSave, moduleReady, pickupSpotId, stack } from './fixtures.js';

const FACADE_READY = moduleReady(() => {
  const sim = createSim(makeSave(), TEST_MAP);
  sim.dispatch({ type: 'pickup', spotId: pickupSpotId('wood') });
  sim.sleep();
});

function pickEverything(sim: SimApi): void {
  for (const spot of TEST_MAP.pickupSpots) {
    sim.dispatch({ type: 'pickup', spotId: spot.id });
  }
}

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(FACADE_READY).toBe(true);
});

describe('daily pickups (GDD §1.3 spots; §8.1 M3 regen 10 wood + 6 stone + 3 wildflowers)', () => {
  it('picking every spot yields exactly the daily quantities into the backpack', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    pickEverything(sim);
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(10);
    expect(countItem(sim.state.inventory, 'material_stone')).toBe(6);
    expect(countItem(sim.state.inventory, 'forage_wildflower')).toBe(3);
    expect(sim.state.pickups.every((p) => !p.available)).toBe(true);
  });

  it('a spot cannot be double-picked the same day', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    sim.dispatch({ type: 'pickup', spotId: pickupSpotId('wildflower') });
    sim.dispatch({ type: 'pickup', spotId: pickupSpotId('wildflower') });
    expect(countItem(sim.state.inventory, 'forage_wildflower')).toBe(1);
  });

  it('pickup grants ZERO XP (anti-grind discipline, §5.2)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    pickEverything(sim);
    expect(sim.state.progress.xp).toBe(0);
  });

  it('a full backpack blocks pickup with zero loss — the spot stays available (§1.3)', () => {
    const fullSlots = [
      stack('hoe', 1),
      stack('watering_can', 1),
      ...Array.from({ length: 10 }, () => stack('crop_cabbage', 99)),
    ];
    const sim = createSim(makeSave({ inventory: { capacity: 12, slots: fullSlots } }), TEST_MAP);
    const woodSpot = pickupSpotId('wood');
    sim.dispatch({ type: 'pickup', spotId: woodSpot });
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(0);
    expect(sim.state.pickups.find((p) => p.spotId === woodSpot)?.available).toBe(true);
  });

  it('unpicked spots are simply overwritten by the nightly refresh — no stacking (§1.3)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    sim.sleep(); // nothing picked on day 1
    pickEverything(sim); // day 2 yields exactly one day's worth, not two
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(10);
    expect(countItem(sim.state.inventory, 'material_stone')).toBe(6);
    expect(countItem(sim.state.inventory, 'forage_wildflower')).toBe(3);
  });

  it('faucet cap: shipping a full day of pickups settles for exactly 92g (§8.1 M3)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    pickEverything(sim);
    sim.dispatch({ type: 'depositAllToBin' });
    const summary = sim.sleep();
    expect(summary.goldEarned).toBe(92); // 10×5 + 6×3 + 3×8
    expect(sim.state.economy.gold).toBe(192);
  });

  it('the faucet can never exceed 92g per day even across greedy multi-day play', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    for (let day = 0; day < 5; day++) {
      pickEverything(sim);
      pickEverything(sim); // greedy double attempt
      sim.dispatch({ type: 'depositAllToBin' });
      const summary = sim.sleep();
      expect(summary.goldEarned).toBeLessThanOrEqual(92);
    }
  });
});
