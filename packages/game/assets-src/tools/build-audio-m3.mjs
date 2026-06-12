/**
 * build-audio-m3.mjs — the M3 audio pipeline (GDD §11.5/§11.6/§11.7; PRD 04 US64~67):
 * assembles the full SFX list + 3 BGM + rain ambience into assets/audio/, with
 * loudness normalization (SFX −14 LUFS / BGM −16 LUFS, true peak −1.5 dBTP) and
 * dual-format output (.ogg Vorbis + .m4a AAC for Safari) — repeatable & mechanical:
 * replacing a track = edit one table row, re-run, re-run gen-manifest.mjs.
 *
 * Sources (license whitelist CC0-1.0 only, GDD §11.1):
 *   - Kenney audio packs (CC0), vendor dir $KENNEY_DIR (default /tmp/kenney),
 *     download URLs in assets-src/recipes.json5 — same vendor flow as M1;
 *   - FreePD GitHub mirror github.com/0lhi/FreePD (repo LICENSE = CC0-1.0;
 *     freepd.com itself shut down in 2025 — the GDD's「FreePD GitHub 镜像」source A5).
 *     $FREEPD_DIR (default /tmp/freepd); files are fetched from the raw mirror when
 *     missing (proxy-bypassed curl per this machine's broken-proxy note);
 *   - ffmpeg-synthesized placeholders (whiff whoosh, rain_loop) — no CC0 candidates
 *     in the Kenney packs; flagged `placeholder` in the manifest.
 *
 * Loudness strategy: BGM gets two-pass ffmpeg loudnorm (linear=true). Short SFX make
 * integrated-loudness measurement unreliable (< ebur128 gating block), so SFX get a
 * measured linear gain toward the target with a −1.5 dBTP peak ceiling — same spirit,
 * robust at 50ms lengths.
 *
 * Usage: node assets-src/tools/build-audio-m3.mjs        (needs ffmpeg + ffprobe)
 */
/* global console, process */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gameRoot = join(here, '..', '..');
const KENNEY = process.env.KENNEY_DIR ?? process.env.VENDOR_DIR ?? '/tmp/kenney';
const FREEPD = process.env.FREEPD_DIR ?? '/tmp/freepd';
const FREEPD_RAW = 'https://raw.githubusercontent.com/0lhi/FreePD/stream';

const SFX_TARGET_I = -14; // LUFS (GDD §11.5)
const BGM_TARGET_I = -16; // LUFS (GDD §11.6)
const TARGET_TP = -1.5; // dBTP (both)

// ---- the tables (key = canonical name = interface, AssetKeys SFX_M3/BGM/AMBIENCE) ----

/** M3 SFX/jingles from Kenney packs: key -> { src, dir } (dir defaults to sfx). */
export const M3_SFX_SOURCES = {
  // footsteps (§11.5: grass/dirt ×3 variants)
  step_grass_0: 'impact-sounds/Audio/footstep_grass_000.ogg',
  step_grass_1: 'impact-sounds/Audio/footstep_grass_001.ogg',
  step_grass_2: 'impact-sounds/Audio/footstep_grass_002.ogg',
  step_dirt_0: 'rpg-audio/Audio/footstep00.ogg',
  step_dirt_1: 'rpg-audio/Audio/footstep01.ogg',
  step_dirt_2: 'rpg-audio/Audio/footstep02.ogg',
  // UI soft set (ui_error ships since M1)
  ui_tick: 'interface-sounds/Audio/tick_001.ogg',
  ui_click: 'interface-sounds/Audio/click_001.ogg',
  ui_open: 'interface-sounds/Audio/open_001.ogg',
  ui_close: 'interface-sounds/Audio/close_001.ogg',
  // building beats (PRD 04 US61)
  build_place: 'impact-sounds/Audio/impactWood_medium_000.ogg',
  build_refund: 'rpg-audio/Audio/handleCoins2.ogg',
  egg_collect: 'interface-sounds/Audio/pluck_001.ogg',
  process_done: 'interface-sounds/Audio/confirmation_002.ogg',
  // M4 reserves (assets + interface now, playback logic M4 — §K62)
  quest_chime: 'interface-sounds/Audio/question_001.ogg', // 0.49s ≤ 0.5s (§11.5)
  blip_talk: 'interface-sounds/Audio/bong_001.ogg',
  hud_soft_tick: 'ui-audio/Audio/rollover2.ogg', // DEFAULT OFF consumer (§11.5)
};

/** Jingles land in audio/jingles (Kenney Music Jingles; all ≤1.8s, day-end ≤4s ✓). */
export const M3_JINGLE_SOURCES = {
  jingle_day_end: 'music-jingles/Audio/Steel jingles/jingles_STEEL07.ogg',
  jingle_collect: 'music-jingles/Audio/Pizzicato jingles/jingles_PIZZI03.ogg',
  jingle_quest: 'music-jingles/Audio/Sax jingles/jingles_SAX07.ogg',
  build_complete: 'music-jingles/Audio/Steel jingles/jingles_STEEL04.ogg', // sfx dir
};

