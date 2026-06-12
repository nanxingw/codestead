/**
 * AssetKeys.ts — asset key & path contract between art, scenes and sim-driven rendering.
 *
 * Sources of truth: game-design.md §11.4 (frame-key contract), §11.5 (SFX list),
 * §11.7 (directory layout), §1.1/§1.5 (map & tileset). `{cropId}` in every frame key is
 * verbatim-equal to CropDef.id (PRD 01 US106). All names lowercase snake_case ASCII.
 *
 * Note: GDD §11.4 calls this module `game/src/assets/keys.ts`; this repo pins it at
 * src/AssetKeys.ts (M1 contract ruling — see openQuestions). Paths below are
 * repo-relative to packages/game/; how PreloadScene resolves them through Vite
 * (publicDir vs ?url imports) is the preload implementer's choice, but the on-disk
 * layout is fixed by §11.7 and the manifest gate.
 */

// ---- loader keys (Phaser cache keys) ----

export const TEXTURES = {
  /** Tileset image, 1px-extruded (margin 1 / spacing 2); Tiled tileset name MUST be 'terrain'. */
  terrain: 'terrain',
  crops: 'crops',
  items: 'items',
  ui: 'ui',
  characters: 'characters',
} as const;

export const MAPS = {
  farm: 'farm',
} as const;

// ---- on-disk paths (GDD §11.7 tree; §1.1 map file) ----

export const ASSET_PATHS = {
  manifest: 'assets/manifest.json', // per-file license traceability (red line 5)
  tilesetTerrain: 'assets/tilesets/terrain.png',
  atlasCropsPng: 'assets/atlases/crops.png',
  atlasCropsJson: 'assets/atlases/crops.json',
  atlasItemsPng: 'assets/atlases/items.png',
  atlasItemsJson: 'assets/atlases/items.json',
  atlasUiPng: 'assets/atlases/ui.png',
  atlasUiJson: 'assets/atlases/ui.json',
  atlasCharactersPng: 'assets/atlases/characters.png',
  atlasCharactersJson: 'assets/atlases/characters.json',
  fontDir: 'assets/fonts/fusion-pixel-12px', // + LICENSE-OFL.txt alongside (OFL-1.1)
  /** Tiled 1.12.2 export: embedded tileset, CSV, no infinite, orthogonal only (GDD §1.1). */
  mapFarm: 'maps/farm.tmj',
} as const;

// ---- crop frame keys (GDD §3.7/§11.4, M1 three-stage art) ----

/** Shared stage-0 "seeded mound" frame for all crops. */
export const CROP_COMMON_SEEDED = 'crop_common_seeded';

/** `crop_{cropId}_s{0..2}` — visual stage bucketed by sim/farming.visualStage(). */
export function cropStageFrame(cropId: string, stage: 0 | 1 | 2): string {
  return `crop_${cropId}_s${stage}`;
}

/** Regrow crops only: the just-picked frame. */
export function cropPickedFrame(cropId: string): string {
  return `crop_${cropId}_picked`;
}

/** Regrow crops only: harvest-count exhausted "old vine" frame. */
export function cropOldVineFrame(cropId: string): string {
  return `crop_${cropId}_old_vine`;
}

// ---- M3 crop frames: full stage table returns (GDD §3.7/§11.4; PRD 04 US46) ----

/** Shared first-sprout frame (M3 full-stage table; GDD §3.7 共享 sprout). */
export const CROP_COMMON_SPROUT = 'crop_common_sprout';
/** Shared withered frame (season-change kills only reachable from M3 on; §3.7). */
export const CROP_COMMON_WITHERED = 'crop_common_withered';
/** Mature "glint" overlay frame (shared FX; plays over the final stage, §3.7). */
export const CROP_MATURE_GLINT = 'fx_mature_glint';

/**
 * M3 full-stage frame: `crop_{cropId}_s{0..stageDays.length}` — spriteStages =
 * stageDays.length + 1 (§3.7 full table, ≈76 frames). M1's 3-stage bucketing
 * (cropStageFrame above) remains valid until the M3 art batch lands.
 */
