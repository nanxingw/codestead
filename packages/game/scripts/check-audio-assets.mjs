/**
 * check-audio-assets.mjs — the §11.7 asset gate, audio items (PRD 04 US66):
 *   1. every file under assets/ + maps/ has a manifest entry (and vice versa);
 *   2. every manifest license ∈ {CC0-1.0, OFL-1.1} and sha256 matches disk;
 *   3. M3 audio is dual-format: every .ogg under bgm/ambience + the M3 sfx/jingle
 *      set has a sibling .m4a (M1's 9 SFX stay legally .ogg-only — AssetKeys
 *      AUDIO_PATHS table; their dual-format upgrade is not an M3 requirement);
 *   4. budgets: SFX single file ≤100KB · BGM single track ≤3.5MB · SFX+jingles
 *      total ≤2.5MB · BGM+ambience total ≤12MB · assets total ≤20MB.
 *
 * Usage: node scripts/check-audio-assets.mjs   (exits non-zero on any violation)
 */
/* global console, process */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(gameRoot, 'assets/manifest.json'), 'utf8'));
const WHITELIST = new Set(manifest.licenseWhitelist ?? ['CC0-1.0', 'OFL-1.1']);

const errors = [];

// ---- 1+2: manifest coverage, whitelist, sha256 honesty ----

function walk(dir) {
  const out = [];
  for (const e of readdirSync(join(gameRoot, dir), { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === 'manifest.json') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const onDisk = new Set([...walk('assets'), ...walk('maps')]);
const listed = new Map(manifest.files.map((f) => [f.path, f]));

for (const path of onDisk) {
  if (!listed.has(path)) errors.push(`no manifest entry: ${path}`);
}
for (const [path, meta] of listed) {
  if (!onDisk.has(path)) {
    errors.push(`manifest entry without file: ${path}`);
    continue;
  }
  if (!WHITELIST.has(meta.license))
    errors.push(`license not whitelisted: ${path} (${meta.license})`);
  const buf = readFileSync(join(gameRoot, path));
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== meta.sha256) errors.push(`sha256 drift (re-run gen-manifest.mjs): ${path}`);
}

// ---- 3: dual format (ogg ⇄ m4a pairs) for all M3 audio ----

/** M1 legacy .ogg-only keys (AssetKeys AUDIO_PATHS — see header). */
const M1_OGG_ONLY = new Set([
  'assets/audio/sfx/hoe_till.ogg',
  'assets/audio/sfx/seed_plant.ogg',
  'assets/audio/sfx/water_pour.ogg',
  'assets/audio/sfx/harvest_pop.ogg',
  'assets/audio/sfx/item_get.ogg',
  'assets/audio/sfx/coins.ogg',
  'assets/audio/sfx/ui_error.ogg',
  'assets/audio/sfx/session_chime.ogg',
  'assets/audio/jingles/jingle_levelup.ogg',
]);

for (const path of onDisk) {
  if (!path.startsWith('assets/audio/')) continue;
  if (path.endsWith('.ogg') && !M1_OGG_ONLY.has(path)) {
    const sibling = path.replace(/\.ogg$/, '.m4a');
    if (!onDisk.has(sibling)) errors.push(`missing m4a pair: ${path}`);
  }
  if (path.endsWith('.m4a')) {
    const sibling = path.replace(/\.m4a$/, '.ogg');
    if (!onDisk.has(sibling)) errors.push(`missing ogg pair: ${path}`);
  }
}

// ---- 4: budgets (§11.7) ----

const KB = 1024;
const MB = 1024 * 1024;
let sfxJingleTotal = 0;
let bgmAmbienceTotal = 0;
let assetsTotal = 0;

for (const path of onDisk) {
  const bytes = statSync(join(gameRoot, path)).size;
  if (path.startsWith('assets/')) assetsTotal += bytes;
  if (path.startsWith('assets/audio/sfx/') || path.startsWith('assets/audio/jingles/')) {
    sfxJingleTotal += bytes;
    if (bytes > 100 * KB) errors.push(`SFX over 100KB: ${path} (${(bytes / KB).toFixed(0)}KB)`);
  }
  if (path.startsWith('assets/audio/bgm/')) {
    bgmAmbienceTotal += bytes;
    if (bytes > 3.5 * MB)
      errors.push(`BGM track over 3.5MB: ${path} (${(bytes / MB).toFixed(2)}MB)`);
  }
  if (path.startsWith('assets/audio/ambience/')) bgmAmbienceTotal += bytes;
}

if (sfxJingleTotal > 2.5 * MB)
  errors.push(`SFX+jingles total over 2.5MB: ${(sfxJingleTotal / MB).toFixed(2)}MB`);
if (bgmAmbienceTotal > 12 * MB)
  errors.push(`BGM+ambience total over 12MB: ${(bgmAmbienceTotal / MB).toFixed(2)}MB`);
if (assetsTotal > 20 * MB)
  errors.push(`assets total over 20MB: ${(assetsTotal / MB).toFixed(2)}MB`);

// ---- report ----

if (errors.length > 0) {
  for (const e of errors) console.error(`[check:audio] ${e}`);
  process.exit(1);
}
console.log(
  `[check:audio] OK — ${onDisk.size} files; SFX+jingles ${(sfxJingleTotal / MB).toFixed(2)}MB/2.5 · ` +
    `BGM+ambience ${(bgmAmbienceTotal / MB).toFixed(2)}MB/12 · assets ${(assetsTotal / MB).toFixed(2)}MB/20`,
);
