/**
 * map-meta.ts — derive MapMeta (GDD §1.5 shape) from raw Tiled .tmj data
 * (pure / Phaser-free; input is the parsed JSON object Phaser keeps in its tilemap
 * cache). This single function backs BOTH consumers of the map contract:
 * `scripts/export-map-meta.mjs` runs it at build time to write
 * `sim/data/farm-map-meta.json` for headless sim tests, and the SCENE layer runs it
 * at boot to hand a MapMeta to createSim/newGameSim straight from the loaded map.
 *
 * Expected object layers (GDD §1.5, snake_case per ruling A-17):
 * spawn (player_spawn, facing) / zones (field_a|field_b|field_c with unlockLevel,
 * market, build_*, village_exit) / interactables (kind property; canonical kinds:
 * door / shipping_bin / well / shop / bulletin_board / sign / letter) / pickups
 * (kind: wood|stone|wildflower) / water_sources / npc_anchors.
 */
import type { Facing, MapMeta, PickupKind, Rect, TilePos } from '../sim/types';
import { DEFAULT_SPAWN } from '../sim/data/constants';

const TILE = 16;

// ---- minimal Tiled .tmj shapes (only what we read) ----

interface TiledProperty {
  name: string;
  value: unknown;
}

interface TiledObject {
  id?: number;
  name?: string;
  type?: string;
  class?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  point?: boolean;
  properties?: TiledProperty[];
}

interface TiledLayer {
  name: string;
  type: string;
  objects?: TiledObject[];
}

export interface TiledMapData {
  width?: number;
  height?: number;
  layers?: TiledLayer[];
}

function prop(obj: TiledObject, name: string): unknown {
  return obj.properties?.find((p) => p.name === name)?.value;
}

function objectLayer(data: TiledMapData, name: string): TiledObject[] {
  const layer = data.layers?.find((l) => l.type === 'objectgroup' && l.name === name);
  return layer?.objects ?? [];
}

/** Tiled rect object (px, top-left origin) → closed tile rect. */
function toRect(o: TiledObject): Rect {
  return {
    x: Math.floor(o.x / TILE),
    y: Math.floor(o.y / TILE),
    w: Math.max(1, Math.round((o.width ?? TILE) / TILE)),
    h: Math.max(1, Math.round((o.height ?? TILE) / TILE)),
  };
}

function toTile(o: TiledObject): TilePos {
  return { x: Math.floor(o.x / TILE), y: Math.floor(o.y / TILE) };
}

function rectTiles(r: Rect): TilePos[] {
  const tiles: TilePos[] = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) tiles.push({ x, y });
  }
  return tiles;
}

function isPickupKind(v: unknown): v is PickupKind {
  return v === 'wood' || v === 'stone' || v === 'wildflower';
}

function isResourceKind(v: unknown): v is 'tree' | 'boulder' {
  return v === 'tree' || v === 'boulder';
}

function isFacing(v: unknown): v is Facing {
  return v === 'up' || v === 'down' || v === 'left' || v === 'right';
}