export function cropStageFrameFull(cropId: string, stage: number): string {
  return `crop_${cropId}_s${stage}`;
}

// ---- item / tool / icon frame keys (GDD §11.4) ----

export function itemFrame(cropId: string): string {
  return `item_${cropId}`;
}

export function seedFrame(cropId: string): string {
  return `seed_${cropId}`;
}

/** `tool_{hoe|can}_t{1..3}` — tier 1 wood / 2 copper / 3 gold. */
export function toolFrame(tool: 'hoe' | 'can', tier: 1 | 2 | 3): string {
  return `tool_${tool}_t${tier}`;
}

/** Forage pickups (GDD §1.3/§11.4 自绘 3 帧); convention matches itemFrame naming. */
export const PICKUP_FRAMES = {
  wood: 'item_wood',
  stone: 'item_stone',
  wildflower: 'item_wildflower',
} as const;

export const ICONS = {
  gold: 'icon_gold',
  xp: 'icon_xp',
  level: 'icon_level',
  sun: 'icon_sun',
  rain: 'icon_rain',
} as const;

// ---- character frames (GDD §11.4: `{actor}_{anim}_{dir}_{frame}`) ----

export const PLAYER_ACTOR = 'player';

/**
 * M4 villager actors (ai-quests §1.1/§1.3). The atlas frames ride the standard
 * `{actor}_{anim}_{dir}_{frame}` contract (Kenney Roguelike Characters CC0 基底 +
 * 职业配件, §1.3); until the art batch lands, src/world/npc.ts synthesizes a
 * distinct 16×16 placeholder per villager so the world still boots (textures.ts
 * fallback discipline). M4 only needs 2-frame idle + facing flip — NO walk/swing
 * (NPCs 站桩, §1.3 寻路与日程 explicitly Out).
 */
export const NPC_ACTORS = {
  npc_carpenter: 'npc_carpenter',
  npc_grocer: 'npc_grocer',
  npc_keeper: 'npc_keeper',
} as const;

/** 8×8 quest bubble frame floated over an NPC with a pending quest (§6.1). */
export const QUEST_BUBBLE_FRAME = 'ui_quest_bubble';

/** Walk 4 frames @8fps; tool swing overlay 3 frames @12fps (~250ms) (GDD §11.4). */
export function actorFrame(
  actor: string,
  anim: 'walk' | 'idle' | 'swing',
  dir: 'up' | 'down' | 'left' | 'right',
  frame: number,
): string {
  return `${actor}_${anim}_${dir}_${frame}`;
}

// ---- UI / HUD / FX frames (GDD §11.3/§11.4) ----

export const UI_FRAMES = {
  panel: 'ui_panel', // 24×24 9-slice, 8px slices
  button: 'ui_button', // three states: normal/hover/pressed
  slot: 'ui_slot', // 20×20; +2px gold.light outline when selected
} as const;

/** `hud_state_{state}` — five-state HUD icons (M2 consumes; keys reserved now). */
export function hudStateFrame(state: 'working' | 'blocked' | 'done' | 'idle' | 'unknown'): string {
  return `hud_state_${state}`;
}

/**
 * 8×8 session-panel icons (hud-sessions §3.1/§12-D5; ui atlas, self-drawn
 * CC0): one frame per state, ⚠ error modifier, ⌁ disconnect bar glyph, 4-frame
 * ◐ spinner. `_hollow` variants carry the `source === 'process'` low-confidence
 * stroke style (US12); for shapes that are already outlines (○ ? ⚠ ⌁) the
 * hollow frame aliases the same drawing.
 */
export const HUD8_FRAMES = {
  blocked: 'hud8_blocked',
  error: 'hud8_error',
  done: 'hud8_done',
  idle: 'hud8_idle',
  unknown: 'hud8_unknown',
  disconnected: 'hud8_disconnected',
  working: ['hud8_working_0', 'hud8_working_1', 'hud8_working_2', 'hud8_working_3'],
} as const;

