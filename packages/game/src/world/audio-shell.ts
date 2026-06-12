/**
 * audio-shell.ts — the THIN Phaser playback shell around the pure AudioDirector
 * (audio/audio-director.ts, GDD §11.6; PRD 04 §J). The reducer decides "when to play
 * what"; this shell merely EXECUTES AudioCommand lists against Phaser.Sound, manages
 * loop instances/fades, performs the first-gesture unlock + lazy load, and routes the
 * four-channel volumes (master/bgm/sfx/ui — GDD §10.7, ruling A-10).
 *
 * Lazy-load discipline (§11.6/§11.7): NO M3 audio (BGM above all) is loaded on the
 * first screen. The shell waits for Phaser's first-gesture UNLOCKED signal, then
 * streams the M3 set through the scene loader; AudioUnlocked is dispatched only when
 * both are done. SFX requested while LOCKED are dropped by the pure gate.
 *
 * SimPaused mapping (§11.6 + §2.5 reconciliation): the suspend arrow applies to
 * tab_hidden / window_blur / menu / dialog — NOT to day_summary (the SUMMARY phase
 * owns that beat: jingle_day_end must be audible on the settlement screen) and NOT
 * to boot_gate/afk. `suspendContext` is executed as BGM+ambience pause (UI clicks in
 * menus stay alive); the real AudioContext.suspend() is reserved for document.hidden.
 *
 * Pause/resume wiring is event-driven off WORLD_EVENTS.paused/resumed — zero polling,
 * zero sim coupling beyond the subscribe-only SimEvent stream (GDD §12).
 */
import Phaser from 'phaser';

import {
  AMBIENCE,
  BGM,
  SFX_M3,
  audioSourcesM3,
  type AmbienceKey,
  type BgmKey,
  type SfxM3Key,
} from '../AssetKeys';
import {
  INITIAL_AUDIO_STATE,
  reduceAudio,
  type AudioCommand,
  type AudioDirectorState,
  type AudioInputEvent,
} from '../audio/audio-director';
import { FOOTSTEP_THROTTLE_MS, footstepKey, type FootstepSurface } from '../audio/sfx-map';
import type { SimApi } from '../sim/sim';
import type { PauseSource, SimEvent } from '../sim/types';
import type { UiAudio } from '../ui/context';
import type { AudioSettings } from '../ui/settings-store';
import { SfxPlayer } from './audio';
import { WORLD_EVENTS } from './events';

/** Pause sources that suspend audio (§11.6 SimPaused = tab 隐藏/菜单; see header). */
const SUSPEND_SOURCES: readonly PauseSource[] = ['tab_hidden', 'window_blur', 'menu', 'dialog'];

/** Minimum pixel movement per frame that counts as walking (footstep driver). */
const FOOTSTEP_MIN_MOVE_PX = 0.5;

interface LoopHandle {
  key: string;
  sound: Phaser.Sound.BaseSound;
  /** Fade level 0..1 — final volume = level × channel gain (re-applied on settings). */
  level: number;
  tween: Phaser.Tweens.Tween | null;
}

export interface AudioShellHooks {
  /** Driver pause-source set (registry timeDriver) — read on pause edges only. */
  pauseSources: () => ReadonlySet<PauseSource>;
  /** Player foot position in world px; null while no player exists. */
  playerPos?: () => { x: number; y: number } | null;
  /** Surface under the player for footstep flavour (tilled/farmland = dirt). */
  surfaceAt?: () => FootstepSurface;
}

export class AudioShell implements UiAudio {
  readonly sfx: SfxPlayer;

