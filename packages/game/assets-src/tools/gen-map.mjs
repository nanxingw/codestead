/**
 * Generates maps/farm.tmj — the M1 farm map (GDD §1.1–§1.5).
 *
 * Authored programmatically (deterministic) instead of hand-clicked in Tiled so
 * zone rects stay byte-exact with the GDD §1.3 table; the output is a regular
 * Tiled 1.12.2 JSON map (embedded tileset, CSV tile data, orthogonal, finite)
 * that opens fine in Tiled for later hand-polish.
 *
 * Layers (§1.5): ground / ground_detail / buildings / above / collision(+invisible)
 * Object layers: spawn / zones / interactables / pickups / water_sources / npc_anchors
 * (farmland / entities / fx are runtime-only and intentionally absent.)
 *
 * Usage: node assets-src/tools/gen-map.mjs
 */
/* global console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILES, TILESET_COLUMNS, gid } from './terrain-def.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(here, '..', '..');

const W = 64;
const H = 48;
const T = 16; // px per tile

// ---------------------------------------------------------------------------
// geometry constants (GDD §1.3 分区明细表 — closed intervals)
// ---------------------------------------------------------------------------

const HOUSE = { x0: 24, y0: 4, x1: 31, y1: 9 };
const DOOR = { x: 27, y: 9 };
const PORCH = { y: 10, x0: 26, x1: 28 };
const INTRO_LETTER = { x: 28, y: 10 };
const WELL = { x0: 21, y0: 8, x1: 22, y1: 9 };
const BIN = { y: 10, x0: 33, x1: 34 };
const FIELD_A = { x0: 22, y0: 14, x1: 29, y1: 19 }; // 8×6 = 48
const FIELD_B = { x0: 10, y0: 14, x1: 19, y1: 19 }; // 10×6 = 60, Lv3
const FIELD_C = { x0: 18, y0: 23, x1: 29, y1: 28 }; // 12×6 = 72, Lv5
const ROAD_V = { x0: 30, x1: 31, y0: 10, y1: 45 };
const ROAD_H = { x0: 31, x1: 46, y0: 21, y1: 22 };
const MARKET = { x0: 46, y0: 18, x1: 56, y1: 26 };
const STALL = { x0: 48, y0: 19, x1: 51, y1: 21 };
const BULLETIN = { x: 54, y: 19 };
const SIGNPOST = { x: 32, y: 20 };
const GATE = { x0: 30, y0: 46, x1: 33, y1: 47 };
const GATE_SIGN_TILE = { x: 29, y: 45 };
const BENCH = { x: 33, y: 8 }; // carpenter bench, east of the farmhouse
const PLOTS = [
  { id: 'build_coop', x0: 42, y0: 32, x1: 47, y1: 35 },
  { id: 'build_workshop', x0: 50, y0: 32, x1: 55, y1: 35 },
  { id: 'build_greenhouse', x0: 44, y0: 37, x1: 51, y1: 42 },
];
const SPAWN = { x: 27, y: 11, facing: 'down' };

// pond blob (irregular, inside (6..16, 26..34), ~60 water tiles — GDD §1.3)
const POND_ROWS = [
  [26, 9, 13],
  [27, 8, 14],
  [28, 7, 15],
  [29, 6, 16],
  [30, 6, 16],
  [31, 7, 15],
  [32, 8, 14],
  [33, 9, 13],
  [34, 10, 12],
];

// daily pickup spots (§1.3: 6 wood + 4 stone on the edge belt, 3 wildflowers)
const PICKUPS = [
  { id: 'pickup_wood_1', kind: 'wood', x: 4, y: 3 },
  { id: 'pickup_wood_2', kind: 'wood', x: 20, y: 2 },
  { id: 'pickup_wood_3', kind: 'wood', x: 45, y: 2 },
  { id: 'pickup_wood_4', kind: 'wood', x: 61, y: 10 },
  { id: 'pickup_wood_5', kind: 'wood', x: 61, y: 30 },
  { id: 'pickup_wood_6', kind: 'wood', x: 20, y: 45 },
  { id: 'pickup_stone_1', kind: 'stone', x: 2, y: 20 },
  { id: 'pickup_stone_2', kind: 'stone', x: 50, y: 2 },
  { id: 'pickup_stone_3', kind: 'stone', x: 61, y: 40 },
  { id: 'pickup_stone_4', kind: 'stone', x: 35, y: 45 },
  { id: 'pickup_flower_1', kind: 'wildflower', x: 5, y: 24 },
  { id: 'pickup_flower_2', kind: 'wildflower', x: 2, y: 8 },
  { id: 'pickup_flower_3', kind: 'wildflower', x: 55, y: 24 },
];

const NPC_ANCHORS = [
  { id: 'carpenter_bench', x: 33, y: 9 },
  { id: 'market_stall', x: 49, y: 22 },
  { id: 'bulletin', x: 54, y: 20 },
  { id: 'pond_sluice', x: 11, y: 25 },
  { id: 'field_edge', x: 21, y: 16 },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const isBorder = (x, y) => x < 2 || y < 2 || x >= W - 2 || y >= H - 2;
const isRoad = (x, y) => inRect(ROAD_V, x, y) || inRect(ROAD_H, x, y);

const pond = new Set();
for (const [y, x0, x1] of POND_ROWS) for (let x = x0; x <= x1; x++) pond.add(`${x},${y}`);
const isPond = (x, y) => pond.has(`${x},${y}`);

/** deterministic per-tile hash for decor scatter */
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 0xffffffff;
}

