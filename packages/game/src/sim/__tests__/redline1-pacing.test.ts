/**
 * Red line 1 calibration — the scripted half of the M1.5 playtest protocol
 * (PRD 02 Implementation Decision 12; GDD §0.5 红线 1 / §1.9 动线 / §5.4 节奏校验).
 *
 * Re-asserts the §5.4 pacing table VERBATIM (it is intentionally NOT script R: D1
 * tills 12 but plants only 10): D1 till 12 + buy 10 radish (spends the full 100g) +
 * plant 10 (+50 XP) → D2 water → D3 harvest 10 (+60 XP) ⇒ 110 ≥ 100 ⇒ Lv2 on the
 * morning of D3, and the first sale settles the same night (+180g).
 *
 * Decoupling discipline (ruling B-3, PRD 02 red line): the band assertions run in the
 * sim's DEFAULT mode, which IS the "成就奖励关闭" deduction mode (SimOptions.achievements
 * defaults off — sim.ts M1.5) — exact XP/gold values are asserted unconditionally
 * there. A second pass runs the SAME script with achievements ON and re-asserts the
 * red line landmarks, proving "成就系统怎么调都不会破坏新手节奏" (PRD 02 US32).
 * The human-playtest half (2 testers, no verbal hints, 10 real minutes) stays manual
 * per PRD 02 Testing Decision #12 — no telemetry.
 */
import { describe, expect, it } from 'vitest';

import { TIME, XP_PLANT, XP_THRESHOLDS } from '../data/constants.js';
import { getCropDef } from '../data/crops.js';
import type { SimApi } from '../sim.js';
import { newGameSim } from '../sim.js';
import type { TilePos } from '../types.js';
import {
  FIELD_A,
  TEST_MAP,
  countItem,
  effLevelOf,
  farmTileEntries,
  tilesInRect,
} from './fixtures.js';

const RADISH_XP = getCropDef('radish_quick').xpHarvest; // 6/茬 (GDD §3.6)
const LV2_XP = XP_THRESHOLDS[1]; // 100 (GDD §5.1)

function tillN(sim: SimApi, n: number): void {
  for (const tile of tilesInRect(FIELD_A)) {
    if (sim.tilledStatus().count >= n) break;
    if (!sim.queryAction(tile, 'hoe').valid) continue;
    sim.dispatch({ type: 'interact', tile, itemId: 'hoe' });
  }
}

function plantedTiles(sim: SimApi): TilePos[] {
  return farmTileEntries(sim.state)
    .filter(({ tile }) => tile.crop !== null)
    .map(({ pos }) => pos);
}

function plantN(sim: SimApi, n: number): void {
  let left = n;
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (left === 0) break;
    if (tile.crop !== null) continue;
    sim.dispatch({ type: 'interact', tile: pos, itemId: 'seed_radish_quick' });
    left--;
  }
}

function waterAll(sim: SimApi): void {
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop && !tile.crop.mature && !tile.wateredToday) {
      sim.dispatch({ type: 'interact', tile: pos, itemId: 'watering_can' });
    }
  }
}

function harvestAll(sim: SimApi): void {
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop?.mature) sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
  }
}

interface PacingCheckpoints {
  xpAfterD1: number;
  xpAfterD3Harvest: number;
  levelAtD2Morning: number;
  levelAtD3Morning: number;
  goldEarnedD3: number;
  shippedD3: unknown;
  levelUpsD3: number[];
  goldAfterD3: number;
  achievements: readonly string[];
}

/** Replay the §5.4 pacing table action for action on an already-created sim. */
function runPacingScript(sim: SimApi): PacingCheckpoints {
  // ---- Day 1 (§5.4 row 1): till 12, buy 10 radish with the whole 100g, plant 10 ----
  expect(sim.state.time.day).toBe(1);
  tillN(sim, 12);
  expect(sim.tilledStatus()).toEqual({ count: 12, cap: 12 }); // Lv1 cap (GDD §1.4)
  sim.dispatch({ type: 'buyShopEntry', entryId: 'seed_radish_quick', requested: 10 });
  expect(sim.state.economy.gold).toBe(0); // 允许花光，不赠种 (GDD §1.9)
  expect(countItem(sim.state.inventory, 'seed_radish_quick')).toBe(10);
  plantN(sim, 10);
  expect(plantedTiles(sim)).toHaveLength(10);
  waterAll(sim); // §1.9 D1 午后: 锄→播→浇
  const xpAfterD1 = sim.state.progress.xp;
  sim.sleep();

  // ---- Day 2 (§5.4 row 2): water only ----
  expect(sim.state.time.day).toBe(2);
  const levelAtD2Morning = effLevelOf(sim.state.progress.xp);
  waterAll(sim);
  sim.sleep();

  // ---- Day 3 (§5.4 row 3): harvest 10 on the MORNING, ship, settle at night ----
  expect(sim.state.time.day).toBe(3);
  harvestAll(sim);
  expect(countItem(sim.state.inventory, 'crop_radish_quick')).toBe(10);
  const xpAfterD3Harvest = sim.state.progress.xp;
  const levelAtD3Morning = effLevelOf(sim.state.progress.xp);
  sim.dispatch({ type: 'depositAllToBin' }); // "卖" completes at the night settlement (A-1)
  const summary = sim.sleep();
  return {
    xpAfterD1,
    xpAfterD3Harvest,
    levelAtD2Morning,
    levelAtD3Morning,
    goldEarnedD3: summary.goldEarned,
    shippedD3: summary.shipped,
    levelUpsD3: summary.levelUps,
    goldAfterD3: sim.state.economy.gold,
    achievements: sim.state.progress.achievements,
  };
}

