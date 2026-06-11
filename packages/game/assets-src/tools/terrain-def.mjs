/**
 * Terrain tileset definition — single source of truth for tile order, names and
 * provenance. Consumed by build-terrain.mjs (image) and gen-map.mjs (gids:
 * gid = index + 1, firstgid 1). Tile names are also embedded as per-tile
 * `name` properties in maps/farm.tmj so runtime code can resolve gids by name.
 *
 * `src: [col, row]` points into Kenney Roguelike/RPG pack
 * Spritesheet/roguelikeSheet_transparent.png (57×31 tiles, 16px, 1px spacing).
 * `src: 'self'` tiles are drawn procedurally (CC0, CODE-28 palette).
 */

export const TILESET_COLUMNS = 8;

export const TILES = [
  // ---- ground ----
  { name: 'grass', src: [5, 0] },
  { name: 'grass_alt', src: [5, 1] },
  { name: 'gravel', src: [7, 1] }, // market-corner ground accent
  { name: 'dirt', src: [6, 0] }, // road
  { name: 'dirt_alt', src: [6, 1] },
  { name: 'water', src: [0, 0] },
  // grass-banked pond 9-patch
  { name: 'pond_nw', src: [2, 0] },
  { name: 'pond_n', src: [3, 0] },
  { name: 'pond_ne', src: [4, 0] },
  { name: 'pond_w', src: [2, 1] },
  { name: 'pond_c', src: [3, 1] },
  { name: 'pond_e', src: [4, 1] },
  { name: 'pond_sw', src: [2, 2] },
  { name: 'pond_s', src: [3, 2] },
  { name: 'pond_se', src: [4, 2] },
  // farmland overlays (runtime `farmland` layer; GDD §1.5 — wet is a darker tile, no alpha tint)
  { name: 'tilled_dry', src: 'self' },
  { name: 'tilled_wet', src: 'self' },
  // ---- farmhouse ----
  { name: 'wall_top', src: [13, 12] },
  { name: 'wall_mid', src: [13, 13] },
  { name: 'wall_base', src: [13, 15] },
  { name: 'house_door', src: [26, 0] },
  { name: 'roof', src: [28, 17] }, // gray shingles
  { name: 'roof_eave', src: [24, 17] },
  { name: 'porch', src: [5, 3] }, // brown brick pavement
  // ---- structures ----
  { name: 'well_nw', src: 'self' },
  { name: 'well_ne', src: 'self' },
  { name: 'well_sw', src: 'self' },
  { name: 'well_se', src: 'self' },
  { name: 'fence_h', src: [48, 23] },
  { name: 'fence_post', src: [51, 23] },
  { name: 'bin', src: [53, 22] }, // shipping bin crate (x2 side by side)
  { name: 'awning_a', src: [10, 0] },
  { name: 'awning_b', src: [10, 1] },
  { name: 'stand_a', src: [15, 6] },
  { name: 'stand_b', src: [16, 6] },
  { name: 'stand_c', src: [17, 6] },
  { name: 'table_l', src: [18, 6] },
  { name: 'table_r', src: [19, 6] },
  { name: 'bulletin_board', src: [17, 0] },
  { name: 'signpost', src: [20, 0] },
  { name: 'sign_small', src: [16, 0] },
  { name: 'gate', src: [48, 1] },
  // ---- vegetation (tree wall & decor) ----
  { name: 'tree_top', src: [13, 9] },
  { name: 'tree_bottom', src: [13, 10] },
  { name: 'pine_top', src: [16, 9] },
  { name: 'pine_bottom', src: [16, 10] },
  { name: 'bush', src: [19, 9] },
  { name: 'hedge', src: [19, 10] },
  { name: 'flower_purple', src: [41, 23] },
  { name: 'flower_gold', src: [42, 23] },
  // ---- meta ----
  { name: 'collision', src: 'self' }, // single reserved gid for the (invisible) collision layer
];

export function tileIndex(name) {
  const i = TILES.findIndex((t) => t.name === name);
  if (i === -1) throw new Error(`unknown tile: ${name}`);
  return i;
}

/** gid in farm.tmj (firstgid = 1). */
export function gid(name) {
  return tileIndex(name) + 1;
}
