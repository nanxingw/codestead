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
import type {
  QuestReward,
  RestorableSaveDoc,
  RestorableSaveDocV2,
  SaveQuests,
} from '@codestead/shared';

import { checkAchievements } from './achievements.js';
import {
  collectProcessedGood,
  demolishStructure,
  moveStructure,
  orderFarmhouseUpgrade,
  placeSprinkler,
  placeStructure,
  sanitizeStructuresInPlace,
  startProcessingJob,
} from './building.js';
import { grantCarpenterTools } from './building.js';
import { buyHen, collectEggs, sellHen } from './coop.js';
import { ECONOMY, INVENTORY, TIME } from './data/constants.js';
import { CROPS_BY_ID } from './data/crops.js';
import type { CropId } from './data/crops.js';
import { ITEMS_BY_ID } from './data/items.js';
import type { ItemId } from './data/items.js';
import {
  buy,
  buyMaterial,
  catalog,
  depositAllToBin,
  depositToBin,
  expandInventory,
  refundSeeds,
  withdrawFromBin,
} from './economy.js';
import type { ShopEntryView } from './economy.js';
import { applyAction, isOldVine, queryAction } from './farming.js';
import { discardAt, move, select, splitAt } from './inventory.js';
import { chooseProfession, markProfessionHintShownInPlace } from './profession.js';
import { bumpCounterInPlace, effectiveLevel } from './leveling.js';
import { runNight } from './night-update.js';
import { clearResourceNode, pickup, refreshPickups } from './pickups.js';
import { grantQuestReward, recordNoteWritten } from './quest-reward.js';
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

  /** Meta-less v2 save snapshot (storage layer adds schemaVersion + meta). */
  serialize(): RestorableSaveDocV2;

  // ---- M1 additive extensions (see header apiDrift note) ----

  /** Derived calendar/clock view (never stored). */
  view(): TimeView;

  /** Tilled-cap status for the hoe-held HUD counter and cap hint (GDD §1.4/§5.8). */
  tilledStatus(): { count: number; cap: number };

  /** Shop catalog view — pure function of the current state (GDD §4.3). */
  shopCatalog(): ShopEntryView[];

  /** Push the render-side player tile/facing into the sim before saving (GDD §1.6). */
  syncPlayer(player: PlayerState): void;

  /**
   * One-time porch-letter semantics (US86 / backlog A-4): sets the
   * `introLetterRead` counter to 1 on the first read (idempotent — repeat reads
   * are no-ops, keeping replays byte-stable). Counter-based, zero schema change.
   */
  markIntroLetterRead(): void;

  /**
   * US39 one-shot settlement hint (GDD §5.3 「达成当日结算屏温和提示一次」): the
   * day-summary panel shows the certificate-desk line when
   * profession.professionHintPending(state) and then burns the flag here
   * (idempotent counter-as-flag, same precedent as markIntroLetterRead).
   */
  markProfessionHintShown(): void;

  /**
   * M4 quest reward grant (PRD 05 §K; A9). Idempotently credits a daemon-issued
   * reward keyed on questId (grantedQuestIds) — reconnect replays / save imports
   * never double-credit. Runs the achievement sweep so #19 智者 lights up, and
   * returns the gold/level/unlock events (GoldChanged + any FarmLevelUp +
   * AchievementUnlocked) so the UI can celebrate; an already-granted questId
   * returns [] and changes nothing. The reward is sim-side: quest gold goes to
   * the wallet via the same faucet as achievements, never the shipping bin.
   */
  applyQuestReward(questId: string, reward: QuestReward): SimEvent[];

  /**
   * M4 thinking-note record (PRD 05 §K; #20 思考的痕迹 predicate). Idempotently
   * bumps `notesWritten` keyed on noteRef, decoupled from the reward grant
   * (§11-E11 — a note may land while the reward is withheld). Runs the sweep so
   * #20 lights up and returns any resulting AchievementUnlocked events.
   */
  recordQuestNote(noteRef: string): SimEvent[];
}

/**
 * Sim run-mode options (M1.5, PRD 02).
 *
 * `achievements` — the achievement engine switch (GDD §4.6 / §5.4 / ruling B-3):
 * OFF by default so every deduction/replay entry point (script R, script B, red-line 1,
 * determinism replays) stays byte-identical to the M1-core baseline — achievement
 * gold/XP can never leak into the economy acceptance bandwidths. Game entry points
 * (boot/menu/dev-fallback) opt in explicitly; that opt-in IS the "成就开启" mode and
 * the default IS the "成就奖励关闭" deduction mode required by §4.6.
 */
