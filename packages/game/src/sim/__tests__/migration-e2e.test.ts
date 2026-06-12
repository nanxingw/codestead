/**
 * End-to-end v1 → v2 migration over REAL saves (PRD 04 §M; GDD §10.6) — the game-side
 * complement of shared/test/save-v1-fixtures.test.ts. Instead of frozen JSON, this
 * suite produces v1 documents through the live pipeline (sim run → SimApi.serialize()
 * → storage composeSaveDoc) and pushes them through the shared chain driver, pinning:
 *
 *   1. every save the M1 game can actually write migrates ok with zero field loss;
 *   2. the B-2 zone derivation in shared/ is EQUIVALENT to the sim's own hydrate
 *      fallback — the migrated unlockedZones equal the live runtime set;
 *   3. the §5.5 canonical xp=2,400 document derives the full zone set (Lv6 band);
 *   4. the migrated document hydrates back into a runnable sim (v2 ⊇ v1 carrier).
 */
import {
  migrateSaveDoc,
  SaveDocV2Schema,
  type RestorableSaveDoc,
  type SaveDoc,
  type SaveDocV2,
} from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { composeSaveDoc, createFreshMeta } from '../../storage/save-codec.js';
import { createSim, newGameSim, type SimApi } from '../sim.js';
import { makeSave, TEST_MAP } from './fixtures.js';
import { runScriptR } from './script-r.js';

/** Downgrade a live v2 document to the frozen v1 shape (the M1 game's write format —
 * the live pipeline writes v2 since the M3 switchover, so the v1 form is rebuilt by
 * dropping exactly the v2 world blocks; every v1 field is carried verbatim). */
function asV1Doc(v2: SaveDocV2): SaveDoc {
  const {
    structures: _s,
    sprinklers: _sp,
    farmhouse: _f,
    unlockedZones: _z,
    clearedResourceNodes: _c,
    ...v1World
  } = v2.world;
  return { ...v2, schemaVersion: 1, world: v1World };
}

/** Wrap a live sim snapshot as the persisted v1 document (deterministic meta). */
function liveSaveDoc(sim: SimApi): SaveDoc {
  return asV1Doc(
    composeSaveDoc(
      sim.serialize(),
      createFreshMeta({
        appVersion: '0.1.0',
        now: 1_780_000_000_000,
        saveId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ),
  );
}

describe('live M1 saves migrate with zero loss (PRD 04 §M)', () => {
  it.each([
    ['fresh day-1', 0],
    ['after 3 script-R mornings', 3],
    ['after 12 script-R mornings (Lv3, field_b open)', 12],
  ] as const)('%s', (_label, mornings) => {
    const sim = newGameSim(`migration-e2e-${mornings}`, TEST_MAP);
    if (mornings > 0) runScriptR(sim, mornings);
    const v1 = liveSaveDoc(sim);
    const snapshot = structuredClone(v1);

    const result = migrateSaveDoc(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SaveDocV2Schema.safeParse(result.doc).success).toBe(true);
    // zero loss across every carried block
    expect(result.doc.meta).toEqual(v1.meta);
    expect(result.doc.time).toEqual(v1.time);
    expect(result.doc.player).toEqual(v1.player);
    expect(result.doc.tools).toEqual(v1.tools);
    expect(result.doc.inventory).toEqual(v1.inventory);
    expect(result.doc.progress).toEqual(v1.progress);
    expect(result.doc.quests).toEqual(v1.quests);
    expect(result.doc.world.farmTiles).toEqual(v1.world.farmTiles);
    expect(result.doc.world.shippingBin).toEqual(v1.world.shippingBin);
    // the input document is untouched (copy-on-migrate, §10.6)
    expect(v1).toEqual(snapshot);

    // B-2 equivalence: shared's xp-derived zones === the live sim's runtime zones.
    expect([...result.doc.world.unlockedZones].sort()).toEqual(
      [...sim.state.farm.unlockedZones].sort(),
    );
  });

  it('migrated world carries v1 farm data into a sim that keeps running (v2 ⊇ v1)', () => {
    const sim = newGameSim('migration-e2e-rehydrate', TEST_MAP);
    runScriptR(sim, 5);
    const result = migrateSaveDoc(liveSaveDoc(sim));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The v2 world block is a superset of the v1 restorable shape — dropping the new
    // (still-empty) M3 blocks yields a v1-loadable document the sim accepts and
    // continues from deterministically.
    const { structures, sprinklers, farmhouse, unlockedZones, clearedResourceNodes, ...v1World } =
      result.doc.world;
    expect(structures).toEqual([]);
    expect(sprinklers).toEqual([]);
    expect(clearedResourceNodes).toEqual([]);
    expect(farmhouse).toEqual({ stage: 0, construction: null });
    expect(unlockedZones).toContain('field_a');
    const { meta: _meta, schemaVersion: _v, ...restorable } = { ...result.doc, world: v1World };
    const resumed = createSim(restorable, TEST_MAP);
    expect(resumed.state.time.day).toBe(sim.state.time.day);
    expect(resumed.state.economy.gold).toBe(sim.state.economy.gold);
    runScriptR(resumed, 2); // keeps running without throwing
    expect(resumed.state.time.day).toBe(sim.state.time.day + 2);
  });
});

describe('§5.5 canonical retro document (xp = 2,400)', () => {
  it('derives the COMPLETE zone set on migration (Lv6 band: 2,150 ≤ xp < 3,300)', () => {
    const restorable: RestorableSaveDoc = makeSave({ progress: { xp: 2_400 } });
    const v1: SaveDoc = {
      schemaVersion: 1,
      meta: createFreshMeta({
        appVersion: '0.1.0',
        now: 1_780_000_000_000,
        saveId: '00000000-0000-4000-8000-000000002400',
      }),
      ...restorable,
    };
    const result = migrateSaveDoc(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.world.unlockedZones).toEqual(['field_a', 'field_b', 'field_c']);
    expect(result.doc.progress.xp).toBe(2_400); // xp itself is untouched by migration
  });
});
