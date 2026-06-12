/**
 * Real-save migration tests (PRD 04 §M / testing seam b) — the per-fixture side of the
 * first real migration chain. The three JSON fixtures under test/fixtures/ are REAL M1
 * saves: generated once from the actual game pipeline (newGameSim → script R mornings →
 * SimApi.serialize() → storage composeSaveDoc) and frozen, NOT hand-rolled documents:
 *
 *   m1-fresh-day1.json     day 1, untouched new game (xp 0 ⇒ field_a only)
 *   m1-midgame.json        day 13 after 12 script-R mornings (Lv3 ⇒ + field_b)
 *   m1-graduate-lv6.json   day 40, xp 2,422 > 2,150 — the §5.5 retro band (Lv6 ⇒ all)
 *
 * For each fixture: the FROZEN v1 schema still accepts it; the chain driver migrates
 * it with zero field loss; the result passes the terminal v2 validation; migration is
 * idempotent (running the driver on its own output is the identity) and deterministic
 * (two runs produce byte-identical JSON); the input is never mutated (GDD §10.6).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrateSaveDoc,
  migrateV1toV2,
  SAVE_SCHEMA_VERSION,
  SaveDocSchema,
  SaveDocV2Schema,
  type SaveDoc,
} from '../src/index.js';

const FIXTURES = ['m1-fresh-day1', 'm1-midgame', 'm1-graduate-lv6'] as const;
type FixtureName = (typeof FIXTURES)[number];

/** xp-derived unlockedZones oracle per fixture (GDD §1.4/§5.1; backlog B-2). */
const EXPECTED_ZONES: Record<FixtureName, string[]> = {
  'm1-fresh-day1': ['field_a'],
  'm1-midgame': ['field_a', 'field_b'],
  'm1-graduate-lv6': ['field_a', 'field_b', 'field_c'],
};

function loadRaw(name: FixtureName): unknown {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

function loadV1(name: FixtureName): SaveDoc {
  const parsed = SaveDocSchema.safeParse(loadRaw(name));
  if (!parsed.success) throw new Error(`${name} no longer parses as v1: ${parsed.error.message}`);
  return parsed.data;
}

describe.each(FIXTURES.map((name) => [name] as const))('real M1 fixture %s', (name) => {
  it('still validates against the FROZEN v1 schema (migration source shape)', () => {
    const raw = loadRaw(name);
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(SaveDocSchema.safeParse(raw).success).toBe(true);
  });

  it('migrates ok through the driver and passes the terminal v2 validation', () => {
    const result = migrateSaveDoc(loadRaw(name));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fromVersion).toBe(1);
    expect(result.doc.schemaVersion).toBe(2);
    expect(SaveDocV2Schema.safeParse(result.doc).success).toBe(true);
  });

  it('loses ZERO v1 data: every carried block is deep-equal to the source', () => {
    const v1 = loadV1(name);
    const result = migrateSaveDoc(loadRaw(name));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v2 = result.doc;
    expect(v2.meta).toEqual(v1.meta);
    expect(v2.time).toEqual(v1.time);
    expect(v2.player).toEqual(v1.player);
    expect(v2.tools).toEqual(v1.tools);
    expect(v2.inventory).toEqual(v1.inventory);
    expect(v2.progress).toEqual(v1.progress);
    expect(v2.quests).toEqual(v1.quests);
    expect(v2.world.farmTiles).toEqual(v1.world.farmTiles);
    expect(v2.world.shippingBin).toEqual(v1.world.shippingBin);
  });

  it('starts every NEW v2 block at "nothing happened yet"; zones derive from xp (B-2)', () => {
    const result = migrateSaveDoc(loadRaw(name));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.world.structures).toEqual([]);
    expect(result.doc.world.sprinklers).toEqual([]);
    expect(result.doc.world.farmhouse).toEqual({ stage: 0, construction: null });
    expect(result.doc.world.clearedResourceNodes).toEqual([]);
    expect(result.doc.world.unlockedZones).toEqual(EXPECTED_ZONES[name]);
  });

  it('is idempotent: driving the migrated doc again is the identity', () => {
    const first = migrateSaveDoc(loadRaw(name));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = migrateSaveDoc(first.doc);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.fromVersion).toBe(2);
    expect(second.doc).toEqual(first.doc);
  });

  it('is deterministic (two runs are byte-identical) and never mutates its input', () => {
    const rawA = loadRaw(name);
    const rawB = loadRaw(name);
    const snapshot = structuredClone(rawA);
    const a = migrateSaveDoc(rawA);
    const b = migrateSaveDoc(rawB);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.doc)).toBe(JSON.stringify(b.doc));
    expect(rawA).toEqual(snapshot); // copy-on-migrate (§10.6)
  });
});

describe('graduate fixture pins the §5.5 retro seam precondition', () => {
  it("xp sits in the Lv6 band (2,150 ≤ xp < 3,300) — retro events are the load path's job", () => {
    const grad = loadV1('m1-graduate-lv6');
    expect(grad.progress.xp).toBeGreaterThanOrEqual(2_150);
    expect(grad.progress.xp).toBeLessThan(3_300);
    // The pure step function agrees with the driver on the same document.
    const direct = migrateV1toV2(grad);
    const driven = migrateSaveDoc(loadRaw('m1-graduate-lv6'));
    expect(driven.ok).toBe(true);
    if (driven.ok) expect(driven.doc).toEqual(direct);
  });
});
