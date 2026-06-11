#!/usr/bin/env node
/**
 * check-map.mjs — build-time validation of maps/farm.tmj against the GDD
 * contracts (§1.1 map spec, §1.3 zone table, §1.5 layer plan).
 *
 * Run: node scripts/check-map.mjs   (exits non-zero on any violation)
 *
 * Checks (CI list from GDD §1.5):
 *   1. 64×48, orthogonal, finite, 16×16 tiles
 *   2. embedded tileset named `terrain`, margin 1 / spacing 2, CSV tile data
 *   3. tile layer names & order: ground, ground_detail, buildings, above, collision
 *   4. object layers: spawn, zones, interactables, pickups, water_sources, npc_anchors
 *   5. tillable zones field_a/b/c = 48+60+72 = 180 tiles, 3 unlock groups (Lv 1/3/5)
 *   6. spawn at (27,11) facing down; required interactable & npc anchors present
 *   7. pickups: 6 wood + 4 stone + 3 wildflower (§1.3 daily counts)
 *   8. collision layer uses a single reserved gid; border (incl. closed south gate)
 *      and pond are blocked; spawn / fields / roads are not
 */
/* global console, process */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mapPath = join(here, '..', 'maps', 'farm.tmj');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`✗ ${msg}`);
  }
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));

// 1. map spec
check(map.width === 64 && map.height === 48, `map is 64×48 (got ${map.width}×${map.height})`);
check(map.orientation === 'orthogonal', 'orientation is orthogonal');
check(map.infinite === false, 'map is finite (infinite: false)');
check(map.tilewidth === 16 && map.tileheight === 16, 'tile size is 16×16');

// 2. tileset
check(Array.isArray(map.tilesets) && map.tilesets.length === 1, 'exactly one tileset');
const ts = map.tilesets[0] ?? {};
check(ts.name === 'terrain', `tileset name is 'terrain' (got '${ts.name}')`);
check(
  typeof ts.image === 'string' && ts.image.endsWith('terrain.png'),
  'tileset is embedded with image terrain.png',
);
check(ts.margin === 1 && ts.spacing === 2, 'tileset extruded: margin 1 / spacing 2');
check(ts.firstgid === 1, 'tileset firstgid is 1');

// 3+4. layers
const TILE_LAYERS = ['ground', 'ground_detail', 'buildings', 'above', 'collision'];
const OBJECT_LAYERS = [
  'spawn',
  'zones',
  'interactables',
  'pickups',
  'water_sources',
  'npc_anchors',
];
const tileLayers = map.layers.filter((l) => l.type === 'tilelayer').map((l) => l.name);
const objLayers = map.layers.filter((l) => l.type === 'objectgroup').map((l) => l.name);
check(
  JSON.stringify(tileLayers) === JSON.stringify(TILE_LAYERS),
  `tile layers are [${TILE_LAYERS}] in order (got [${tileLayers}])`,
);
check(
  JSON.stringify(objLayers) === JSON.stringify(OBJECT_LAYERS),
  `object layers are [${OBJECT_LAYERS}] in order (got [${objLayers}])`,
);
for (const l of map.layers.filter((l) => l.type === 'tilelayer')) {
  check(
    Array.isArray(l.data) && l.data.length === 64 * 48,
    `layer '${l.name}' has CSV (plain array) data of 3072 gids`,
  );
  check(l.encoding === undefined || l.encoding === 'csv', `layer '${l.name}' not base64-encoded`);
}
const layerByName = (n) => map.layers.find((l) => l.name === n);
check(layerByName('collision')?.visible === false, 'collision layer is invisible');

// 5. tillable zones / unlock groups
const zones = layerByName('zones')?.objects ?? [];
const fieldRect = (n) => zones.find((o) => o.name === n);
const area = (o) => (o ? (o.width / 16) * (o.height / 16) : 0);
const getProp = (o, n) => o?.properties?.find((p) => p.name === n)?.value;
const fa = fieldRect('field_a');
const fb = fieldRect('field_b');
const fc = fieldRect('field_c');
check(area(fa) === 48, `field_a is 48 tiles (got ${area(fa)})`);
check(area(fb) === 60, `field_b is 60 tiles (got ${area(fb)})`);
check(area(fc) === 72, `field_c is 72 tiles (got ${area(fc)})`);
check(area(fa) + area(fb) + area(fc) === 180, 'tillable total is 180 tiles');
check(getProp(fa, 'unlockLevel') === 1, 'field_a unlockLevel = 1');
check(getProp(fb, 'unlockLevel') === 3, 'field_b unlockLevel = 3');
check(getProp(fc, 'unlockLevel') === 5, 'field_c unlockLevel = 5');
check(fa && fa.x === 22 * 16 && fa.y === 14 * 16, 'field_a at (22,14)');
check(fb && fb.x === 10 * 16 && fb.y === 14 * 16, 'field_b at (10,14)');
check(fc && fc.x === 18 * 16 && fc.y === 23 * 16, 'field_c at (18,23)');
for (const name of ['market', 'build_coop', 'build_workshop', 'build_greenhouse', 'village_exit']) {
  check(
    zones.some((o) => o.name === name),
    `zone '${name}' present`,
  );
}

