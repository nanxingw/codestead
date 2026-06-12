/**
 * Quality is PRODUCED in gameplay, not just unit-tested in isolation (PRD 04 §G43/45,
 * review finding high/US43). This is the SIM-LEVEL seam the quality.ts header anticipates:
 * the harvest reducer draws from the serialized sfc32 stream (sim/time rngState), tags the
 * produced stack, and settlement prices every line by its grade (silver 1.25× / gold 1.5×).
 *
 * Asserts external behaviour only (§Testing Decisions): non-normal stacks appear after a
 * fast-forward of harvests, and the shipping settlement gold reflects the per-grade
 * multipliers — never internal call counts.
 */
import { describe, expect, it } from 'vitest';

import { applyAction } from '../farming.js';
import { depositAllToBin, settleShipping, unitSalePrice, type PriceCtx } from '../economy.js';
import { cropItemId, getItemDef } from '../data/items.js';
import type { ItemStack, Quality, WorldState } from '../types.js';
import { makeWorldState } from './fixtures.js';

const TURNIP = 'turnip';
const TURNIP_ITEM = cropItemId(TURNIP);

/** A field of `n` mature single-harvest turnips on contiguous tilled tiles. */
function matureTurnipField(n: number, rngState: string): WorldState {
  const state = makeWorldState({ time: { ...makeWorldState().time, rngState } });
  for (let i = 0; i < n; i++) {
    state.farm.tiles[`${20 + i},14`] = {
      tilled: true,
      wateredToday: false,
      crop: {
        cropId: TURNIP,
        daysGrown: 99,
        mature: true,
        regrowDaysLeft: null,
        harvestsLeft: null,
        withered: false,
      },
    };
  }
  // Big bag so a full pack never blocks the fast-forward (24 slots, all stacks of 99).
  state.inventory.capacity = 24;
  while (state.inventory.slots.length < 24) state.inventory.slots.push(null);
  return state;
}

/** Fast-forward: harvest every mature tile; return the post-harvest state. */
function harvestAll(state: WorldState, n: number): WorldState {
  let s = state;
  for (let i = 0; i < n; i++) {
    s = applyAction(s, { kind: 'harvest', tile: { x: 20 + i, y: 14 } }).state;
  }
  return s;
}

function qualityOf(stack: ItemStack): Quality {
  return stack.quality ?? 'normal';
}

describe('quality is produced by the harvest reducer (PRD 04 US43)', () => {
  it('a fast-forward of harvests yields non-normal (silver AND gold) stacks', () => {
    // 200 harvests over the deterministic stream: with the provisional 5%/20% bands the
    // odds of zero silver or zero gold are astronomically small, and the stream is fixed,
    // so this is a stable assertion (no test randomness — §2.2).
    const N = 200;
    const after = harvestAll(matureTurnipField(N, '0123456789abcdef0123456789abcdef'), N);
    const grades = new Set(
      after.inventory.slots
        .filter((s): s is ItemStack => s !== null && s.itemId === TURNIP_ITEM)
        .map(qualityOf),
    );
    expect(grades.has('silver')).toBe(true);
    expect(grades.has('gold')).toBe(true);
  });

  it('quality stacks never merge across grades; quality never changes XP (§4.5)', () => {
    const N = 60;
    const after = harvestAll(matureTurnipField(N, 'fedcba9876543210fedcba9876543210'), N);
    const turnipStacks = after.inventory.slots.filter(
      (s): s is ItemStack => s !== null && s.itemId === TURNIP_ITEM,
    );
    // Every turnip stack is internally single-grade (a stack carries one quality only).
    for (const s of turnipStacks) expect([undefined, 'silver', 'gold']).toContain(s.quality);
    // Total harvested count is exactly N regardless of how the grades split into stacks.
    const total = turnipStacks.reduce((sum, s) => sum + s.count, 0);
    expect(total).toBe(N);
    // XP is per-harvest and grade-independent: N harvests grant exactly N × the §3.6
    // turnip xpHarvest, which one isolated harvest reveals (no magic number here).
    const xpPerHarvest = harvestAll(matureTurnipField(1, 'fedcba9876543210fedcba9876543210'), 1)
      .progress.xp;
    expect(after.progress.xp).toBe(N * xpPerHarvest);
  });

  it('shipping settlement prices every line by its own grade (silver 1.25× / gold 1.5×)', () => {
    const N = 120;
    const harvested = harvestAll(matureTurnipField(N, '13579bdf02468ace13579bdf02468ace'), N);

    // Independently compute the expected gold from the produced stacks (the test oracle:
    // sum over grades of unitSalePrice(turnip, grade) × count), BEFORE settlement.
    const ctx: PriceCtx = { profession: null };
    const byGrade = new Map<Quality, number>();
    for (const s of harvested.inventory.slots) {
      if (s && s.itemId === TURNIP_ITEM) {
        byGrade.set(qualityOf(s), (byGrade.get(qualityOf(s)) ?? 0) + s.count);
      }
    }
    let expectedGold = 0;
    for (const [grade, count] of byGrade) {
      expectedGold += unitSalePrice(getItemDef(TURNIP_ITEM), grade, ctx) * count;
    }
    // At least one silver and one gold contributed, so the total strictly exceeds the
    // all-normal price — proving the multipliers actually moved the number.
    const allNormalGold = unitSalePrice(getItemDef(TURNIP_ITEM), 'normal', ctx) * N;
    expect(expectedGold).toBeGreaterThan(allNormalGold);

    const goldBefore = harvested.economy.gold;
    const deposited = depositAllToBin(harvested).state;
    const settled = settleShipping(deposited).state;
    expect(settled.economy.gold - goldBefore).toBe(expectedGold);
  });
});
