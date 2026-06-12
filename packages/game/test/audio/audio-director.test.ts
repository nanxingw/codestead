/**
 * AudioDirector pure-reducer tests (PRD 04 testing decisions: replay event
 * sequences, assert command sequences — never touch a real AudioContext).
 */
import { describe, expect, it } from 'vitest';

import {
  AMBIENCE_FADE,
  BGM_FADE,
  INITIAL_AUDIO_STATE,
  INITIAL_SFX_GATE,
  SFX_POLICY,
  dayTrackFor,
  gateSfx,
  reduceAudio,
  releaseSfx,
  setSfxUnlocked,
  type AudioCommand,
  type AudioDirectorState,
  type AudioInputEvent,
  type SfxGateState,
  type SfxRequest,
} from '../../src/audio/audio-director';

/** Replay helper: fold a sequence, returning the final state + full command log. */
function replay(
  events: AudioInputEvent[],
  from: AudioDirectorState = INITIAL_AUDIO_STATE,
): { state: AudioDirectorState; log: AudioCommand[] } {
  let state = from;
  const log: AudioCommand[] = [];
  for (const event of events) {
    const result = reduceAudio(state, event);
    state = result.state;
    log.push(...result.commands);
  }
  return { state, log };
}

describe('reduceAudio — five-state BGM machine (GDD §11.6)', () => {
  it('unlock on an odd sunny day enters DAY_CALM with track A', () => {
    const { state, log } = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
    ]);
    expect(state.phase).toBe('DAY_CALM');
    expect(log).toEqual([
      { cmd: 'playBgm', track: 'bgm_day_a', fadeInMs: BGM_FADE.RESUME_FADE_IN_MS, loop: true },
    ]);
  });

  it('LOCKED drops everything: no commands before AudioUnlocked', () => {
    const { state, log } = replay([
      { type: 'DayStarted', day: 1, weather: 'rain' },
      { type: 'DayEnded' },
      { type: 'WeatherChanged', weather: 'sunny' },
      { type: 'SimPaused' },
      { type: 'SimResumed' },
    ]);
    expect(log).toEqual([]);
    expect(state.unlocked).toBe(false);
  });

  it('odd/even day parity alternates A and B through the summary cycle', () => {
    expect(dayTrackFor(1)).toBe('bgm_day_a');
    expect(dayTrackFor(2)).toBe('bgm_day_b');
    const { log } = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
      { type: 'DayEnded' },
      { type: 'DayStarted', day: 2, weather: 'sunny' },
      { type: 'DayEnded' },
      { type: 'DayStarted', day: 3, weather: 'sunny' },
    ]);
    const plays = log.filter((c) => c.cmd === 'playBgm');
    expect(plays.map((c) => c.track)).toEqual(['bgm_day_a', 'bgm_day_b', 'bgm_day_a']);
  });

  it('DayEnded: fade out 800ms → jingle_day_end once → silence (SUMMARY)', () => {
    const { state, log } = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
      { type: 'DayEnded' },
    ]);
    expect(state.phase).toBe('SUMMARY');
    expect(log.slice(1)).toEqual([
      { cmd: 'stopBgm', fadeOutMs: BGM_FADE.SUMMARY_FADE_OUT_MS },
      { cmd: 'playJingleOnce', key: 'jingle_day_end' },
    ]);
    // Double DayEnded never replays the jingle.
    const again = reduceAudio(state, { type: 'DayEnded' });
    expect(again.commands).toEqual([]);
  });

  it('closing the summary (DayStarted) fades the day track back in at 600ms', () => {
    const summary = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
      { type: 'DayEnded' },
    ]).state;
    const { state, log } = replay([{ type: 'DayStarted', day: 2, weather: 'sunny' }], summary);
    expect(state.phase).toBe('DAY_CALM');
    expect(log).toEqual([
      { cmd: 'playBgm', track: 'bgm_day_b', fadeInMs: BGM_FADE.RESUME_FADE_IN_MS, loop: true },
    ]);
  });

  it('rain in/out crossfades (800/600) and toggles the ambience bus (1.5s)', () => {
    const playing = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
    ]).state;
    const rainOn = reduceAudio(playing, { type: 'WeatherChanged', weather: 'rain' });
    expect(rainOn.state.phase).toBe('RAIN_DAY');
    expect(rainOn.commands).toEqual([
      { cmd: 'setRainAmbience', on: true, fadeMs: AMBIENCE_FADE.RAIN_IN_MS },
      {
        cmd: 'crossfadeBgm',
        track: 'bgm_rain_day',
        fadeOutMs: BGM_FADE.CROSSFADE_OUT_MS,
        fadeInMs: BGM_FADE.CROSSFADE_IN_MS,
      },
    ]);
    const rainOff = reduceAudio(rainOn.state, { type: 'WeatherChanged', weather: 'sunny' });
    expect(rainOff.state.phase).toBe('DAY_CALM');
    expect(rainOff.commands).toEqual([
      { cmd: 'setRainAmbience', on: false, fadeMs: AMBIENCE_FADE.RAIN_OUT_MS },
      {
        cmd: 'crossfadeBgm',
        track: 'bgm_day_a',
        fadeOutMs: BGM_FADE.CROSSFADE_OUT_MS,
        fadeInMs: BGM_FADE.CROSSFADE_IN_MS,
      },
    ]);
  });

  it('unlocking during rain starts the rain track and the ambience bus', () => {
    const { state, log } = replay([
      { type: 'DayStarted', day: 2, weather: 'rain' },
      { type: 'AudioUnlocked' },
    ]);
    expect(state.phase).toBe('RAIN_DAY');
    expect(log).toEqual([
      { cmd: 'setRainAmbience', on: true, fadeMs: AMBIENCE_FADE.RAIN_IN_MS },
      { cmd: 'playBgm', track: 'bgm_rain_day', fadeInMs: BGM_FADE.RESUME_FADE_IN_MS, loop: true },
    ]);
  });

  it('SimPaused suspends, SimResumed restores the pre-pause phase without restart', () => {
    const playing = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
    ]).state;
    const paused = reduceAudio(playing, { type: 'SimPaused' });
    expect(paused.state.phase).toBe('SUSPENDED');
    expect(paused.state.suspendedFrom).toBe('DAY_CALM');
    expect(paused.commands).toEqual([{ cmd: 'suspendContext' }]);
    const resumed = reduceAudio(paused.state, { type: 'SimResumed' });
    expect(resumed.state.phase).toBe('DAY_CALM');
    expect(resumed.state.suspendedFrom).toBeNull();
    // No playBgm / no jingle backlog — resume only (§11.6 不重播不积压).
    expect(resumed.commands).toEqual([{ cmd: 'resumeContext' }]);
  });

  it('suspend/resume across a music-setting flip lands in the right phase', () => {
    const playing = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
    ]).state;
    const { state, log } = replay(
      [
        { type: 'SimPaused' },
        { type: 'MusicSettingChanged', enabled: false },
        { type: 'SimResumed' },
      ],
      playing,
    );
    expect(state.phase).toBe('SILENT');
    expect(log).toEqual([
      { cmd: 'suspendContext' },
      { cmd: 'stopBgm', fadeOutMs: BGM_FADE.SUMMARY_FADE_OUT_MS },
      { cmd: 'resumeContext' },
    ]);
  });

  it('music off stops BGM; music back on resumes the correct day phase', () => {
    const playing = replay([
      { type: 'DayStarted', day: 2, weather: 'rain' },
      { type: 'AudioUnlocked' },
    ]).state;
    const off = reduceAudio(playing, { type: 'MusicSettingChanged', enabled: false });
    expect(off.state.phase).toBe('SILENT');
    expect(off.commands).toEqual([{ cmd: 'stopBgm', fadeOutMs: BGM_FADE.SUMMARY_FADE_OUT_MS }]);
    const on = reduceAudio(off.state, { type: 'MusicSettingChanged', enabled: true });
    expect(on.state.phase).toBe('RAIN_DAY');
    expect(on.commands).toEqual([
      { cmd: 'playBgm', track: 'bgm_rain_day', fadeInMs: BGM_FADE.RESUME_FADE_IN_MS, loop: true },
    ]);
  });

  it('music disabled at unlock time stays SILENT (no BGM commands)', () => {
    const { state, log } = replay([
      { type: 'MusicSettingChanged', enabled: false },
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
      { type: 'DayEnded' },
      { type: 'DayStarted', day: 2, weather: 'sunny' },
    ]);
    expect(state.phase).toBe('SILENT');
    // The day-end jingle still plays (it is a jingle, not BGM); zero playBgm.
    expect(log.filter((c) => c.cmd === 'playBgm')).toEqual([]);
    expect(log).toContainEqual({ cmd: 'playJingleOnce', key: 'jingle_day_end' });
  });

  it('unlock failure degrades to global mute, stays locked, no error UI', () => {
    const result = reduceAudio(INITIAL_AUDIO_STATE, { type: 'AudioUnlockFailed' });
    expect(result.commands).toEqual([{ cmd: 'muteAll' }]);
    expect(result.state.unlocked).toBe(false);
  });

  it('weather repeat (sunny→sunny) is a no-op', () => {
    const playing = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
    ]).state;
    const result = reduceAudio(playing, { type: 'WeatherChanged', weather: 'sunny' });
    expect(result.commands).toEqual([]);
    expect(result.state).toEqual(playing);
  });

  it('overnight weather change surfaces as an ambience command on DayStarted', () => {
    const summary = replay([
      { type: 'DayStarted', day: 1, weather: 'sunny' },
      { type: 'AudioUnlocked' },
      { type: 'DayEnded' },
    ]).state;
    const { log } = replay([{ type: 'DayStarted', day: 2, weather: 'rain' }], summary);
    expect(log).toEqual([
      { cmd: 'setRainAmbience', on: true, fadeMs: AMBIENCE_FADE.RAIN_IN_MS },
      { cmd: 'playBgm', track: 'bgm_rain_day', fadeInMs: BGM_FADE.RESUME_FADE_IN_MS, loop: true },
    ]);
  });
});

