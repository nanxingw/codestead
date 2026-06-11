/**
 * pickups.ts contract — daily forage refresh, bare-hand pickup, zero-loss semantics,
 * and the ≤66g/day optional faucet (GDD §1.3 / §2.5 #6 / §4.7). Gated on TODO(M1).
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

describe('daily pickups (GDD §1.3 — 6 wood + 4 stone + 3 wildflowers)', () => {
  it('picking every spot yields exactly the daily quantities into the backpack', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    pickEverything(sim);
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(6);
    expect(countItem(sim.state.inventory, 'material_stone')).toBe(4);
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
    expect(countItem(sim.state.inventory, 'material_wood')).toBe(6);
    expect(countItem(sim.state.inventory, 'material_stone')).toBe(4);
    expect(countItem(sim.state.inventory, 'forage_wildflower')).toBe(3);
  });

  it('faucet cap: shipping a full day of pickups settles for exactly 66g (§4.7 ≤66g/日)', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    pickEverything(sim);
    sim.dispatch({ type: 'depositAllToBin' });
    const summary = sim.sleep();
    expect(summary.goldEarned).toBe(66); // 6×5 + 4×3 + 3×8
    expect(sim.state.economy.gold).toBe(166);
  });

  it('the faucet can never exceed 66g per day even across greedy multi-day play', () => {
    const sim = createSim(makeSave(), TEST_MAP);
    for (let day = 0; day < 5; day++) {
      pickEverything(sim);
      pickEverything(sim); // greedy double attempt
      sim.dispatch({ type: 'depositAllToBin' });
      const summary = sim.sleep();
      expect(summary.goldEarned).toBeLessThanOrEqual(66);
    }
  });
});
