/**
 * Heavy acceptance: 10,000-night weather simulation (PRD 02 Testing Decision #5;
 * GDD §2.9 验收要点 "10,000 夜模拟雨频 20%±3%、无 3 连雨、第 1 天恒晴"; parameters
 * authoritative in GDD §2.1 / §3.4, ruling A-4).
 *
 * Two layers:
 *  1. PURE chain — drives rollWeather exactly the way the live pipeline does
 *     (newGameSim pre-rolls day 2 with ['sunny']; every NightUpdate #9 rolls day+1
 *     with the two preceding days), 10,000 nights per seed in milliseconds.
 *  2. INTEGRATION mirror — a real sim slept N nights must produce the exact same
 *     weather sequence as the pure chain for the same seed, so the 10k statistics
 *     proven on layer 1 transfer to the shipped pipeline by construction.
 *
 * Statistics note: with the RAIN_MAX_CONSECUTIVE=2 cap, the chain is a 3-state
 * Markov process whose stationary rain share is (p + p²)/(1 + p + p²) ≈ 19.35%
 * at p = 0.20 — comfortably inside both the GDD §2.9 band (20% ± 3pp) and the
 * tighter convergence band asserted here (20% ± 2pp). Seeds are fixed, so these
 * assertions are deterministic — never flaky.
 */
import { describe, expect, it } from 'vitest';

import { TIME } from '../data/constants.js';
import { newGameSim } from '../sim.js';
import { rngFromSeed, rngNext, rollWeather } from '../time.js';
import type { Weather } from '../types.js';
import { TEST_MAP } from './fixtures.js';

const NIGHTS = 10_000;
const SEEDS = ['wx-alpha', 'wx-bravo', 'wx-charlie', 'wx-delta', 'wx-echo'] as const;

/**
 * Reproduce the live rng→weather chain for days 1..totalDays:
 * day 1 forced sunny (new save), day 2 pre-rolled with recent ['sunny'] (newGameSim),
 * day d≥3 rolled at the settlement of day d−2 with recent [weather(d−2), weather(d−1)]
 * (night-update.ts #9). Index d−1 of the result = weather of day d.
 */
function weatherChain(seed: string, totalDays: number): Weather[] {
  const weather: Weather[] = ['sunny'];
  let roll = rollWeather(rngFromSeed(seed), 2, ['sunny']);
  weather.push(roll.weather);
  for (let day = 3; day <= totalDays; day++) {
    roll = rollWeather(roll.rngState, day, [weather[day - 3], weather[day - 2]]);
    weather.push(roll.weather);
  }
  return weather;
}

function rainCount(weather: readonly Weather[]): number {
  return weather.filter((w) => w === 'rain').length;
}

function maxConsecutiveRain(weather: readonly Weather[]): number {
  let run = 0;
  let max = 0;
  for (const w of weather) {
    run = w === 'rain' ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

describe(`10,000-night weather statistics (GDD §2.9, pure chain, ${SEEDS.length} seeds)`, () => {
  it.each(SEEDS)('seed "%s": spring rain rate converges to 20% ± 2pp', (seed) => {
    const weather = weatherChain(seed, NIGHTS);
    expect(weather).toHaveLength(NIGHTS);
    const rate = rainCount(weather) / NIGHTS;
    // GDD §2.9 contract band is 20% ± 3pp; the M1.5 heavy-test plan pins the tighter
    // ± 2pp convergence band (theory: ≈19.35% under the consecutive-rain cap).
    expect(rate).toBeGreaterThanOrEqual(0.18);
    expect(rate).toBeLessThanOrEqual(0.22);
  });

  it.each(SEEDS)('seed "%s": 连雨 ≤2 holds on every one of the 10,000 nights', (seed) => {
    const weather = weatherChain(seed, NIGHTS);
    expect(maxConsecutiveRain(weather)).toBeLessThanOrEqual(TIME.RAIN_MAX_CONSECUTIVE);
  });

  it.each(SEEDS)('seed "%s": day 1 is sunny and the rain cap actually binds', (seed) => {
    const weather = weatherChain(seed, NIGHTS);
    expect(weather[0]).toBe('sunny'); // D1 强制晴 (GDD §2.1)
    // Sanity that the statistics are not degenerate: rain happens, and 2-day rain
    // streaks (the capped maximum) actually occur within 10,000 nights.
    expect(rainCount(weather)).toBeGreaterThan(0);
    expect(maxConsecutiveRain(weather)).toBe(TIME.RAIN_MAX_CONSECUTIVE);
  });
});

describe('forced-sunny day 1 (GDD §2.1 RAIN_FORCED_SUNNY_DAYS)', () => {
  it('only absolute day 1 is forced sunny — the constant is exactly [1]', () => {
    // M1 spring lock: the calendar wraps every 28 days but day numbers never reset,
    // so day 29 ("spring 1" of the next cycle) is NOT forced (GDD §2.6).
    expect([...TIME.RAIN_FORCED_SUNNY_DAYS]).toEqual([1]);
  });

  it('rollWeather(day 1) is sunny regardless of rng value or recent weather', () => {
    for (let i = 0; i < 50; i++) {
      const rng = rngFromSeed(`forced-${i}`);
      expect(rollWeather(rng, 1, []).weather).toBe('sunny');
      expect(rollWeather(rng, 1, ['rain', 'rain']).weather).toBe('sunny');
    }
  });

  it('a forced day still consumes the rng exactly once (deterministic consumption)', () => {
    const rng = rngFromSeed('consumption');
    expect(rollWeather(rng, 1, []).rngState).toBe(rngNext(rng).rngState);
    expect(rollWeather(rng, 5, ['rain', 'rain']).rngState).toBe(rngNext(rng).rngState);
  });

  it('every fresh save wakes up sunny on day 1 (100 seeds)', () => {
    for (let i = 0; i < 100; i++) {
      const sim = newGameSim(`d1-sunny-${i}`, TEST_MAP);
      expect(sim.state.time.day).toBe(1);
      expect(sim.state.time.weatherToday).toBe('sunny');
    }
  });
});

describe('integration mirror: the full sim reproduces the pure chain (1,000 nights)', () => {
  const DAYS = 1_000;
  const SEED = 'wx-integration';

  function liveWeather(): { observed: Weather[]; rainDaysSeen: number } {
    const sim = newGameSim(SEED, TEST_MAP);
    const observed: Weather[] = [sim.state.time.weatherToday];
    while (observed.length < DAYS) {
      sim.sleep(); // manual sleep ≡ 22:00 settlement (ruling A-20)
      observed.push(sim.state.time.weatherToday);
    }
    return { observed, rainDaysSeen: sim.state.progress.counters.rainDaysSeen ?? 0 };
  }

  it('1,000 slept nights match the pure chain day by day (same seed)', () => {
    const { observed } = liveWeather();
    expect(observed).toEqual(weatherChain(SEED, DAYS));
  });

  it('the integrated run also satisfies the §2.9 constraints and books rainDaysSeen', () => {
    const { observed, rainDaysSeen } = liveWeather();
    expect(observed[0]).toBe('sunny');
    expect(maxConsecutiveRain(observed)).toBeLessThanOrEqual(TIME.RAIN_MAX_CONSECUTIVE);
    // NightUpdate #9 bumps rainDaysSeen once per rainy morning (days 2..N; day 1 is
    // forced sunny) — the counter the rain_blessing achievement (#5) will read in M1.5.
    expect(rainDaysSeen).toBe(rainCount(observed));
  });
});