export interface SimOptions {
  achievements?: boolean;
}

function makeSim(
  initial: WorldState,
  quests: SaveQuests,
  map: MapMeta,
  options: SimOptions = {},
): SimApi {
  // M3 §8.1: the carpenter axe + pickaxe are the labor path's tools. Granting here covers
  // BOTH entry points (newGameSim and createSim→hydrate flow through makeSim) with one
  // idempotent, zero-loss call — already-owned tools are a no-op, a full bag postpones the
  // grant without loss, and replays stay byte-stable (the grant has no rng). This is the
  // "木匠服务已开通" hand-out PRD 04 open question 8 left to the facade. Events are dropped:
  // the grant is a silent baseline like the starting hoe/can, not a pickup notification.
  let state = grantCarpenterTools(initial).state;
  const achievementsOn = options.achievements === true;
  const listeners = new Set<(event: SimEvent) => void>();

  /**
   * Achievement sweep (M1.5): runs after every command and after each advanceMinutes
   * batch — the only paths that move counters/tools — which subsumes the GDD §5.6
   * trigger points (after bumpCounter / after tool upgrades). Also retro-unlocks
   * imported old saves on their first tick (PRD 02 US10/US16). No-unlock sweeps keep
   * the same state reference (cheap predicate scan, no clone).
   */
  function sweepAchievements(): SimEvent[] {
    if (!achievementsOn) return [];
    const result = checkAchievements(state);
    state = result.state;
    return result.events;
  }

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
    // Achievement sweep BEFORE the summary snapshot: settlement counters (sellCount /
    // goldEarned / sleepCount / rainDaysSeen) unlock exactly here, so (a) the new
    // unlocks ride the summary's progress block (GDD §5.8 「新成就」, PRD 02 US11)
    // and (b) instant achievement gold is in the wallet before goldBalance is pinned —
    // goldBalance MUST equal the gold the DayEnded-triggered night autosave persists
    // (GDD §2.5 contract). No-op in the default rewards-off deduction mode (B-3).
    const unlocks = sweepAchievements();
    const summary: DaySummary = {
      ...result.summary,
      goldBalance: state.economy.gold,
      achievementsUnlocked: unlocks.flatMap((e) =>
        e.type === 'AchievementUnlocked' ? [e.id] : [],
      ),
    };
    const events: SimEvent[] = [...result.events, ...unlocks, { type: 'DayEnded', summary }];
    if (state.time.weatherToday !== weatherBefore) {
      events.push({ type: 'WeatherChanged', weather: state.time.weatherToday });
    }
    events.push({ type: 'DayStarted', day: state.time.day, weather: state.time.weatherToday });
    return { summary, events };
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
      case 'splitItem': {
        state = {
          ...state,
          inventory: splitAt(state.inventory, command.from, command.to, command.count),
        };
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
      // ---- M3 material economy routes (PRD 04 §E/§H): the §8.1 labor path (clear), the
      // anti-soft-lock shop floor (buyMaterial), and the §6.2 backpack QoL (expand).
      // Blocked attempts return [] — the UI derives the single reason from state. ----
      case 'clearResourceNode':
        return applyGuardedResult(clearResourceNode(state, map, command.nodeId));
      case 'buyMaterial': {
        const result = buyMaterial(state, command.material, command.requested);
        if ('blocked' in result) return [];
        state = result.state;
        return result.events;
      }
      case 'expandInventory': {
        const result = expandInventory(state);
        if ('blocked' in result) return [];
        state = result.state;
        return result.events;
      }
      // ---- M3 build / coop / profession routes (PRD 04 §N73; task contract):
      // blocked attempts return [] — the UI derives the single reason from state
      // (canPlace/refundFor/canChooseProfession are pure read-only queries). ----
      case 'placeStructure':
        return applyGuardedResult(placeStructure(state, command.defId, command.origin));
      case 'placeSprinkler':
        return applyGuardedResult(placeSprinkler(state, command.defId, command.tile));
      case 'demolishStructure':
        return applyGuardedResult(demolishStructure(state, command.instanceId));
      case 'moveStructure':
        return applyGuardedResult(moveStructure(state, command.instanceId, command.origin));
      case 'orderFarmhouseUpgrade':
        return applyGuardedResult(orderFarmhouseUpgrade(state, command.defId));
      case 'startProcessingJob':
        return applyGuardedResult(
          startProcessingJob(state, command.instanceId, command.slot, command.inputItemId),
        );
      case 'collectProcessedGood':
        return applyGuardedResult(collectProcessedGood(state, command.instanceId, command.slot));
      case 'buyHen':
        return applyGuardedResult(buyHen(state, command.instanceId));
      case 'sellHen':
        return applyGuardedResult(sellHen(state, command.instanceId));
      case 'collectEggs':
        return applyGuardedResult(collectEggs(state, command.instanceId));
      case 'chooseProfession':
        return applyGuardedResult(chooseProfession(state, command.profession));
      case 'sleep': {
        return runNightFlow().events;
      }
    }
  }

  /** Shared ok/blocked routing for the M3 guarded reducers (see the case comments). */
  function applyGuardedResult(
    result: { ok: true; state: WorldState; events: SimEvent[] } | { ok: false; error: string },
  ): SimEvent[] {
    if (!result.ok) return [];
    state = result.state;
    return result.events;
  }

  return {
    get state(): Readonly<WorldState> {
      return state;
    },
    dispatch(command: SimCommand): SimEvent[] {
      const events = applyCommand(command);
      events.push(...sweepAchievements());
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
      events.push(...sweepAchievements());
      emit(events);
      return events;
    },
    sleep(): DaySummary {
      const { summary, events } = runNightFlow();
      events.push(...sweepAchievements());
      emit(events);
      return summary;
    },
    on(listener: (event: SimEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    serialize(): RestorableSaveDocV2 {
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
    markIntroLetterRead(): void {
      if ((state.progress.counters.introLetterRead ?? 0) > 0) return;
      const next = structuredClone(state);
      bumpCounterInPlace(next, 'introLetterRead', 1);
      state = next;
      emit(sweepAchievements()); // counter moved outside dispatch — keep the sweep contract
    },
    markProfessionHintShown(): void {
      if ((state.progress.counters.professionHintShown ?? 0) > 0) return;
      const next = structuredClone(state);
      markProfessionHintShownInPlace(next);
      state = next;
      emit(sweepAchievements()); // counter moved outside dispatch — keep the sweep contract
    },
    applyQuestReward(questId: string, reward: QuestReward): SimEvent[] {
      const result = grantQuestReward(state, quests, questId, reward);
      if (!result.granted) return []; // idempotent no-op (already granted) — UI shows nothing
      state = result.state;
      quests = result.quests;
      // questsCompleted moved outside dispatch — run the sweep so #19 智者 fires
      // (GDD §5.6), exactly as markIntroLetterRead does for its counter.
      const events = [...result.events, ...sweepAchievements()];
      emit(events);
      return events;
    },
    recordQuestNote(noteRef: string): SimEvent[] {
      const result = recordNoteWritten(state, quests, noteRef);
      if (!result.recorded) return []; // idempotent on the ref (§11-E11 decoupling)
      state = result.state;
      quests = result.quests;
      const events = sweepAchievements(); // notesWritten moved → #20 思考的痕迹 sweep
      emit(events);
      return events;
    },
  };
}

// ---- persistence: WorldState ⇄ RestorableSaveDoc ----

const HARVESTED_PREFIX = 'harvestedCrops:';

function serializeWorld(state: WorldState, quests: SaveQuests): RestorableSaveDocV2 {
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
      // ---- v2 blocks (GDD §8.4/§10.2; BuildModeState never enters the save) ----
      structures: structuredClone(state.structures ?? []),
      sprinklers: structuredClone(state.sprinklers ?? []),
      farmhouse: structuredClone(state.farmhouse ?? { stage: 0, construction: null }),
      unlockedZones: [...state.farm.unlockedZones], // B-2: persisted from v2 on
      clearedResourceNodes: [...(state.clearedResourceNodes ?? [])],
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
 * The restore input: storage migrates everything to v2 before the sim sees it, but the
 * v1 restorable shape stays accepted (a strict superset relationship) so M1-era test
 * fixtures and the migration-equivalence suites keep exercising the same path.
 */
export type RestorableInput = RestorableSaveDoc | RestorableSaveDocV2;

type V2WorldExtras = Partial<Omit<RestorableSaveDocV2['world'], 'farmTiles' | 'shippingBin'>>;

/**
 * Tolerant hydration (GDD §10.9): unknown cropId → tile degrades to empty tilled soil;
 * unknown itemId → slot null / bin line dropped; everything logged with console.warn.
 * Runtime-only fields not present in the save are re-derived:
 *   - farm.unlockedZones: union of the persisted v2 set (B-2) and the xp-derived set —
 *     reachable area never shrinks across save/load (§1.4 / PRD 01 US10);
 *   - pickups via refreshPickups (the save has no pickup field) — reloading restores
 *     today's forage; recorded as an open question in the M1 workflow (B-7 pending);
 *   - dayLog starts empty (mid-day reload loses only the summary's "today" lines);
 *   - newEntriesSeenDay starts empty (the NEW badge does not survive a reload).
 * M3: the v2 carriers (structures/sprinklers/farmhouse/clearedResourceNodes) hydrate
 * with empty defaults for v1-shaped inputs, then pass through the §8.5 import
 * sanitiser (illegal entities reclaimed at 100%, never silently deleted — US70).
 */
function hydrate(save: RestorableInput, map: MapMeta): { state: WorldState; quests: SaveQuests } {
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

  // unlockedZones: the persisted v2 set (B-2, absent on v1-shaped input) unioned with
  // the xp-derived set — the union keeps the M1 guarantee that reachable area never
  // shrinks across save/load (§1.4 / PRD 01 US10) and makes v1→v2 loads byte-equal to
  // the old derivation. Known benign deviation unchanged from M1: a manual mid-day
  // reload on a level-up day opens the zone a few hours before the next-6:00 rule
  // would (derivation can only over-open, never re-fence).
  const extras: V2WorldExtras = save.world as V2WorldExtras;
  const knownZones = new Set(map.unlockGroups.map((g) => g.zoneId));
  const unlockedZones = [
    ...new Set([
      'field_a',
      ...(extras.unlockedZones ?? []).filter((z) => knownZones.has(z) || z === 'field_a'),
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
    // M3 carriers (empty defaults for v1-shaped input; see header note).
    structures: structuredClone(extras.structures ?? []),
    sprinklers: structuredClone(extras.sprinklers ?? []),
    farmhouse: structuredClone(extras.farmhouse ?? { stage: 0, construction: null }),
    clearedResourceNodes: [...(extras.clearedResourceNodes ?? [])],
  };
  // Tolerant pass over structure contents (§10.9 unknown-id discipline, same as the
  // inventory above): unknown items in chest slots / processing jobs degrade with a
  // warning, never a crash.
  for (const s of state.structures ?? []) {
    if (s.data?.kind === 'chest') {
      s.data.slots = s.data.slots.map((slot, i) => {
        if (slot && !ITEMS_BY_ID.has(slot.itemId)) {
          console.warn(`[sim] unknown itemId "${slot.itemId}" in chest slot ${i} — cleared`);
          return null;
        }
        return slot;
      });
    }
    if (s.data?.kind === 'dryingRack' || s.data?.kind === 'workshop') {
      s.data.jobs = s.data.jobs.map((job, i) => {
        if (job && (!ITEMS_BY_ID.has(job.inputItemId) || !ITEMS_BY_ID.has(job.outputItemId))) {
          console.warn(`[sim] unknown item in processing job ${i} — job dropped`);
          return null;
        }
        return job;
      });
    }
  }
  // §8.5 import sanitiser (US70): illegal footprints/instances reclaimed at 100%,
  // reported — never silently deleted.
  const reclaimed = sanitizeStructuresInPlace(state, { map });
  for (const r of reclaimed.reclaimed) {
    console.warn(
      `[sim] structure ${r.instanceId} (${r.defId}) reclaimed on load — ${r.refundGold}g refunded (§8.5)`,
    );
  }
  state = refreshPickups(state, map);
  return { state, quests: structuredClone(save.quests) };
}

/** Restore a sim from a validated save (storage layer has already run safeParse +
 * the v1→v2 migration chain; v1-shaped inputs stay accepted — see RestorableInput). */
export function createSim(save: RestorableInput, map: MapMeta, options?: SimOptions): SimApi {
  const { state, quests } = hydrate(save, map);
  return makeSim(state, quests, map, options);
}

/**
 * Fresh state per GDD §10.2 new-save values: gold 100, capacity 12, both tools tier 1,
 * day 1, minuteOfDay 360, spring, xp 0, empty farmTiles, weatherToday 'sunny' (forced),
 * weatherTomorrow pre-rolled from seed, slot0 hoe / slot1 watering_can, no seeds.
 */
export function newGameSim(seed: string, map: MapMeta, options?: SimOptions): SimApi {
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
  return makeSim(state, { grantedQuestIds: [], completedCount: 0, noteRefs: [] }, map, options);
}
