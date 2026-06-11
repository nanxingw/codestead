/**
 * Shared test fixtures for the sim layer (M1 contract tests).
 *
 * - TEST_MAP is the REAL map contract: sim/data/farm-map-meta.json, generated from
 *   maps/farm.tmj by scripts/export-map-meta.mjs (build chain, after check-map.mjs).
 *   Headless acceptance (Script R / night settlement / zone unlocks) therefore runs
 *   on the same MapMeta the game boots with — fixture drift is impossible by
 *   construction. Regenerate with `pnpm --filter @codestead/game map:meta`.
 * - FIELD_A/B/C stay as small hand-constructed rects (GDD §1.3 zone table) for
 *   targeted geometry tests.
 * - makeSave / makeWorldState build §10.2 new-game-shaped documents with overrides.
 * - moduleReady() probes the once-TODO(M1) skeleton paths. The skipIf gates built on it
 *   are gone (implementation landed): each test file now asserts its probes are true in
 *   an explicit "probes: implementation landed" test, so a regression is a red test,
 *   never a silently skipped suite.
 *
 * Determinism discipline: this directory lives under sim/** — no wall clock and no
 * engine randomness anywhere, including tests (GDD §2.2). Use makeTestRng instead.
 */
import type {
  RestorableSaveDoc,
  SaveInventory,
  SavePlayer,
  SaveProgress,
  SaveQuests,
  SaveTime,
  SaveTools,
  SaveWorld,
  ItemStack,
} from '@codestead/shared';

import type { MapMeta, PickupKind, Rect, TilePos, TileState, WorldState } from '../types.js';
import { XP_THRESHOLDS, M1_LEVEL_CAP } from '../data/constants.js';
import farmMapMeta from '../data/farm-map-meta.json';

// ---- readiness probe (skeletons threw 'TODO(M1): …'; now guarded by explicit tests) ----

/** True when the probed code path is implemented (anything but a TODO(M1) throw). */
export function moduleReady(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (err) {
    return !(err instanceof Error && err.message.includes('TODO(M1'));
  }
}

// ---- deterministic test PRNG (LCG; test-local, never used by the sim itself) ----

export function makeTestRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ---- deep freeze (purity assertions: pure fns must not mutate their input) ----

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ---- map fixture (the generated GDD §1.5 contract — real farm.tmj data) ----

export const FIELD_A: Rect = { x: 22, y: 14, w: 8, h: 6 }; // 48 tiles, Lv1 (GDD §1.3)
export const FIELD_B: Rect = { x: 10, y: 14, w: 10, h: 6 }; // 60 tiles, Lv3
export const FIELD_C: Rect = { x: 18, y: 23, w: 12, h: 6 }; // 72 tiles, Lv5

/**
 * The build-time MapMeta generated from maps/farm.tmj (scripts/export-map-meta.mjs).
 * The JSON's inferred literal types are wider than MapMeta (string vs unions), so a
 * single cast re-narrows it; export-map-meta.mjs asserts the §1.5 invariants
 * (180 tillable tiles, 3 unlock groups, spawn (27,11), 6/4/3 pickups) before writing.
 */
export const TEST_MAP: MapMeta = farmMapMeta as MapMeta;

/** First pickup spot of `kind` in the real map (tests must not hard-code spot ids). */
export function pickupSpotId(kind: PickupKind): string {
  const spot = TEST_MAP.pickupSpots.find((s) => s.kind === kind);
  if (!spot) throw new Error(`farm-map-meta.json has no '${kind}' pickup spot`);
  return spot.id;
}

/** All tile positions of a closed-interval rect, row-major (deterministic order). */
export function tilesInRect(rect: Rect): TilePos[] {
  const out: TilePos[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) out.push({ x, y });
  }
  return out;
}

// ---- save / state factories (§10.2 new-game row) ----

export const TEST_RNG_STATE = '0123456789abcdef0123456789abcdef'; // 32 hex (GDD §10.2)

export function stack(itemId: string, count: number): ItemStack {
  return { itemId, count };
}

/** New-game inventory: slot0 hoe / slot1 watering_can, no seeds (GDD §10.2/§6.2). */
export function defaultSlots(extra: (ItemStack | null)[] = []): (ItemStack | null)[] {
  const slots: (ItemStack | null)[] = [stack('hoe', 1), stack('watering_can', 1), ...extra];
  while (slots.length < 12) slots.push(null);
  return slots.slice(0, 12);
}

/** Cumulative XP needed to sit exactly at `level` (GDD §5.1 thresholds). */
export function xpForLevel(level: number): number {
  return XP_THRESHOLDS[level - 1] ?? 0;
}

/** Effective level derived locally from the §5.1 thresholds + M1 cap (test-side oracle). */
export function effLevelOf(xp: number): number {
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(level, M1_LEVEL_CAP);
}

export interface SaveOverrides {
  time?: Partial<SaveTime>;
  player?: Partial<SavePlayer>;
  tools?: Partial<SaveTools>;
  inventory?: Partial<SaveInventory>;
  world?: Partial<SaveWorld>;
  progress?: Partial<SaveProgress>;
  quests?: Partial<SaveQuests>;
}

/** Meta-less SaveDoc with §10.2 new-game defaults; per-block shallow overrides. */
export function makeSave(overrides: SaveOverrides = {}): RestorableSaveDoc {
  return {
    time: {
      day: 1,
      season: 'spring',
      minuteOfDay: 360,
      weatherToday: 'sunny', // day 1 forced sunny (GDD §2.1)
      weatherTomorrow: 'sunny',
      rngState: TEST_RNG_STATE,
      ...overrides.time,
    },
    player: {
      tileX: 27,
      tileY: 11,
      facing: 'down',
      gold: 100, // new save 100g (GDD §4.1)
      selectedSlot: 0,
      ...overrides.player,
    },
    tools: { hoe: 1, wateringCan: 1, ...overrides.tools },
    inventory: { capacity: 12, slots: defaultSlots(), ...overrides.inventory },
    world: { farmTiles: {}, shippingBin: [], ...overrides.world },
    progress: {
      xp: 0,
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
      collectionLog: {},
      stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
      ...overrides.progress,
    },
    quests: { grantedQuestIds: [], completedCount: 0, noteRefs: [], ...overrides.quests },
  };
}

/** Runtime WorldState with new-game defaults, for module-level (non-facade) tests. */
export function makeWorldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    time: {
      day: 1,
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: TEST_RNG_STATE,
    },
    player: { tileX: 27, tileY: 11, facing: 'down' },
    farm: { tiles: {}, unlockedZones: ['field_a'] },
    inventory: { slots: defaultSlots(), capacity: 12, selected: 0 },
    tools: { hoe: 1, wateringCan: 1 },
    economy: { gold: 100, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    progress: { xp: 0, profession: null, counters: {}, achievements: [], xpHistory: [] },
    pickups: TEST_MAP.pickupSpots.map((s) => ({ spotId: s.id, kind: s.kind, available: true })),
    dayLog: [],
    ...overrides,
  };
}

// ---- state inspection helpers (implementation-agnostic) ----

export function parseKey(key: string): TilePos {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

export function farmTileEntries(state: {
  farm: { tiles: Record<string, TileState> };
}): { pos: TilePos; tile: TileState }[] {
  return Object.entries(state.farm.tiles).map(([key, tile]) => ({ pos: parseKey(key), tile }));
}

export function countItem(inv: { slots: readonly (ItemStack | null)[] }, itemId: string): number {
  return inv.slots.reduce((sum, s) => (s && s.itemId === itemId ? sum + s.count : sum), 0);
}