function layerGrid() {
  return new Array(W * H).fill(0);
}
function put(grid, x, y, name) {
  if (x < 0 || y < 0 || x >= W || y >= H) throw new Error(`out of map: ${x},${y}`);
  grid[y * W + x] = gid(name);
}

// ---------------------------------------------------------------------------
// ground
// ---------------------------------------------------------------------------

const ground = layerGrid();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let name = hash(x, y) < 0.12 ? 'grass_alt' : 'grass';
    if (isRoad(x, y)) name = hash(x, y) < 0.2 ? 'dirt_alt' : 'dirt';
    if (inRect(GATE, x, y)) name = 'dirt'; // road runs up to the (closed) gate
    if (inRect(STALL, x, y)) name = 'gravel';
    if (y === PORCH.y && x >= PORCH.x0 && x <= PORCH.x1) name = 'porch';
    // field base color (§1.5 ground: 田区底色)
    if ([FIELD_A, FIELD_B, FIELD_C].some((r) => inRect(r, x, y))) name = 'dirt_alt';
    // backing for the farmhouse so transparent door/eave pixels show wall, not grass
    if (inRect(HOUSE, x, y)) name = 'wall_base';
    put(ground, x, y, name);
  }
}
// pond 9-patch by neighbors
for (const key of pond) {
  const [x, y] = key.split(',').map(Number);
  const n = isPond(x, y - 1);
  const s = isPond(x, y + 1);
  const w = isPond(x - 1, y);
  const e = isPond(x + 1, y);
  let name = 'pond_c';
  if (!n && !w) name = 'pond_nw';
  else if (!n && !e) name = 'pond_ne';
  else if (!s && !w) name = 'pond_sw';
  else if (!s && !e) name = 'pond_se';
  else if (!n) name = 'pond_n';
  else if (!s) name = 'pond_s';
  else if (!w) name = 'pond_w';
  else if (!e) name = 'pond_e';
  put(ground, x, y, name);
}

// ---------------------------------------------------------------------------
// ground_detail — sparse flowers on plain grass (never on fields/roads/border)
// ---------------------------------------------------------------------------

const groundDetail = layerGrid();
for (let y = 2; y < H - 2; y++) {
  for (let x = 2; x < W - 2; x++) {
    if (isRoad(x, y) || isPond(x, y)) continue;
    if ([FIELD_A, FIELD_B, FIELD_C, HOUSE, MARKET, ...PLOTS].some((r) => inRect(r, x, y))) continue;
    const h = hash(x * 7 + 3, y * 5 + 1);
    if (h < 0.015) put(groundDetail, x, y, 'flower_gold');
    else if (h < 0.03) put(groundDetail, x, y, 'flower_purple');
  }
}

