/**
 * tiles.ts — sparse farm-tile table helpers, tilled-cap accounting, zone unlocking
 * (GDD §1.4 dual-track unlock, §3.1 sparse table).
 *
 * The map itself comes in as MapMeta (built from farm.tmj by
 * packages/game/scripts/export-map-meta.ts → sim/data/farm-map-meta.json, GDD §1.5);
 * sim NEVER parses .tmj and never imports Phaser.
 *
 * NOTE: this module and leveling.ts form a deliberate, benign import cycle
 * (canTill needs effectiveLevel; grantXp needs tilledCapForLevel). Both sides are
 * pure hoisted function declarations referenced only at call time.
 */
import { TILLED_CAP_BY_LEVEL } from './data/constants.js';
import { effectiveLevel } from './leveling.js';
import type { MapMeta, Rect, TileKey, TilePos, TileState, WorldState } from './types.js';

const MAP_WIDTH = 64;
const MAP_HEIGHT = 48;

/** Canonical sparse key: `"x,y"` (GDD §3.1/§10.2). */
export function tileKey(pos: TilePos): TileKey {
  return `${pos.x},${pos.y}`;
}

/** Parse a sparse key back to coordinates; rejects malformed/out-of-bounds keys (64×48). */
export function parseTileKey(key: TileKey): TilePos {
  const match = /^(\d+),(\d+)$/.exec(key);
  if (!match) throw new Error(`Invalid tile key: "${key}"`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (x >= MAP_WIDTH || y >= MAP_HEIGHT) {
    throw new Error(`Tile key out of bounds (${MAP_WIDTH}×${MAP_HEIGHT}): "${key}"`);
  }
  return { x, y };
}

export function getTile(state: WorldState, pos: TilePos): TileState | null {
  return state.farm.tiles[tileKey(pos)] ?? null;
}

/** Count of currently tilled farm tiles (monotonic in M1 — no shovel; GDD §1.4). */
export function tilledCount(state: WorldState): number {
  return Object.keys(state.farm.tiles).length;
}

/**
 * Current cap from TILLED_CAP_BY_LEVEL given the effective farm level (GDD §1.4):
 * Lv1=12 / Lv3=18 / Lv5=24 / Lv7=32 / Lv9=42, intermediate levels inherit the
 * previous bracket.
 */
export function tilledCapForLevel(effectiveLvl: number): number {
  let cap = TILLED_CAP_BY_LEVEL[0].cap;
  for (const bracket of TILLED_CAP_BY_LEVEL) {
    if (effectiveLvl >= bracket.level) cap = bracket.cap;
  }
  return cap;
}

/** Closed-interval containment for the {x, y, w, h} rect shape (GDD §1.1). */
function rectContains(rect: Rect, pos: TilePos): boolean {
  return pos.x >= rect.x && pos.x < rect.x + rect.w && pos.y >= rect.y && pos.y < rect.y + rect.h;
}

/**
 * Is this tile inside a tillable rect AND inside an unlocked zone AND not already
 * tilled AND under the global tilled cap? (transition T1 conditions, GDD §3.3 T1 +
 * §1.4 cap). Obstacle collision is a render-layer concern: the tillable rects in
 * MapMeta are obstacle-free field area by construction (GDD §1.5).
 */
export function canTill(state: WorldState, map: MapMeta, pos: TilePos): boolean {
  if (getTile(state, pos) !== null) return false; // T1 is grass → tilled only; hoe on tilled = no-op
  if (!map.tillable.some((r) => rectContains(r, pos))) return false;
  for (const group of map.unlockGroups) {
    if (
      group.rects.some((r) => rectContains(r, pos)) &&
      !state.farm.unlockedZones.includes(group.zoneId)
    ) {
      return false; // fenced field (field_b @Lv3 / field_c @Lv5, GDD §1.4)
    }
  }
  const cap = tilledCapForLevel(effectiveLevel(state.progress.xp));
  return tilledCount(state) < cap;
}

/**
 * Zones whose unlock is due at the next 6:00 (level-up evening announces, NEXT morning
 * unlocks; GDD §1.4). Unlocking only REMOVES collision — flood-fill reachable area is
 * monotonically non-decreasing (asserted in tests, PRD 01 US10). Applied by runNight
 * as part of the new-morning state.
 */
export function pendingZoneUnlocks(state: WorldState, map: MapMeta): string[] {
  const lvl = effectiveLevel(state.progress.xp);
  return map.unlockGroups
    .filter((g) => g.farmLevel <= lvl && !state.farm.unlockedZones.includes(g.zoneId))
    .map((g) => g.zoneId);
}
