/**
 * tiles.ts contract tests — sparse keys, tilled-cap brackets, T1 till conditions,
 * zone unlock scheduling (GDD §1.4 / §3.1 / §3.3 T1). Gated on the TODO(M1) skeletons.
 */
import { describe, expect, it } from 'vitest';

import {
  canTill,
  getTile,
  nextCapLevel,
  parseTileKey,
  pendingZoneUnlocks,
  tileKey,
  tillBlockedByCap,
  tilledCapForLevel,
  tilledCount,
} from '../tiles.js';
import type { TileState } from '../types.js';
import { TEST_MAP, makeWorldState, moduleReady, xpForLevel } from './fixtures.js';

const KEY_READY = moduleReady(() => parseTileKey(tileKey({ x: 1, y: 2 })));
const CAP_READY = moduleReady(() => tilledCapForLevel(1));
const TILL_READY = moduleReady(() => canTill(makeWorldState(), TEST_MAP, { x: 22, y: 14 }));
const UNLOCK_READY = moduleReady(() => pendingZoneUnlocks(makeWorldState(), TEST_MAP));

const tilled = (crop: TileState['crop'] = null): TileState => ({
  tilled: true,
  wateredToday: false,
  crop,
});

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(KEY_READY).toBe(true);
  expect(CAP_READY).toBe(true);
  expect(TILL_READY).toBe(true);
  expect(UNLOCK_READY).toBe(true);
});

describe('sparse tile keys (GDD §3.1/§10.2: "x,y")', () => {
  it('tileKey emits the canonical "x,y" form and roundtrips through parseTileKey', () => {
    expect(tileKey({ x: 22, y: 14 })).toBe('22,14');
    expect(tileKey({ x: 0, y: 0 })).toBe('0,0');
    expect(parseTileKey('63,47')).toEqual({ x: 63, y: 47 });
    expect(parseTileKey(tileKey({ x: 5, y: 9 }))).toEqual({ x: 5, y: 9 });
  });

  it('parseTileKey rejects out-of-bounds and malformed keys (map is 64×48)', () => {
    for (const bad of ['64,0', '0,48', '-1,3', 'a,b', '1;2', '1,2,3', '']) {
      expect(() => parseTileKey(bad), bad).toThrow();
    }
  });

  it('getTile / tilledCount read the sparse table', () => {
    const state = makeWorldState({
      farm: { tiles: { '22,14': tilled(), '23,14': tilled() }, unlockedZones: ['field_a'] },
    });
    expect(getTile(state, { x: 22, y: 14 })).toEqual(tilled());
    expect(getTile(state, { x: 25, y: 14 })).toBeNull();
    expect(tilledCount(state)).toBe(2);
    expect(tilledCount(makeWorldState())).toBe(0);
  });
});

describe('tilled cap brackets (GDD §1.4: intermediate levels inherit)', () => {
  it.each([
    [1, 12],
    [2, 12],
    [3, 18],
    [4, 18],
    [5, 24],
    [6, 24],
    [7, 32],
    [8, 32],
    [9, 42],
    [10, 42],
  ])('level %i → cap %i', (level, cap) => {
    expect(tilledCapForLevel(level)).toBe(cap);
  });
});

