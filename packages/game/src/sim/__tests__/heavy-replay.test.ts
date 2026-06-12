/**
 * Heavy acceptance: deterministic replay ×100 (PRD 02 Testing Decision #4; GDD §3.9
 * 验收要点 "同 seed 同日志 28 天哈希一致 ×100 次" / §2.9 "暂停期序列化状态逐字节相同").
 *
 * Scripted schedule = script R (GDD §4.6): the same executable day plan the economy
 * acceptance replays. Per ruling B-3 script R contains no achievement rewards, so this
 * fingerprint stays decoupled from the achievements engine by construction.
 *
 * Fingerprint = per settled day, the JSON bytes of { day record, serialize() } — a
 * full-run log compared byte-for-byte (strictly stronger than comparing hashes, and
 * the first divergent run/day is reported directly on failure).
 *
 * CI cost (PRD 02 Further Notes): one 28-day scripted run is milliseconds at M1 state
 * size, so the full ×100 fits PR CI. CODESTEAD_REPLAY_RUNS overrides the count
 * (nightly can raise it; a constrained runner can lower it) without changing the
 * acceptance semantics — every executed run must be byte-identical.
 */
import { describe, expect, it } from 'vitest';

import { createSim, newGameSim, type SimOptions } from '../sim.js';
import { TEST_MAP } from './fixtures.js';
import { runScriptR } from './script-r.js';

const DAYS = 28;
const SEED = 'replay-x100';
const DEFAULT_RUNS = 100;

// The game package compiles without node types (browser tsconfig); tests run in node,
// so the env knob is read through a narrowly-typed globalThis view.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const RUNS = Math.max(2, Number(env?.CODESTEAD_REPLAY_RUNS ?? DEFAULT_RUNS) || DEFAULT_RUNS);

/** One full scripted run; returns one byte-exact fingerprint line per settled day. */
function replayFingerprint(seed: string, days: number, options?: SimOptions): string[] {
  const sim = newGameSim(seed, TEST_MAP, options);
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const record = runScriptR(sim, 1)[0];
    if (!record) throw new Error('script R produced no day record');
    lines.push(JSON.stringify({ record, save: sim.serialize() }));
  }
  return lines;
}