// ---------------------------------------------------------------------------
// buildings + above + collision bookkeeping
// ---------------------------------------------------------------------------

const buildings = layerGrid();
const above = layerGrid();
const collide = new Set();
const block = (x, y) => collide.add(`${x},${y}`);

// tree-wall border: hedge fill, pines scattered on the inner ring
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isBorder(x, y)) continue;
    block(x, y);
    if (inRect(GATE, x, y)) continue; // gate visuals below
    put(buildings, x, y, 'hedge');
  }
}
// scattered trees along the inner border ring (top of tree goes to `above`)
for (let x = 2; x < W - 2; x += 4) {
  put(buildings, x, 1, 'tree_bottom');
  put(above, x, 0, 'tree_top');
  if (x < GATE.x0 - 1 || x > GATE.x1 + 1) {
    put(buildings, x, H - 1, 'pine_bottom');
    put(above, x, H - 2, 'pine_top');
  }
}
for (let y = 5; y < H - 2; y += 4) {
  put(buildings, 1, y, 'tree_bottom');
  put(above, 1, y - 1, 'tree_top');
  put(buildings, W - 2, y, 'pine_bottom');
  put(above, W - 2, y - 1, 'pine_top');
}

// farmhouse: roof (above) rows y0..y0+2, walls (buildings) rows y0+3..y1
for (let x = HOUSE.x0; x <= HOUSE.x1; x++) {
  put(above, x, HOUSE.y0, 'roof');
  put(above, x, HOUSE.y0 + 1, 'roof');
  put(above, x, HOUSE.y0 + 2, 'roof_eave');
  put(buildings, x, HOUSE.y0 + 3, 'wall_top');
  put(buildings, x, HOUSE.y0 + 4, 'wall_mid');
  put(buildings, x, HOUSE.y1, 'wall_base');
}
put(buildings, DOOR.x, DOOR.y, 'house_door');
for (let y = HOUSE.y0; y <= HOUSE.y1; y++) for (let x = HOUSE.x0; x <= HOUSE.x1; x++) block(x, y);

// well (2×2)
put(buildings, WELL.x0, WELL.y0, 'well_nw');
put(buildings, WELL.x1, WELL.y0, 'well_ne');
put(buildings, WELL.x0, WELL.y1, 'well_sw');
put(buildings, WELL.x1, WELL.y1, 'well_se');
for (let y = WELL.y0; y <= WELL.y1; y++) for (let x = WELL.x0; x <= WELL.x1; x++) block(x, y);

// shipping bin (2×1)
put(buildings, BIN.x0, BIN.y, 'bin');
put(buildings, BIN.x1, BIN.y, 'bin');
block(BIN.x0, BIN.y);
block(BIN.x1, BIN.y);

// carpenter bench
put(buildings, BENCH.x, BENCH.y, 'table_l');
block(BENCH.x, BENCH.y);

// market stall 4×3: awning / produce stands / counter
for (let x = STALL.x0; x <= STALL.x1; x++) {
  put(buildings, x, STALL.y0, x % 2 ? 'awning_b' : 'awning_a');
  put(buildings, x, STALL.y0 + 1, ['stand_a', 'stand_b', 'stand_c', 'stand_a'][x - STALL.x0]);
  put(buildings, x, STALL.y1, (x - STALL.x0) % 2 ? 'table_r' : 'table_l');
  for (let y = STALL.y0; y <= STALL.y1; y++) block(x, y);
}

// bulletin board & junction signpost & gate sign
put(buildings, BULLETIN.x, BULLETIN.y, 'bulletin_board');
block(BULLETIN.x, BULLETIN.y);
put(buildings, SIGNPOST.x, SIGNPOST.y, 'signpost');
block(SIGNPOST.x, SIGNPOST.y);
put(buildings, GATE_SIGN_TILE.x, GATE_SIGN_TILE.y, 'sign_small');
block(GATE_SIGN_TILE.x, GATE_SIGN_TILE.y);

