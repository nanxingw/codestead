/**
 * Assembles the 8 M1 SFX (GDD §11.5 convergence) into assets/audio/.
 *
 * 7 of 8 are copied verbatim from Kenney CC0 audio packs (see
 * assets-src/recipes.json5 for pack download URLs); `water_pour` has no CC0
 * source in those packs, so it is synthesized with ffmpeg (filtered noise,
 * self-made, CC0) and flagged `placeholder` in assets/manifest.json.
 *
 * Usage: node assets-src/tools/build-audio.mjs   (VENDOR_DIR=/tmp/kenney; needs ffmpeg for water_pour)
 */
/* global console, process */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(here, '..', '..');
const VENDOR = process.env.VENDOR_DIR ?? '/tmp/kenney';

/** SFX key -> vendor file (relative to VENDOR_DIR). Keys/paths per AssetKeys.AUDIO_PATHS. */
export const SFX_SOURCES = {
  hoe_till: 'impact-sounds/Audio/impactSoft_heavy_001.ogg',
  seed_plant: 'interface-sounds/Audio/drop_001.ogg',
  harvest_pop: 'interface-sounds/Audio/pluck_002.ogg',
  item_get: 'interface-sounds/Audio/confirmation_001.ogg',
  coins: 'rpg-audio/Audio/handleCoins.ogg',
  jingle_levelup: 'music-jingles/Audio/Pizzicato jingles/jingles_PIZZI07.ogg',
  ui_error: 'interface-sounds/Audio/error_004.ogg',
};

const sfxDir = join(gameRoot, 'assets/audio/sfx');
const jingleDir = join(gameRoot, 'assets/audio/jingles');
mkdirSync(sfxDir, { recursive: true });
mkdirSync(jingleDir, { recursive: true });

for (const [key, rel] of Object.entries(SFX_SOURCES)) {
  const src = join(VENDOR, rel);
  if (!existsSync(src)) throw new Error(`vendor file missing: ${src}`);
  const dest =
    key === 'jingle_levelup' ? join(jingleDir, `${key}.ogg`) : join(sfxDir, `${key}.ogg`);
  copyFileSync(src, dest);
  console.log(`${key} <- ${rel}`);
}

// water_pour: soft 0.7s filtered-noise pour (self-made, CC0, placeholder)
const waterDest = join(sfxDir, 'water_pour.ogg');
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=pink:duration=0.7:amplitude=0.5:seed=20260611',
    '-af',
    'highpass=f=500,lowpass=f=4500,tremolo=f=11:d=0.4,afade=t=in:d=0.06,afade=t=out:st=0.45:d=0.25,volume=0.7',
    // built-in vorbis encoder (homebrew ffmpeg may lack libvorbis); fine for a noise SFX
    '-c:a',
    'vorbis',
    '-strict',
    'experimental',
    '-ar',
    '44100',
    '-ac',
    '2',
    waterDest,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log('water_pour <- ffmpeg synth (placeholder)');
