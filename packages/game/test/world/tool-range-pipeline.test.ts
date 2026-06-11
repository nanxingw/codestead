/**
 * tool-range-pipeline.test.ts — the M1.5 range-tool input pipeline against the REAL
 * sim (headless): the scene expands copper/gold ranges via expandToolRange, filters
 * by queryAction verb (exactly what WorldScene.hoeRangeTiles / waterRangeTiles do),
 * then dispatches ONE per-tile `interact` command per legal tile. The sim re-validates
 * every tile independently (T transitions + the global tilled cap), per PRD 02
 * acceptance: 范围批量后开垦帽计数正确、达帽后续格被拒；部分非法只作用合法子集；
 * 已湿格 no-op 跳过.
 */
import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/sim/data/items';
import { newGameSim, type SimApi } from '../../src/sim/sim';
import type { TilePos } from '../../src/sim/types';
import { FALLBACK_MAP_META } from '../../src/world/map-meta';
import { expandToolRange, type ToolTier } from '../../src/world/tool-range';

/** Field A of FALLBACK_MAP_META: x 22..29, y 14..19, unlocked from Lv1. */
const FIELD_A = { x: 22, y: 14 };

/** The WorldScene legal-subset filter, verbatim (hoeRangeTiles / waterRangeTiles). */
function legalSubset(sim: SimApi, tiles: TilePos[], itemId: ItemId, verb: string): TilePos[] {
  return tiles.filter((t) => {
    const q = sim.queryAction(t, itemId);
    return q.valid && q.verb === verb;
  });
}

/** The WorldScene batch dispatch: one interact per legal tile, in expansion order. */
function dispatchBatch(sim: SimApi, tiles: TilePos[], itemId: ItemId): void {
  for (const t of tiles) sim.dispatch({ type: 'interact', tile: t, itemId });
}

function tillBatch(sim: SimApi, origin: TilePos, tier: ToolTier, facing: 'right' | 'down'): void {
  const tiles = expandToolRange(origin, facing, tier, FALLBACK_MAP_META);
  dispatchBatch(sim, legalSubset(sim, tiles, 'hoe', 'till'), 'hoe');
}

describe('copper/gold hoe batch through per-tile interact commands', () => {
  it('gold 3×3 tills all 9 tiles and bumps tillCount per tile', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    const center = { x: FIELD_A.x + 1, y: FIELD_A.y + 1 };
    tillBatch(sim, center, 3, 'right');
    expect(Object.keys(sim.state.farm.tiles)).toHaveLength(9);
    expect(sim.state.progress.counters.tillCount).toBe(9);
    expect(sim.tilledStatus()).toEqual({ count: 9, cap: 12 });
  });

  it('partially illegal range acts on the legal subset only (§3.9 #3)', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    // Origin on the field edge: a 3×3 centered here pokes outside the tillable rect.
    tillBatch(sim, { x: FIELD_A.x, y: FIELD_A.y }, 3, 'right');
    // Only the 4 in-rect tiles (22..23 × 14..15) till; the rest are skipped.
    expect(Object.keys(sim.state.farm.tiles).sort()).toEqual(
      ['22,14', '22,15', '23,14', '23,15'].sort(),
    );
  });

  it('filling the Lv1 cap (12) mid-batch rejects the remaining tiles', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    tillBatch(sim, { x: FIELD_A.x + 1, y: FIELD_A.y + 1 }, 3, 'right'); // 9 tilled
    tillBatch(sim, { x: FIELD_A.x + 4, y: FIELD_A.y }, 2, 'down'); // 12 tilled — at cap
    expect(sim.tilledStatus().count).toBe(12);
    // Next copper line: every tile is rejected by canTill's cap check.
    tillBatch(sim, { x: FIELD_A.x + 5, y: FIELD_A.y }, 2, 'down');
    expect(sim.tilledStatus().count).toBe(12);
    expect(sim.state.progress.counters.tillCount).toBe(12);
  });

  it('already-tilled tiles drop out of the legal subset (no double-till)', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    const origin = { x: FIELD_A.x, y: FIELD_A.y };
    tillBatch(sim, origin, 2, 'right'); // 3 tilled
    const again = legalSubset(
      sim,
      expandToolRange(origin, 'right', 2, FALLBACK_MAP_META),
      'hoe',
      'till',
    );
    expect(again).toHaveLength(0);
    expect(sim.state.progress.counters.tillCount).toBe(3);
  });
});

describe('copper/gold can beat through per-tile interact commands', () => {
  it('copper line waters the dry tilled subset; wet/non-tilled tiles no-op out', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    const origin = { x: FIELD_A.x, y: FIELD_A.y };
    tillBatch(sim, origin, 2, 'right'); // 22,14 / 23,14 / 24,14 tilled & dry
    sim.dispatch({ type: 'interact', tile: origin, itemId: 'watering_can' }); // wet the first

    const range = expandToolRange(origin, 'right', 2, FALLBACK_MAP_META);
    const wet = legalSubset(sim, range, 'watering_can', 'water');
    expect(wet).toEqual([
      { x: 23, y: 14 },
      { x: 24, y: 14 },
    ]); // wet origin skipped, dry extension kept
    dispatchBatch(sim, wet, 'watering_can');
    expect(sim.state.farm.tiles['22,14'].wateredToday).toBe(true);
    expect(sim.state.farm.tiles['23,14'].wateredToday).toBe(true);
    expect(sim.state.farm.tiles['24,14'].wateredToday).toBe(true);
    expect(sim.state.progress.counters.waterCount).toBe(3); // 1 tap + 2 from the beat
  });

  it('a fully wet/untilled range has an empty legal subset (beat skips, no swing)', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    const range = expandToolRange({ x: FIELD_A.x, y: FIELD_A.y }, 'right', 3);
    expect(legalSubset(sim, range, 'watering_can', 'water')).toHaveLength(0);
  });

  it('gold 3×3 single beat waters at most 9 tiles (§3.9 acceptance)', () => {
    const sim = newGameSim('range-test', FALLBACK_MAP_META);
    const center = { x: FIELD_A.x + 1, y: FIELD_A.y + 1 };
    tillBatch(sim, center, 3, 'right');
    const wet = legalSubset(
      sim,
      expandToolRange(center, 'right', 3, FALLBACK_MAP_META),
      'watering_can',
      'water',
    );
    expect(wet.length).toBe(9);
    dispatchBatch(sim, wet, 'watering_can');
    expect(Object.values(sim.state.farm.tiles).every((t) => t.wateredToday)).toBe(true);
  });
});
