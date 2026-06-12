/**
 * export-import.ts — JSON export/import backstop (GDD §10.6, PRD 01 US93).
 *
 * Export: the SaveDoc itself, pretty-printed (no wrapper, no checksum), file
 * name `codestead-save-day012-20260610-1430.json`, Blob + <a download>, zero
 * network. Hand-editing the file is a feature, not cheating (§10.6).
 *
 * Import (M1): file text → JSON.parse → version classification → safeParse →
 * tolerant-load sanitize. ANY failure rejects the import and the existing save
 * is untouched — `parseImportedSave` is pure, persistence happens only in
 * `applyImportedSave` after the caller confirms an ok result. The M5 preview/
 * confirm screen and migrate-on-import are out of M1 scope (§10.1 ruling).
 */
import type { SaveDocV2 } from '@codestead/shared';

import { validateSaveDoc } from './save-codec';
import { classifyRawSave, CURRENT_SAVE_VERSION, migrateRawSave } from './migrations';
import { sanitizeSaveDoc } from './sanitize';
import type { SaveStorage } from './save-storage';

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** `codestead-save-day012-20260610-1430.json` (§10.6; local wall clock, display only). */
export function exportFileName(day: number, now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}`;
  return `codestead-save-day${pad(day, 3)}-${date}-${time}.json`;
}

/** Pretty-printed document body (the SaveDoc itself, no wrapper). */
export function exportSaveJson(doc: SaveDocV2): string {
  return JSON.stringify(doc, null, 2);
}

/** Trigger a browser download of the save. Browser-only (Blob + <a download>). */
export function downloadSaveDoc(doc: SaveDocV2, now: Date = new Date()): void {
  const blob = new Blob([exportSaveJson(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFileName(doc.time.day, now);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export type ImportFailureStage = 'parse' | 'version' | 'schema';

export type ImportResult =
  | {
      ok: true;
      doc: SaveDocV2;
      warnings: string[];
      /** Source schemaVersion when the imported file was migrated (US37 retro seam). */
      migratedFromVersion?: number;
    }
  | { ok: false; stage: ImportFailureStage; issues: string[] };

/**
 * Validate an imported JSON text. Pure — never touches storage, so a rejected
 * import trivially leaves the existing save byte-identical (US93).
 */
export function parseImportedSave(jsonText: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    return {
      ok: false,
      stage: 'parse',
      issues: [error instanceof Error ? error.message : 'invalid JSON'],
    };
  }

  const classified = classifyRawSave(raw);
  switch (classified.kind) {
    case 'empty':
    case 'malformed':
      return { ok: false, stage: 'schema', issues: ['not a Codestead save document'] };
    case 'too_new':
      return {
        ok: false,
        stage: 'version',
        issues: [
          `save version ${classified.foundVersion} is newer than this build (current ${CURRENT_SAVE_VERSION})`,
        ],
      };
    case 'older': {
      const migrated = migrateRawSave(classified.raw, classified.foundVersion);
      if (!migrated.ok) {
        return {
          ok: false,
          stage: 'version',
          issues: [`no migration path from save version ${classified.foundVersion}`],
        };
      }
      return finishImport(migrated.doc, classified.foundVersion);
    }
    case 'current':
      return finishImport(classified.raw);
  }
}

function finishImport(raw: unknown, migratedFromVersion?: number): ImportResult {
  const validated = validateSaveDoc(raw);
  if (!validated.ok) return { ok: false, stage: 'schema', issues: validated.issues };
  const sanitized = sanitizeSaveDoc(validated.doc);
  return {
    ok: true,
    doc: sanitized.doc,
    warnings: sanitized.warnings,
    ...(migratedFromVersion !== undefined ? { migratedFromVersion } : {}),
  };
}

// ---- US37 retro seam across the in-game import reload ----
//
// The pause-menu/settings import persists the MIGRATED doc and reloads the page
// (save-transfer.ts), so the boot machine re-reads the slot as 'current' and the
// migration provenance would be lost. sessionStorage survives exactly one reload
// in the same tab — the importer stashes the source version, PreloadScene pops it
// and hands it to the registry seam. Best-effort: storage being unavailable only
// skips the retro banners (presentation), never the import itself.

const RETRO_SESSION_KEY = 'codestead.import.fromVersion';

/** Stash the source schemaVersion of a just-imported save before the reload. */
export function stashImportedFromVersion(version: number): void {
  try {
    window.sessionStorage.setItem(RETRO_SESSION_KEY, String(version));
  } catch {
    // Presentation-only seam — never let storage quirks break the import.
  }
}

/** Pop (read + clear) the stashed source version after the reload, if any. */
export function popImportedFromVersion(): number | undefined {
  try {
    const raw = window.sessionStorage.getItem(RETRO_SESSION_KEY);
    if (raw === null) return undefined;
    window.sessionStorage.removeItem(RETRO_SESSION_KEY);
    const version = Number(raw);
    return Number.isInteger(version) && version >= 1 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a successfully parsed import, replacing the current slot. Runs the
 * write-path safeParse self-check once more (defense in depth); on self-check
 * failure nothing is written and the existing save stays intact.
 */
export async function applyImportedSave(storage: SaveStorage, doc: SaveDocV2): Promise<void> {
  const validated = validateSaveDoc(doc);
  if (!validated.ok) {
    throw new Error(`import self-check failed; existing save untouched: ${validated.issues[0]}`);
  }
  await storage.write(validated.doc);
}
