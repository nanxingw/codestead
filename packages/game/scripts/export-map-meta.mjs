#!/usr/bin/env node
/**
 * export-map-meta.mjs — build-time map → sim contract (GDD §1.5).
 *
 * Reads maps/farm.tmj, derives MapMeta through the SAME Phaser-free pure function
 * the scene layer uses at runtime (src/world/map-meta.ts buildMapMeta, loaded via
 * the tsx ESM hooks), and writes src/sim/data/farm-map-meta.json. The sim layer
 * and its headless tests import only that JSON — they never parse .tmj and never
 * import Phaser.
 *
 * Run: node scripts/export-map-meta.mjs
 * Build chain: check-map.mjs (validates the .tmj) → this script (derives MapMeta).
 *
 * Sanity asserts mirror the GDD §1.5 CI line for the DERIVED data: tillable 180
 * tiles, 3 unlock groups (field_a Lv1 / field_b Lv3 / field_c Lv5), spawn (27,11),
 * 6 wood + 4 stone + 3 wildflower pickup spots.
 */
/* global console, process */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register(); // compile TypeScript on the fly for the dynamic import below

const here = dirname(fileURLToPath(import.meta.url));
const mapPath = join(here, '..', 'maps', 'farm.tmj');
const outPath = join(here, '..', 'src', 'sim', 'data', 'farm-map-meta.json');
const modulePath = pathToFileURL(join(here, '..', 'src', 'world', 'map-meta.ts')).href;

const { buildMapMeta } = await import(modulePath);

const raw = JSON.parse(readFileSync(mapPath, 'utf8'));
const meta = buildMapMeta(raw);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`✗ ${msg}`);
  }
}

const tillableTiles = meta.tillable.reduce((sum, r) => sum + r.w * r.h, 0);
check(tillableTiles === 180, `tillable is 180 tiles (got ${tillableTiles})`);
check(meta.unlockGroups.length === 3, `3 unlock groups (got ${meta.unlockGroups.length})`);
const groupLevel = (zoneId) => meta.unlockGroups.find((g) => g.zoneId === zoneId)?.farmLevel;
check(groupLevel('field_a') === 1, 'field_a unlock group at farm level 1');
check(groupLevel('field_b') === 3, 'field_b unlock group at farm level 3');
check(groupLevel('field_c') === 5, 'field_c unlock group at farm level 5');
check(
  meta.spawn.tile.x === 27 && meta.spawn.tile.y === 11 && meta.spawn.facing === 'down',
  `spawn is (27,11) facing down (got ${meta.spawn.tile.x},${meta.spawn.tile.y} ${meta.spawn.facing})`,
);
const countKind = (k) => meta.pickupSpots.filter((s) => s.kind === k).length;
check(countKind('wood') === 6, `6 wood pickup spots (got ${countKind('wood')})`);
check(countKind('stone') === 4, `4 stone pickup spots (got ${countKind('stone')})`);
check(countKind('wildflower') === 3, `3 wildflower pickup spots (got ${countKind('wildflower')})`);
check(meta.interactables.length >= 8, `≥8 interactables (got ${meta.interactables.length})`);

if (failures > 0) {
  console.error(`export-map-meta: ${failures} failure(s) — farm-map-meta.json NOT written`);
  process.exit(1);
}

const json = `${JSON.stringify(meta, null, 2)}\n`;
if (existsSync(outPath) && readFileSync(outPath, 'utf8') === json) {
  console.log('export-map-meta: farm-map-meta.json up to date');
} else {
  writeFileSync(outPath, json);
  console.log('export-map-meta: wrote src/sim/data/farm-map-meta.json');
}
