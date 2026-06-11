import { describe, expect, it } from 'vitest';

import { exportFileName, exportSaveJson, parseImportedSave } from '../src/storage/export-import';
import { classifyRawSave, migrateRawSave } from '../src/storage/migrations';
import { makeSaveDoc } from './helpers/save-fixture';

describe('export', () => {
  it('builds the §10.6 file name: codestead-save-day012-20260610-1430.json', () => {
    const now = new Date(2026, 5, 10, 14, 30); // 2026-06-10 14:30 local
    expect(exportFileName(12, now)).toBe('codestead-save-day012-20260610-1430.json');
  });

  it('pretty-prints the SaveDoc itself (no wrapper, no checksum)', () => {
    const doc = makeSaveDoc();
    const json = exportSaveJson(doc);
    expect(json).toContain('\n  "schemaVersion": 1');
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
    const result = parseImportedSave(JSON.stringify({ ...makeSaveDoc(), schemaVersion: 2 }));
    expect(result).toMatchObject({ ok: false, stage: 'version' });
  });
});

describe('migrations (v1 placeholder chain)', () => {
  it('classifies raw values per the §10.4 branches', () => {
    expect(classifyRawSave(undefined).kind).toBe('empty');
    expect(classifyRawSave('garbage').kind).toBe('malformed');
    expect(classifyRawSave({}).kind).toBe('malformed');
    expect(classifyRawSave({ schemaVersion: 1 }).kind).toBe('current');
    expect(classifyRawSave({ schemaVersion: 7 })).toMatchObject({
      kind: 'too_new',
      foundVersion: 7,
    });
  });

  it('walking from the current version is a no-op copy', () => {
    const doc = makeSaveDoc();
    const outcome = migrateRawSave(doc, 1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.doc).toEqual(doc);
      expect(outcome.doc).not.toBe(doc); // copy, never the original
    }
  });
});
