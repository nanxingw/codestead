/**
 * sim.ts — the SimApi facade: the ONLY surface the scene layer may touch.
 *
 * Data flow is strictly one-way: scenes translate input into SimCommands and subscribe
 * to SimEvents; render/audio never call back into game rules (GDD §12, tech-stack §1).
 * Pause is driver-side: when any pause source is active the driver simply stops calling
 * advanceMinutes (GDD §2.4/§2.8) — the sim has no notion of real time.
 *
 * Persistence contract: serialize() returns the meta-less save shape; restore accepts
 * ONLY RestorableSaveDoc, so wall-clock meta cannot reach the sim by type (GDD §10.2,
 * PRD 01 US99). The storage layer (packages/game/src/storage/**) wraps it with
 * { schemaVersion, meta } and runs the zod safeParse self-check before writing.
 *
 * apiDrift (recorded in the M1 workflow output) — additive facade extensions beyond
 * the contract SimApi, needed by the render/UI layer without breaking the
 * "facade-only" discipline:
 *   - view(): TimeView — clock/calendar for the top-right panel (§6.6);
 *   - tilledStatus(): {count, cap} — the "耕地 17/18" counter + cap hint (§1.4/§5.8);
 *   - shopCatalog(): ShopEntryView[] — the shop UI cannot rebuild availability rules;
 *   - syncPlayer(player) — movement is render-side (§1.6); the scene must push
 *     tile/facing into the sim so serialize() persists the real position.
 */
import type { RestorableSaveDoc, SaveQuests } from '@codestead/shared';

import { ECONOMY, INVENTORY, TIME } from './data/constants.js';
import { CROPS_BY_ID } from './data/crops.js';
import type { CropId } from './data/crops.js';
import { ITEMS_BY_ID } from './data/items.js';
import type { ItemId } from './data/items.js';
import {
  buy,
  catalog,
  depositAllToBin,
  depositToBin,
  refundSeeds,
  withdrawFromBin,
} from './economy.js';
import type { ShopEntryView } from './economy.js';
import { applyAction, isOldVine, queryAction } from './farming.js';
import { discardAt, move, select } from './inventory.js';
import { effectiveLevel } from './leveling.js';
import { runNight } from './night-update.js';
import { pickup, refreshPickups } from './pickups.js';
import { getTile, tilledCapForLevel, tilledCount } from './tiles.js';
import { advanceMinutes as advanceClock, rngFromSeed, rollWeather, timeView } from './time.js';
import type {
  ActionQuery,
  CounterId,
  CropState,
  DaySummary,
  FarmAction,
  ItemStack,
  MapMeta,
  PlayerState,
  SimCommand,
  SimEvent,
  TileKey,
  TilePos,
  TileState,
  TimeView,
  WorldState,
} from './types.js';

export interface SimApi {
  /** Read-only snapshot of the current state (do not mutate; sim owns the state). */
  readonly state: Readonly<WorldState>;

  /** Apply one command (keyboard E and mouse click MUST arrive as identical commands). */
  dispatch(command: SimCommand): SimEvent[];

  /** Pure cursor query, called every frame (GDD §1.7). null itemId = bare hand. */
  queryAction(tile: TilePos, itemId: ItemId | null): ActionQuery;

  /**
   * Advance n whole game minutes (the driver always passes 1; GDD §2.8). When the day
   * boundary is crossed this runs the full NightUpdate and includes DayEnded(summary)
   * in the returned events.
   */
  advanceMinutes(n: number): SimEvent[];

  /** Manual sleep (house door, ruling A-20) — identical settlement to 22:00. */
  sleep(): DaySummary;

  /** Subscribe to sim events; returns an unsubscribe function. */
  on(listener: (event: SimEvent) => void): () => void;

  /** Meta-less save snapshot (storage layer adds schemaVersion + meta). */
  serialize(): RestorableSaveDoc;

  // ---- M1 additive extensions (see header apiDrift note) ----

  /** Derived calendar/clock view (never stored). */
  view(): TimeView;

  /** Tilled-cap status for the hoe-held HUD counter and cap hint (GDD §1.4/§5.8). */
  tilledStatus(): { count: number; cap: number };

  /** Shop catalog view — pure function of the current state (GDD §4.3). */
  shopCatalog(): ShopEntryView[];

  /** Push the render-side player tile/facing into the sim before saving (GDD §1.6). */
  syncPlayer(player: PlayerState): void;
}

