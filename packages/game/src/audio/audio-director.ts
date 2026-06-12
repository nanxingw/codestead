/**
 * audio-director.ts — AudioDirector PURE REDUCER contract (M3, GDD §11.6; PRD 04 §J).
 *
 * Architecture ruling (PRD 04 implementation decisions, hard rule): the director is a
 * pure reducer — sim events in, (state, command list) out — and a THIN Phaser shell
 * (audio/ shell module, M3 implementer) merely executes the commands against
 * Phaser.Sound / WebAudio. This file must stay Phaser-free and wall-clock-free
 * (ESLint-enforced like hud/**): testability = replaying event sequences and
 * asserting command sequences, never touching a real AudioContext (PRD 04 testing).
 *
 * Five-state BGM machine (§11.6, load-bearing):
 *
 *   [SILENT] ─first gesture unlock & loaded─► [DAY_CALM(A|B by day parity)]
 *      ▲            ◄─WeatherChanged─► [RAIN_DAY]   (crossfade out 800ms / in 600ms)
 *      │ music off in settings
 *      └────────── [SUMMARY]: fade out 800ms → jingle_day_end ONCE → silence
 *                     │ DayStarted (summary closed) → DAY_CALM (fade in 600ms)
 *   any ─SimPaused─► [SUSPENDED] (AudioContext.suspend()) ─SimResumed─► restore
 *                     previous state from the pause point — no restart, no backlog.
 *
 * Unlock discipline (§11.6/§11.7): BGM is NOT loaded on the first screen; the first
 * input gesture unlocks audio and triggers lazy loading. SFX requested while LOCKED
 * are DROPPED, never queued; a failed resume degrades to global mute — no error UI.
 *
 * CONTRACT FILE: types + constants are binding; `reduceAudio`/SFX-gate bodies are
 * implemented below (M3 audio stream).
 */
import type { BgmKey, SfxKey, SfxM3Key } from '../AssetKeys';

// ---- channels & defaults (GDD §10.7; ruling A-10 — localStorage, never SaveDoc) ----

export type AudioChannel = 'bgm' | 'sfx' | 'ui';

/** Defaults: master 80 (M1), bgm 35 / sfx 70 / ui 50 — bgm deliberately low (§10.7). */
export const DEFAULT_AUDIO_SETTINGS = {
  master: 80,
  muted: false,
  bgm: 35,
  sfx: 70,
  ui: 50,
} as const;

/** Mix layers within channels (§11.6): world 1.0 / UI 0.8 / jingle 1.0 / blip 0.25. */
export const LAYER_GAIN = { world: 1.0, ui: 0.8, jingle: 1.0, blip: 0.25 } as const;

// ---- fades (§11.6 numbers, verbatim) ----

export const BGM_FADE = {
  CROSSFADE_OUT_MS: 800,
  CROSSFADE_IN_MS: 600,
  SUMMARY_FADE_OUT_MS: 800,
  RESUME_FADE_IN_MS: 600,
} as const;

export const AMBIENCE_FADE = { RAIN_IN_MS: 1_500, RAIN_OUT_MS: 1_500 } as const;

// ---- the five-state machine ----

export type BgmPhase = 'SILENT' | 'DAY_CALM' | 'RAIN_DAY' | 'SUMMARY' | 'SUSPENDED';

export interface AudioDirectorState {
  phase: BgmPhase;
  /** Phase to restore on SimResumed (SUSPENDED keeps the pre-pause phase here). */
  suspendedFrom: BgmPhase | null;
  /** Odd day = track A, even = track B (§11.6 anti-earworm alternation). */
  dayParity: 'odd' | 'even';
  raining: boolean;
  /** First-gesture unlock done & files loaded (lazy; first screen never loads BGM). */
  unlocked: boolean;
  /** Settings toggle: bgm channel muted/zero ⇒ stay SILENT. */
  musicEnabled: boolean;
}

export const INITIAL_AUDIO_STATE: AudioDirectorState = {
  phase: 'SILENT',
  suspendedFrom: null,
  dayParity: 'odd',
  raining: false,
  unlocked: false,
  musicEnabled: true,
};

/**
 * Inputs: the sim events the director subscribes to (§12 — subscribe-only, never call
 * back into the sim) plus shell-side lifecycle facts.
 */
