/**
 * farming.ts — tile/crop state machine: till, water, plant, harvest, clear
 * (GDD §3.2 state machine, §3.3 transition table T1~T13, §3.4 watering rules).
 *
 * Same-tile action priority (GDD §3.5): interactable entity > MATURE-CROP HARVEST
 * (highest farming priority, protects against accidental scything) > per-selected-item verb.
 *
 * Deliberately impossible transitions (GDD §3.3): tilled soil never reverts to grass;
 * mature single-harvest crops never expire; hoe on tilled/cropped tile is a no-op.
 * Old-vine state triggers ONLY by harvest-count exhaustion, never by time (§3.2);
 * it is encoded as `crop.harvestsLeft === 0` (no extra field in the save shape).
 * Withered state must be implemented + tested but is unreachable in M1 (§3.1).
 *
 * apiDrift note (recorded in the M1 workflow output): queryAction/applyAction take a
 * trailing `map: MapMeta` parameter beyond the skeleton signature — T1 validity
 * (tillable rects, locked zones) cannot be decided without the map contract.
 */
import { XP_PLANT } from './data/constants.js';
import { getCropDef } from './data/crops.js';
import { cropItemId, ITEMS_BY_ID, seedItemId } from './data/items.js';
import type { ItemId } from './data/items.js';
import { addInPlace, canAdd, removeItemInPlace } from './inventory.js';
import {
  bumpCounterInPlace,
  effectiveLevel,
  grantXpInPlace,
  raiseCounterInPlace,
} from './leveling.js';
import { canTill, getTile, parseTileKey, tileKey } from './tiles.js';
import { timeView } from './time.js';
import type {
  ActionQuery,
  CropState,
  FarmAction,
  MapMeta,
  SimEvent,
  TilePos,
  WorldState,
} from './types.js';

export type { FarmAction };

/** Old vine = regrow crop whose pod-season harvests are exhausted (GDD §3.2). */
export function isOldVine(crop: CropState): boolean {
  return crop.harvestsLeft === 0;
}

function hasItem(state: WorldState, itemId: ItemId): boolean {
  return state.inventory.slots.some((s) => s !== null && s.itemId === itemId);
}

function tileChangedEvent(state: WorldState, tile: TilePos): SimEvent {
  return { type: 'tileChanged', tile, state: getTile(state, tile) };
}

/**
 * Pure per-frame query driving the tile cursor (GDD §1.7): is there a valid action for
 * `itemId` on `tile`, and which verb? MUST be side-effect free and cheap. Covers the
 * FARMING verbs only — fixed interactables (bin/door/stall: 'sell'/'talk') are routed
 * by the scene layer via the interactables object layer, never through this query.
 * All invalid cases collapse to { valid:false, verb:'none' } (gray cursor); contextual
 * hint text (e.g. tilled-cap reached) is derived UI-side from the facade helpers.
 *
 * `itemId === null` means the bare hand (empty hotbar slot): per the §3.5 同格动作
 * 优先级 table (农产品/空手 row) it can ONLY trigger the mature-crop harvest above —
 * every other tile is invalid.
 */
export function queryAction(
  state: WorldState,
  tile: TilePos,
  itemId: ItemId | null,
  map: MapMeta,
): ActionQuery {
  const t = getTile(state, tile);
  const crop = t?.crop ?? null;

  // Highest farming priority: mature crop → harvest, with ANY selected item or the
  // bare hand (§3.5).
  if (crop && crop.mature && !crop.withered && !isOldVine(crop)) {
    return { valid: true, verb: 'harvest' };
  }

  if (itemId === null) return { valid: false, verb: 'none' }; // bare hand: harvest only

  const def = ITEMS_BY_ID.get(itemId);
  if (!def) return { valid: false, verb: 'none' };

  if (itemId === 'hoe') {
    if (crop?.withered) return { valid: true, verb: 'till' }; // T11 (M1-unreachable, tested)
    if (crop && isOldVine(crop)) return { valid: true, verb: 'till' }; // §3.2 镰刀/锄头清除老藤
    if (t === null && canTill(state, map, tile)) return { valid: true, verb: 'till' }; // T1
    return { valid: false, verb: 'none' };
  }

  if (itemId === 'watering_can') {
    // T2; wet tiles and rain-wetted tiles are no-ops (§3.4 — rain wets every open tile).
    if (t !== null && !t.wateredToday) return { valid: true, verb: 'water' };
    return { valid: false, verb: 'none' };
  }

  if (def.category === 'seed' && def.cropId) {
    // T3 conditions: tilled, empty, in-season, unlocked, seed in backpack.
    if (t !== null && crop === null) {
      const cropDef = getCropDef(def.cropId);
      const season = timeView(state.time).season;
      if (
        cropDef.seasons.includes(season) &&
        cropDef.unlockLevel <= effectiveLevel(state.progress.xp) &&
        hasItem(state, itemId)
      ) {
        return { valid: true, verb: 'sow' };
      }
    }
    return { valid: false, verb: 'none' };
  }

  // Crops / materials / bare hand: only the harvest priority above applies.
  return { valid: false, verb: 'none' };
}

