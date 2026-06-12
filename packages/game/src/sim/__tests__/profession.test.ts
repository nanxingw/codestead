/**
 * profession.ts behavior tests (GDD §5.3; PRD 04 §F36~39; ruling A-13).
 *
 * Covers: the certificate-desk gate (Lv5 floor, irreversibility), the pure
 * chooseProfession reducer + ProfessionChosen event, the immediate §4.5 pricing
 * effect through the single unitSalePrice entry, the retro level-up catch-up for
 * old saves (canonical fixture xp=2,400 ⇒ [Lv6], §5.5 acceptance), and the
 * one-shot US39 settlement hint flag.
 */
import { describe, expect, it } from 'vitest';

import { checkAchievements } from '../achievements.js';
import { XP_CAP, XP_THRESHOLDS } from '../data/constants.js';
import { settleShipping } from '../economy.js';
import {
  canChooseProfession,
  chooseProfession,
  LEVEL_CAP_M3,
  markProfessionHintShownInPlace,
  PROFESSION_MIN_LEVEL,
  professionHintPending,
  retroLevelUpEvents,
} from '../profession.js';
import type { SimEvent, WorldState } from '../types.js';
import { deepFreeze, makeWorldState, xpForLevel } from './fixtures.js';

function stateAtLevel(level: number, extra: Partial<WorldState> = {}): WorldState {
  return makeWorldState({
    progress: {
      xp: xpForLevel(level),
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    ...extra,
  });
}

function levelUps(events: SimEvent[]): { level: number; tilledCap: number }[] {
  return events.flatMap((e) =>
    e.type === 'FarmLevelUp' ? [{ level: e.level, tilledCap: e.tilledCap }] : [],
  );
}

describe('certificate-desk gate (§5.3: Lv5 floor, active choice, irreversible)', () => {
  it('constants pin the §5.1/§5.3 values', () => {
    expect(LEVEL_CAP_M3).toBe(10);
    expect(PROFESSION_MIN_LEVEL).toBe(5);
  });

  it('below Lv5 the desk refuses with LEVEL_TOO_LOW', () => {
    const result = canChooseProfession(stateAtLevel(4));
    expect(result).toEqual({ allowed: false, current: null, reason: 'LEVEL_TOO_LOW' });
    const attempt = chooseProfession(stateAtLevel(4), 'horticulturist');
    expect(attempt).toEqual({ ok: false, error: 'LEVEL_TOO_LOW' });
  });

  it('at exactly Lv5 (xp 1,300) the choice opens', () => {
    expect(canChooseProfession(stateAtLevel(5))).toEqual({ allowed: true, current: null });
  });

  it('staying unchosen never blocks anything — the desk stays open at Lv10 (§5.3)', () => {
    expect(canChooseProfession(stateAtLevel(10)).allowed).toBe(true);
  });

  it('choosing commits the profession, emits ProfessionChosen, and is pure', () => {
    const start = deepFreeze(stateAtLevel(5));
    const result = chooseProfession(start, 'artisan');
    if (!result.ok) throw new Error('expected ok');
    expect(result.state.progress.profession).toBe('artisan');
    expect(result.events).toEqual([{ type: 'ProfessionChosen', profession: 'artisan' }]);
    expect(start.progress.profession).toBeNull(); // input untouched (pure contract)
  });

  it('the choice is irreversible: a second signature is impossible (§5.3)', () => {
    const first = chooseProfession(stateAtLevel(5), 'horticulturist');
    if (!first.ok) throw new Error('expected ok');
    expect(canChooseProfession(first.state)).toEqual({
      allowed: false,
      current: 'horticulturist',
      reason: 'ALREADY_CHOSEN',
    });
    const second = chooseProfession(first.state, 'artisan');
    expect(second).toEqual({ ok: false, error: 'ALREADY_CHOSEN' });
    expect(first.state.progress.profession).toBe('horticulturist'); // unchanged
  });

  it('#18 signed_papers rides the REGULAR sweep after choosing (0 XP, §5.6)', () => {
    const chosen = chooseProfession(stateAtLevel(5), 'horticulturist');
    if (!chosen.ok) throw new Error('expected ok');
    const sweep = checkAchievements(chosen.state);
    expect(sweep.state.progress.achievements).toContain('signed_papers');
    expect(sweep.state.progress.xp).toBe(chosen.state.progress.xp); // commemorative
  });
});

describe('profession multiplier reaches the wallet via unitSalePrice only (§4.5)', () => {
  it('horticulturist boosts the NEXT settlement: turnip 38 → floor(38×1.1) = 41', () => {
    const base = stateAtLevel(5, {
      economy: {
        gold: 0,
        shippingBin: [{ itemId: 'crop_turnip', count: 1 }],
        collectionLog: {},
        newEntriesSeenDay: {},
      },
    });
    const unchosen = settleShipping(base);
    expect(unchosen.state.economy.gold).toBe(38);

    const chosen = chooseProfession(base, 'horticulturist');
    if (!chosen.ok) throw new Error('expected ok');
    const settled = settleShipping(chosen.state);
    expect(settled.state.economy.gold).toBe(41); // immediate, no grandfathering
  });
});

describe('retroLevelUpEvents — M1 save catch-up at load (§5.3/§5.5; PRD 04 US37)', () => {
  it('canonical acceptance fixture: xp=2,400 from the old Lv5 cap ⇒ exactly [Lv6]', () => {
    expect(retroLevelUpEvents(2_400, 5)).toEqual([
      { type: 'FarmLevelUp', level: 6, tilledCap: 24 },
    ]);
  });

  it('a maxed M1 save replays Lv6..Lv10 in ascending order with §1.4 caps', () => {
    expect(levelUps(retroLevelUpEvents(XP_CAP, 5))).toEqual([
      { level: 6, tilledCap: 24 },
      { level: 7, tilledCap: 32 },
      { level: 8, tilledCap: 32 },
      { level: 9, tilledCap: 42 },
      { level: 10, tilledCap: 42 },
    ]);
  });

  it('saves at or below the recorded level need no catch-up (empty, never negative)', () => {
    expect(retroLevelUpEvents(xpForLevel(5), 5)).toEqual([]);
    expect(retroLevelUpEvents(0, 1)).toEqual([]);
    expect(retroLevelUpEvents(XP_THRESHOLDS[5] - 1, 5)).toEqual([]); // 2,149 — still Lv5
  });

  it('clamps at LEVEL_CAP_M3 even for out-of-range xp inputs', () => {
    expect(levelUps(retroLevelUpEvents(999_999, 9)).map((u) => u.level)).toEqual([10]);
  });
});

describe('one-shot settlement hint (PRD 04 US39 — once, then silence forever)', () => {
  it('pending exactly while Lv5+ ∧ unchosen ∧ never shown', () => {
    expect(professionHintPending(stateAtLevel(4))).toBe(false); // too early
    expect(professionHintPending(stateAtLevel(5))).toBe(true); // condition first met
  });

  it('marking the hint burns the flag permanently (idempotent)', () => {
    const state = stateAtLevel(5);
    markProfessionHintShownInPlace(state);
    expect(professionHintPending(state)).toBe(false);
    markProfessionHintShownInPlace(state); // no-op repeat
    expect(state.progress.counters.professionHintShown).toBe(1);
  });

  it('an already-chosen profession suppresses the hint even if never marked', () => {
    const chosen = chooseProfession(stateAtLevel(5), 'artisan');
    if (!chosen.ok) throw new Error('expected ok');
    expect(professionHintPending(chosen.state)).toBe(false);
  });
});