/** Build a MapMeta from parsed farm.tmj data. Tolerant: missing layers yield empties. */
export function buildMapMeta(raw: TiledMapData): MapMeta {
  const zones = objectLayer(raw, 'zones');

  const fieldRects = new Map<string, Rect[]>();
  const unlockLevels = new Map<string, number>();
  const buildPlots: MapMeta['buildPlots'] = [];
  for (const o of zones) {
    const name = o.name ?? '';
    if (name.startsWith('field_')) {
      const list = fieldRects.get(name) ?? [];
      list.push(toRect(o));
      fieldRects.set(name, list);
      // All three fields carry unlockLevel (1/3/5) — MapMeta keeps the full set of
      // 3 unlock groups (GDD §1.5 CI line); field_a (Lv1) is open from day one.
      const lvl = prop(o, 'unlockLevel');
      if (typeof lvl === 'number' && lvl >= 1) unlockLevels.set(name, lvl);
    } else if (name.startsWith('build_')) {
      buildPlots.push({ id: name, rect: toRect(o) });
    }
  }

  const tillable: Rect[] = [...fieldRects.values()].flat();
  const unlockGroups: MapMeta['unlockGroups'] = [...unlockLevels.entries()].map(
    ([zoneId, farmLevel]) => ({ zoneId, farmLevel, rects: fieldRects.get(zoneId) ?? [] }),
  );

  const spawnObj = objectLayer(raw, 'spawn').find((o) => (o.name ?? '') === 'player_spawn');
  const facingValue = spawnObj ? prop(spawnObj, 'facing') : undefined;
  const spawn = spawnObj
    ? { tile: toTile(spawnObj), facing: isFacing(facingValue) ? facingValue : 'down' }
    : { tile: { ...DEFAULT_SPAWN.tile }, facing: DEFAULT_SPAWN.facing };

  const interactables: MapMeta['interactables'] = objectLayer(raw, 'interactables').map((o) => {
    const kind = prop(o, 'kind');
    return {
      id: o.name ?? `interactable_${String(o.id ?? 0)}`,
      kind: typeof kind === 'string' ? kind : (o.class ?? o.type ?? 'unknown'),
      tiles: rectTiles(toRect(o)),
    };
  });

  const pickupSpots: MapMeta['pickupSpots'] = [];
  for (const o of objectLayer(raw, 'pickups')) {
    const kind = prop(o, 'kind') ?? o.class ?? o.type;
    if (!isPickupKind(kind)) continue;
    pickupSpots.push({ id: o.name ?? `pickup_${String(o.id ?? 0)}`, kind, tile: toTile(o) });
  }

  const waterSources: TilePos[] = objectLayer(raw, 'water_sources').flatMap((o) =>
    o.width !== undefined && o.width > TILE ? rectTiles(toRect(o)) : [toTile(o)],
  );

  const npcAnchors: MapMeta['npcAnchors'] = objectLayer(raw, 'npc_anchors').map((o) => ({
    id: o.name ?? `npc_${String(o.id ?? 0)}`,
    tile: toTile(o),
  }));

  // M3 §8.1: clearable trees/boulders (axe → 5 wood, pickaxe → 3 stone). Parsed from the
  // optional `resource_nodes` object layer (kind: tree|boulder). Absent layer ⇒ undefined
  // (the field stays optional until every shipped map carries it — clearResourceNode
  // degrades to UNKNOWN_NODE cleanly when missing).
  const resourceNodes: NonNullable<MapMeta['resourceNodes']> = [];
  for (const o of objectLayer(raw, 'resource_nodes')) {
    const kind = prop(o, 'kind') ?? o.class ?? o.type;
    if (!isResourceKind(kind)) continue;
    resourceNodes.push({ id: o.name ?? `node_${String(o.id ?? 0)}`, kind, tile: toTile(o) });
  }

  return {
    width: 64,
    height: 48,
    tillable,
    unlockGroups,
    waterSources,
    spawn,
    interactables,
    pickupSpots,
    buildPlots,
    npcAnchors,
    ...(resourceNodes.length > 0 ? { resourceNodes } : {}),
  };
}

/**
 * DEV-ONLY fallback used while maps/farm.tmj has not landed: zone rects and fixed
 * interactables transcribed from the GDD §1.3 layout table (fields A/B/C, house door,
 * shipping bin, well, shop stall, bulletin board, intro letter). Pickup-spot positions
 * are NOT specified in the GDD (they belong to the map); the placeholder coordinates
 * below exist only so the pickup loop is exercisable before the real map lands and
 * MUST be superseded by farm.tmj.
 */
