/**
 * audio.ts — minimal M1 SFX adapter (integration glue; no dedicated audio stream yet).
 *
 * Implements the UiAudio contract from ui/context.ts on top of Phaser's global sound
 * manager: 50ms same-key dedupe is the only M1 limiter (GDD §11.5), master volume /
 * muted come from the settings store via UIScene. World-side action sounds are driven
 * purely by SimEvents (one-way flow, GDD §12): the sim emits each event exactly once
 * through on(), so subscription here cannot double-fire.
 *
 * UI-side sounds (coins on GoldChanged, the level-up jingle, ui_error) are played by
 * UIScene through the same UiAudio instance — they are NOT mapped here.
 */
import type Phaser from 'phaser';

import { SFX, type SfxKey } from '../AssetKeys';
import type { SimApi } from '../sim/sim';
import type { SimEvent } from '../sim/types';
import type { UiAudio } from '../ui/context';

/** Same-key dedupe window (GDD §11.5: the only M1 audio limiter). */
export const SFX_DEDUPE_MS = 50;

/** harvest_pop pitch jitter: ±10% pitch ≈ ±170 cents (GDD §6.4 「±10% 音高」). */
export const HARVEST_PITCH_JITTER_CENTS = 170;

/** Random detune for one harvest_pop play (render-side, NOT sim rng — no determinism). */
export function harvestDetuneCents(): number {
  return Math.round((Math.random() * 2 - 1) * HARVEST_PITCH_JITTER_CENTS);
}

export class SfxPlayer implements UiAudio {
  private readonly lastPlayedAt = new Map<SfxKey, number>();

  constructor(private readonly scene: Phaser.Scene) {}

  play(key: SfxKey, opts?: { detune?: number; volume?: number }): void {
    const now = this.scene.time.now;
    const last = this.lastPlayedAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - last < SFX_DEDUPE_MS) return;
    this.lastPlayedAt.set(key, now);
    if (!this.scene.cache.audio.exists(key)) return; // missing asset: silent (preload warned)
    try {
      const config: { detune?: number; volume?: number } = {};
      if (opts?.detune !== undefined) config.detune = opts.detune;
      if (opts?.volume !== undefined) config.volume = opts.volume;
      if (config.detune !== undefined || config.volume !== undefined) {
        this.scene.sound.play(key, config);
      } else {
        this.scene.sound.play(key);
      }
    } catch (error) {
      console.warn(`[audio] failed to play ${key}:`, error);
    }
  }

  /** Settings panel pushes 0..100 + muted immediately on change (GDD §10.7). */
  setMasterVolume(volume: number, muted: boolean): void {
    this.scene.sound.volume = Math.min(100, Math.max(0, volume)) / 100;
    this.scene.sound.mute = muted;
  }
}

/** SimEvent → world SFX mapping (GDD §11.5 M1 list). Returns the unsubscribe fn. */
export function attachWorldSfx(sim: SimApi, audio: UiAudio): () => void {
  return sim.on((event: SimEvent) => {
    switch (event.type) {
      case 'TileTilled':
        audio.play(SFX.hoeTill);
        break;
      case 'CropPlanted':
        audio.play(SFX.seedPlant);
        break;
      case 'CropWatered':
        audio.play(SFX.waterPour);
        break;
      case 'CropHarvested':
        audio.play(SFX.harvestPop, { detune: harvestDetuneCents() }); // ±10% pitch (§6.4)
        break;
      case 'ItemPicked':
        audio.play(SFX.itemGet);
        break;
      default:
        break; // gold/level/ui sounds belong to UIScene (same UiAudio instance)
    }
  });
}