/**
 * Apply a farm action (range tools pass pre-expanded tile lists; partially-invalid
 * ranges act on the legal subset only, GDD §3.9 #3). Returns the new state + events;
 * never throws on invalid targets — invalid tiles are skipped (no-op discipline).
 *
 * XP side effects: plant +5/plant (first planting of regrow crops only — regrowth
 * cycles never re-grant); harvest grants CropDef.xpHarvest per pick; till/water grant 0
 * (GDD §5.2). Counter bumps (tillCount/plantCount/harvestCount/waterCount) happen here
 * (GDD §5.6 instrumentation).
 *
 * `map` is only needed by the 'till' branch (T1 validity); when omitted, till actions
 * skip every tile (water/plant/harvest/clear are map-independent).
 */
export function applyAction(
  state: WorldState,
  action: FarmAction,
  map?: MapMeta,
): { state: WorldState; events: SimEvent[] } {
  const next = structuredClone(state);
  const events: SimEvent[] = [];

  switch (action.kind) {
    case 'till': {
      if (!map) break; // T1 validity is undecidable without the map contract
      for (const pos of action.tiles) {
        if (!canTill(next, map, pos)) continue; // skip illegal subset (§3.9 #3)
        next.farm.tiles[tileKey(pos)] = { tilled: true, wateredToday: false, crop: null };
        bumpCounterInPlace(next, 'tillCount', 1);
        events.push({ type: 'TileTilled', tile: pos });
        events.push(tileChangedEvent(next, pos));
      }
      break;
    }

    case 'water': {
      const watered: TilePos[] = [];
      for (const pos of action.tiles) {
        const t = getTile(next, pos);
        if (t === null || t.wateredToday) continue; // wet / rain-day tiles are no-ops (§3.4)
        t.wateredToday = true;
        bumpCounterInPlace(next, 'waterCount', 1);
        watered.push(pos);
        events.push(tileChangedEvent(next, pos));
      }
      if (watered.length > 0) events.push({ type: 'CropWatered', tiles: watered });
      break;
    }

    case 'plant': {
      const t = getTile(next, action.tile);
      const cropDef = getCropDef(action.cropId);
      const season = timeView(next.time).season;
      if (
        t === null ||
        t.crop !== null ||
        !cropDef.seasons.includes(season) ||
        cropDef.unlockLevel > effectiveLevel(next.progress.xp)
      ) {
        break; // T3 conditions (GDD §3.3); replanting onto a crop is blocked (§3.9 #7)
      }
      if (removeItemInPlace(next.inventory, seedItemId(action.cropId), 1) === 0) break;
      t.crop = {
        cropId: action.cropId,
        daysGrown: 0,
        mature: false,
        regrowDaysLeft: null,
        harvestsLeft: cropDef.regrowLimit ?? null, // bean_vine 8 / berry 6 (§3.1)
        withered: false,
      };
      // Planting in rain wets the tile instantly (§2.9); an already-wet tile counts
      // as watered for tonight either way (T3).
      if (next.time.weatherToday === 'rain') t.wateredToday = true;
      bumpCounterInPlace(next, 'plantCount', 1);
      events.push({ type: 'CropPlanted', tile: action.tile, cropId: action.cropId });
      events.push(tileChangedEvent(next, action.tile));
      events.push(...grantXpInPlace(next, XP_PLANT)); // +5 XP/株 (§5.2)
      break;
    }

    case 'harvest': {
      const t = getTile(next, action.tile);
      const crop = t?.crop ?? null;
      if (t === null || crop === null || !crop.mature || crop.withered) break;
      const cropDef = getCropDef(crop.cropId);
      const itemId = cropItemId(crop.cropId);
      // Full backpack: the whole pick is blocked, crop stays mature, the regrow
      // harvest is NOT consumed — zero loss (§3.9 #1). UI toasts from its own check.
      if (!canAdd(next.inventory, itemId, 1)) break;
      addInPlace(next.inventory, itemId, 1);
      if (crop.harvestsLeft !== null) {
        // T7: regrow crop → regrowing; exhausting the pod season turns it into the
        // old vine (harvestsLeft === 0), which never regrows and never expires (§3.2).
        crop.harvestsLeft -= 1;
        crop.mature = false;
        crop.regrowDaysLeft = crop.harvestsLeft > 0 ? (cropDef.regrowDays ?? null) : null;
        const limit = cropDef.regrowLimit ?? 0;
        raiseCounterInPlace(next, 'regrowChainMax', limit - crop.harvestsLeft);
      } else {
        t.crop = null; // T6: single harvest — tile stays tilled, watered state untouched
      }
      bumpCounterInPlace(next, 'harvestCount', 1);
      bumpCounterInPlace(next, `harvestedCrops:${crop.cropId}`, 1);
      next.dayLog.push({ kind: 'harvested', cropId: crop.cropId, count: 1 });
      events.push({
        type: 'CropHarvested',
        tile: action.tile,
        cropId: crop.cropId,
        count: 1,
        xp: cropDef.xpHarvest,
      });
      events.push(tileChangedEvent(next, action.tile));
      events.push(...grantXpInPlace(next, cropDef.xpHarvest));
      break;
    }

    case 'clear': {
      const t = getTile(next, action.tile);
      const crop = t?.crop ?? null;
      if (t === null || crop === null) break;
      // Sickle (T9/T11) + old-vine removal (§3.2). Mature healthy crops are protected
      // even against an explicit clear command (harvest priority, §3.5).
      if (crop.mature && !crop.withered && !isOldVine(crop)) break;
      const wasOldVine = isOldVine(crop);
      t.crop = null;
      // T11 withered → 耕地·干; §3.2 old-vine 清除 → 耕地·干 (both reset moisture).
      if (crop.withered || wasOldVine) t.wateredToday = false;
      events.push(tileChangedEvent(next, action.tile));
      break;
    }
  }

  return { state: next, events };
}