describe('gateSfx — anti-machine-gun trio + combo ladder (§11.5/§6.4)', () => {
  const unlocked: SfxGateState = setSfxUnlocked(INITIAL_SFX_GATE, true);
  const req = (
    atMs: number,
    key: SfxRequest['key'] = 'hoe_till',
    comboEligible = false,
  ): SfxRequest => ({ key, channel: 'sfx', atMs, comboEligible });

  it('LOCKED drops requests without queueing or mutating state', () => {
    const d = gateSfx(INITIAL_SFX_GATE, { key: 'hoe_till', channel: 'sfx', atMs: 100 }, 0.5);
    expect(d.play).toBe(false);
    expect(d.rate).toBe(1);
    expect(d.state).toBe(INITIAL_SFX_GATE);
  });

  it('same-key 50ms dedupe window drops the rapid repeat', () => {
    const a = gateSfx(unlocked, req(1000), 0.5);
    expect(a.play).toBe(true);
    const b = gateSfx(a.state, req(1049), 0.5);
    expect(b.play).toBe(false);
    const c = gateSfx(a.state, req(1050), 0.5);
    expect(c.play).toBe(true);
  });

  it('different keys do not dedupe each other', () => {
    const a = gateSfx(unlocked, req(1000, 'hoe_till'), 0.5);
    const b = gateSfx(a.state, req(1010, 'seed_plant'), 0.5);
    expect(b.play).toBe(true);
  });

  it('concurrency cap 3 per key; releaseSfx frees a slot', () => {
    let state = unlocked;
    for (const at of [0, 100, 200]) {
      const d = gateSfx(state, req(at), 0.5);
      expect(d.play).toBe(true);
      state = d.state;
    }
    expect(gateSfx(state, req(300), 0.5).play).toBe(false);
    state = releaseSfx(state, 'hoe_till');
    expect(gateSfx(state, req(300), 0.5).play).toBe(true);
  });

  it('releaseSfx never goes below zero', () => {
    expect(releaseSfx(unlocked, 'never_played')).toBe(unlocked);
  });

  it('jitter spans ±4%: draw 0 → 0.96, draw 0.5 → 1, draw→1 → ~1.04', () => {
    expect(gateSfx(unlocked, req(0), 0).rate).toBeCloseTo(1 - SFX_POLICY.PITCH_JITTER, 10);
    expect(gateSfx(unlocked, req(0), 0.5).rate).toBeCloseTo(1, 10);
    expect(gateSfx(unlocked, req(0), 0.999999).rate).toBeCloseTo(1 + SFX_POLICY.PITCH_JITTER, 4);
  });

  it('combo ladder: +1 semitone per chained pickup inside 1s, capped at +7', () => {
    let state = unlocked;
    const rates: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = gateSfx(
        state,
        { key: 'item_get', channel: 'sfx', atMs: i * 100, comboEligible: true },
        0.5,
      );
      expect(d.play).toBe(true);
      rates.push(d.rate);
      state = releaseSfx(d.state, 'item_get'); // keep concurrency out of the picture
    }
    const semis = rates.map((r) => Math.round(12 * Math.log2(r)));
    expect(semis).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]);
  });

  it('combo resets after the 1s window lapses', () => {
    const a = gateSfx(
      unlocked,
      { key: 'item_get', channel: 'sfx', atMs: 0, comboEligible: true },
      0.5,
    );
    const b = gateSfx(
      a.state,
      { key: 'item_get', channel: 'sfx', atMs: 500, comboEligible: true },
      0.5,
    );
    expect(Math.round(12 * Math.log2(b.rate))).toBe(1);
    const c = gateSfx(
      b.state,
      { key: 'item_get', channel: 'sfx', atMs: 1700, comboEligible: true },
      0.5,
    );
    expect(Math.round(12 * Math.log2(c.rate))).toBe(0);
  });

  it('non-combo keys do not advance or reset the combo chain', () => {
    const a = gateSfx(
      unlocked,
      { key: 'item_get', channel: 'sfx', atMs: 0, comboEligible: true },
      0.5,
    );
    const mid = gateSfx(a.state, req(100, 'hoe_till'), 0.5);
    const b = gateSfx(
      mid.state,
      { key: 'item_get', channel: 'sfx', atMs: 200, comboEligible: true },
      0.5,
    );
    expect(Math.round(12 * Math.log2(b.rate))).toBe(1);
  });
});