describe('canTill — T1 condition chain (GDD §3.3 T1)', () => {
  it('allows a free tile inside the unlocked field A under the cap', () => {
    expect(canTill(makeWorldState(), TEST_MAP, { x: 22, y: 14 })).toBe(true);
  });

  it('rejects tiles outside any tillable rect', () => {
    expect(canTill(makeWorldState(), TEST_MAP, { x: 5, y: 5 })).toBe(false);
    expect(canTill(makeWorldState(), TEST_MAP, { x: 33, y: 10 })).toBe(false); // shipping bin
  });

  it('rejects locked-zone tiles (field B needs Lv3, field C needs Lv5)', () => {
    const state = makeWorldState(); // Lv1, only field_a unlocked
    expect(canTill(state, TEST_MAP, { x: 10, y: 14 })).toBe(false); // field B
    expect(canTill(state, TEST_MAP, { x: 18, y: 23 })).toBe(false); // field C
  });

  it('rejects already-tilled tiles and enforces the global cap (Lv1 = 12)', () => {
    const tiles: Record<string, TileState> = {};
    for (let i = 0; i < 12; i++) tiles[`${22 + (i % 8)},${14 + Math.floor(i / 8)}`] = tilled();
    const state = makeWorldState({ farm: { tiles, unlockedZones: ['field_a'] } });
    expect(canTill(state, TEST_MAP, { x: 22, y: 14 })).toBe(false); // already tilled
    expect(canTill(state, TEST_MAP, { x: 27, y: 16 })).toBe(false); // cap reached
  });
});

describe('cap-reached feedback helpers (GDD §1.4 hint, US36 / backlog A-2)', () => {
  /** Lv1 state with the 12-tile cap fully used inside field A. */
  function atCapState(): ReturnType<typeof makeWorldState> {
    const tiles: Record<string, TileState> = {};
    for (let i = 0; i < 12; i++) tiles[`${22 + (i % 8)},${14 + Math.floor(i / 8)}`] = tilled();
    return makeWorldState({ farm: { tiles, unlockedZones: ['field_a'] } });
  }

  it('tillBlockedByCap fires ONLY when the cap is the single blocking reason', () => {
    const state = atCapState();
    expect(tillBlockedByCap(state, TEST_MAP, { x: 27, y: 16 })).toBe(true); // cap-only
    expect(tillBlockedByCap(state, TEST_MAP, { x: 22, y: 14 })).toBe(false); // already tilled
    expect(tillBlockedByCap(state, TEST_MAP, { x: 5, y: 5 })).toBe(false); // not tillable
    expect(tillBlockedByCap(state, TEST_MAP, { x: 10, y: 14 })).toBe(false); // fenced field B
    expect(tillBlockedByCap(makeWorldState(), TEST_MAP, { x: 22, y: 14 })).toBe(false); // under cap
  });

  it('nextCapLevel names the §1.4 bracket the hint points at (「农场 Lv N 后…」)', () => {
    expect(nextCapLevel(1)).toBe(3); // 12 → 18 @Lv3
    expect(nextCapLevel(2)).toBe(3);
    expect(nextCapLevel(3)).toBe(5); // 18 → 24 @Lv5
    expect(nextCapLevel(5)).toBe(7); // M1 effective max level still names Lv7 (M3)
    expect(nextCapLevel(9)).toBeNull(); // top bracket: no hint target
    expect(nextCapLevel(10)).toBeNull();
  });
});

describe('zone unlocks due at next 6:00 (GDD §1.4)', () => {
  it('reports field_b once effective level reaches 3 and it is not yet unlocked', () => {
    const state = makeWorldState({
      progress: {
        xp: xpForLevel(3),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    expect(pendingZoneUnlocks(state, TEST_MAP)).toEqual(['field_b']);
  });

  it('reports nothing at Lv1 or when all due zones are already unlocked', () => {
    expect(pendingZoneUnlocks(makeWorldState(), TEST_MAP)).toEqual([]);
    const unlocked = makeWorldState({
      farm: { tiles: {}, unlockedZones: ['field_a', 'field_b'] },
      progress: {
        xp: xpForLevel(3),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    expect(pendingZoneUnlocks(unlocked, TEST_MAP)).toEqual([]);
  });

  it('reports both fields for a Lv5 save that never unlocked them', () => {
    const state = makeWorldState({
      progress: {
        xp: xpForLevel(5),
        profession: null,
        counters: {},
        achievements: [],
        xpHistory: [],
      },
    });
    expect([...pendingZoneUnlocks(state, TEST_MAP)].sort()).toEqual(['field_b', 'field_c']);
  });
});
