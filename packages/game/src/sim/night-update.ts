/**
 * night-update.ts — the 11-phase atomic NightUpdate (GDD §2.5, fixed-order CONTRACT).
 *
 * Triggered by crossing minute 1320 or by the house-door sleep confirm (ruling A-20;
 * both are exactly the same settlement). One synchronous pure function, never
 * interruptible by pause sources; crash-injection tests assert no intermediate state
 * (the input state is never mutated — every phase works on the pipeline's own clone).
 *
 * Phase order (verbatim from GDD §2.5 — DO NOT reorder):
 *   1 settleShipping   (economy.settleShipping)
 *   2 growCrops        (farming.growCrops)
 *   3 resetWatered     (farming.resetWatered)
 *   4 progressConstruction  — M3, no-op in M1
 *   5 produceAnimals        — M3, no-op in M1
 *   6 refreshPickups   (pickups.refreshPickups)
 *   7 advanceDay       (day++, minuteOfDay = 360)
 *   8 seasonCheck           — M1 no-op (spring lock)
 *   9 rollWeather      (weatherToday ← weatherTomorrow; roll new tomorrow; if the new
 *                       weatherToday is rain → wet all open-field tiles) — AFTER #7,
 *                       so the summary's "tomorrow" weather is the shifted weatherToday
 *  10 buildSummary     (phases 1..9 + dayLog → DaySummary; clear dayLog;
 *                       "tomorrow" list never empty — shop-teaser fallback)
 *  11 autosave         — performed by the CALLER (storage layer) with the returned
 *                       state; a write failure never blocks the summary screen
 *
 * Between #9 and #10 the settlement also applies the documented "new morning" effects
 * that the GDD anchors to the next 6:00 but does not number as phases:
 *   - fence/zone unlocks earned by level-ups during the day (GDD §1.4 "次日 6:00");
 *   - the soft-lock relief mail check (GDD §4.8 "晨检");
 *   - pruning stale NEW-badge bookkeeping (GDD §4.3, badge lasts one game day).
 */
import { TIME } from './data/constants.js';
import { getCropDef } from './data/crops.js';
import type { CropId } from './data/crops.js';
import { ITEMS_BY_ID } from './data/items.js';
import { morningReliefCheck, settleShipping } from './economy.js';
import { applyRainWetting, growCrops, isOldVine, resetWatered } from './farming.js';
import { bumpCounterInPlace } from './leveling.js';
import { refreshPickups } from './pickups.js';
import { pendingZoneUnlocks } from './tiles.js';
import { rollWeather, timeView } from './time.js';
import type { DaySummary, MapMeta, SimEvent, TomorrowItem, WorldState } from './types.js';

