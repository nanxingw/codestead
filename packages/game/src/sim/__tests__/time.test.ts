/**
 * time.ts contract tests — sfc32 rng, derived calendar view, weather roll constraints
 * (GDD §2.1 / §2.2 / §2.5 #9 / §2.9 验收要点). Suites are gated on the TODO(M1)
 * skeletons and auto-activate when the implementation lands.
 */
import { describe, expect, it } from 'vitest';

import { rngFromSeed, rngNext, rollWeather, timeView } from '../time.js';
import { TIME } from '../data/constants.js';
import type { TimeState, Weather } from '../types.js';
import { TEST_RNG_STATE, moduleReady } from './fixtures.js';

const RNG_READY = moduleReady(() => rngNext(rngFromSeed('probe')));
const VIEW_READY = moduleReady(() =>
  timeView({
    day: 1,
    minuteOfDay: 360,
    weatherToday: 'sunny',
    weatherTomorrow: 'sunny',
    rngState: TEST_RNG_STATE,
  }),
);
const WEATHER_READY = moduleReady(() => rollWeather(TEST_RNG_STATE, 2, ['sunny']));

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(RNG_READY).toBe(true);
  expect(VIEW_READY).toBe(true);
  expect(WEATHER_READY).toBe(true);
});

describe('deterministic rng (GDD §2.2 sfc32, 32-hex serialized)', () => {
  it('rngFromSeed produces a 32-hex state; same seed ⇒ same state', () => {
    const a = rngFromSeed('codestead');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(rngFromSeed('codestead')).toBe(a);
    expect(rngFromSeed('other-seed')).not.toBe(a);
  });

  it('rngNext is pure & deterministic: same state ⇒ same value and next state', () => {
    const s0 = rngFromSeed('codestead');
    const r1 = rngNext(s0);
    const r2 = rngNext(s0);
    expect(r1).toEqual(r2);
    expect(r1.rngState).toMatch(/^[0-9a-f]{32}$/);
    expect(r1.rngState).not.toBe(s0);
  });

  it('produces floats in [0,1) with variation across a chain of 200 draws', () => {
    let state = rngFromSeed('codestead');
    const values: number[] = [];
    for (let i = 0; i < 200; i++) {
      const r = rngNext(state);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(1);
      values.push(r.value);
      state = r.rngState;
    }
    expect(new Set(values).size).toBeGreaterThan(150); // not a constant/short-cycle stream
  });
});

describe('timeView derivation (GDD §2.2/§2.6/§2.7 — never stored)', () => {
  const at = (day: number, minuteOfDay: number): TimeState => ({
    day,
    minuteOfDay,
    weatherToday: 'sunny',
    weatherTomorrow: 'sunny',
    rngState: TEST_RNG_STATE,
  });

  it('derives season/dayOfSeason/year from the absolute day (M1 locked to spring)', () => {
    expect(timeView(at(1, 360))).toMatchObject({ season: 'spring', dayOfSeason: 1, year: 1 });
    expect(timeView(at(28, 360)).dayOfSeason).toBe(28);
    expect(timeView(at(29, 360)).dayOfSeason).toBe(1); // calendar wraps every 28 days (§2.6)
    expect(timeView(at(29, 360)).season).toBe('spring'); // M1 spring lock
    expect(timeView(at(TIME.DAYS_PER_YEAR + 1, 360)).year).toBe(2);
  });

  it('clock floors mm to the 10-minute display step (§2.1)', () => {
    expect(timeView(at(1, 360))).toMatchObject({ hh: 6, mm: 0 });
    expect(timeView(at(1, 1295))).toMatchObject({ hh: 21, mm: 30 }); // 21:35 → 21:30
    expect(timeView(at(1, 779))).toMatchObject({ hh: 12, mm: 50 }); // 12:59 → 12:50
  });

  // §2.7: dawn 6:00–7:30 / day 7:30–17:00 / golden 17:00–19:00 / dusk 19:00–22:00.
  // Interior sample points only (the boundary minute ownership is presentation detail).
  it.each([
    [400, 'dawn'],
    [460, 'day'],
    [1010, 'day'],
    [1030, 'golden'],
    [1130, 'golden'],
    [1150, 'dusk'],
    [1310, 'dusk'],
  ] as const)('minute %i → phase %s', (minute, phase) => {
    expect(timeView(at(1, minute)).phase).toBe(phase);
  });
});

describe('rollWeather constraints (GDD §2.1, ruling A-4)', () => {
  const manySeeds = Array.from({ length: 50 }, (_, i) => rngFromSeed(`weather-${i}`));

  it('day 1 is forced sunny regardless of rng (watering tutorial guard)', () => {
    for (const state of manySeeds) {
      expect(rollWeather(state, 1, []).weather).toBe('sunny');
    }
  });

  it('after 2 consecutive rain days the next day is forced sunny', () => {
    for (const state of manySeeds) {
      expect(rollWeather(state, 10, ['rain', 'rain']).weather).toBe('sunny');
    }
  });

  it('consumes the rng exactly once per roll (returned state advances deterministically)', () => {
    const s0 = rngFromSeed('weather-chain');
    const a = rollWeather(s0, 5, ['sunny']);
    const b = rollWeather(s0, 5, ['sunny']);
    expect(a).toEqual(b); // pure
    expect(a.rngState).not.toBe(s0);
  });

  it('sequential simulation: rain frequency ≈20%±3%, never 3 consecutive rain days (§2.9)', () => {
    // Medium sample per PRD 01 (万夜级 simulation is the M1.5 heavy version).
    const NIGHTS = 4000;
    let state = rngFromSeed('weather-sim');
    const recent: Weather[] = ['sunny'];
    let rainDays = 0;
    let consecutive = 0;
    for (let day = 2; day < NIGHTS + 2; day++) {
      const r = rollWeather(state, day, [...recent]);
      state = r.rngState;
      if (r.weather === 'rain') {
        rainDays++;
        consecutive++;
      } else {
        consecutive = 0;
      }
      expect(consecutive).toBeLessThanOrEqual(TIME.RAIN_MAX_CONSECUTIVE);
      recent.push(r.weather);
      if (recent.length > 2) recent.shift();
    }
    const frequency = rainDays / NIGHTS;
    // Steady-state of the clamped chain is ≈19.4%; assert the documented 20%±3% band.
    expect(frequency).toBeGreaterThanOrEqual(0.17);
    expect(frequency).toBeLessThanOrEqual(0.23);
  });
});
