/**
 * ambience-view.ts — the `fx` layer (GDD §1.5 #7, depth 1100): day-night tint
 * stepped every 10 game minutes (§2.7) and the rain overlay + particles.
 *
 * Screen-space (scrollFactor 0) over the 640×360 logical viewport. Rain particles
 * prefer the `fx_rain_0` atlas frame and fall back to the generated 2×2 particle.
 * No flashing above 1Hz anywhere (photosensitivity red line, §11.7).
 */
import Phaser from 'phaser';

import type { Weather } from '../sim/types';
import { FX_FRAMES, TEXTURES } from '../AssetKeys';
import { GAME_HEIGHT, GAME_WIDTH } from '../scale';
import { lightingAt, RAIN_OVERLAY } from './lighting';
import { hasFrame, PARTICLE_TEXTURE } from './textures';
import { PALETTE } from './palette';

const FX_DEPTH = 1100;

export class AmbienceView {
  private readonly tintRect: Phaser.GameObjects.Rectangle;
  private readonly rainRect: Phaser.GameObjects.Rectangle;
  private rainEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private lastBucket = -1;
  private lastWeather: Weather | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.tintRect = scene.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0xffffff, 0)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(FX_DEPTH);
    this.rainRect = scene.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, RAIN_OVERLAY.color, RAIN_OVERLAY.alpha)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(FX_DEPTH)
      .setVisible(false);
  }

  /** Per-frame; internally no-ops until the 10-minute bucket or weather changes. */
  update(minuteOfDay: number, weather: Weather): void {
    const bucket = Math.floor(minuteOfDay / 10);
    if (bucket === this.lastBucket && weather === this.lastWeather) return;
    this.lastBucket = bucket;
    this.lastWeather = weather;

    const light = lightingAt(minuteOfDay, weather);
    this.tintRect.setFillStyle(light.tintColor, light.tintAlpha);
    this.setRain(light.rain);
  }

  private setRain(on: boolean): void {
    this.rainRect.setVisible(on);
    if (on && this.rainEmitter === null) {
      const useAtlas = hasFrame(this.scene, TEXTURES.ui, FX_FRAMES.rain0);
      this.rainEmitter = this.scene.add.particles(0, 0, useAtlas ? TEXTURES.ui : PARTICLE_TEXTURE, {
        ...(useAtlas ? { frame: [FX_FRAMES.rain0, FX_FRAMES.rain1] } : {}),
        x: { min: 0, max: GAME_WIDTH },
        y: -8,
        lifespan: 900,
        speedY: { min: 280, max: 360 },
        speedX: { min: -30, max: -10 },
        quantity: 2,
        alpha: 0.6,
        tint: PALETTE.waterPale,
      });
      this.rainEmitter.setScrollFactor(0).setDepth(FX_DEPTH + 1);
    } else if (!on && this.rainEmitter !== null) {
      this.rainEmitter.destroy();
      this.rainEmitter = null;
    }
  }
}