export const FALLBACK_MAP_META: MapMeta = {
  width: 64,
  height: 48,
  tillable: [
    { x: 22, y: 14, w: 8, h: 6 }, // field A (§1.3)
    { x: 10, y: 14, w: 10, h: 6 }, // field B (§1.3, Lv3)
    { x: 18, y: 23, w: 12, h: 6 }, // field C (§1.3, Lv5)
  ],
  unlockGroups: [
    { zoneId: 'field_a', farmLevel: 1, rects: [{ x: 22, y: 14, w: 8, h: 6 }] },
    { zoneId: 'field_b', farmLevel: 3, rects: [{ x: 10, y: 14, w: 10, h: 6 }] },
    { zoneId: 'field_c', farmLevel: 5, rects: [{ x: 18, y: 23, w: 12, h: 6 }] },
  ],
  waterSources: [
    { x: 21, y: 8 },
    { x: 22, y: 8 },
    { x: 21, y: 9 },
    { x: 22, y: 9 }, // well (§1.3)
  ],
  spawn: { tile: { ...DEFAULT_SPAWN.tile }, facing: DEFAULT_SPAWN.facing },
  // Canonical kind vocabulary (matches farm.tmj): door / shipping_bin / well / shop /
  // bulletin_board / sign / letter. Ids match the GDD §1.5 object names.
  interactables: [
    { id: 'house_door', kind: 'door', tiles: [{ x: 27, y: 9 }] },
    {
      id: 'shipping_bin',
      kind: 'shipping_bin',
      tiles: [
        { x: 33, y: 10 },
        { x: 34, y: 10 },
      ],
    },
    {
      id: 'well',
      kind: 'well',
      tiles: rectTiles({ x: 21, y: 8, w: 2, h: 2 }),
    },
    { id: 'shop_stall', kind: 'shop', tiles: rectTiles({ x: 48, y: 19, w: 4, h: 3 }) },
    { id: 'bulletin_board', kind: 'bulletin_board', tiles: [{ x: 54, y: 19 }] },
    // Readable signs (US5 / backlog A-3); positions mirror farm.tmj.
    { id: 'signpost_junction', kind: 'sign', tiles: [{ x: 32, y: 20 }] },
    { id: 'gate_sign', kind: 'sign', tiles: rectTiles({ x: 30, y: 46, w: 4, h: 2 }) },
    { id: 'intro_letter', kind: 'letter', tiles: [{ x: 28, y: 10 }] },
  ],
  // Ids follow the farm.tmj pickup naming (pickup_<kind>_<n>); 6 wood + 4 stone along
  // the tree wall, 3 wildflowers (pond / wall / market); §1.3.
  pickupSpots: [
    { id: 'pickup_wood_1', kind: 'wood', tile: { x: 6, y: 3 } },
    { id: 'pickup_wood_2', kind: 'wood', tile: { x: 14, y: 3 } },
    { id: 'pickup_wood_3', kind: 'wood', tile: { x: 40, y: 3 } },
    { id: 'pickup_wood_4', kind: 'wood', tile: { x: 56, y: 6 } },
    { id: 'pickup_wood_5', kind: 'wood', tile: { x: 3, y: 22 } },
    { id: 'pickup_wood_6', kind: 'wood', tile: { x: 60, y: 28 } },
    { id: 'pickup_stone_1', kind: 'stone', tile: { x: 20, y: 3 } },
    { id: 'pickup_stone_2', kind: 'stone', tile: { x: 48, y: 3 } },
    { id: 'pickup_stone_3', kind: 'stone', tile: { x: 3, y: 36 } },
    { id: 'pickup_stone_4', kind: 'stone', tile: { x: 60, y: 40 } },
    { id: 'pickup_flower_1', kind: 'wildflower', tile: { x: 10, y: 24 } },
    { id: 'pickup_flower_2', kind: 'wildflower', tile: { x: 36, y: 3 } },
    { id: 'pickup_flower_3', kind: 'wildflower', tile: { x: 52, y: 24 } },
  ],
  buildPlots: [
    { id: 'build_coop', rect: { x: 42, y: 32, w: 6, h: 4 } },
    { id: 'build_shed', rect: { x: 50, y: 32, w: 6, h: 4 } },
    { id: 'build_greenhouse', rect: { x: 44, y: 37, w: 8, h: 6 } },
  ],
  npcAnchors: [],
  // M3 §8.1: clearable trees (5 wood) along the wooded west wall + boulders (3 stone) on
  // the rocky south/east edges — none overlap fields A/B/C, interactables, or build plots.
  // A representative starter stand (the §8.1 ≈200 wood + 90 stone full stock belongs in the
  // authored farm.tmj resource_nodes layer; FALLBACK exists only until that layer lands).
  resourceNodes: [
    { id: 'tree_w1', kind: 'tree', tile: { x: 2, y: 6 } },
    { id: 'tree_w2', kind: 'tree', tile: { x: 4, y: 7 } },
    { id: 'tree_w3', kind: 'tree', tile: { x: 2, y: 9 } },
    { id: 'tree_w4', kind: 'tree', tile: { x: 5, y: 10 } },
    { id: 'tree_w5', kind: 'tree', tile: { x: 3, y: 12 } },
    { id: 'tree_n1', kind: 'tree', tile: { x: 44, y: 5 } },
    { id: 'tree_n2', kind: 'tree', tile: { x: 46, y: 6 } },
    { id: 'tree_n3', kind: 'tree', tile: { x: 50, y: 5 } },
    { id: 'boulder_s1', kind: 'boulder', tile: { x: 6, y: 40 } },
    { id: 'boulder_s2', kind: 'boulder', tile: { x: 8, y: 41 } },
    { id: 'boulder_s3', kind: 'boulder', tile: { x: 12, y: 42 } },
    { id: 'boulder_e1', kind: 'boulder', tile: { x: 58, y: 24 } },
    { id: 'boulder_e2', kind: 'boulder', tile: { x: 60, y: 26 } },
  ],
};