export type AudioInputEvent =
  | { type: 'DayStarted'; day: number; weather: 'sunny' | 'rain' }
  | { type: 'DayEnded' }
  | { type: 'WeatherChanged'; weather: 'sunny' | 'rain' }
  | { type: 'SimPaused' } // tab hidden / menu — suspend, resume from the pause point
  | { type: 'SimResumed' }
  | { type: 'AudioUnlocked' } // first input gesture + lazy load finished
  | { type: 'AudioUnlockFailed' } // resume failed ⇒ global mute degrade, no error UI
  | { type: 'MusicSettingChanged'; enabled: boolean };

/** Outputs: imperative commands for the thin shell. Pure data, replay-assertable. */
export type AudioCommand =
  | { cmd: 'playBgm'; track: BgmKey; fadeInMs: number; loop: true }
  | { cmd: 'stopBgm'; fadeOutMs: number }
  | { cmd: 'crossfadeBgm'; track: BgmKey; fadeOutMs: number; fadeInMs: number }
  | { cmd: 'playJingleOnce'; key: 'jingle_day_end' }
  | { cmd: 'setRainAmbience'; on: boolean; fadeMs: number }
  | { cmd: 'suspendContext' }
  | { cmd: 'resumeContext' }
  | { cmd: 'muteAll' }; // unlock-failure degrade (§11.6)

export interface AudioReduceResult {
  state: AudioDirectorState;
  commands: AudioCommand[];
}

/** Day track by parity (§11.6): odd → day_a, even → day_b. */
export function dayTrackFor(day: number): BgmKey {
  return day % 2 === 1 ? 'bgm_day_a' : 'bgm_day_b';
}

/** Day-phase BGM track for the current state (rain wins over parity). */
function bgmTrackFor(state: AudioDirectorState): BgmKey {
  if (state.raining) return 'bgm_rain_day';
  return state.dayParity === 'odd' ? 'bgm_day_a' : 'bgm_day_b';
}

/** The phase a playing director should sit in for the current weather. */
function dayPhaseFor(state: AudioDirectorState): BgmPhase {
  return state.raining ? 'RAIN_DAY' : 'DAY_CALM';
}

/** Effective (post-restore) phase: SUSPENDED is transparent for transition logic. */
function effectivePhase(state: AudioDirectorState): BgmPhase {
  return state.phase === 'SUSPENDED' ? (state.suspendedFrom ?? 'SILENT') : state.phase;
}

/** Write the effective phase back (into suspendedFrom while SUSPENDED). */
function withEffectivePhase(state: AudioDirectorState, phase: BgmPhase): AudioDirectorState {
  return state.phase === 'SUSPENDED' ? { ...state, suspendedFrom: phase } : { ...state, phase };
}

const MUSIC_PHASES: readonly BgmPhase[] = ['DAY_CALM', 'RAIN_DAY'];

/**
 * THE reducer (pure). Contract test seams (PRD 04 testing decisions): replay
 * unlock→DAY_CALM(A); odd/even switching; rain in/out crossfades; DayEnded→SUMMARY
 * (fade 800ms → jingle once → silence) → DayStarted → DAY_CALM (fade 600ms);
 * SimPaused/SimResumed restores without restarting; LOCKED drops everything.
 */