// south gate (closed in M1): gate tiles over the border opening
for (let y = GATE.y0; y <= GATE.y1; y++)
  for (let x = GATE.x0; x <= GATE.x1; x++) {
    put(buildings, x, y, 'gate');
    block(x, y);
  }

// locked-field fences (removed at runtime on zoneUnlocked — collision only ever removed)
function fenceRing(tiles) {
  for (const [x, y, name] of tiles) {
    put(buildings, x, y, name);
    block(x, y);
  }
}
// field B: full outside perimeter ring
{
  const ring = [];
  for (let x = FIELD_B.x0 - 1; x <= FIELD_B.x1 + 1; x++) {
    ring.push([x, FIELD_B.y0 - 1, 'fence_h'], [x, FIELD_B.y1 + 1, 'fence_h']);
  }
  for (let y = FIELD_B.y0; y <= FIELD_B.y1; y++) {
    ring.push([FIELD_B.x0 - 1, y, 'fence_post'], [FIELD_B.x1 + 1, y, 'fence_post']);
  }
  fenceRing(ring);
}
// field C: outside ring on N/S/W; east fence sits on the field's own last column
// (x29) because the vertical road occupies x30..31 (§1.3) and must stay walkable.
{
  const ring = [];
  for (let x = FIELD_C.x0 - 1; x <= FIELD_C.x1; x++) {
    ring.push([x, FIELD_C.y0 - 1, 'fence_h'], [x, FIELD_C.y1 + 1, 'fence_h']);
  }
  for (let y = FIELD_C.y0; y <= FIELD_C.y1; y++) {
    ring.push([FIELD_C.x0 - 1, y, 'fence_post'], [FIELD_C.x1, y, 'fence_post']);
  }
  fenceRing(ring);
}

// build plots: corner stakes
for (const p of PLOTS) {
  for (const [x, y] of [
    [p.x0, p.y0],
    [p.x1, p.y0],
    [p.x0, p.y1],
    [p.x1, p.y1],
  ]) {
    put(buildings, x, y, 'fence_post');
    block(x, y);
  }
}

// pond collides
for (const key of pond) {
  const [x, y] = key.split(',').map(Number);
  block(x, y);
}

// collision layer from the set
const collision = layerGrid();
for (const key of collide) {
  const [x, y] = key.split(',').map(Number);
  put(collision, x, y, 'collision');
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

let nextObjectId = 1;
const obj = (name, x, y, opts = {}) => {
  const o = {
    id: nextObjectId++,
    name,
    type: opts.kind ?? '',
    x: x * T,
    y: y * T,
    width: (opts.w ?? 0) * T,
    height: (opts.h ?? 0) * T,
    rotation: 0,
    visible: true,
    properties: opts.properties ?? [],
  };
  if (!opts.w && !opts.h) {
    o.point = true;
    o.x = (x + 0.5) * T;
    o.y = (y + 0.5) * T;
  }
  if (opts.kind)
    o.properties = [...o.properties, { name: 'kind', type: 'string', value: opts.kind }];
  return o;
};
const prop = (name, type, value) => ({ name, type, value });

const spawnObjects = [
  obj('player_spawn', SPAWN.x, SPAWN.y, { properties: [prop('facing', 'string', SPAWN.facing)] }),
];

const rectObj = (name, r, props = [], kind) =>
  obj(name, r.x0, r.y0, { w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1, properties: props, kind });

const zoneObjects = [
  rectObj('field_a', FIELD_A, [prop('unlockLevel', 'int', 1)]),
  rectObj('field_b', FIELD_B, [prop('unlockLevel', 'int', 3)]),
  rectObj('field_c', FIELD_C, [prop('unlockLevel', 'int', 5)]),
  rectObj('market', MARKET),
  ...PLOTS.map((p) => rectObj(p.id, p)),
  rectObj('village_exit', GATE, [
    prop('targetMap', 'string', 'village.tmj'),
    prop('targetSpawn', 'string', 'from_farm'),
  ]),
];

const interactableObjects = [
  obj('house_door', DOOR.x, DOOR.y, { w: 1, h: 1, kind: 'door' }),
  obj('shipping_bin', BIN.x0, BIN.y, { w: 2, h: 1, kind: 'shipping_bin' }),
  rectObj('well', WELL, [], 'well'),
  rectObj('shop_stall', STALL, [], 'shop'),
  obj('bulletin_board', BULLETIN.x, BULLETIN.y, { w: 1, h: 1, kind: 'bulletin_board' }),
  obj('signpost_junction', SIGNPOST.x, SIGNPOST.y, { w: 1, h: 1, kind: 'sign' }),
  rectObj('gate_sign', GATE, [], 'sign'),
  obj('intro_letter', INTRO_LETTER.x, INTRO_LETTER.y, { w: 1, h: 1, kind: 'letter' }),
];

const pickupObjects = PICKUPS.map((p) => obj(p.id, p.x, p.y, { kind: p.kind }));

// water sources: the well tiles + every land tile orthogonally adjacent to pond water
const waterSourceObjects = [];
{
  let i = 0;
  for (let y = WELL.y0; y <= WELL.y1; y++)
    for (let x = WELL.x0; x <= WELL.x1; x++) waterSourceObjects.push(obj(`well_${i++}`, x, y, {}));
  const bank = new Set();
  for (const key of pond) {
    const [x, y] = key.split(',').map(Number);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (!isPond(nx, ny) && !isBorder(nx, ny)) bank.add(`${nx},${ny}`);
    }
  }
  let b = 0;
  for (const key of [...bank].sort()) {
    const [x, y] = key.split(',').map(Number);
    waterSourceObjects.push(obj(`pond_bank_${b++}`, x, y, {}));
  }
}