/**
 * NightUpdate #2 growCrops (GDD §2.5): each planted tile grows +1 day iff
 * wateredToday || weatherToday === 'rain' (open field); regrow countdown advances the
 * same way; max +1 day per night; unwatered = stall, never death (T4/T5/T8).
 */
export function growCrops(state: WorldState): { state: WorldState; events: SimEvent[] } {
  const next = structuredClone(state);
  const events: SimEvent[] = [];
  const rainy = next.time.weatherToday === 'rain';
  for (const [key, t] of Object.entries(next.farm.tiles)) {
    const crop = t.crop;
    if (crop === null || crop.withered || isOldVine(crop)) continue;
    if (!t.wateredToday && !rainy) continue; // T5: stall, no penalty
    const cropDef = getCropDef(crop.cropId);
    let changed = false;
    if (crop.regrowDaysLeft !== null) {
      // T8: countdown −1 per watered night; reaching 0 turns mature at this settlement
      // (bean: harvest d9 → rdl 2→1→0 → mature morning d11 — acceptance §3 harvest days).
      crop.regrowDaysLeft = Math.max(0, crop.regrowDaysLeft - 1);
      if (crop.regrowDaysLeft === 0) {
        crop.regrowDaysLeft = null;
        crop.mature = true;
      }
      changed = true;
    } else if (!crop.mature) {
      crop.daysGrown += 1; // T4: at most +1 per night
      if (crop.daysGrown >= cropDef.growthDays) crop.mature = true;
      changed = true;
    }
    if (changed) events.push({ type: 'tileChanged', tile: parseTileKey(key), state: t });
  }
  return { state: next, events };
}

/** NightUpdate #3 resetWatered (GDD §2.5 #3, T12): all wateredToday = false. */
export function resetWatered(state: WorldState): WorldState {
  const next = structuredClone(state);
  for (const t of Object.values(next.farm.tiles)) t.wateredToday = false;
  return next;
}

/**
 * Rain morning effect (NightUpdate #9 tail, GDD §2.5/§3.3 T13): when the shifted
 * weatherToday is rain, set wateredToday = true on every open-field farm tile.
 * Planting during rain also wets the tile immediately (applyAction's plant path, §2.9).
 */
export function applyRainWetting(state: WorldState): WorldState {
  const next = structuredClone(state);
  if (next.time.weatherToday !== 'rain') return next;
  for (const t of Object.values(next.farm.tiles)) t.wateredToday = true;
  return next;
}

/**
 * Visual stage 0..2 (M1 three-stage art: sprout / growing / mature) bucketed from
 * daysGrown/growthDays (GDD §3.7). Exact bucket thresholds are not specified in the
 * GDD; this maps [0, 0.5) → 0, [0.5, 1) → 1, ≥1 → 2. Stage changes land at 6:00
 * because growth only happens at night settlement.
 */
export function visualStage(daysGrown: number, growthDays: number): 0 | 1 | 2 {
  if (growthDays <= 0) return 2;
  const ratio = daysGrown / growthDays;
  if (ratio >= 1) return 2;
  return ratio >= 0.5 ? 1 : 0;
}