export function reduceAudio(state: AudioDirectorState, event: AudioInputEvent): AudioReduceResult {
  switch (event.type) {
    case 'AudioUnlocked': {
      if (state.unlocked) return { state, commands: [] };
      let next: AudioDirectorState = { ...state, unlocked: true };
      const commands: AudioCommand[] = [];
      if (next.raining)
        commands.push({ cmd: 'setRainAmbience', on: true, fadeMs: AMBIENCE_FADE.RAIN_IN_MS });
      if (effectivePhase(next) === 'SILENT' && next.musicEnabled) {
        next = withEffectivePhase(next, dayPhaseFor(next));
        commands.push({
          cmd: 'playBgm',
          track: bgmTrackFor(next),
          fadeInMs: BGM_FADE.RESUME_FADE_IN_MS,
          loop: true,
        });
      }
      return { state: next, commands };
    }

    case 'AudioUnlockFailed': {
      // Degrade to global mute — no error UI, stay LOCKED (§11.6).
      return { state, commands: [{ cmd: 'muteAll' }] };
    }

    case 'MusicSettingChanged': {
      if (event.enabled === state.musicEnabled) return { state, commands: [] };
      let next: AudioDirectorState = { ...state, musicEnabled: event.enabled };
      const commands: AudioCommand[] = [];
      const phase = effectivePhase(next);
      if (!event.enabled) {
        if (MUSIC_PHASES.includes(phase)) {
          commands.push({ cmd: 'stopBgm', fadeOutMs: BGM_FADE.SUMMARY_FADE_OUT_MS });
        }
        if (phase !== 'SILENT') next = withEffectivePhase(next, 'SILENT');
      } else if (phase === 'SILENT' && next.unlocked) {
        next = withEffectivePhase(next, dayPhaseFor(next));
        commands.push({
          cmd: 'playBgm',
          track: bgmTrackFor(next),
          fadeInMs: BGM_FADE.RESUME_FADE_IN_MS,
          loop: true,
        });
      }
      return { state: next, commands };
    }

    case 'DayStarted': {
      const raining = event.weather === 'rain';
      let next: AudioDirectorState = {
        ...state,
        dayParity: event.day % 2 === 1 ? 'odd' : 'even',
        raining,
      };
      const commands: AudioCommand[] = [];
      if (next.unlocked && raining !== state.raining) {
        commands.push({
          cmd: 'setRainAmbience',
          on: raining,
          fadeMs: raining ? AMBIENCE_FADE.RAIN_IN_MS : AMBIENCE_FADE.RAIN_OUT_MS,
        });
      }
      const phase = effectivePhase(next);
      if (phase === 'SUMMARY' || phase === 'SILENT') {
        // Summary closed (or music re-enabled while silent): fade the day track in.
        if (next.unlocked && next.musicEnabled) {
          next = withEffectivePhase(next, dayPhaseFor(next));
          commands.push({
            cmd: 'playBgm',
            track: bgmTrackFor(next),
            fadeInMs: BGM_FADE.RESUME_FADE_IN_MS,
            loop: true,
          });
        } else if (phase === 'SUMMARY') {
          next = withEffectivePhase(next, 'SILENT');
        }
      } else if (MUSIC_PHASES.includes(phase)) {
        // Defensive: a day roll without a summary — re-target track if it changed.
        const target = dayPhaseFor(next);
        const track = bgmTrackFor(next);
        next = withEffectivePhase(next, target);
        commands.push({
          cmd: 'crossfadeBgm',
          track,
          fadeOutMs: BGM_FADE.CROSSFADE_OUT_MS,
          fadeInMs: BGM_FADE.CROSSFADE_IN_MS,
        });
      }
      return { state: next, commands };
    }

    case 'DayEnded': {
      if (!state.unlocked) return { state, commands: [] };
      const phase = effectivePhase(state);
      if (phase === 'SUMMARY') return { state, commands: [] };
      const commands: AudioCommand[] = [];
      if (MUSIC_PHASES.includes(phase)) {
        commands.push({ cmd: 'stopBgm', fadeOutMs: BGM_FADE.SUMMARY_FADE_OUT_MS });
      }
      commands.push({ cmd: 'playJingleOnce', key: 'jingle_day_end' });
      return { state: withEffectivePhase(state, 'SUMMARY'), commands };
    }

    case 'WeatherChanged': {
      const raining = event.weather === 'rain';
      if (raining === state.raining) return { state, commands: [] };
      let next: AudioDirectorState = { ...state, raining };
      const commands: AudioCommand[] = [];
      if (next.unlocked) {
        commands.push({
          cmd: 'setRainAmbience',
          on: raining,
          fadeMs: raining ? AMBIENCE_FADE.RAIN_IN_MS : AMBIENCE_FADE.RAIN_OUT_MS,
        });
      }
      const phase = effectivePhase(next);
      if (MUSIC_PHASES.includes(phase)) {
        const target = dayPhaseFor(next);
        if (target !== phase) {
          next = withEffectivePhase(next, target);
          commands.push({
            cmd: 'crossfadeBgm',
            track: bgmTrackFor(next),
            fadeOutMs: BGM_FADE.CROSSFADE_OUT_MS,
            fadeInMs: BGM_FADE.CROSSFADE_IN_MS,
          });
        }
      }
      return { state: next, commands };
    }

    case 'SimPaused': {
      if (state.phase === 'SUSPENDED') return { state, commands: [] };
      return {
        state: { ...state, suspendedFrom: state.phase, phase: 'SUSPENDED' },
        commands: state.unlocked ? [{ cmd: 'suspendContext' }] : [],
      };
    }

    case 'SimResumed': {
      if (state.phase !== 'SUSPENDED') return { state, commands: [] };
      return {
        // Restore the pre-pause phase — no restart, no backlog (§11.6).
        state: { ...state, phase: state.suspendedFrom ?? 'SILENT', suspendedFrom: null },
        commands: state.unlocked ? [{ cmd: 'resumeContext' }] : [],
      };
    }
  }
}