  private director: AudioDirectorState = INITIAL_AUDIO_STATE;
  private bgm: LoopHandle | null = null;
  private ambience: LoopHandle | null = null;
  private channels: AudioSettings | null = null;
  private suspended = false;
  private destroyed = false;
  private unsubSim: (() => void) | null = null;
  private lastFootstepAt = 0;
  private lastPos: { x: number; y: number } | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly hooks: AudioShellHooks,
  ) {
    this.sfx = new SfxPlayer(scene);

    // First-gesture unlock → lazy load → AudioUnlocked (§11.6; BGM never preloads).
    if (scene.sound.locked) {
      scene.sound.once(Phaser.Sound.Events.UNLOCKED, this.beginLazyLoad);
    } else {
      this.beginLazyLoad();
    }

    scene.game.events.on(WORLD_EVENTS.paused, this.onPaused);
    scene.game.events.on(WORLD_EVENTS.resumed, this.onResumed);
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.onUpdate);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  /** Subscribe to the sim event stream and seed day/weather state (subscribe-only). */
  attach(sim: SimApi): void {
    this.dispatch({
      type: 'DayStarted',
      day: sim.state.time.day,
      weather: sim.state.time.weatherToday,
    });
    this.unsubSim = sim.on((event: SimEvent) => {
      switch (event.type) {
        case 'DayStarted':
          this.dispatch({ type: 'DayStarted', day: event.day, weather: event.weather });
          break;
        case 'DayEnded':
          this.dispatch({ type: 'DayEnded' });
          break;
        case 'WeatherChanged':
          this.dispatch({ type: 'WeatherChanged', weather: event.weather });
          break;
        default:
          break; // action SFX ride attachWorldSfx; building beats included (sfx-map)
      }
    });
  }

  // ---- UiAudio (delegation to the gated SFX player) ----

  play(...args: Parameters<UiAudio['play']>): void {
    this.sfx.play(...args);
  }

  setMasterVolume(volume: number, muted: boolean): void {
    this.sfx.setMasterVolume(volume, muted);
  }

  /** Four-channel push (PRD 04 US56); flips MusicSettingChanged on bgm 0-crossings. */
  setChannelVolumes(audio: AudioSettings): void {
    const wasEnabled = this.musicEnabled();
    this.channels = { ...audio };
    this.sfx.setChannelVolumes(audio);
    this.applyLoopVolumes();
    const enabled = this.musicEnabled();
    if (enabled !== wasEnabled) this.dispatch({ type: 'MusicSettingChanged', enabled });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubSim?.();
    this.unsubSim = null;
    this.scene.game.events.off(WORLD_EVENTS.paused, this.onPaused);
    this.scene.game.events.off(WORLD_EVENTS.resumed, this.onResumed);
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.onUpdate);
    this.disposeLoop(this.bgm);
    this.disposeLoop(this.ambience);
    this.bgm = null;
    this.ambience = null;
  }

  // ---- director plumbing ----

  private dispatch(event: AudioInputEvent): void {
    const result = reduceAudio(this.director, event);
    this.director = result.state;
    for (const command of result.commands) this.execute(command);
  }

  private execute(command: AudioCommand): void {
    switch (command.cmd) {
      case 'playBgm':
        this.startLoop('bgm', command.track, command.fadeInMs);
        return;
      case 'stopBgm':
        this.stopLoop('bgm', command.fadeOutMs);
        return;
      case 'crossfadeBgm':
        this.stopLoop('bgm', command.fadeOutMs);
        this.startLoop('bgm', command.track, command.fadeInMs);
        return;
      case 'playJingleOnce':
        this.sfx.play(command.key);
        return;
      case 'setRainAmbience':
        if (command.on) this.startLoop('ambience', AMBIENCE.rainLoop, command.fadeMs);
        else this.stopLoop('ambience', command.fadeMs);
        return;
      case 'suspendContext':
        this.suspendPlayback();
        return;
      case 'resumeContext':
        this.resumePlayback();
        return;
      case 'muteAll':
        this.scene.sound.mute = true; // unlock-failure degrade (§11.6) — no error UI
        return;
    }
  }

  // ---- unlock + lazy load (§11.6/§11.7) ----

  private readonly beginLazyLoad = (): void => {
    if (this.destroyed) return;
    const keys: (BgmKey | AmbienceKey | SfxM3Key)[] = [
      ...Object.values(BGM),
      ...Object.values(AMBIENCE),
      ...Object.values(SFX_M3),
    ];
    let queued = 0;
    for (const key of keys) {
      if (this.scene.cache.audio.exists(key)) continue;
      this.scene.load.audio(key, [...audioSourcesM3(key)]);
      queued++;
    }
    const finish = (): void => this.onLazyLoadDone();
    if (queued === 0) {
      finish();
      return;
    }
    this.scene.load.once(Phaser.Loader.Events.COMPLETE, finish);
    this.scene.load.start();
  };

  private onLazyLoadDone(): void {
    if (this.destroyed) return;
    // Gesture happened (Phaser reported UNLOCKED) — verify the context actually runs;
    // a refusal degrades to global mute with no error UI (§11.6).
    const ctx = this.audioContext();
    if (this.scene.sound.locked) {
      this.dispatch({ type: 'AudioUnlockFailed' });
      return;
    }
    if (ctx && ctx.state !== 'running') {
      ctx.resume().then(
        () => this.dispatch({ type: 'AudioUnlocked' }),
        () => this.dispatch({ type: 'AudioUnlockFailed' }),
      );
      return;
    }
    this.dispatch({ type: 'AudioUnlocked' });
  }

  // ---- pause / resume edges (driver sources via hooks) ----

  private readonly onPaused = (): void => {
    if (this.destroyed) return;
    const sources = this.hooks.pauseSources();
    if (!SUSPEND_SOURCES.some((s) => sources.has(s))) return;
    this.suspended = true;
    this.dispatch({ type: 'SimPaused' });
  };

  private readonly onResumed = (): void => {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.dispatch({ type: 'SimResumed' });
  };

  // ---- loop management (BGM + rain ambience bus) ----

  private startLoop(slot: 'bgm' | 'ambience', key: string, fadeInMs: number): void {
    if (!this.scene.cache.audio.exists(key)) return; // missing asset: stay silent
    const existing = slot === 'bgm' ? this.bgm : this.ambience;
    if (existing && existing.key === key) {
      this.fadeLoop(existing, slot, 1, fadeInMs);
      return;
    }
    if (existing) this.disposeLoop(existing);
    let handle: LoopHandle;
    try {
      const sound = this.scene.sound.add(key, { loop: true });
      handle = { key, sound, level: 0, tween: null };
      sound.play({ volume: 0 });
    } catch (error) {
      console.warn(`[audio] failed to start loop ${key}:`, error);
      return;
    }
    if (slot === 'bgm') this.bgm = handle;
    else this.ambience = handle;
    this.fadeLoop(handle, slot, 1, fadeInMs);
  }

  private stopLoop(slot: 'bgm' | 'ambience', fadeOutMs: number): void {
    const handle = slot === 'bgm' ? this.bgm : this.ambience;
    if (!handle) return;
    if (slot === 'bgm') this.bgm = null;
    else this.ambience = null;
    handle.tween?.remove();
    const proxy = { level: handle.level };
    handle.tween = this.scene.tweens.add({
      targets: proxy,
      level: 0,
      duration: Math.max(1, fadeOutMs),
      onUpdate: () => {
        handle.level = proxy.level;
        this.applyLoopVolume(handle, slot);
      },
      onComplete: () => this.disposeLoop(handle),
    });
  }

  private fadeLoop(
    handle: LoopHandle,
    slot: 'bgm' | 'ambience',
    target: number,
    durationMs: number,
  ): void {
    handle.tween?.remove();
    const proxy = { level: handle.level };
    this.applyLoopVolume(handle, slot);
    handle.tween = this.scene.tweens.add({
      targets: proxy,
      level: target,
      duration: Math.max(1, durationMs),
      onUpdate: () => {
        handle.level = proxy.level;
        this.applyLoopVolume(handle, slot);
      },
    });
  }

  private disposeLoop(handle: LoopHandle | null): void {
    if (!handle) return;
    handle.tween?.remove();
    handle.tween = null;
    try {
      handle.sound.stop();
      handle.sound.destroy();
    } catch {
      /* already torn down with the scene */
    }
  }

  /** BGM rides the bgm channel; the rain bus rides sfx (ambience is not music). */
  private applyLoopVolume(handle: LoopHandle, slot: 'bgm' | 'ambience'): void {
    const channels = this.channels ?? this.sfx.channelSettings;
    const gain = (slot === 'bgm' ? channels.bgm : channels.sfx) / 100;
    (handle.sound as Phaser.Sound.WebAudioSound).setVolume(handle.level * gain);
  }

  private applyLoopVolumes(): void {
    if (this.bgm) this.applyLoopVolume(this.bgm, 'bgm');
    if (this.ambience) this.applyLoopVolume(this.ambience, 'ambience');
  }

  private musicEnabled(): boolean {
    const channels = this.channels ?? this.sfx.channelSettings;
    return channels.bgm > 0;
  }

  // ---- suspend / resume execution (see header for the §11.6 mapping) ----

  private suspendPlayback(): void {
    this.pauseIfPlaying(this.bgm);
    this.pauseIfPlaying(this.ambience);
    // True absence (tab hidden): suspend the context itself — browser-throttle-proof.
    if (typeof document !== 'undefined' && document.hidden) {
      void this.audioContext()?.suspend();
    }
  }

  private resumePlayback(): void {
    const ctx = this.audioContext();
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {
        this.scene.sound.mute = true; // resume refusal → global mute degrade (§11.6)
      });
    }
    this.resumeIfPaused(this.bgm);
    this.resumeIfPaused(this.ambience);
  }

  private pauseIfPlaying(handle: LoopHandle | null): void {
    if (handle?.sound.isPlaying === true) handle.sound.pause();
  }

  private resumeIfPaused(handle: LoopHandle | null): void {
    if (handle?.sound.isPaused === true) handle.sound.resume();
  }

  private audioContext(): AudioContext | null {
    const manager = this.scene.sound as Partial<Phaser.Sound.WebAudioSoundManager>;
    return manager.context ?? null;
  }

  // ---- footsteps (§11.5: grass/dirt ×3 variants, 0.3s throttle) ----

  private readonly onUpdate = (): void => {
    if (this.destroyed || !this.hooks.playerPos) return;
    const pos = this.hooks.playerPos();
    if (!pos) {
      this.lastPos = null;
      return;
    }
    const last = this.lastPos;
    this.lastPos = { x: pos.x, y: pos.y };
    if (!last) return;
    const moved = Math.abs(pos.x - last.x) + Math.abs(pos.y - last.y);
    if (moved < FOOTSTEP_MIN_MOVE_PX) return;
    const now = this.scene.time.now;
    if (now - this.lastFootstepAt < FOOTSTEP_THROTTLE_MS) return;
    this.lastFootstepAt = now;
    const surface = this.hooks.surfaceAt ? this.hooks.surfaceAt() : 'grass';
    this.sfx.playCue({
      key: footstepKey(surface, Math.random()), // render-side draw, not sim rng
      channel: 'sfx',
      layer: 'world',
    });
  };
}