export function hud8Hollow(frame: string): string {
  return `${frame}_hollow`;
}

export const FX_FRAMES = {
  rain0: 'fx_rain_0',
  rain1: 'fx_rain_1',
  splash0: 'fx_splash_0',
  splash1: 'fx_splash_1',
} as const;

// ---- M3 building / quality frames (GDD §8/§11.4 conventions; PRD 04 §L68) ----

/**
 * Structure exterior frames: `structure_{defId}` (built) / `structure_{defId}_site`
 * (construction site). `{defId}` is verbatim from data/buildings.ts BLUEPRINTS —
 * same一字不差 discipline as `{cropId}` ↔ CropDef.id (§11.4).
 */
export function structureFrame(defId: string, state: 'built' | 'site' = 'built'): string {
  return state === 'site' ? `structure_${defId}_site` : `structure_${defId}`;
}

/**
 * Quality badges, overlaid on item icons in bag/bin/codex (PRD 04 US45). DOUBLE-CODED
 * by contract: distinct SHAPE per grade, not colour alone — grayscale-readable (§10.8).
 * Normal has no badge.
 */
export const QUALITY_BADGE_FRAMES = {
  silver: 'quality_badge_silver',
  gold: 'quality_badge_gold',
} as const;

/** Coop hen actor frames ride the standard `{actor}_{anim}_{dir}_{frame}` contract. */
export const HEN_ACTOR = 'hen';

/** Interior tilemaps (GDD §8.3 室内场景; same Tiled pipeline contract as farm.tmj). */
export const INTERIOR_MAPS = {
  farmhouse_0: 'maps/interiors/farmhouse_0.tmj', // 10×8, bed + save point
  farmhouse_1: 'maps/interiors/farmhouse_1.tmj', // 12×10
  farmhouse_2: 'maps/interiors/farmhouse_2.tmj', // 16×12 incl. study (M4 interface)
  coop_interior: 'maps/interiors/coop_interior.tmj', // 8×6, 4 roosts + egg spot
  workshop_interior: 'maps/interiors/workshop_interior.tmj', // 10×6, 6 slots
  greenhouse_interior: 'maps/interiors/greenhouse_interior.tmj', // 12×10, 24 plots
} as const;

// ---- audio (GDD §11.5 M1 convergence: the 8 M1 SFX + master volume + muted;
// M2 adds the session-HUD soft click — hud-sessions §3.4) ----

/** Canonical SFX keys — the audio interface; 50ms same-key dedupe is the only M1 limiter. */
export const SFX = {
  hoeTill: 'hoe_till',
  seedPlant: 'seed_plant',
  waterPour: 'water_pour',
  harvestPop: 'harvest_pop',
  itemGet: 'item_get',
  coins: 'coins',
  jingleLevelup: 'jingle_levelup',
  uiError: 'ui_error',
  /** Session HUD →blocked/→done cue (Kenney UI Audio soft click; 40% volume, ≤200ms, §3.4). */
  sessionChime: 'session_chime',
} as const;
export type SfxKey = (typeof SFX)[keyof typeof SFX];

/** On-disk audio files (GDD §11.7: audio/sfx|jingles; .ogg only in M1 — m4a dual format is M3). */
export const AUDIO_PATHS: Readonly<Record<SfxKey, string>> = {
  hoe_till: 'assets/audio/sfx/hoe_till.ogg',
  seed_plant: 'assets/audio/sfx/seed_plant.ogg',
  water_pour: 'assets/audio/sfx/water_pour.ogg',
  harvest_pop: 'assets/audio/sfx/harvest_pop.ogg',
  item_get: 'assets/audio/sfx/item_get.ogg',
  coins: 'assets/audio/sfx/coins.ogg',
  jingle_levelup: 'assets/audio/jingles/jingle_levelup.ogg',
  ui_error: 'assets/audio/sfx/ui_error.ogg',
  session_chime: 'assets/audio/sfx/session_chime.ogg',
};

