/**
 * Casual bot — the §5.4 「休闲路径（只浇水+顺手收）」 oracle (PRD 02 testing
 * decision 3 second half; the "waiting-room player" profile from the PRD problem
 * statement).
 *
 * 口径 (kept deliberately minimal so the bot under-states a real casual player):
 *   - D1 setup only: till a small fixed plot (10 tiles — under the Lv1 cap of 12),
 *     spend the starting 100g on 10 radish seeds, plant, water;
 *   - every later morning, in order: ① water everything growing, ② harvest whatever
 *     happens to be mature (顺手收) and ship it, ③ re-sow ONLY the same plot with
 *     radish when the wallet allows (no expansion, no higher-tier seeds, no tool
 *     upgrades, no foraging, no berry/cabbage chasing), ④ water the new plantings;
 *   - sleep (manual sleep ≡ 22:00 settlement, ruling A-20).
 *
 * Income cadence note: sales settle overnight (GDD §4.2), so the wallet is empty on
 * harvest mornings — the bot replants the morning AFTER each payday (a 3-day radish
 * cycle), which is exactly the low-pressure rhythm §5.4 describes.
 */
import type { SimApi } from '../sim.js';
import type { TilePos } from '../types.js';
import { TEST_MAP, countItem, effLevelOf, farmTileEntries, tilesInRect } from './fixtures.js';

const PLOT_TILES = 10;
const SEED = 'seed_radish_quick';
const SEED_PRICE = 10; // GDD §3.6 radish_quick

export interface CasualDayRecord {
  day: number;
  xpAfterMorning: number;
  levelAfterMorning: number;
}

/** First PLOT_TILES tiles of the always-unlocked field A (deterministic order). */
function plotTiles(): TilePos[] {
  const fieldA = TEST_MAP.unlockGroups.find((g) => g.zoneId === 'field_a');
  if (!fieldA || fieldA.rects.length === 0) throw new Error('field_a missing from TEST_MAP');
  return fieldA.rects.flatMap((rect) => tilesInRect(rect)).slice(0, PLOT_TILES);
}

function waterAll(sim: SimApi): void {
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop && !tile.crop.mature && !tile.wateredToday) {
      sim.dispatch({ type: 'interact', tile: pos, itemId: 'watering_can' });
    }
  }
}

function harvestInPassing(sim: SimApi): void {
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop?.mature) sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
  }
}

/** Re-sow empty plot tiles with radish, buying only what the wallet covers. */
function resowPlot(sim: SimApi, plot: TilePos[]): void {
  const empties = plot.filter((pos) => {
    const tile = sim.state.farm.tiles[`${pos.x},${pos.y}`];
    return tile !== undefined && tile.crop === null;
  });
  if (empties.length === 0) return;
  const have = countItem(sim.state.inventory, SEED);
  const buy = Math.min(
    Math.floor(sim.state.economy.gold / SEED_PRICE),
    Math.max(0, empties.length - have),
  );
  if (buy > 0) sim.dispatch({ type: 'buyShopEntry', entryId: SEED, requested: buy });
  for (const pos of empties) {
    if (countItem(sim.state.inventory, SEED) === 0) break;
    sim.dispatch({ type: 'interact', tile: pos, itemId: SEED });
  }
}

/** Run the casual bot for `days` mornings; one record per settled day. */
export function runCasualBot(sim: SimApi, days: number): CasualDayRecord[] {
  const plot = plotTiles();
  const records: CasualDayRecord[] = [];
  for (let i = 0; i < days; i++) {
    const day = sim.state.time.day;
    if (i === 0) {
      for (const pos of plot) sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
    }
    waterAll(sim); // ① 只浇水
    harvestInPassing(sim); // ② 顺手收
    sim.dispatch({ type: 'depositAllToBin' });
    resowPlot(sim, plot); // ③ same plot only — never expands
    waterAll(sim); // ④ water the same-morning plantings (§3.4)
    const xpAfterMorning = sim.state.progress.xp;
    sim.sleep();
    records.push({ day, xpAfterMorning, levelAfterMorning: effLevelOf(xpAfterMorning) });
  }
  return records;
}
