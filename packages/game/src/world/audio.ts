/**
 * audio.ts — SFX playback adapter (M1 dedupe → full M3 gate, GDD §11.5).
 *
 * Implements the UiAudio contract from ui/context.ts on top of Phaser's global sound
 * manager. The play policy is the PURE gate in audio/audio-director.ts (`gateSfx`):
 * 50ms same-key dedupe (M1) + concurrency cap 3 + ±4% pitch jitter + the §6.4 harvest
 * combo ladder (M3). This file is only the Phaser-facing shell around that gate.
 *
 * Channel volumes (GDD §10.7, ruling A-10): master/muted apply globally on the sound
 * manager; bgm/sfx/ui are per-sound multipliers from routeForKey() — pushed by UIScene
 * via setChannelVolumes(). LOCKED behaviour per §11.6: requests before the first
 * gesture are dropped, never queued.
 *
 * World-side action sounds are driven purely by SimEvents (one-way flow, GDD §12)
 * through the audio/sfx-map.ts cue table; UI-side sounds (coins on GoldChanged, the
 * jingles, ui_error) are played by UIScene through the same UiAudio instance.
 */
import Phaser from 'phaser';

import type { SfxKey, SfxM3Key } from '../AssetKeys';
import {
  gateSfx,
  releaseSfx,
  setSfxUnlocked,
  INITIAL_SFX_GATE,
  LAYER_GAIN,
  type SfxGateState,
} from '../audio/audio-director';
import { cueForWorldEvent, routeForKey, type SfxCue, type SfxLayer } from '../audio/sfx-map';
import type { SimApi } from '../sim/sim';
import type { SimEvent } from '../sim/types';
import type { UiAudio } from '../ui/context';
import type { AudioSettings } from '../ui/settings-store';
import { DEFAULT_SETTINGS } from '../ui/settings-store';

/** Same-key dedupe window (GDD §11.5) — re-exported for tests/back-compat. */
export const SFX_DEDUPE_MS = 50;

export class SfxPlayer implements UiAudio {
  private gate: SfxGateState;
  private channels: AudioSettings = { ...DEFAULT_SETTINGS.audio };

  constructor(private readonly scene: Phaser.Scene) {
    // LOCKED until the first input gesture unlocks the sound manager (§11.6).
    this.gate = setSfxUnlocked(INITIAL_SFX_GATE, !scene.sound.locked);
    if (scene.sound.locked) {
      scene.sound.once(Phaser.Sound.Events.UNLOCKED, () => {
        this.gate = setSfxUnlocked(this.gate, true);
      });
    }
  }

  play(key: SfxKey | SfxM3Key, opts?: { detune?: number; volume?: number }): void {
    const route = routeForKey(key);
    this.playRouted(key, route.channel, route.layer, false, opts);
  }

  /** World cue entry (sfx-map table): carries combo eligibility for the §6.4 ladder. */
  playCue(cue: SfxCue): void {
    this.playRouted(cue.key, cue.channel, cue.layer, cue.comboEligible === true);
  }

  /** Settings panel pushes 0..100 + muted immediately on change (GDD §10.7). */
  setMasterVolume(volume: number, muted: boolean): void {
    this.scene.sound.volume = Math.min(100, Math.max(0, volume)) / 100;
    this.scene.sound.mute = muted;
  }

  /** Full four-channel push (M3, PRD 04 US56). */
  setChannelVolumes(audio: AudioSettings): void {
    this.channels = { ...audio };
    this.setMasterVolume(audio.master, audio.muted);
  }

  get channelSettings(): Readonly<AudioSettings> {
    return this.channels;
  }

  private playRouted(
    key: SfxKey | SfxM3Key,
    channel: 'bgm' | 'sfx' | 'ui',
    layer: SfxLayer,
    comboEligible: boolean,
    opts?: { detune?: number; volume?: number },
  ): void {
    // Pitch jitter is an anti-machine-gun measure for repeated action SFX (§11.5);
    // musical content (jingles) plays at true pitch — draw 0.5 centers to rate 1.
    const jitterDraw = layer === 'jingle' ? 0.5 : Math.random(); // render-side, NOT sim rng
    const decision = gateSfx(
      this.gate,
      { key, channel, atMs: this.scene.time.now, comboEligible },
      jitterDraw,
    );
    this.gate = decision.state;
    if (!decision.play) return;
    if (!this.scene.cache.audio.exists(key)) {
      // Missing asset: silent (preload warned), but free the concurrency slot.
      this.gate = releaseSfx(this.gate, key);
      return;
    }
    const channelGain = this.channels[channel] / 100;
    const volume = (opts?.volume ?? 1) * channelGain * LAYER_GAIN[layer];
    try {
      const sound = this.scene.sound.add(key);
      const release = (): void => {
        this.gate = releaseSfx(this.gate, key);
        sound.destroy();
      };
      sound.once(Phaser.Sound.Events.COMPLETE, release);
      sound.once(Phaser.Sound.Events.STOP, release);
      sound.play({ volume, rate: decision.rate, detune: opts?.detune ?? 0 });
    } catch (error) {
      this.gate = releaseSfx(this.gate, key);
      console.warn(`[audio] failed to play ${key}:`, error);
    }
  }
}

/** SimEvent → world SFX mapping (audio/sfx-map.ts table). Returns the unsubscribe fn. */
export function attachWorldSfx(sim: SimApi, audio: SfxPlayer): () => void {
  return sim.on((event: SimEvent) => {
    const cue = cueForWorldEvent(event);
    if (cue) audio.playCue(cue);
  });
}