// ---- M3 audio (GDD §11.5 full SFX list / §11.6 BGM; PRD 04 §J/§K/§L) ----
//
// Kept SEPARATE from the M1 `SFX`/`AUDIO_PATHS` tables on purpose: PreloadScene
// eagerly iterates those at boot, while every M3 asset below is (a) dual-format
// ogg+m4a (Safari, §11.5) and (b) lazily loaded after the first input gesture —
// BGM must NEVER load on the first screen (cold start ≤3s, §11.6/§11.7).
// Canonical name = interface (§11.5); building-beat names (build_place/build_refund/
// build_complete/egg_collect/process_done) are coined by this contract pass for the
// PRD 04 US61 beats and recorded as a §11.5 list backfill item.

/** BGM tracks (§11.6): day A/B alternate by game-day parity; rain has its own track. */
export const BGM = {
  dayA: 'bgm_day_a',
  dayB: 'bgm_day_b',
  rainDay: 'bgm_rain_day',
} as const;
export type BgmKey = (typeof BGM)[keyof typeof BGM];

/** Ambience loops (own bus; rain fades in 1.5s / out 1.5s, §11.6). */
export const AMBIENCE = {
  rainLoop: 'rain_loop', // 45~60s seamless loop (§11.5)
} as const;
export type AmbienceKey = (typeof AMBIENCE)[keyof typeof AMBIENCE];

/** M3 SFX & jingles (canonical keys; M4-reserved sounds produce assets only, §K62). */
export const SFX_M3 = {
  // world actions (§11.5)
  stepGrass0: 'step_grass_0',
  stepGrass1: 'step_grass_1',
  stepGrass2: 'step_grass_2',
  stepDirt0: 'step_dirt_0',
  stepDirt1: 'step_dirt_1',
  stepDirt2: 'step_dirt_2',
  whiff: 'whiff',
  // UI five-piece set, soft variants (§11.5; ui_error already ships in M1)
  uiTick: 'ui_tick',
  uiClick: 'ui_click',
  uiOpen: 'ui_open',
  uiClose: 'ui_close',
  // jingles
  jingleDayEnd: 'jingle_day_end', // ≤4s, falling resolution = "putting it down" (§11.5)
  jingleCollect: 'jingle_collect',
  // building beats (PRD 04 US61 — coined, see note above)
  buildPlace: 'build_place',
  buildRefund: 'build_refund',
  buildComplete: 'build_complete', // completion confetti beat (no popup, §8.3)
  eggCollect: 'egg_collect',
  processDone: 'process_done',
  // M4-reserved (assets + play interface now; playback logic lands M4, §K62)
  questChime: 'quest_chime', // ≤0.5s
  jingleQuest: 'jingle_quest',
  blipTalk: 'blip_talk', // per-2-chars, 0.25× volume, can be disabled
  hudSoftTick: 'hud_soft_tick', // DEFAULT OFF; blocked/done only, 10s dedupe (§11.5)
} as const;
export type SfxM3Key = (typeof SFX_M3)[keyof typeof SFX_M3];

const M3_AUDIO_DIRS: Readonly<Record<string, 'sfx' | 'jingles' | 'bgm' | 'ambience'>> = {
  bgm_day_a: 'bgm',
  bgm_day_b: 'bgm',
  bgm_rain_day: 'bgm',
  rain_loop: 'ambience',
  jingle_day_end: 'jingles',
  jingle_collect: 'jingles',
  jingle_quest: 'jingles',
};

/**
 * Dual-format source list for one M3 audio key, ogg first (Phaser picks the first
 * playable; m4a is the Safari fallback — §11.5/§11.6 loudnorm pipeline emits both).
 */
export function audioSourcesM3(key: BgmKey | AmbienceKey | SfxM3Key): readonly string[] {
  const dir = M3_AUDIO_DIRS[key] ?? 'sfx';
  return [`assets/audio/${dir}/${key}.ogg`, `assets/audio/${dir}/${key}.m4a`];
}