describe('red line 1 — §5.4 pacing table replayed action for action', () => {
  it('deduction mode (default = 成就奖励关闭, B-3): exact XP/gold landmarks', () => {
    // SimOptions.achievements defaults OFF — this IS the §4.6/§5.4 deduction mode.
    const cp = runPacingScript(newGameSim('redline1', TEST_MAP));
    expect(cp.achievements).toEqual([]); // the engine granted nothing in this mode
    expect(cp.xpAfterD1).toBe(10 * XP_PLANT); // 播 +50, 锄/浇 0 (§5.2)
    expect(cp.levelAtD2Morning).toBe(1); // not earlier than D3
    expect(cp.xpAfterD3Harvest).toBe(110); // 50 播 + 60 收, nothing else
    expect(cp.levelAtD3Morning).toBe(2); // 红线 1: Lv2 于 D3 晨
    expect(cp.goldEarnedD3).toBe(180); // 10 × 18g through the bin
    expect(cp.shippedD3).toEqual([{ cropId: 'radish_quick', count: 10, gold: 180 }]);
    expect(cp.levelUpsD3).toContain(2); // the day's progress block reports the level-up
    expect(cp.goldAfterD3).toBe(180); // D3 band [150,300] (§4.6) hit at the baseline point
  });

  it('achievements ON cannot break the newbie pacing (PRD 02 US32)', () => {
    const cp = runPacingScript(newGameSim('redline1', TEST_MAP, { achievements: true }));
    expect(cp.achievements.length).toBeGreaterThan(0); // engine actually live in this run
    expect(cp.levelAtD2Morning).toBe(1); // achievement XP cannot reach Lv2 by D2 (§5.6 budget)
    expect(cp.levelAtD3Morning).toBe(2); // the landmark is sow+harvest XP, never rewards
    expect(cp.xpAfterD3Harvest).toBeGreaterThanOrEqual(110);
    expect(cp.goldEarnedD3).toBe(180); // achievement gold is instant-to-wallet, never via bin
    expect(cp.goldAfterD3).toBeGreaterThanOrEqual(180);
    expect(cp.goldAfterD3).toBeLessThanOrEqual(300 + 340); // ≤ band ceiling + total faucet (§4.7)
  });

  it('decoupling proof at the numbers level: sow+harvest XP alone crosses Lv2 (B-3)', () => {
    // 10 plantings × 5 XP + 10 radish harvests × 6 XP = 110 ≥ 100 — red line 1 is
    // achievable with ZERO achievement XP, whatever the achievements engine grants.
    expect(10 * XP_PLANT + 10 * RADISH_XP).toBe(110);
    expect(10 * XP_PLANT + 10 * RADISH_XP).toBeGreaterThanOrEqual(LV2_XP);
  });
});

describe('red line 1 — real-time budget derived from the §2.1 constants', () => {
  it('one game day costs exactly 3 real minutes', () => {
    expect(TIME.REAL_MS_PER_GAME_MINUTE * TIME.GAME_MINUTES_PER_DAY).toBe(180_000);
  });

  it('first sow→harvest→sell completes within the 10-real-minute red line', () => {
    // Sale completes at the D3 night settlement = 3 full game days after the D1 6:00
    // start = 9.0 real minutes ≤ 10 (GDD §1.9: "出售完成时点 = D3 夜结算，≈9 分钟").
    const sellCompleteMs = 3 * TIME.GAME_MINUTES_PER_DAY * TIME.REAL_MS_PER_GAME_MINUTE;
    expect(sellCompleteMs).toBe(540_000);
    expect(sellCompleteMs).toBeLessThanOrEqual(600_000);
    // The Lv2 moment (D3 morning harvest) lands after two full days (6.0 real minutes),
    // i.e. strictly inside the budget with ≥1 real minute of slack for walking.
    const d3MorningMs = 2 * TIME.GAME_MINUTES_PER_DAY * TIME.REAL_MS_PER_GAME_MINUTE;
    expect(d3MorningMs).toBe(360_000);
    expect(d3MorningMs).toBeLessThan(sellCompleteMs);
  });
});
