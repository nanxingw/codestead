/**
 * lighting.ts — day-night tint computation (GDD §2.7, pure / Phaser-free).
 *
 * Presentation only, stepped every 10 game minutes (CLOCK_DISPLAY_STEP):
 * | 6:00–7:30  | dawn   | warm orange 25% → 0 |
 * | 7:30–17:00 | day    | no tint             |
 * | 17:00–19:00| golden | warm gold → 15%     |
 * | 19:00–22:00| dusk   | blue-purple → 45%   |
 * Rain adds a constant 10% cold-grey overlay all day (+ rain particles, view-side).
 */
import { TIME } from '../sim/data/constants';
import type { TimeView, Weather } from '../sim/types';
import { LIGHT_COLORS } from './palette';

// §2.7 phase boundaries in minutes-of-day (6:00 / 7:30 / 17:00 / 19:00 / 22:00).
const DAWN_END = 450;
const GOLDEN_START = 1020;
const DUSK_START = 1140;

const DAWN_MAX_ALPHA = 0.25;
const GOLDEN_MAX_ALPHA = 0.15;
const DUSK_MAX_ALPHA = 0.45;
/** Rain: 10% cold grey all day (§2.7). */
export const RAIN_OVERLAY = { color: LIGHT_COLORS.rainGrey, alpha: 0.1 } as const;

export interface LightingStep {
  phase: TimeView['phase'];
  /** Full-screen tint color (fx layer, depth 1100). */
  tintColor: number;
  /** 0 = no tint. */
  tintAlpha: number;
  /** Rain overlay active (view also drives particles + future rain loop from this). */
  rain: boolean;
}

/** Tint for a minute-of-day, bucketed to CLOCK_DISPLAY_STEP so it visibly steps. */
export function lightingAt(minuteOfDay: number, weather: Weather): LightingStep {
  const step = TIME.CLOCK_DISPLAY_STEP;
  const m = Math.max(
    TIME.DAY_START_MINUTE,
    Math.min(TIME.DAY_END_MINUTE, Math.floor(minuteOfDay / step) * step),
  );
  const rain = weather === 'rain';

  if (m < DAWN_END) {
    const t = (DAWN_END - m) / (DAWN_END - TIME.DAY_START_MINUTE);
    return { phase: 'dawn', tintColor: LIGHT_COLORS.dawn, tintAlpha: DAWN_MAX_ALPHA * t, rain };
  }
  if (m < GOLDEN_START) {
    return { phase: 'day', tintColor: LIGHT_COLORS.golden, tintAlpha: 0, rain };
  }
  if (m < DUSK_START) {
    const t = (m - GOLDEN_START) / (DUSK_START - GOLDEN_START);
    return {
      phase: 'golden',
      tintColor: LIGHT_COLORS.golden,
      tintAlpha: GOLDEN_MAX_ALPHA * t,
      rain,
    };
  }
  const t = (m - DUSK_START) / (TIME.DAY_END_MINUTE - DUSK_START);
  return {
    phase: 'dusk',
    tintColor: LIGHT_COLORS.dusk,
    tintAlpha: GOLDEN_MAX_ALPHA + (DUSK_MAX_ALPHA - GOLDEN_MAX_ALPHA) * t,
    rain,
  };
}