const anchorObjects = NPC_ANCHORS.map((a) => obj(a.id, a.x, a.y, {}));

// ---------------------------------------------------------------------------
// assemble map
// ---------------------------------------------------------------------------

let layerId = 1;
const tileLayer = (name, data, visible = true) => ({
  id: layerId++,
  name,
  type: 'tilelayer',
  width: W,
  height: H,
  x: 0,
  y: 0,
  opacity: 1,
  visible,
  data,
});
const objectLayer = (name, objects) => ({
  id: layerId++,
  name,
  type: 'objectgroup',
  draworder: 'topdown',
  x: 0,
  y: 0,
  opacity: 1,
  visible: true,
  objects,
});

const map = {
  type: 'map',
  version: '1.10',
  tiledversion: '1.12.2',
  orientation: 'orthogonal',
  renderorder: 'right-down',
  infinite: false,
  compressionlevel: -1,
  width: W,
  height: H,
  tilewidth: T,
  tileheight: T,
  layers: [
    tileLayer('ground', ground),
    tileLayer('ground_detail', groundDetail),
    tileLayer('buildings', buildings),
    tileLayer('above', above),
    tileLayer('collision', collision, false),
    objectLayer('spawn', spawnObjects),
    objectLayer('zones', zoneObjects),
    objectLayer('interactables', interactableObjects),
    objectLayer('pickups', pickupObjects),
    objectLayer('water_sources', waterSourceObjects),
    objectLayer('npc_anchors', anchorObjects),
  ],
  tilesets: [
    {
      firstgid: 1,
      name: 'terrain',
      image: '../assets/tilesets/terrain.png',
      imagewidth: 2 + TILESET_COLUMNS * 16 + (TILESET_COLUMNS - 1) * 2,
      imageheight:
        2 +
        Math.ceil(TILES.length / TILESET_COLUMNS) * 16 +
        (Math.ceil(TILES.length / TILESET_COLUMNS) - 1) * 2,
      margin: 1,
      spacing: 2,
      columns: TILESET_COLUMNS,
      tilecount: TILES.length,
      tilewidth: 16,
      tileheight: 16,
      tiles: TILES.map((t, i) => ({ id: i, properties: [prop('name', 'string', t.name)] })),
    },
  ],
  nextlayerid: layerId,
  nextobjectid: nextObjectId,
};

const dest = join(gameRoot, 'maps/farm.tmj');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(map) + '\n');
console.log(
  `farm.tmj: ${W}×${H}, ${map.layers.length} layers, ${nextObjectId - 1} objects, pond=${pond.size}, collision=${collide.size} -> ${dest}`,
);