// 6. spawn / interactables / npc anchors
const spawnObjs = layerByName('spawn')?.objects ?? [];
const spawn = spawnObjs.find((o) => o.name === 'player_spawn');
check(!!spawn, 'player_spawn exists');
if (spawn) {
  check(
    Math.floor(spawn.x / 16) === 27 && Math.floor(spawn.y / 16) === 11,
    `spawn tile is (27,11) (got ${Math.floor(spawn.x / 16)},${Math.floor(spawn.y / 16)})`,
  );
  check(getProp(spawn, 'facing') === 'down', 'spawn facing down');
}
const interactables = layerByName('interactables')?.objects ?? [];
for (const name of [
  'house_door',
  'shipping_bin',
  'well',
  'shop_stall',
  'bulletin_board',
  'signpost_junction',
  'gate_sign',
  'intro_letter',
]) {
  const o = interactables.find((i) => i.name === name);
  check(!!o, `interactable '${name}' present`);
  check(!o || typeof getProp(o, 'kind') === 'string', `interactable '${name}' has a kind property`);
}
const door = interactables.find((i) => i.name === 'house_door');
check(!door || (door.x === 27 * 16 && door.y === 9 * 16), 'house_door at (27,9)');
const bin = interactables.find((i) => i.name === 'shipping_bin');
check(
  !bin || (bin.x === 33 * 16 && bin.y === 10 * 16 && bin.width === 2 * 16),
  'shipping_bin at (33..34,10)',
);
const anchors = layerByName('npc_anchors')?.objects ?? [];
for (const name of ['carpenter_bench', 'market_stall', 'bulletin', 'pond_sluice', 'field_edge']) {
  check(
    anchors.some((a) => a.name === name),
    `npc anchor '${name}' present`,
  );
}

// 7. pickups (§1.3: 6 wood / 4 stone / 3 wildflower)
const pickups = layerByName('pickups')?.objects ?? [];
const countKind = (k) => pickups.filter((o) => getProp(o, 'kind') === k).length;
check(countKind('wood') === 6, `6 wood pickups (got ${countKind('wood')})`);
check(countKind('stone') === 4, `4 stone pickups (got ${countKind('stone')})`);
check(countKind('wildflower') === 3, `3 wildflower pickups (got ${countKind('wildflower')})`);

// water sources present
const water = layerByName('water_sources')?.objects ?? [];
check(water.length >= 4, `water_sources non-empty incl. well (got ${water.length})`);

// 8. collision sanity
const col = layerByName('collision')?.data ?? [];
const gids = new Set(col.filter((g) => g !== 0));
check(gids.size === 1, `collision layer uses a single reserved gid (got ${gids.size})`);
const at = (x, y) => col[y * 64 + x] !== 0;
let borderOk = true;
for (let x = 0; x < 64; x++) borderOk &&= at(x, 0) && at(x, 1) && at(x, 46) && at(x, 47);
for (let y = 0; y < 48; y++) borderOk &&= at(0, y) && at(1, y) && at(62, y) && at(63, y);
check(borderOk, 'border 2-thick fully blocked (south gate closed in M1)');
check(!at(27, 11), 'spawn tile walkable');
check(!at(30, 30) && !at(31, 12) && !at(40, 21), 'road tiles walkable');
let fieldAOpen = true;
for (let y = 14; y <= 19; y++) for (let x = 22; x <= 29; x++) fieldAOpen &&= !at(x, y);
check(fieldAOpen, 'field_a fully walkable (no fence inside the Lv1 field)');
check(at(8, 29), 'pond water blocked');
for (const p of pickups) {
  const tx = Math.floor(p.x / 16);
  const ty = Math.floor(p.y / 16);
  check(!at(tx, ty), `pickup '${p.name}' on a walkable tile (${tx},${ty})`);
}

// tileset tile names available for runtime gid lookup
const named = new Set(
  (ts.tiles ?? []).map((t) => t.properties?.find((p) => p.name === 'name')?.value).filter(Boolean),
);
for (const need of ['tilled_dry', 'tilled_wet', 'collision', 'fence_h', 'fence_post']) {
  check(named.has(need), `tileset names tile '${need}' (runtime farmland/fence lookups)`);
}

if (failures > 0) {
  console.error(`check-map: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-map: farm.tmj OK (64×48, layers, zones 180, anchors, pickups, collision)');