describe(`deterministic replay ×${RUNS} (GDD §3.9 / §2.2)`, () => {
  // M3 grew the serialized state (structures/quality/sprinklers), so ×100 full-run
  // fingerprints take seconds, not milliseconds — same acceptance, larger budget.
  it(
    `same seed + same 28-day schedule ⇒ byte-identical full-run log, ${RUNS} times`,
    { timeout: 60_000 },
    () => {
      const baseline = replayFingerprint(SEED, DAYS);
      expect(baseline).toHaveLength(DAYS);

      const divergences: { run: number; firstDivergentDay: number }[] = [];
      for (let run = 2; run <= RUNS; run++) {
        const lines = replayFingerprint(SEED, DAYS);
        const idx = lines.findIndex((line, i) => line !== baseline[i]);
        if (idx !== -1 || lines.length !== baseline.length) {
          divergences.push({ run, firstDivergentDay: idx + 1 }); // minimal repro: seed + day
        }
      }
      expect(divergences).toEqual([]);
    },
  );

  it('the shipped mode (achievements ON) is byte-deterministic too (×10)', () => {
    // The ×100 above runs the default B-3 deduction mode (achievements off — sim.ts
    // SimOptions). The game itself boots with achievements:true, so the ON mode gets
    // its own replay lock: same seed + same schedule + live achievement engine must
    // still be byte-identical (rewards are pure state functions, zero wall clock).
    const options: SimOptions = { achievements: true };
    const baseline = replayFingerprint(SEED, DAYS, options);
    expect(baseline).toHaveLength(DAYS);
    for (let run = 2; run <= 10; run++) {
      const lines = replayFingerprint(SEED, DAYS, options);
      const idx = lines.findIndex((line, i) => line !== baseline[i]);
      expect({ run, firstDivergentDay: idx + 1 }).toEqual({ run, firstDivergentDay: 0 });
    }
  });

  it('achievements ON and OFF share the weather/rng stream until reward XP changes play', () => {
    // B-3 decoupling, restated for the M3 rng model: achievement rewards are a pure XP
    // delta and never touch the night weather roll directly. But M3 quality (§4.5 / PRD 04
    // US43) makes the HARVEST reducer a second consumer of the same serialized sfc32 stream
    // (sim/time rngState) — so once reward XP raises the effective level, script R changes
    // what it plants/harvests, the harvest-draw count diverges, and the shared stream (hence
    // weather) legitimately splits. Before that first gameplay divergence the two modes are
    // byte-identical in BOTH weather AND rngState — proving rewards alone never perturb the
    // stream; only reward-INDUCED gameplay does (script R first crosses a level boundary
    // around D5 for this seed). This supersedes the M1 "weather is the sole rng consumer,
    // so the streams lockstep for all 28 days" assumption (quality.ts header).
    const off = replayFingerprint(SEED, DAYS);
    const on = replayFingerprint(SEED, DAYS, { achievements: true });
    const timeOf = (line: string): { rngState: string; weatherToday: string; xp?: number } => {
      const parsed = JSON.parse(line) as {
        save: { time: { rngState: string; weatherToday: string }; progress: { xp: number } };
      };
      return { ...parsed.save.time, xp: parsed.save.progress.xp };
    };

    // The first day the serialized time block (weather + rngState) splits between the modes.
    const firstDivergentDay = (() => {
      for (let day = 0; day < DAYS; day++) {
        const a = timeOf(on[day]);
        const b = timeOf(off[day]);
        if (a.rngState !== b.rngState || a.weatherToday !== b.weatherToday) return day + 1;
      }
      return -1;
    })();

    // Pre-divergence: both rngState AND weather are byte-identical — rewards alone are inert
    // on the stream. ON already carries MORE xp before the split (rewards are flowing).
    expect(firstDivergentDay).toBeGreaterThan(1);
    for (let day = 0; day < firstDivergentDay - 1; day++) {
      expect(timeOf(on[day]).rngState).toBe(timeOf(off[day]).rngState);
      expect(timeOf(on[day]).weatherToday).toBe(timeOf(off[day]).weatherToday);
    }
    expect(timeOf(on[firstDivergentDay - 2]).xp).toBeGreaterThan(
      timeOf(off[firstDivergentDay - 2]).xp ?? 0,
    );
  });

  it('a save/load seam in the middle of the schedule does not change the bytes', () => {
    // ×100 covers run-to-run identity; this pins the replay seam itself (GDD §2.9):
    // interrupt at D14, restore from the serialized bytes, finish — identical log.
    const straight = replayFingerprint(SEED, DAYS);

    const sim = newGameSim(SEED, TEST_MAP);
    const lines: string[] = [];
    for (let i = 0; i < 14; i++) {
      const record = runScriptR(sim, 1)[0];
      lines.push(JSON.stringify({ record, save: sim.serialize() }));
    }
    const resumed = createSim(sim.serialize(), TEST_MAP);
    for (let i = 14; i < DAYS; i++) {
      const record = runScriptR(resumed, 1)[0];
      lines.push(JSON.stringify({ record, save: resumed.serialize() }));
    }
    expect(lines).toEqual(straight);
  });
});

describe('pause-window serialization (GDD §2.9 暂停期逐字节相同)', () => {
  it('while the driver is paused (no advance), repeated serializes are byte-identical', () => {
    const sim = newGameSim('replay-pause', TEST_MAP);
    runScriptR(sim, 5);
    sim.advanceMinutes(123); // park the clock mid-day, then "pause" = simply stop calling
    const first = JSON.stringify(sim.serialize());
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(sim.serialize())).toBe(first);
    }
  });

  it('serialize() is observation-only: a daily-serializing run ends identical to a twin', () => {
    const observed = newGameSim('replay-observer', TEST_MAP);
    const untouched = newGameSim('replay-observer', TEST_MAP);
    for (let i = 0; i < 10; i++) {
      runScriptR(observed, 1);
      observed.serialize(); // mid-run reads must not perturb the state
      runScriptR(untouched, 1);
    }
    expect(JSON.stringify(observed.serialize())).toBe(JSON.stringify(untouched.serialize()));
  });
});