/**
 * BGM (GDD §11.6: 90~150s loop, day A/B folk-feel, rain soft 60-80 BPM).
 * Authors verified against the archived freepd.com pages (Wayback 2024-11/2025-01).
 */
export const BGM_SOURCES = {
  bgm_day_a: {
    file: 'Happy Whistling Ukulele.mp3', // Rafael Krux, 123s — in the 90~150s window
    mirrorPath: 'Upbeat/Happy%20Whistling%20Ukulele.mp3',
    trimSec: null,
  },
  bgm_day_b: {
    file: 'Pickled Pink.mp3', // Kevin MacLeod, 175s — trimmed to 150s with a 2s tail fade
    mirrorPath: 'Upbeat/Pickled%20Pink.mp3',
    trimSec: 150,
  },
  bgm_rain_day: {
    file: 'Lovely Piano Song.mp3', // Rafael Krux, 96s soft piano
    mirrorPath: 'Romance/Lovely%20Piano%20Song.mp3',
    trimSec: null,
  },
};

// ---- helpers ----

function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function ffmpeg(args) {
  // loudnorm prints its JSON on stderr; capture both.
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-y', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.stderr) return String(error.stderr);
    throw error;
  }
}

/** Run ffmpeg's loudnorm measurement pass and parse the JSON blob from stderr. */
function measureJson(src, targetI) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      src,
      '-af',
      `loudnorm=I=${targetI}:TP=${TARGET_TP}:LRA=11:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const stderr = String(result.stderr ?? '');
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`loudnorm JSON not found for ${src}`);
  return JSON.parse(stderr.slice(start, end + 1));
}

/**
 * Encode `src` (+ filter) to ogg & m4a beside each other. `-vn` drops embedded
 * cover art (some FreePD mp3s carry one — ogg would try to encode it as theora).
 * Vorbis quality per §11.5/§11.6: SFX q4, BGM q3 (ffmpeg native encoder, -q:a).
 */
function encodeDual(src, destBase, { filter, oggQuality, m4aBitrate }) {
  const common = ['-vn', '-i', src];
  if (filter) common.push('-af', filter);
  const oggOut = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      ...common,
      '-ar',
      '44100',
      '-ac',
      '2', // the native vorbis encoder rejects mono sources (some Kenney UI ticks)
      '-c:a',
      'vorbis',
      '-strict',
      'experimental',
      '-q:a',
      String(oggQuality),
      `${destBase}.ogg`,
    ],
    { encoding: 'utf8' },
  );
  if (oggOut.status !== 0) throw new Error(`ogg encode failed: ${destBase}\n${oggOut.stderr}`);
  const m4aOut = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      ...common,
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'aac',
      '-b:a',
      m4aBitrate,
      `${destBase}.m4a`,
    ],
    { encoding: 'utf8' },
  );
  if (m4aOut.status !== 0) throw new Error(`m4a encode failed: ${destBase}\n${m4aOut.stderr}`);
}

/** SFX: measured linear gain toward target I with a −1.5 dBTP ceiling (see header). */
function sfxGainFilter(src) {
  const m = measureJson(src, SFX_TARGET_I);
  const inputI = Number(m.input_i);
  const inputTp = Number(m.input_tp);
  let gainDb;
  if (Number.isFinite(inputI) && inputI > -70) {
    gainDb = SFX_TARGET_I - inputI;
  } else {
    gainDb = 0; // unmeasurable (ultra-short): peak-normalize only
  }
  if (Number.isFinite(inputTp)) gainDb = Math.min(gainDb, TARGET_TP - inputTp);
  return `volume=${gainDb.toFixed(2)}dB`;
}

/** BGM: proper two-pass loudnorm (linear) + optional trim/fade for the loop window. */
function bgmFilter(src, trimSec) {
  const m = measureJson(src, BGM_TARGET_I);
  const loudnorm =
    `loudnorm=I=${BGM_TARGET_I}:TP=${TARGET_TP}:LRA=11` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`;
  if (trimSec) {
    return { filter: `atrim=0:${trimSec},afade=t=out:st=${trimSec - 2}:d=2,${loudnorm}` };
  }
  return { filter: loudnorm };
}

function fetchFreePd(entry) {
  const dest = join(FREEPD, entry.file);
  if (existsSync(dest)) return dest;
  mkdirSync(FREEPD, { recursive: true });
  console.log(`fetch ${entry.mirrorPath} ...`);
  // Local proxy 127.0.0.1:7897 is broken on this machine — bypass it.
  run('curl', ['-sSL', '--noproxy', '*', '-o', dest, `${FREEPD_RAW}/${entry.mirrorPath}`]);
  return dest;
}