export function runNight(
  state: WorldState,
  map: MapMeta,
): { state: WorldState; summary: DaySummary; events: SimEvent[] } {
  const events: SimEvent[] = [];
  const settledView = timeView(state.time); // calendar of the day being settled
  const settledDay = state.time.day;
  const weatherOfSettledDay = state.time.weatherToday;

  // #1 settleShipping (atomic: price → credit → clear → collection log → events)
  const settle = settleShipping(state);
  let cur = settle.state;
  events.push(...settle.events);

  // #2 growCrops (+1 day iff watered or rain; stall otherwise)
  const growth = growCrops(cur);
  cur = growth.state;
  events.push(...growth.events);

  // #3 resetWatered (visual dry-out; #9 re-wets if the new day is rainy → net T12)
  cur = resetWatered(cur);

  // #4 progressConstruction — M3, no-op in M1
  // #5 produceAnimals — M3, no-op in M1

  // #6 refreshPickups (zero-loss overwrite of all forage spots)
  cur = refreshPickups(cur, map);

  // #7 advanceDay — `cur` is the pipeline's own clone from here on; direct mutation is safe.
  cur.time.day += 1;
  cur.time.minuteOfDay = TIME.DAY_START_MINUTE;

  // #8 seasonCheck — M1 no-op (spring lock, GDD §2.6)

  // #9 rollWeather: shift tomorrow → today, then roll the new tomorrow.
  const newToday = cur.time.weatherTomorrow;
  const roll = rollWeather(cur.time.rngState, cur.time.day + 1, [weatherOfSettledDay, newToday]);
  cur.time.weatherToday = newToday;
  cur.time.weatherTomorrow = roll.weather;
  cur.time.rngState = roll.rngState;
  if (newToday === 'rain') {
    cur = applyRainWetting(cur); // T13: every open-field tile wakes up wet
    bumpCounterInPlace(cur, 'rainDaysSeen', 1);
  }
  bumpCounterInPlace(cur, 'sleepCount', 1);

  // ---- new-morning effects (see header note; not numbered §2.5 phases) ----
  for (const zoneId of pendingZoneUnlocks(cur, map)) {
    cur.farm.unlockedZones.push(zoneId); // unlock only ever REMOVES collision (§1.4)
    events.push({ type: 'zoneUnlocked', zoneId });
  }
  const relief = morningReliefCheck(cur);
  cur = relief.state;
  events.push(...relief.events);
  for (const [entryId, day] of Object.entries(cur.economy.newEntriesSeenDay)) {
    if (day < cur.time.day) delete cur.economy.newEntriesSeenDay[entryId];
  }

  // #10 buildSummary (phases 1..9 + dayLog → DaySummary; clear dayLog)
  const harvested = aggregateHarvests(cur);
  const xpGained = cur.dayLog.reduce((sum, e) => (e.kind === 'xpGained' ? sum + e.amount : sum), 0);
  const levelUps = cur.dayLog.flatMap((e) => (e.kind === 'levelUp' ? [e.level] : []));
  const shippedCrops = settle.shipped.flatMap((line) => {
    const def = ITEMS_BY_ID.get(line.itemId);
    // DaySummary.shipped is crop-keyed per GDD §2.5; material lines (wood/stone/
    // wildflower) still count toward goldEarned but have no cropId row (open question).
    return def?.category === 'crop' && def.cropId
      ? [{ cropId: def.cropId, count: line.count, gold: line.gold }]
      : [];
  });
  const summary: DaySummary = {
    day: settledDay,
    season: settledView.season,
    dayOfSeason: settledView.dayOfSeason,
    year: settledView.year,
    harvested,
    shipped: shippedCrops,
    goldEarned: settle.shipped.reduce((sum, line) => sum + line.gold, 0),
    goldBalance: cur.economy.gold, // === the gold persisted by autosave (#11 ≥ #1)
    xpGained,
    levelUps,
    tomorrow: buildTomorrow(cur),
    weatherNext: cur.time.weatherToday, // the shifted weatherToday (#9 after #7)
  };
  cur.progress.xpHistory = [...cur.progress.xpHistory, xpGained].slice(-3); // ≤3-day ETA window
  cur.dayLog = [];

  // #11 autosave — performed by the CALLER (storage layer) with the returned state.
  return { state: cur, summary, events };
}

function aggregateHarvests(state: WorldState): { cropId: CropId; count: number }[] {
  const byCrop = new Map<CropId, number>();
  for (const entry of state.dayLog) {
    if (entry.kind !== 'harvested') continue;
    byCrop.set(entry.cropId, (byCrop.get(entry.cropId) ?? 0) + entry.count);
  }
  return [...byCrop.entries()].map(([cropId, count]) => ({ cropId, count }));
}

/**
 * "Tomorrow" promises, ≤3, ascending by inDays, NEVER empty (GDD §2.5): when nothing
 * else qualifies, the fixed shop teaser ("商店有新鲜种子等你") fills the list.
 */
function buildTomorrow(state: WorldState): TomorrowItem[] {
  const items: TomorrowItem[] = [];
  if (state.time.weatherToday === 'rain') items.push({ kind: 'rain' });

  const readiness = new Map<CropId, number>();
  for (const tile of Object.values(state.farm.tiles)) {
    const crop = tile.crop;
    if (crop === null || crop.withered || isOldVine(crop) || crop.mature) continue;
    const inDays =
      crop.regrowDaysLeft !== null
        ? Math.max(1, crop.regrowDaysLeft)
        : Math.max(1, getCropDef(crop.cropId).growthDays - crop.daysGrown);
    const prev = readiness.get(crop.cropId);
    if (prev === undefined || inDays < prev) readiness.set(crop.cropId, inDays);
  }
  const ready = [...readiness.entries()]
    .map(([cropId, inDays]) => ({ kind: 'cropReady' as const, cropId, inDays }))
    .sort((a, b) => a.inDays - b.inDays || a.cropId.localeCompare(b.cropId));
  items.push(...ready);
  if (items.length === 0) items.push({ kind: 'shopTeaser' }); // 明日之诺永不为空 (§2.5)
  return items.slice(0, 3);
}
