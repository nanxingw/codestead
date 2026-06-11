/**
 * serialize() ⇄ SaveDoc v1 schema conformance (GDD §10.2/§10.3; PRD 01 US98/US99).
 *
 * The storage layer runs SaveDocSchema.safeParse as its write-time self check; these
 * tests prove the sim's serialize() output ALWAYS satisfies the schema (a failure
 * there is by contract a programming bug — it must be caught here, not at write time),
 * and that hydration is tolerant per GDD §10.9.
 */
import { describe, expect, it, vi } from 'vitest';

import { SaveDocSchema, SAVE_SCHEMA_VERSION } from '@codestead/shared';
import type { SaveDoc, SaveMeta } from '@codestead/shared';

import { createSim, newGameSim } from '../sim.js';
import { canTill } from '../tiles.js';
import { TEST_MAP, makeSave, moduleReady, stack, xpForLevel } from './fixtures.js';
import { runScriptR } from './script-r.js';

const READY = moduleReady(() => newGameSim('schema-probe', TEST_MAP).serialize());

/** Fixed display-only meta (real-clock data never reaches the sim, §10.2). */
const META: SaveMeta = {
  saveId: '123e4567-e89b-42d3-a456-426614174000',
  appVersion: '0.1.0-test',
  createdAtReal: 0,
  savedAtReal: 0,
  saveCount: 1,
  playTimeRealSeconds: 0,
};

function wrap(doc: ReturnType<ReturnType<typeof newGameSim>['serialize']>): SaveDoc {
  return { schemaVersion: SAVE_SCHEMA_VERSION, meta: META, ...doc };
}

// skipIf gates removed (M1 sim landed): a false probe is a loud red, never a silent skip.
it('probes: implementation landed', () => {
  expect(READY).toBe(true);
});

describe('serialize() output is always SaveDocSchema-valid (US98)', () => {
  it('a fresh new game serializes to a schema-valid §10.2 document', () => {
    const doc = newGameSim('schema-fresh', TEST_MAP).serialize();
    const parsed = SaveDocSchema.safeParse(wrap(doc));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    // §10.2 new-save row spot checks
    expect(doc.time.day).toBe(1);
    expect(doc.time.season).toBe('spring');
    expect(doc.time.weatherToday).toBe('sunny');
    expect(doc.player.gold).toBe(100);
    expect(doc.inventory.slots[0]).toEqual(stack('hoe', 1));
    expect(doc.inventory.slots[1]).toEqual(stack('watering_can', 1));
    expect(doc.quests).toEqual({ grantedQuestIds: [], completedCount: 0, noteRefs: [] });
  });

  it('stays schema-valid after a played week (tilled/planted/sold state)', () => {
    const sim = newGameSim('schema-week', TEST_MAP);
    runScriptR(sim, 7);
    const doc = sim.serialize();
    const parsed = SaveDocSchema.safeParse(wrap(doc));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    // sparse keys obey the bounds-checked "x,y" regex baked into the schema
    expect(Object.keys(doc.world.farmTiles).length).toBeGreaterThan(0);
    // stats are derived from counters (never a second source of truth)
    expect(doc.progress.stats.totalHarvests).toBe(doc.progress.counters['harvestCount']);
    expect(doc.progress.stats.totalGoldEarned).toBe(doc.progress.counters['goldEarned']);
  });
});

describe('zone unlocks re-derived from xp on load (US10 / GDD §1.4)', () => {
  it('a Lv3 night-save reloads with field_b open and tillable — no unlock regression', () => {
    const save = makeSave({ progress: { xp: xpForLevel(3) } }); // night autosave at Lv3
    const sim = createSim(save, TEST_MAP);
    expect(sim.state.farm.unlockedZones).toContain('field_a');
    expect(sim.state.farm.unlockedZones).toContain('field_b');
    expect(sim.state.farm.unlockedZones).not.toContain('field_c'); // Lv5 zone stays fenced
    expect(canTill(sim.state, TEST_MAP, { x: 10, y: 14 })).toBe(true); // field_b corner tile
  });
});

describe('tolerant hydration (GDD §10.9)', () => {
  it('degrades unknown cropIds to empty tilled soil and drops unknown itemIds + warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const save = makeSave({
        world: {
          farmTiles: {
            '22,14': {
              tilled: true,
              wateredToday: false,
              crop: {
                cropId: 'crystal_melon_from_v9', // future crop, unknown in M1
                daysGrown: 3,
                mature: false,
                regrowDaysLeft: null,
                harvestsLeft: null,
                withered: false,
              },
            },
          },
          shippingBin: [stack('artifact_from_v9', 2), stack('crop_turnip', 1)],
        },
        inventory: {
          capacity: 12,
          slots: [
            stack('hoe', 1),
            stack('gadget_from_v9', 3), // unknown → slot cleared
            ...Array.from({ length: 10 }, () => null),
          ],
        },
      });
      const sim = createSim(save, TEST_MAP);
      expect(sim.state.farm.tiles['22,14']).toEqual({
        tilled: true,
        wateredToday: false,
        crop: null,
      });
      expect(sim.state.inventory.slots[1]).toBeNull();
      expect(sim.state.economy.shippingBin).toEqual([stack('crop_turnip', 1)]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('porch-letter one-time semantics (US86 / backlog A-4)', () => {
  it('markIntroLetterRead sets the counter once, idempotently, and round-trips', () => {
    const sim = newGameSim('letter-probe', TEST_MAP);
    expect(sim.state.progress.counters.introLetterRead).toBeUndefined();
    sim.markIntroLetterRead();
    expect(sim.state.progress.counters.introLetterRead).toBe(1);
    sim.markIntroLetterRead(); // repeat reads are no-ops (one-time semantics)
    sim.markIntroLetterRead();
    expect(sim.state.progress.counters.introLetterRead).toBe(1);

    // Zero schema change (PRD 02 red line): it is a plain counter in SaveDoc v1.
    const doc = sim.serialize();
    expect(doc.progress.counters['introLetterRead']).toBe(1);
    expect(SaveDocSchema.safeParse(wrap(doc)).success).toBe(true);

    // Restore keeps the read state — the porch highlight never comes back.
    const restored = createSim(doc, TEST_MAP);
    expect(restored.state.progress.counters.introLetterRead).toBe(1);
    restored.markIntroLetterRead(); // still idempotent after a reload
    expect(restored.state.progress.counters.introLetterRead).toBe(1);
  });
});
