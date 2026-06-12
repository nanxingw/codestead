import { describe, expect, it } from 'vitest';

import { exportFileName, exportSaveJson, parseImportedSave } from '../src/storage/export-import';
import { classifyRawSave, migrateRawSave } from '../src/storage/migrations';
import { makeSaveDoc, makeSaveDocV1 } from './helpers/save-fixture';

describe('export', () => {
  it('builds the §10.6 file name: codestead-save-day012-20260610-1430.json', () => {
    const now = new Date(2026, 5, 10, 14, 30); // 2026-06-10 14:30 local
    expect(exportFileName(12, now)).toBe('codestead-save-day012-20260610-1430.json');
  });

  it('pretty-prints the SaveDoc itself (no wrapper, no checksum)', () => {
    const doc = makeSaveDoc();
    const json = exportSaveJson(doc);
    expect(json).toContain('\n  "schemaVersion": 2'); // CURRENT = v2 since M3 (§10.6)
    expect(JSON.parse(json)).toEqual(doc);
  });
});

describe('import (M1: any failure rejects, existing save untouched)', () => {
  it('round-trips an exported save', () => {
    const doc = makeSaveDoc();
    const result = parseImportedSave(exportSaveJson(doc));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc).toEqual(doc);
  });

  it('rejects broken JSON at the parse stage', () => {
    const result = parseImportedSave('{ not json');
    expect(result).toMatchObject({ ok: false, stage: 'parse' });
  });

  it('rejects schema violations with issue paths for the UI', () => {
    const doc = makeSaveDoc();
    const tampered = { ...doc, player: { ...doc.player, selectedSlot: 99 } };
    const result = parseImportedSave(JSON.stringify(tampered));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('schema');
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects too-new saves (read-only forward, never migrate downward)', () => {
    const result = parseImportedSave(JSON.stringify({ ...makeSaveDoc(), schemaVersion: 3 }));
    expect(result).toMatchObject({ ok: false, stage: 'version' });
  });

  it('imports a frozen v1 document through the migration chain (US69)', () => {
    const result = parseImportedSave(JSON.stringify(makeSaveDocV1(), null, 2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.schemaVersion).toBe(2);
      expect(result.doc.world.structures).toEqual([]);
      expect(result.doc.world.farmhouse).toEqual({ stage: 0, construction: null });
      // US37 retro seam: the source version travels with the parse result so the
      // scene layer can replay the Lv6..N catch-up banners for v1 saves.
      expect(result.migratedFromVersion).toBe(1);
    }
  });

  it('current-version imports carry no migration provenance (US37 seam)', () => {
    const result = parseImportedSave(JSON.stringify(makeSaveDoc()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.migratedFromVersion).toBeUndefined();
  });
});

describe('migrations (shared v1→v2 chain, GDD §10.6)', () => {
  it('classifies raw values per the §10.4 branches', () => {
    expect(classifyRawSave(undefined).kind).toBe('empty');
    expect(classifyRawSave('garbage').kind).toBe('malformed');
    expect(classifyRawSave({}).kind).toBe('malformed');
    expect(classifyRawSave({ schemaVersion: 2 }).kind).toBe('current');
    expect(classifyRawSave({ schemaVersion: 1 })).toMatchObject({
      kind: 'older',
      foundVersion: 1,
    });
    expect(classifyRawSave({ schemaVersion: 7 })).toMatchObject({
      kind: 'too_new',
      foundVersion: 7,
    });
  });

  it('walking from the current version is a no-op copy', () => {
    const doc = makeSaveDoc();
    const outcome = migrateRawSave(doc, 2);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.doc).toEqual(doc);
      expect(outcome.doc).not.toBe(doc); // copy, never the original
    }
  });

  it('walks a v1 document up the shared chain (B-2 zones derived from xp)', () => {
    const outcome = migrateRawSave(makeSaveDocV1(), 1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const world = (outcome.doc as { world: { unlockedZones: string[] } }).world;
      expect(world.unlockedZones).toEqual(['field_a']); // xp 0 ⇒ Lv1 band
    }
  });
});
