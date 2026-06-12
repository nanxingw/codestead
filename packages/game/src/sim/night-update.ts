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
 *   4 progressConstruction  — M3 (building.ts): 工地 → 烘干 → 加工 (§8.4 order)
 *   5 produceAnimals        — M3 (coop.ts): eggs per built coop, uncapped
 *   6 refreshPickups   (pickups.refreshPickups — M3 regen 10 wood + 6 stone, §8.1)
 *   7 advanceDay       (day++, minuteOfDay = 360)
 *   8 seasonCheck           — M3 still a framework no-op (season rotation is B-11
 *                             owner-pending; PRD 04 Out of Scope)
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
 *   - M3: greenhouse interior tiles are EXEMPT from rain wetting (§8.2 室内无雨天豁免 —
 *     applied right after #9's applyRainWetting so farming.ts stays interior-agnostic);
 *   - M3: sprinklers wet their coverage at 6:00 (§3.8/§5.3; tier 1 cross, tier 2 3×3;
 *     outdoor only — coverage never crosses a greenhouse wall);
 *   - the soft-lock relief mail check (GDD §4.8 "晨检");
 *   - pruning stale NEW-badge bookkeeping (GDD §4.3, badge lasts one game day).
 */
import {
  greenhousePlotKeys,
  progressConstructionInPlace,
  progressProcessingInPlace,
  sprinklerCoverage,
} from './building.js';
import { produceAnimalsInPlace } from './coop.js';
import { TIME } from './data/constants.js';
import { getCropDef } from './data/crops.js';
import type { CropId } from './data/crops.js';
import { ITEMS_BY_ID } from './data/items.js';
import { morningReliefCheck, settleShipping } from './economy.js';
import { applyRainWetting, growCrops, isOldVine, resetWatered } from './farming.js';
import { bumpCounterInPlace } from './leveling.js';
import { refreshPickups } from './pickups.js';
import { pendingZoneUnlocks, tileKey, tilledCapForLevel } from './tiles.js';
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

  // #4 progressConstruction + in-progress goods, fixed §8.4 order: 工地 → 烘干 → 加工
  // (`cur` is the pipeline's own clone after #3 — InPlace composition is safe).
  events.push(...progressConstructionInPlace(cur));
  events.push(...progressProcessingInPlace(cur));

  // #5 produceAnimals (1 egg/hen per settlement night, built coops only)
  events.push(...produceAnimalsInPlace(cur));

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
  const interiorKeys = greenhousePlotKeys(cur.structures);
  if (newToday === 'rain') {
    cur = applyRainWetting(cur); // T13: every open-field tile wakes up wet
    // §8.2 室内无雨天豁免: greenhouse interior plots stay dry under rain (the exemption
    // lives here so farming.ts stays interior-agnostic).
    for (const key of interiorKeys) {
      const tile = cur.farm.tiles[key];
      if (tile) tile.wateredToday = false;
    }
    bumpCounterInPlace(cur, 'rainDaysSeen', 1);
  }
  // Sprinklers wet their coverage at 6:00 (§3.8/§5.3) — outdoor tiles only; coverage
  // never crosses a greenhouse wall (interior watering needs the can; open question).
  for (const sp of cur.sprinklers ?? []) {
    for (const pos of sprinklerCoverage(sp)) {
      const key = tileKey(pos);
      if (interiorKeys.has(key)) continue;
      const tile = cur.farm.tiles[key];
      if (tile) tile.wateredToday = true;
    }
  }
  bumpCounterInPlace(cur, 'sleepCount', 1);

  // ---- new-morning effects (see header note; not numbered §2.5 phases) ----
  const unlockedTonight: { zoneId: string; farmLevel: number }[] = [];
  for (const zoneId of pendingZoneUnlocks(cur, map)) {
    cur.farm.unlockedZones.push(zoneId); // unlock only ever REMOVES collision (§1.4)
    const farmLevel = map.unlockGroups.find((g) => g.zoneId === zoneId)?.farmLevel ?? 1;
    unlockedTonight.push({ zoneId, farmLevel });
    events.push({ type: 'zoneUnlocked', zoneId });
  }
  const relief = morningReliefCheck(cur);
  cur = relief.state;
  events.push(...relief.events);
  // NEW-badge pruning (GDD §4.3; backlog A-13 — current semantics pinned as default):
  // the badge lives for the UNLOCK DAY itself (level-ups happen during the day; the
  // badge dies at this settlement). If the owner rules "first game day AFTER unlock",
  // change BOTH this condition and catalog()'s `=== today` check together.
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
    // Filled by the facade's post-settlement achievement sweep (sim.ts runNightFlow);
    // runNight itself never judges achievements (pure §2.5 pipeline).
    achievementsUnlocked: [],
    tomorrow: buildTomorrow(cur, unlockedTonight),
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
 * A zone unlocked by this settlement leads the list (GDD §1.4 「日结算屏明示数字」,
 * backlog A-14): 「明早西田开放 · 可打理田地 12→18」 — caps derived from the zone's
 * farmLevel bracket, so the line is correct even on multi-level jumps.
 */
function buildTomorrow(
  state: WorldState,
  unlockedTonight: { zoneId: string; farmLevel: number }[],
): TomorrowItem[] {
  const items: TomorrowItem[] = [];
  for (const unlock of unlockedTonight) {
    items.push({
      kind: 'zoneUnlocked',
      zoneId: unlock.zoneId,
      prevCap: tilledCapForLevel(unlock.farmLevel - 1),
      newCap: tilledCapForLevel(unlock.farmLevel),
    });
  }
  if (state.time.weatherToday === 'rain') items.push({ kind: 'rain' });

  // Construction promises (§8.3 acceptance「还差 N 天完工」/ §2.5 TomorrowItem): one
  // line per active site (and the farmhouse order), inDays = remaining settlement
  // nights AFTER this settlement's #4 tick.
  const sites: Extract<TomorrowItem, { kind: 'construction' }>[] = [];
  for (const s of state.structures ?? []) {
    if (s.state === 'underConstruction' && s.daysLeft !== undefined) {
      sites.push({ kind: 'construction', buildingId: s.defId, inDays: s.daysLeft });
    }
  }
  if (state.farmhouse?.construction) {
    sites.push({
      kind: 'construction',
      buildingId: `farmhouse_${state.farmhouse.construction.targetStage}`,
      inDays: state.farmhouse.construction.nightsLeft,
    });
  }
  sites.sort((a, b) => a.inDays - b.inDays || a.buildingId.localeCompare(b.buildingId));
  items.push(...sites);

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
