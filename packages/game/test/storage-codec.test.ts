import { describe, expect, it } from 'vitest';

import {
  advanceMeta,
  composeSaveDoc,
  createFreshMeta,
  toRestorable,
  validateSaveDoc,
} from '../src/storage/save-codec';
import { makeMeta, makeRestorable, makeSaveDoc } from './helpers/save-fixture';

describe('save-codec', () => {
  it('composes a sim snapshot + meta into a schema-valid SaveDoc v1', () => {
    const doc = composeSaveDoc(makeRestorable(), makeMeta());
    const result = validateSaveDoc(doc);
    expect(result.ok).toBe(true);
  });

  it('toRestorable strips meta and schemaVersion (wall clock never reaches the sim)', () => {
    const restorable = makeRestorable();
    const roundTripped = toRestorable(composeSaveDoc(restorable, makeMeta()));
    expect(roundTripped).toEqual(restorable);
    expect('meta' in roundTripped).toBe(false);
    expect('schemaVersion' in roundTripped).toBe(false);
  });

  it('rejects tampered documents with readable issue paths (write-path self-check)', () => {
    const doc = makeSaveDoc();
    const tampered = { ...doc, player: { ...doc.player, gold: -5 } };
    const result = validateSaveDoc(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.startsWith('player.gold'))).toBe(true);
    }
  });

  it('rejects out-of-bounds farmTiles keys at the schema layer (GDD §10.9)', () => {
    const doc = makeSaveDoc();
    const bad = {
      ...doc,
      world: {
        ...doc.world,
        farmTiles: { '64,10': { tilled: true, wateredToday: false, crop: null } },
      },
    };
    expect(validateSaveDoc(bad).ok).toBe(false);
  });

  it('advanceMeta bumps saveCount and accumulates display-only play time', () => {
    const fresh = createFreshMeta({ appVersion: '0.1.0', now: 1_000, saveId: makeMeta().saveId });
    expect(fresh.saveCount).toBe(0);
    expect(fresh.createdAtReal).toBe(1_000);
    const next = advanceMeta(fresh, { now: 31_000, elapsedRealSeconds: 30 });
    expect(next.saveCount).toBe(1);
    expect(next.savedAtReal).toBe(31_000);
    expect(next.playTimeRealSeconds).toBe(30);
    expect(next.createdAtReal).toBe(1_000); // creation timestamp never moves
  });
});