function makeSim(initial: WorldState, quests: SaveQuests, map: MapMeta): SimApi {
  let state = initial;
  const listeners = new Set<(event: SimEvent) => void>();

  function emit(events: SimEvent[]): void {
    for (const event of events) {
      for (const listener of listeners) listener(event);
    }
  }

  /** Shared by the 22:00 boundary and manual sleep — exactly the same settlement (A-20). */
  function runNightFlow(): { summary: DaySummary; events: SimEvent[] } {
    const weatherBefore = state.time.weatherToday;
    const result = runNight(state, map);
    state = result.state;
    const events: SimEvent[] = [...result.events, { type: 'DayEnded', summary: result.summary }];
    if (state.time.weatherToday !== weatherBefore) {
      events.push({ type: 'WeatherChanged', weather: state.time.weatherToday });
    }
    events.push({ type: 'DayStarted', day: state.time.day, weather: state.time.weatherToday });
    return { summary: result.summary, events };
  }

  function interactToFarmAction(tile: TilePos, itemId: ItemId | null): FarmAction | null {
    const query = queryAction(state, tile, itemId, map);
    if (!query.valid) return null;
    switch (query.verb) {
      case 'till': {
        // Hoe on a withered crop (T11) or an exhausted old vine (§3.2 镰刀/锄头清除)
        // is a clear; on grass it is the T1 till.
        const tileCrop = getTile(state, tile)?.crop ?? null;
        return tileCrop && (tileCrop.withered || isOldVine(tileCrop))
          ? { kind: 'clear', tile }
          : { kind: 'till', tiles: [tile] };
      }
      case 'water':
        return { kind: 'water', tiles: [tile] };
      case 'harvest':
        return { kind: 'harvest', tile };
      case 'sow': {
        const def = itemId === null ? undefined : ITEMS_BY_ID.get(itemId);
        return def?.cropId ? { kind: 'plant', tile, cropId: def.cropId } : null;
      }
      default:
        return null;
    }
  }

  function applyCommand(command: SimCommand): SimEvent[] {
    switch (command.type) {
      case 'interact': {
        const action = interactToFarmAction(command.tile, command.itemId);
        if (!action) return [];
        const result = applyAction(state, action, map);
        state = result.state;
        return result.events;
      }
      case 'selectSlot': {
        state = { ...state, inventory: select(state.inventory, command.slot) };
        return [];
      }
      case 'moveItem': {
        state = { ...state, inventory: move(state.inventory, command.from, command.to) };
        return [];
      }
      case 'discardItem': {
        const result = discardAt(state, command.slot);
        state = result.state;
        return result.events;
      }
      case 'depositToBin': {
        const result = depositToBin(state, command.slot, command.count);
        state = result.state;
        return result.events;
      }
      case 'withdrawFromBin': {
        const result = withdrawFromBin(state, command.index, command.count);
        state = result.state;
        return result.events;
      }
      case 'depositAllToBin': {
        const result = depositAllToBin(state);
        state = result.state;
        return result.events;
      }
      case 'buyShopEntry': {
        const result = buy(state, command.entryId, command.requested);
        if ('blocked' in result) return []; // UI derives the single blocked reason from state
        state = result.state;
        return result.events;
      }
      case 'refundSeeds': {
        const result = refundSeeds(state, command.slot, command.count);
        state = result.state;
        return result.events;
      }
      case 'pickup': {
        const result = pickup(state, command.spotId);
        state = result.state;
        return result.events;
      }
      case 'sleep': {
        return runNightFlow().events;
      }
    }
  }

  return {
    get state(): Readonly<WorldState> {
      return state;
    },
    dispatch(command: SimCommand): SimEvent[] {
      const events = applyCommand(command);
      emit(events);
      return events;
    },
    queryAction(tile: TilePos, itemId: ItemId | null): ActionQuery {
      return queryAction(state, tile, itemId, map);
    },
    advanceMinutes(n: number): SimEvent[] {
      const events: SimEvent[] = [];
      for (let i = 0; i < n; i++) {
        events.push(...advanceClock(state, 1)); // minute-by-minute: the 22:00 boundary is never stepped over
        if (state.time.minuteOfDay >= TIME.DAY_END_MINUTE) {
          events.push(...runNightFlow().events);
        }
      }
      emit(events);
      return events;
    },
    sleep(): DaySummary {
      const { summary, events } = runNightFlow();
      emit(events);
      return summary;
    },
    on(listener: (event: SimEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    serialize(): RestorableSaveDoc {
      return serializeWorld(state, quests);
    },
    view(): TimeView {
      return timeView(state.time);
    },
    tilledStatus(): { count: number; cap: number } {
      return {
        count: tilledCount(state),
        cap: tilledCapForLevel(effectiveLevel(state.progress.xp)),
      };
    },
    shopCatalog(): ShopEntryView[] {
      return catalog(state);
    },
    syncPlayer(player: PlayerState): void {
      state = { ...state, player: { ...player } };
    },
  };
}

// ---- persistence: WorldState ⇄ RestorableSaveDoc ----

const HARVESTED_PREFIX = 'harvestedCrops:';

function serializeWorld(state: WorldState, quests: SaveQuests): RestorableSaveDoc {
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(state.progress.counters)) {
    if (typeof value === 'number') counters[key] = value;
  }
  const harvestsByCrop: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    if (key.startsWith(HARVESTED_PREFIX))
      harvestsByCrop[key.slice(HARVESTED_PREFIX.length)] = value;
  }
  return {
    time: {
      day: state.time.day,
      season: timeView(state.time).season, // M1 'spring'; stored per §10.2 field table
      minuteOfDay: state.time.minuteOfDay,
      weatherToday: state.time.weatherToday,
      weatherTomorrow: state.time.weatherTomorrow,
      rngState: state.time.rngState,
    },
    player: {
      tileX: state.player.tileX,
      tileY: state.player.tileY,
      facing: state.player.facing,
      gold: state.economy.gold,
      selectedSlot: state.inventory.selected,
    },
    tools: { ...state.tools },
    inventory: {
      capacity: state.inventory.capacity,
      slots: structuredClone(state.inventory.slots),
    },
    world: {
      farmTiles: structuredClone(state.farm.tiles),
      shippingBin: structuredClone(state.economy.shippingBin),
    },
    progress: {
      xp: state.progress.xp,
      profession: state.progress.profession,
      counters,
      achievements: [...state.progress.achievements],
      xpHistory: [...state.progress.xpHistory],
      collectionLog: structuredClone(state.economy.collectionLog),
      stats: {
        // Derived from counters — stats never become a second source of truth.
        totalGoldEarned: counters['goldEarned'] ?? 0,
        totalHarvests: counters['harvestCount'] ?? 0,
        harvestsByCrop,
      },
    },
    quests: structuredClone(quests),
  };
}

