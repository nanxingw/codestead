/**
 * sfx-map.ts — pure SimEvent → SFX cue table (GDD §11.5 「规范名 = 接口」; PRD 04 US61).
 *
 * One place declares which canonical sound a sim event triggers, on which settings
 * channel (bgm/sfx/ui — GDD §10.7) and at which mix layer (§11.6 分层: world 1.0 /
 * ui 0.8 / jingle 1.0 / blip 0.25). The Phaser shell merely looks cues up here —
 * no scattered hard-coded keys (US61).
 *
 * Split of responsibilities preserved from M1: WORLD cues (this table via
 * `cueForWorldEvent`) are played by the world-side adapter; UI-side sounds
 * (coins on GoldChanged, level-up jingle, achievement jingle, ui_error) stay in
 * UIScene through the same UiAudio instance — `uiCueFor` documents those keys.
 *
 * Phaser-free by law (eslint no-restricted-imports on audio/**).
 */
import { SFX, SFX_M3, type SfxKey, type SfxM3Key } from '../AssetKeys';
import type { SimEvent } from '../sim/types';
import type { AudioChannel } from './audio-director';
import { LAYER_GAIN } from './audio-director';

export type SfxLayer = keyof typeof LAYER_GAIN;

export interface SfxCue {
  key: SfxKey | SfxM3Key;
  channel: AudioChannel;
  layer: SfxLayer;
  /** Marks the §6.4 combo ladder participants (1s window, +1 semitone, cap +7). */
  comboEligible?: boolean;
}

const world = (key: SfxKey | SfxM3Key, comboEligible?: boolean): SfxCue =>
  comboEligible === true
    ? { key, channel: 'sfx', layer: 'world', comboEligible: true }
    : { key, channel: 'sfx', layer: 'world' };
const jingle = (key: SfxKey | SfxM3Key): SfxCue => ({ key, channel: 'sfx', layer: 'jingle' });

/**
 * World-action cues (played by the world-side SimEvent subscriber).
 * M3 building beats per PRD 04 US61: 放置成交 build_place / 拆除返还 build_refund /
 * 竣工 build_complete / 鸡舍捡蛋 egg_collect / 加工完成 process_done.
 */
export function cueForWorldEvent(event: SimEvent): SfxCue | null {
  switch (event.type) {
    case 'TileTilled':
      return world(SFX.hoeTill);
    case 'CropPlanted':
      return world(SFX.seedPlant);
    case 'CropWatered':
      return world(SFX.waterPour);
    case 'CropHarvested':
      return world(SFX.harvestPop, true);
    case 'ItemPicked':
      // Coop egg pickup keeps its canonical beat (US61) — eggs ride ItemPicked.
      return event.itemId === 'animal_egg'
        ? world(SFX_M3.eggCollect, true)
        : world(SFX.itemGet, true);
    case 'StructurePlaced':
    case 'StructureMoved':
    case 'SprinklerPlaced':
      return world(SFX_M3.buildPlace);
    case 'StructureRemoved':
      return world(SFX_M3.buildRefund);
    case 'ConstructionCompleted':
      return jingle(SFX_M3.buildComplete);
    case 'ProcessingDone':
      return world(SFX_M3.processDone);
    case 'ProfessionChosen':
      // Provisional pick: the「决定已落」collect jingle (§11.5 has no dedicated key).
      return jingle(SFX_M3.jingleCollect);
    default:
      return null; // gold/level/ui/weather sounds belong to the UI side (below)
  }
}

/** UI-side canonical keys (UIScene plays these through the same UiAudio). */
export const UI_CUES = {
  goldChanged: { key: SFX.coins, channel: 'sfx', layer: 'world' },
  levelUp: { key: SFX.jingleLevelup, channel: 'sfx', layer: 'jingle' },
  /** M3: achievements graduate from the reused item_get to the collect jingle. */
  achievementUnlocked: { key: SFX_M3.jingleCollect, channel: 'sfx', layer: 'jingle' },
  error: { key: SFX.uiError, channel: 'ui', layer: 'ui' },
  tick: { key: SFX_M3.uiTick, channel: 'ui', layer: 'ui' },
  click: { key: SFX_M3.uiClick, channel: 'ui', layer: 'ui' },
  open: { key: SFX_M3.uiOpen, channel: 'ui', layer: 'ui' },
  close: { key: SFX_M3.uiClose, channel: 'ui', layer: 'ui' },
} as const satisfies Record<string, SfxCue>;

/**
 * Channel/layer routing for a raw key (used when a caller plays by key through
 * UiAudio rather than via a cue). Defaults to the world action bus.
 */
export function routeForKey(key: SfxKey | SfxM3Key): { channel: AudioChannel; layer: SfxLayer } {
  switch (key) {
    case SFX.uiError:
    case SFX.sessionChime:
    case SFX_M3.uiTick:
    case SFX_M3.uiClick:
    case SFX_M3.uiOpen:
    case SFX_M3.uiClose:
    case SFX_M3.hudSoftTick:
      return { channel: 'ui', layer: 'ui' };
    case SFX_M3.blipTalk:
      return { channel: 'ui', layer: 'blip' };
    case SFX.jingleLevelup:
    case SFX_M3.jingleDayEnd:
    case SFX_M3.jingleCollect:
    case SFX_M3.jingleQuest:
    case SFX_M3.buildComplete:
    case SFX_M3.questChime:
      return { channel: 'sfx', layer: 'jingle' };
    default:
      return { channel: 'sfx', layer: 'world' };
  }
}

// ---- footsteps (§11.5: step_grass/dirt_{0..2}, 0.3s throttle) ----

export const FOOTSTEP_THROTTLE_MS = 300;

export type FootstepSurface = 'grass' | 'dirt';

/** Variant pick from a caller-drawn uniform sample in [0,1) (render-side rng). */
export function footstepKey(surface: FootstepSurface, variantDraw: number): SfxM3Key {
  const i = Math.min(2, Math.max(0, Math.floor(variantDraw * 3)));
  const table: Record<FootstepSurface, readonly [SfxM3Key, SfxM3Key, SfxM3Key]> = {
    grass: [SFX_M3.stepGrass0, SFX_M3.stepGrass1, SFX_M3.stepGrass2],
    dirt: [SFX_M3.stepDirt0, SFX_M3.stepDirt1, SFX_M3.stepDirt2],
  };
  return table[surface][i];
}
