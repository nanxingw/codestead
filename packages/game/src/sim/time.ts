/**
 * time.ts — game clock, weather roll, deterministic RNG (GDD §2).
 *
 * Determinism iron rules (GDD §2.2, enforced by ESLint + CI grep):
 * - NO Date.now / performance.now / new Date / Math.random anywhere in sim/**;
 * - the sim only ever receives whole game minutes via advanceMinutes;
 * - all randomness flows through the serialized sfc32 rngState — same seed + same
 *   command script ⇒ byte-identical save.
 *
 * The render-side driver (NOT this module) owns the accumulator loop, pause-source set,
 * AFK timer and delta clamping (GDD §2.8); this module is pure state → state.
 */
import { TIME } from './data/constants.js';
import type { Season, SimEvent, TimeState, TimeView, Weather, WorldState } from './types.js';

// ---- deterministic RNG (sfc32, state serialized as 32 hex chars; GDD §2.2/§10.2) ----

const HEX32 = /^[0-9a-f]{32}$/;

function parseRngState(rngState: string): [number, number, number, number] {
  if (!HEX32.test(rngState)) throw new Error(`Invalid rngState (expected 32 hex): ${rngState}`);
  return [
    parseInt(rngState.slice(0, 8), 16),
    parseInt(rngState.slice(8, 16), 16),
    parseInt(rngState.slice(16, 24), 16),
    parseInt(rngState.slice(24, 32), 16),
  ];
}

function serializeRngState(a: number, b: number, c: number, d: number): string {
  return (
    (a >>> 0).toString(16).padStart(8, '0') +
    (b >>> 0).toString(16).padStart(8, '0') +
    (c >>> 0).toString(16).padStart(8, '0') +
    (d >>> 0).toString(16).padStart(8, '0')
  );
}

/**
 * Create an initial rngState from an arbitrary seed string (new game).
 * Seeding: xmur3 string hash → four 32-bit lanes → 12 discarded sfc32 outputs as warm-up
 * (standard sfc32 seeding practice; GDD §2.2 only mandates "sfc32, 32 hex chars").
 */
export function rngFromSeed(seed: string): string {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const lane = (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  let state = serializeRngState(lane(), lane(), lane(), lane());
  for (let i = 0; i < 12; i++) state = rngNext(state).rngState;
  return state;
}

/** Advance the PRNG once: returns the float in [0,1) and the next serialized state. */
export function rngNext(rngState: string): { value: number; rngState: string } {
  let [a, b, c, d] = parseRngState(rngState);
  a |= 0;
  b |= 0;
  c |= 0;
  d |= 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return { value: (t >>> 0) / 4294967296, rngState: serializeRngState(a, b, c, d) };
}

// ---- clock ----

/**
 * Advance the clock by n whole game minutes. The driver always calls with n=1 so the
 * 22:00 boundary can never be stepped over (GDD §2.8). The clock clamps at
 * DAY_END_MINUTE; the FACADE (sim.ts) detects the boundary and runs NightUpdate —
 * this function itself never runs settlement and never wraps the day.
 */
export function advanceMinutes(state: WorldState, n: number): SimEvent[] {
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`advanceMinutes: n must be a non-negative integer, got ${n}`);
  state.time.minuteOfDay = Math.min(state.time.minuteOfDay + n, TIME.DAY_END_MINUTE);
  // No clock event exists in the §12 event vocabulary; the driver derives clock ticks
  // from state.time (CLOCK_DISPLAY_STEP) after each advance.
  return [];
}

/** Derived calendar/clock view — never stored (GDD §2.2/§2.6). */
export function timeView(time: TimeState): TimeView {
  // M1 spring lock (GDD §2.6): seasonCheck is a no-op, the calendar wraps every 28 days
  // as "spring, day N" — so season is NOT derived from dayOfSeason until M3.
  const season: Season = 'spring';
  const dayOfSeason = ((time.day - 1) % TIME.DAYS_PER_SEASON) + 1;
  const year = Math.floor((time.day - 1) / TIME.DAYS_PER_YEAR) + 1;
  const hh = Math.floor(time.minuteOfDay / 60);
  const mm =
    Math.floor((time.minuteOfDay % 60) / TIME.CLOCK_DISPLAY_STEP) * TIME.CLOCK_DISPLAY_STEP;
  // Phase table (GDD §2.7): dawn 6:00–7:30, day 7:30–17:00, golden 17:00–19:00, dusk 19:00–22:00.
  const m = time.minuteOfDay;
  const phase: TimeView['phase'] =
    m < 450 ? 'dawn' : m < 1020 ? 'day' : m < 1140 ? 'golden' : 'dusk';
  return { season, dayOfSeason, year, hh, mm, phase };
}

// ---- weather (consumed by NightUpdate #9 rollWeather; GDD §2.5) ----

/**
 * Roll the weather for `dayBeingRolled`: spring 20%/night, forced sunny on
 * RAIN_FORCED_SUNNY_DAYS, max RAIN_MAX_CONSECUTIVE consecutive rain days
 * (GDD §2.1, ruling A-4). Pure; ALWAYS consumes the rng exactly once per settled
 * night (the only rng consumer in M1) — even when a constraint forces the result,
 * so the consumption count stays deterministic per night.
 *
 * `recentWeather` is the chronological weather of the days immediately before
 * `dayBeingRolled` (the last RAIN_MAX_CONSECUTIVE entries are inspected).
 */
export function rollWeather(
  rngState: string,
  dayBeingRolled: number,
  recentWeather: readonly Weather[],
): { weather: Weather; rngState: string } {
  const { value, rngState: nextState } = rngNext(rngState);
  let weather: Weather;
  if ((TIME.RAIN_FORCED_SUNNY_DAYS as readonly number[]).includes(dayBeingRolled)) {
    weather = 'sunny'; // day 1 forced sunny — watering tutorial guard (GDD §2.1)
  } else {
    const recent = recentWeather.slice(-TIME.RAIN_MAX_CONSECUTIVE);
    const atRainCap =
      recent.length === TIME.RAIN_MAX_CONSECUTIVE && recent.every((w) => w === 'rain');
    weather = atRainCap ? 'sunny' : value < TIME.RAIN_PROBABILITY.spring ? 'rain' : 'sunny';
  }
  return { weather, rngState: nextState };
}
