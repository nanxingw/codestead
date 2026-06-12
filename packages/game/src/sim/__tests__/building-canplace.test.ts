/**
 * canPlace table-driven tests — the six §8.3 placement rules, one positive and one
 * negative case each, plus the PRD 04 boundary cases (door-front reachability, move
 * exempting its own footprint, player/hen occupancy, stone path refusing farmland).
 *
 * Gated on the M3 contract stub (see m3-probe.ts): skipped until sim/building.ts
 * lands, then arms automatically.
 *
 * Geometry comes from the real map contract (farm-map-meta.json): build plots
 * build_coop (42,32 6×4) / build_workshop (50,32 6×4) / build_greenhouse (44,37 8×6)
 * are guaranteed buildable; waterSources tiles (e.g. the well-pond at 21,8) are not.
 */
import { describe, expect, it } from 'vitest';

import { canPlace, type CanPlaceViolation } from '../building.js';
import { getBlueprint } from '../data/buildings.js';
import type { TilePos, WorldState } from '../types.js';
import { makeWorldState, TEST_MAP, xpForLevel } from './fixtures.js';
import { m3Implemented } from './m3-probe.js';

/** A Lv9 state with empty M3 carriers, parked away from the build plots. */
function buildState(overrides: Partial<WorldState> = {}): WorldState {
  return makeWorldState({
    player: { tileX: 27, tileY: 11, facing: 'down' },
    progress: {
      xp: xpForLevel(9),
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
    },
    structures: [],
    sprinklers: [],
    farmhouse: { stage: 0, construction: null },
    clearedResourceNodes: [],
    ...overrides,
  });
}

/**
 * apiDrift (recorded by the building implementer): rule ② (buildable) judges from a
 * map injected through CanPlaceOptions — `{ map }` heuristic or an `isBuildable`
 * callback from the render layer. All calls here inject the real map contract.
 */
const MAP_OPTS = { map: TEST_MAP } as const;

function violationsAt(state: WorldState, defId: string, origin: TilePos): CanPlaceViolation[] {
  const def = getBlueprint(defId);
  return canPlace(state, def, origin, MAP_OPTS).tiles.flatMap((t) => t.violations);
}

const READY = m3Implemented(() =>
  canPlace(buildState(), getBlueprint('storage_chest'), { x: 43, y: 33 }, MAP_OPTS),
);

it.skipIf(READY)('canPlace suite pending — arms when sim/building.ts lands (contract stub)', () => {
  expect(READY).toBe(false);
});

describe.skipIf(!READY)('canPlace — the six §8.3 rules (PRD 04 US6)', () => {
  it('green case: a chest on an empty build-plot tile passes every rule', () => {
    const result = canPlace(
      buildState(),
      getBlueprint('storage_chest'),
      { x: 43, y: 33 },
      MAP_OPTS,
    );
    expect(result.ok).toBe(true);
    for (const report of result.tiles) expect(report.violations).toEqual([]);
  });

  it('① out_of_bounds: a 2×1 rack anchored on the last column overflows the map', () => {
    const v = violationsAt(buildState(), 'drying_rack', { x: 63, y: 20 });
    expect(v).toContain('out_of_bounds');
  });

  it('② not_buildable: water tiles refuse placement', () => {
    const v = violationsAt(buildState(), 'storage_chest', { x: 21, y: 8 }); // pond (§1.2)
    expect(v).toContain('not_buildable');
  });

  it('③ farmland_conflict: a tilled tile refuses placement — stone path included (§8.3)', () => {
    const state = buildState();
    state.farm.tiles['43,33'] = { tilled: true, wateredToday: false, crop: null };
    expect(violationsAt(state, 'storage_chest', { x: 43, y: 33 })).toContain('farmland_conflict');
    expect(violationsAt(state, 'stone_path', { x: 43, y: 33 })).toContain('farmland_conflict');
  });

  it('④ overlap: an existing structure blocks the footprint; relocation exempts ITSELF', () => {
    const state = buildState({
      structures: [
        {
          instanceId: 'chest-1',
          defId: 'storage_chest',
          origin: { x: 51, y: 33 },
          state: 'built',
          data: { kind: 'chest', slots: Array.from({ length: 24 }, () => null) },
        },
      ],
    });
    expect(violationsAt(state, 'storage_chest', { x: 51, y: 33 })).toContain('overlap');
    // moving chest-1 onto (or around) its own tile is exempt from rule ④ (§8.3)
    const moved = canPlace(
      state,
      getBlueprint('storage_chest'),
      { x: 51, y: 33 },
      {
        ...MAP_OPTS,
        movingInstanceId: 'chest-1',
      },
    );
    expect(moved.ok).toBe(true);
  });

  it('⑤ occupant_inside: the player standing in the footprint blocks placement', () => {
    const state = buildState({ player: { tileX: 51, tileY: 33, facing: 'down' } });
    expect(violationsAt(state, 'storage_chest', { x: 51, y: 33 })).toContain('occupant_inside');
  });

  it('⑤ occupant_inside: caller-supplied hen tiles block placement the same way', () => {
    const def = getBlueprint('storage_chest');
    const blocked = canPlace(
      buildState(),
      def,
      { x: 51, y: 33 },
      {
        ...MAP_OPTS,
        henTiles: [{ x: 51, y: 33 }],
      },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.tiles.flatMap((t) => t.violations)).toContain('occupant_inside');
    // a hen elsewhere does not
    const clear = canPlace(
      buildState(),
      def,
      { x: 51, y: 33 },
      {
        ...MAP_OPTS,
        henTiles: [{ x: 60, y: 40 }],
      },
    );
    expect(clear.ok).toBe(true);
  });

  it('⑥ door_unreachable: a blocked door-front tile fails buildings (and only buildings)', () => {
    // coop at (42,32): doorOffset (1,2) ⇒ door (43,34), front tile (43,35).
    const state = buildState({
      structures: [
        {
          instanceId: 'blocker',
          defId: 'storage_chest',
          origin: { x: 43, y: 35 },
          state: 'built',
          data: { kind: 'chest', slots: Array.from({ length: 24 }, () => null) },
        },
      ],
    });
    const blocked = canPlace(state, getBlueprint('coop'), { x: 42, y: 32 }, MAP_OPTS);
    expect(blocked.ok).toBe(false);
    expect(blocked.tiles.flatMap((t) => t.violations)).toContain('door_unreachable');
    // with the blocker gone the same placement is green
    expect(canPlace(buildState(), getBlueprint('coop'), { x: 42, y: 32 }, MAP_OPTS).ok).toBe(true);
  });

  it('reports violations PER TILE (red tiles name their rules — hover text, US6)', () => {
    // Rack half-overlapping a tilled tile: one report red, the other green.
    const state = buildState();
    state.farm.tiles['52,33'] = { tilled: true, wateredToday: false, crop: null };
    const result = canPlace(state, getBlueprint('drying_rack'), { x: 51, y: 33 }, MAP_OPTS);
    expect(result.ok).toBe(false);
    const red = result.tiles.filter((t) => t.violations.length > 0);
    const green = result.tiles.filter((t) => t.violations.length === 0);
    expect(red.length).toBeGreaterThanOrEqual(1);
    expect(green.length).toBeGreaterThanOrEqual(1);
    expect(red.some((t) => t.tile.x === 52 && t.tile.y === 33)).toBe(true);
  });
});
