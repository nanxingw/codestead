/**
 * AudioDirector replay invariants — the cross-cutting properties of the pure reducer
 * over LONG event diaries (GDD §11.6; PRD 04 "AudioDirector 纯 reducer 测试").
 * Per-transition behaviour is pinned in audio-director.test.ts; this file replays
 * multi-day scripts and asserts the laws that must hold over ANY sequence:
 *
 *   - purity: reduceAudio never mutates its input state;
 *   - determinism: the same diary always produces the same command log;
 *   - "locked drops everything": zero commands before AudioUnlocked;
 *   - one jingle per DayEnded, never more (§11.6 "仅一次");
 *   - 感知不干预: the input vocabulary is sim/shell lifecycle ONLY — session-HUD
 *     states (working/blocked/done/idle) cannot reach the BGM machine even by type,
 *     so "blocked 不改 BGM" holds by construction (compile-time proof below).
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_AUDIO_STATE,
  reduceAudio,
  type AudioCommand,
  type AudioDirectorState,
  type AudioInputEvent,
} from '../../src/audio/audio-director';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function replay(events: AudioInputEvent[]): {
  state: AudioDirectorState;
  log: AudioCommand[];
} {
  let state = INITIAL_AUDIO_STATE;
  const log: AudioCommand[] = [];
  for (const event of events) {
    const result = reduceAudio(deepFreeze(structuredClone(state)), deepFreeze(event));
    state = result.state;
    log.push(...result.commands);
  }
  return { state, log };
}

/** A 7-day diary: unlock mid-day-1, rain on day 3, a pause on day 5, setting flip. */
function weekDiary(): AudioInputEvent[] {
  const diary: AudioInputEvent[] = [
    { type: 'DayStarted', day: 1, weather: 'sunny' },
    { type: 'AudioUnlocked' },
  ];
  for (let day = 1; day <= 7; day++) {
    if (day > 1) diary.push({ type: 'DayStarted', day, weather: day === 3 ? 'rain' : 'sunny' });
    if (day === 3) diary.push({ type: 'WeatherChanged', weather: 'rain' });
    if (day === 4) diary.push({ type: 'WeatherChanged', weather: 'sunny' });
    if (day === 5) diary.push({ type: 'SimPaused' }, { type: 'SimResumed' });
    if (day === 6) {
      diary.push(
        { type: 'MusicSettingChanged', enabled: false },
        { type: 'MusicSettingChanged', enabled: true },
      );
    }
    diary.push({ type: 'DayEnded' });
  }
  return diary;
}

describe('reduceAudio replay laws (GDD §11.6)', () => {
  it('is pure: deep-frozen inputs replay the whole week without a single mutation', () => {
    expect(() => replay(weekDiary())).not.toThrow();
  });

  it('is deterministic: the same diary yields byte-identical states and command logs', () => {
    const a = replay(weekDiary());
    const b = replay(weekDiary());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.log.length).toBeGreaterThan(0);
  });

  it('locked drops EVERYTHING: a full week before unlock emits zero commands', () => {
    const noUnlock = weekDiary().filter((e) => e.type !== 'AudioUnlocked');
    const { state, log } = replay(noUnlock);
    expect(log).toEqual([]);
    expect(state.unlocked).toBe(false);
    expect(state.phase).toBe('SILENT');
  });

  it('exactly one jingle_day_end per DayEnded — never queued, never doubled', () => {
    const diary = weekDiary();
    const dayEnds = diary.filter((e) => e.type === 'DayEnded').length;
    const { log } = replay(diary);
    expect(log.filter((c) => c.cmd === 'playJingleOnce')).toHaveLength(dayEnds);
  });

  it('a paused week resumes from the pause point — suspend/resume come in pairs', () => {
    const { log } = replay(weekDiary());
    const suspends = log.filter((c) => c.cmd === 'suspendContext').length;
    const resumes = log.filter((c) => c.cmd === 'resumeContext').length;
    expect(suspends).toBe(1);
    expect(resumes).toBe(1);
  });
});

describe('感知不干预 — session states can never touch the BGM (PRD 04 hard rule)', () => {
  it('the input vocabulary is exactly the 8 sim/shell lifecycle events', () => {
    // Compile-time exhaustive in BOTH directions: adding a session/HUD input to
    // AudioInputEvent (e.g. 'SessionBlocked') breaks this Record's type, and so does
    // removing a lifecycle event. "blocked 不改 BGM" is thereby a structural fact.
    const vocabulary: Record<AudioInputEvent['type'], true> = {
      DayStarted: true,
      DayEnded: true,
      WeatherChanged: true,
      SimPaused: true,
      SimResumed: true,
      AudioUnlocked: true,
      AudioUnlockFailed: true,
      MusicSettingChanged: true,
    };
    expect(Object.keys(vocabulary)).toHaveLength(8);
  });
});