/**
 * Tolerant hydration (GDD §10.9): unknown cropId → tile degrades to empty tilled soil;
 * unknown itemId → slot null / bin line dropped; everything logged with console.warn.
 * Runtime-only fields not present in SaveDoc v1 are re-derived:
 *   - farm.unlockedZones from effectiveLevel(xp) (the save has no zone field; see the
 *     derivation note at the assignment below);
 *   - pickups via refreshPickups (the save has no pickup field) — reloading restores
 *     today's forage; recorded as an open question in the M1 workflow;
 *   - dayLog starts empty (mid-day reload loses only the summary's "today" lines);
 *   - newEntriesSeenDay starts empty (the NEW badge does not survive a reload).
 */
function hydrate(save: RestorableSaveDoc, map: MapMeta): { state: WorldState; quests: SaveQuests } {
  const tiles: Record<TileKey, TileState> = {};
  for (const [key, tile] of Object.entries(save.world.farmTiles)) {
    let crop: CropState | null = null;
    if (tile.crop) {
      if (CROPS_BY_ID.has(tile.crop.cropId as CropId)) {
        crop = { ...tile.crop, cropId: tile.crop.cropId as CropId };
      } else {
        console.warn(
          `[sim] unknown cropId "${tile.crop.cropId}" at ${key} — tile degraded to tilled soil`,
        );
      }
    }
    tiles[key] = { tilled: true, wateredToday: tile.wateredToday, crop };
  }

  const slots = save.inventory.slots.map((stack): ItemStack | null => {
    if (stack === null) return null;
    if (ITEMS_BY_ID.has(stack.itemId)) return { ...stack };
    console.warn(`[sim] unknown itemId "${stack.itemId}" in inventory — slot cleared`);
    return null;
  });

  const shippingBin = save.world.shippingBin.filter((stack) => {
    if (ITEMS_BY_ID.has(stack.itemId)) return true;
    console.warn(`[sim] unknown itemId "${stack.itemId}" in shipping bin — line dropped`);
    return false;
  });

  const counters: WorldState['progress']['counters'] = {};
  for (const [key, value] of Object.entries(save.progress.counters)) {
    counters[key as CounterId] = value;
  }
  // Re-seed stats-backing counters if a hand-edited save dropped them (stats are
  // derived). Only non-zero values are seeded so a normal save→load round trip never
  // introduces counter keys the live run did not create (byte-identical replay).
  if (counters.goldEarned === undefined && save.progress.stats.totalGoldEarned > 0) {
    counters.goldEarned = save.progress.stats.totalGoldEarned;
  }
  if (counters.harvestCount === undefined && save.progress.stats.totalHarvests > 0) {
    counters.harvestCount = save.progress.stats.totalHarvests;
  }
  for (const [cropId, count] of Object.entries(save.progress.stats.harvestsByCrop)) {
    if (count > 0) counters[`${HARVESTED_PREFIX}${cropId}`] ??= count;
  }

  // SaveDoc v1 has no unlockedZones field. Re-derive from effectiveLevel(xp): every
  // zone whose farmLevel the player has reached is open after a reload — reachable
  // area never shrinks across save/load (§1.4 / PRD 01 US10). Autosave runs at night,
  // AFTER pendingZoneUnlocks applied that morning's unlocks, so level-derived zones
  // are exactly the live set on every normal load. Known deviation: a manual mid-day
  // reload on a level-up day opens the zone a few hours before the next-6:00 rule
  // would (derivation can only over-open, never re-fence). Persisting unlockedZones
  // in SaveDoc is deferred to an owner ruling (schema change, GDD §10.2).
  const unlockedZones = [
    ...new Set([
      'field_a',
      ...map.unlockGroups
        .filter((g) => g.farmLevel <= effectiveLevel(save.progress.xp))
        .map((g) => g.zoneId),
    ]),
  ];

  let state: WorldState = {
    time: {
      day: save.time.day,
      minuteOfDay: save.time.minuteOfDay,
      weatherToday: save.time.weatherToday,
      weatherTomorrow: save.time.weatherTomorrow,
      rngState: save.time.rngState,
    },
    player: { tileX: save.player.tileX, tileY: save.player.tileY, facing: save.player.facing },
    farm: { tiles, unlockedZones },
    inventory: {
      slots,
      capacity: save.inventory.capacity,
      selected: save.player.selectedSlot,
    },
    tools: { ...save.tools },
    economy: {
      gold: save.player.gold,
      shippingBin: structuredClone(shippingBin),
      collectionLog: structuredClone(save.progress.collectionLog),
      newEntriesSeenDay: {},
    },
    progress: {
      xp: save.progress.xp,
      profession: save.progress.profession,
      counters,
      achievements: [...save.progress.achievements],
      xpHistory: [...save.progress.xpHistory],
    },
    pickups: [],
    dayLog: [],
  };
  state = refreshPickups(state, map);
  return { state, quests: structuredClone(save.quests) };
}