// ---- SFX event bus: anti-machine-gun gate + combo scale (§11.5/§6.4; PRD 04 §K) ----

export const SFX_POLICY = {
  /** Same-key dedupe window (M1 already ships this). */
  DEDUPE_MS: 50,
  /** Random pitch jitter ±4% (M3). */
  PITCH_JITTER: 0.04,
  /** Max simultaneously playing instances per key (M3). */
  MAX_CONCURRENT: 3,
  /** Harvest combo: +1 semitone per pickup within the window, capped at +7 (§6.4). */
  COMBO_WINDOW_MS: 1_000,
  COMBO_MAX_SEMITONES: 7,
} as const;

/** A play request entering the bus; `atMs` is the shell-supplied timeline stamp. */
export interface SfxRequest {
  key: SfxKey | SfxM3Key;
  channel: AudioChannel;
  atMs: number;
  /** Marks combo-eligible pickups (item_get/harvest_pop) for the semitone ladder. */
  comboEligible?: boolean;
}

export interface SfxGateState {
  lastPlayedAtMs: Partial<Record<string, number>>;
  activeCount: Partial<Record<string, number>>;
  combo: { count: number; lastAtMs: number };
  /** LOCKED before first-gesture unlock: requests are dropped, never queued (§11.6). */
  unlocked: boolean;
}

export const INITIAL_SFX_GATE: SfxGateState = {
  lastPlayedAtMs: {},
  activeCount: {},
  combo: { count: 0, lastAtMs: 0 },
  unlocked: false,
};

export interface SfxDecision {
  play: boolean;
  /** Playback rate factor: combo semitones (2^(n/12)) × jitter; 1 when not playing. */
  rate: number;
  state: SfxGateState;
}

/**
 * Pure throttle/combo gate (testable without audio): applies the §11.5 trio
 * (50ms same-key dedupe → concurrency cap 3 → ±4% jitter via caller-drawn `jitterDraw`
 * in [0,1)) and the §6.4 combo ladder for comboEligible requests.
 */
export function gateSfx(state: SfxGateState, req: SfxRequest, jitterDraw: number): SfxDecision {
  // LOCKED: drop, never queue (§11.6). State untouched so unlock starts clean.
  if (!state.unlocked) return { play: false, rate: 1, state };

  // 1. Same-key 50ms dedupe (M1 limiter, kept verbatim).
  const last = state.lastPlayedAtMs[req.key];
  if (last !== undefined && req.atMs - last < SFX_POLICY.DEDUPE_MS) {
    return { play: false, rate: 1, state };
  }

  // 2. Concurrency cap 3 per key (shell releases via releaseSfx on complete).
  if ((state.activeCount[req.key] ?? 0) >= SFX_POLICY.MAX_CONCURRENT) {
    return { play: false, rate: 1, state };
  }

  // 3. Combo ladder (§6.4): +1 semitone per combo-eligible pickup within 1s, cap +7.
  let combo = state.combo;
  let semitones = 0;
  if (req.comboEligible === true) {
    const chained = combo.count > 0 && req.atMs - combo.lastAtMs <= SFX_POLICY.COMBO_WINDOW_MS;
    const count = chained ? combo.count + 1 : 1;
    semitones = Math.min(count - 1, SFX_POLICY.COMBO_MAX_SEMITONES);
    combo = { count, lastAtMs: req.atMs };
  }

  // 4. ±4% pitch jitter from the caller-drawn uniform sample in [0,1).
  const draw = Math.min(1, Math.max(0, jitterDraw));
  const jitter = 1 + (draw * 2 - 1) * SFX_POLICY.PITCH_JITTER;
  const rate = Math.pow(2, semitones / 12) * jitter;

  return {
    play: true,
    rate,
    state: {
      ...state,
      lastPlayedAtMs: { ...state.lastPlayedAtMs, [req.key]: req.atMs },
      activeCount: { ...state.activeCount, [req.key]: (state.activeCount[req.key] ?? 0) + 1 },
      combo,
    },
  };
}

/** Shell hook: a playing instance finished — free one concurrency slot for `key`. */
export function releaseSfx(state: SfxGateState, key: string): SfxGateState {
  const current = state.activeCount[key] ?? 0;
  if (current <= 0) return state;
  return { ...state, activeCount: { ...state.activeCount, [key]: current - 1 } };
}

/** Shell hook: first-gesture unlock landed (or failed back to locked). */
export function setSfxUnlocked(state: SfxGateState, unlocked: boolean): SfxGateState {
  if (state.unlocked === unlocked) return state;
  return { ...state, unlocked };
}
