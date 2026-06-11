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

export const FX_FRAMES = {
  rain0: 'fx_rain_0',
  rain1: 'fx_rain_1',
  splash0: 'fx_splash_0',
  splash1: 'fx_splash_1',
} as const;

// ---- audio (GDD §11.5 M1 convergence: exactly these 8 SFX + master volume + muted) ----

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
};
