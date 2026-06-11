/**
 * Baseline income script R (GDD §4.6) — executable acceptance harness.
 *
 * Each morning at 6:00, in order (per the §4.6 day-by-day table; the table expands
 * to the cap BEFORE replanting — see D1 "锄 12 格 → 买 10 小萝卜 → 种下"):
 *   ① water every planted, not-yet-watered, non-mature crop tile;
 *   ② harvest everything mature → ship all sellable stacks to the bin;
 *   ③ expand tilled tiles up to the level cap (Lv1=12 / Lv3=18 / Lv5=24);
 *   ④ replant every empty tilled tile: best = highest unlocked gold-per-tile-day,
 *      buy as many as affordable while still able to fill the rest with radish
 *      (the §4.6 "买得起几格种几格，余格种小萝卜" rule), filler = radish_quick;
 *   ⑤ water the same-morning plantings (the §3.4 "watered every day" rule — the §5.4
 *      pacing table requires D1 plantings to grow on night 1);
 *   ⑥ no tools, no pickups, no achievements (script R scope, GDD §4.6);
 *   ⑦ sleep (manual sleep ≡ 22:00 settlement, ruling A-20).
 */
import type { SimApi } from '../sim.js';
import type { DaySummary, TilePos } from '../types.js';
import { getCropDef, type CropId } from '../data/crops.js';
import { seedItemId } from '../data/items.js';
import { RELIEF } from '../data/constants.js';
import { TEST_MAP, countItem, effLevelOf, farmTileEntries, tilesInRect } from './fixtures.js';

/** M1 crops ordered by descending gold/tile·day (GDD §3.6 "金币/格·日" column:
 * berry ≈10.8 > cabbage 9.8 > bean_vine ≈7.8 > potato 6.5 > turnip 4.5 > radish 4.0). */
export const GPD_RANK: readonly CropId[] = [
  'berry',
  'cabbage',
  'bean_vine',
  'potato',
  'turnip',
  'radish_quick',
];

export interface ScriptRDayRecord {
  /** Game day the morning ran on (1-based). */
  day: number;
  /** §4.8 soft-lock relief predicate evaluated at wake-up, BEFORE any action. */
  reliefEligibleAtWake: boolean;
  /** XP and effective level after the morning actions (red line 1 reads D3 here). */
  xpAfterMorning: number;
  levelAfterMorning: number;
  summary: DaySummary;
  goldAfterSettlement: number;
  /** Σ summary.goldEarned, day 1..this day (§4.6 累计毛收入). */
  cumulativeGross: number;
}

function unlockedTillable(sim: SimApi): TilePos[] {
  const zones = new Set(sim.state.farm.unlockedZones);
  const tiles: TilePos[] = [];
  for (const group of TEST_MAP.unlockGroups) {
    if (!zones.has(group.zoneId)) continue;
    for (const rect of group.rects) tiles.push(...tilesInRect(rect));
  }
  return tiles;
}

function waterAll(sim: SimApi): void {
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop && !tile.crop.mature && !tile.wateredToday) {
      sim.dispatch({ type: 'interact', tile: pos, itemId: 'watering_can' });
    }
  }
}

function harvestAll(sim: SimApi): void {
  // Mature-crop harvest has top farming priority for ANY selected item (GDD §3.5).
  for (const { pos, tile } of farmTileEntries(sim.state)) {
    if (tile.crop?.mature) sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
  }
}

function expandToCap(sim: SimApi): void {
  for (const pos of unlockedTillable(sim)) {
    if (sim.state.farm.tiles[`${pos.x},${pos.y}`]) continue;
    if (!sim.queryAction(pos, 'hoe').valid) continue; // cap reached or blocked → skip
    sim.dispatch({ type: 'interact', tile: pos, itemId: 'hoe' });
  }
}

function replant(sim: SimApi): void {
  const empties = farmTileEntries(sim.state)
    .filter(({ tile }) => tile.crop === null)
    .map(({ pos }) => pos)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (empties.length === 0) return;

  const gold = sim.state.economy.gold;
  const eff = effLevelOf(sim.state.progress.xp);
  const best = GPD_RANK.find((id) => getCropDef(id).unlockLevel <= eff) ?? 'radish_quick';
  const bestPrice = getCropDef(best).seedPrice;
  const fillerPrice = getCropDef('radish_quick').seedPrice; // 10g (GDD §3.6)

  // §4.6: buy best for as many tiles as affordable while radish can still fill the rest.
  let nBest: number;
  if (best === 'radish_quick') {
    nBest = Math.min(Math.floor(gold / fillerPrice), empties.length);
  } else {
    nBest = Math.floor((gold - empties.length * fillerPrice) / (bestPrice - fillerPrice));
    nBest = Math.max(0, Math.min(nBest, empties.length));
  }
  if (nBest > 0)
    sim.dispatch({ type: 'buyShopEntry', entryId: seedItemId(best), requested: nBest });

  const goldLeft = sim.state.economy.gold;
  const nFiller = Math.min(Math.floor(goldLeft / fillerPrice), empties.length - nBest);
  if (best !== 'radish_quick' && nFiller > 0) {
    sim.dispatch({ type: 'buyShopEntry', entryId: seedItemId('radish_quick'), requested: nFiller });
  }

  for (const pos of empties) {
    const cropId =
      countItem(sim.state.inventory, seedItemId(best)) > 0
        ? best
        : countItem(sim.state.inventory, seedItemId('radish_quick')) > 0
          ? ('radish_quick' as CropId)
          : null;
    if (cropId === null) break;
    sim.dispatch({ type: 'interact', tile: pos, itemId: seedItemId(cropId) });
  }
}

/** §4.8 soft-lock relief trigger condition (asserted to NEVER hold under script R). */
export function reliefEligible(sim: SimApi): boolean {
  const noSeeds = !sim.state.inventory.slots.some((s) => s?.itemId.startsWith('seed_'));
  const noCrops = !farmTileEntries(sim.state).some(({ tile }) => tile.crop !== null);
  return (
    sim.state.economy.gold < RELIEF.GOLD_BELOW &&
    noSeeds &&
    noCrops &&
    sim.state.economy.shippingBin.length === 0
  );
}

/** Run script R for `days` mornings; returns one record per settled day. */
export function runScriptR(sim: SimApi, days: number): ScriptRDayRecord[] {
  const records: ScriptRDayRecord[] = [];
  let cumulativeGross = 0;
  for (let i = 0; i < days; i++) {
    const day = sim.state.time.day;
    const reliefEligibleAtWake = reliefEligible(sim);

    waterAll(sim); // ①
    harvestAll(sim); // ②
    sim.dispatch({ type: 'depositAllToBin' }); // ② ship
    expandToCap(sim); // ③ (table order: expand before replant)
    replant(sim); // ④
    waterAll(sim); // ⑤ water same-morning plantings

    const xpAfterMorning = sim.state.progress.xp;
    const summary = sim.sleep(); // ⑦
    cumulativeGross += summary.goldEarned;
    records.push({
      day,
      reliefEligibleAtWake,
      xpAfterMorning,
      levelAfterMorning: effLevelOf(xpAfterMorning),
      summary,
      goldAfterSettlement: sim.state.economy.gold,
      cumulativeGross,
    });
  }
  return records;
}