/** Restore a sim from a validated save (storage layer has already run safeParse). */
export function createSim(save: RestorableSaveDoc, map: MapMeta): SimApi {
  const { state, quests } = hydrate(save, map);
  return makeSim(state, quests, map);
}

/**
 * Fresh state per GDD §10.2 new-save values: gold 100, capacity 12, both tools tier 1,
 * day 1, minuteOfDay 360, spring, xp 0, empty farmTiles, weatherToday 'sunny' (forced),
 * weatherTomorrow pre-rolled from seed, slot0 hoe / slot1 watering_can, no seeds.
 */
export function newGameSim(seed: string, map: MapMeta): SimApi {
  const roll = rollWeather(rngFromSeed(seed), 2, ['sunny']); // pre-roll day 2; day 1 forced sunny
  const slots: (ItemStack | null)[] = Array.from({ length: INVENTORY.M1_CAPACITY }, () => null);
  slots[0] = { itemId: 'hoe', count: 1 };
  slots[1] = { itemId: 'watering_can', count: 1 };
  let state: WorldState = {
    time: {
      day: 1,
      minuteOfDay: TIME.DAY_START_MINUTE,
      weatherToday: 'sunny',
      weatherTomorrow: roll.weather,
      rngState: roll.rngState,
    },
    player: {
      tileX: map.spawn.tile.x,
      tileY: map.spawn.tile.y,
      facing: map.spawn.facing,
    },
    farm: { tiles: {}, unlockedZones: ['field_a'] },
    inventory: { slots, capacity: 12, selected: 0 },
    tools: { hoe: 1, wateringCan: 1 },
    economy: {
      gold: ECONOMY.STARTING_GOLD,
      shippingBin: [],
      collectionLog: {},
      newEntriesSeenDay: {},
    },
    progress: { xp: 0, profession: null, counters: {}, achievements: [], xpHistory: [] },
    pickups: [],
    dayLog: [],
  };
  state = refreshPickups(state, map);
  return makeSim(state, { grantedQuestIds: [], completedCount: 0, noteRefs: [] }, map);
}