// ---- main ----

const dirs = {
  sfx: join(gameRoot, 'assets/audio/sfx'),
  jingles: join(gameRoot, 'assets/audio/jingles'),
  bgm: join(gameRoot, 'assets/audio/bgm'),
  ambience: join(gameRoot, 'assets/audio/ambience'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// 1. Kenney SFX (loud-normalized, dual format).
for (const [key, rel] of Object.entries(M3_SFX_SOURCES)) {
  const src = join(KENNEY, rel);
  if (!existsSync(src)) throw new Error(`vendor file missing: ${src}`);
  encodeDual(src, join(dirs.sfx, key), {
    filter: sfxGainFilter(src),
    oggQuality: 4, // §11.5: SFX Vorbis q4
    m4aBitrate: '96k',
  });
  console.log(`${key} <- ${rel}`);
}

// 2. Kenney jingles (jingle_day_end/collect/quest in jingles/, build_complete in sfx/).
for (const [key, rel] of Object.entries(M3_JINGLE_SOURCES)) {
  const src = join(KENNEY, rel);
  if (!existsSync(src)) throw new Error(`vendor file missing: ${src}`);
  const dir = key === 'build_complete' ? dirs.sfx : dirs.jingles;
  encodeDual(src, join(dir, key), {
    filter: sfxGainFilter(src),
    oggQuality: 4, // jingles ride the SFX spec (§11.5)
    m4aBitrate: '112k',
  });
  console.log(`${key} <- ${rel}`);
}

// 3. FreePD BGM (two-pass loudnorm −16 LUFS, ogg ~96k + m4a 96k, ≤3.5MB/track).
for (const [key, entry] of Object.entries(BGM_SOURCES)) {
  const src = fetchFreePd(entry);
  encodeDual(src, join(dirs.bgm, key), {
    ...bgmFilter(src, entry.trimSec),
    oggQuality: 3, // §11.6: BGM Vorbis q3
    m4aBitrate: '96k',
  });
  console.log(`${key} <- FreePD mirror ${entry.file}`);
}

// 4. Synthesized placeholders (self-made, CC0; flagged placeholder in the manifest).
//    whiff: short band-passed noise whoosh (§11.5 — no CC0 whoosh in the packs).
{
  const dest = join(dirs.sfx, 'whiff');
  const gen = [
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=white:duration=0.28:amplitude=0.6:seed=20260611',
  ];
  const filter =
    'highpass=f=600,lowpass=f=2600,afade=t=in:d=0.05,afade=t=out:st=0.12:d=0.16,volume=-8dB';
  ffmpeg([
    ...gen,
    '-af',
    filter,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-c:a',
    'vorbis',
    '-strict',
    'experimental',
    '-q:a',
    '4',
    `${dest}.ogg`,
  ]);
  ffmpeg([
    ...gen,
    '-af',
    filter,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    `${dest}.m4a`,
  ]);
  console.log('whiff <- ffmpeg synth (placeholder)');
}

//    rain_loop: 50s filtered pink-noise rain bed (§11.5 45~60s; stationary noise +
//    30ms edge fades keeps the loop seam inaudible at ambience levels).
{
  const dest = join(dirs.ambience, 'rain_loop');
  const gen = [
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=pink:duration=50:amplitude=0.45:seed=20260611',
  ];
  const filter =
    'highpass=f=400,lowpass=f=7000,tremolo=f=0.3:d=0.15,afade=t=in:d=0.03,afade=t=out:st=49.97:d=0.03,volume=-14dB';
  ffmpeg([
    ...gen,
    '-af',
    filter,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-c:a',
    'vorbis',
    '-strict',
    'experimental',
    '-q:a',
    '3',
    `${dest}.ogg`,
  ]);
  ffmpeg([
    ...gen,
    '-af',
    filter,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    `${dest}.m4a`,
  ]);
  console.log('rain_loop <- ffmpeg synth (placeholder)');
}

// 5. Budget report (§11.7 gates live in scripts/check-audio-assets.mjs).
let totals = { sfxJingle: 0, bgmAmbience: 0 };
for (const [name, dir] of Object.entries(dirs)) {
  const files = run('ls', [dir]).trim().split('\n');
  let bytes = 0;
  for (const f of files) bytes += statSync(join(dir, f)).size;
  if (name === 'sfx' || name === 'jingles') totals.sfxJingle += bytes;
  else totals.bgmAmbience += bytes;
  console.log(`${name}: ${(bytes / 1024).toFixed(0)} KB (${files.length} files)`);
}
console.log(
  `SFX+jingles total ${(totals.sfxJingle / 1024 / 1024).toFixed(2)} MB (budget 2.5) | ` +
    `BGM+ambience total ${(totals.bgmAmbience / 1024 / 1024).toFixed(2)} MB (budget 12)`,
);
