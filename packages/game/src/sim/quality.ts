/**
 * quality.ts — crop quality (M3, GDD §4.5; PRD 04 §G).
 *
 * Settled by the GDD (do NOT touch without a doc revision):
 *   - three grades: normal / silver / gold; zod source of truth = shared QualitySchema;
 *   - sale multipliers silver 1.25× / gold 1.5×, composed inside unitSalePrice with the
 *     profession multiplier, multiply-all-then-floor-ONCE (§4.5 canonical example:
 *     gold turnip + horticulturist = floor(38 × 1.5 × 1.1) = 62);
 *   - quality never changes XP; price-tier judgements use the BASE price (§4.5);
 *   - quality applies to HARVESTED CROPS only (PRD 04 conservative reading): seeds,
 *     materials, eggs and processed goods are always normal — processing any-quality
 *     input yields a normal product (recorded in openQuestions);
 *   - UI: quality badges must be double-encoded (colour + shape) and grayscale-readable
 *     (§10.8 / PRD 04 light-sensitivity notes).
 *
 * NOT settled (PRD 04 待裁决 1 — owner decision pending): the GENERATION mechanism
 * (probability? watering/sprinkler linkage?). Until the owner rules, this module ships
 * a PROVISIONAL flat distribution (no gameplay linkage — the most conservative shape:
 * quality stays a pure "surprise bonus", introduces no new grind axis, and any future
 * mechanism can only redistribute the same three outcomes). Backfill GDD §4.5/§3.x
 * with the ruling, then replace PROVISIONAL_QUALITY_ROLL in the same commit.
 *
 * Layer rules: zero Phaser, zero wall clock; randomness ONLY via the caller-supplied
 * draw from the serialized sfc32 stream (sim/time owns rngState).
 */
import type { Quality } from '@codestead/shared';

export type { Quality };

/** Sale multipliers (GDD §4.5). Consumed exclusively by economy.unitSalePrice. */
export const QUALITY_MULT: Readonly<Record<Quality, number>> = {
  normal: 1,
  silver: 1.25,
  gold: 1.5,
};

/**
 * ⚠ PROVISIONAL (PRD 04 待裁决 1): flat roll probabilities, normal = remainder (75%).
 * Chosen conservative: rare enough to stay a surprise, no behavioural coupling.
 */
export const PROVISIONAL_QUALITY_ROLL = { silver: 0.2, gold: 0.05 } as const;

/**
 * Roll the quality of one harvested crop unit.
 *
 * @param draw one uniform draw in [0,1) from the sim's serialized rng stream —
 *   the caller (harvest reducer) draws so replay determinism stays with rngState.
 *   Order contract: gold band first ([0, gold)), then silver ([gold, gold+silver)).
 */
export function rollQuality(draw: number): Quality {
  if (draw < PROVISIONAL_QUALITY_ROLL.gold) return 'gold';
  if (draw < PROVISIONAL_QUALITY_ROLL.gold + PROVISIONAL_QUALITY_ROLL.silver) return 'silver';
  return 'normal';
}

/** Stack-merge rule: stacks merge only when itemId AND quality both match (§6.1 + v2). */
export function sameQuality(a: Quality | undefined, b: Quality | undefined): boolean {
  return (a ?? 'normal') === (b ?? 'normal');
}
