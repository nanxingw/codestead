/**
 * migrations.ts — version classification + the migration entry point.
 *
 * GDD §10.6: the migration chain is a pure-function array (v → v+1); ANY field
 * add/remove/change bumps `schemaVersion`, no gray area. Since M3 the chain
 * LIVES IN SHARED (shared/src/save-migrations.ts, next to the schema, with
 * fixture tests + the CI guard asserting every link 1..CURRENT-1 exists);
 * this module is the runtime entry point that walks it.
 *
 * Boot-machine rules (GDD §10.4):
 * - version == CURRENT → VALIDATE (safeParse) → RUNNING | RECOVERY;
 * - version <  CURRENT → MIGRATING on a copy → RUNNING | RECOVERY;
 * - version >  CURRENT → TOO_NEW: read-only + export-only, never write or
 *   migrate downward.
 */
import {
  CURRENT_SAVE_SCHEMA_VERSION,
  SAVE_MIGRATIONS as SHARED_SAVE_MIGRATIONS,
} from '@codestead/shared';

export const CURRENT_SAVE_VERSION = CURRENT_SAVE_SCHEMA_VERSION;

/** One chain link: migrates a document FROM `from` TO `from + 1`. Pure. */
export interface SaveMigration {
  readonly from: number;
  readonly migrate: (doc: unknown) => unknown;
}

/**
 * The shared chain (single source of truth) viewed through the local link shape.
 * shared's steps also carry their input schema; the walker below relies on the
 * step itself validating/throwing, with the caller's final validate as the gate.
 */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = SHARED_SAVE_MIGRATIONS.map((step) => ({
  from: step.from,
  migrate: (doc: unknown): unknown => {
    if (!step.inputSchema.safeParse(doc).success) {
      throw new Error(`save document does not satisfy the v${step.from} schema`);
    }
    return step.migrate(doc);
  },
}));

export type LoadClassification =
  | { kind: 'empty' }
  | { kind: 'current'; raw: unknown }
  | { kind: 'older'; raw: unknown; foundVersion: number }
  | { kind: 'too_new'; raw: unknown; foundVersion: number }
  /** Not an object / no readable integer schemaVersion → recovery path. */
  | { kind: 'malformed'; raw: unknown };

/** Classify a raw stored/imported value by its schemaVersion (GDD §10.4 branches). */
export function classifyRawSave(raw: unknown): LoadClassification {
  if (raw === undefined || raw === null) return { kind: 'empty' };
  if (typeof raw !== 'object') return { kind: 'malformed', raw };
  const version = (raw as Record<string, unknown>)['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'malformed', raw };
  }
  if (version === CURRENT_SAVE_VERSION) return { kind: 'current', raw };
  if (version < CURRENT_SAVE_VERSION) return { kind: 'older', raw, foundVersion: version };
  return { kind: 'too_new', raw, foundVersion: version };
}

export type MigrationOutcome =
  | { ok: true; doc: unknown }
  | { ok: false; failedAtVersion: number; reason: 'missing-link' | 'threw'; error?: unknown };

/**
 * Walk the chain from `foundVersion` up to CURRENT on a deep copy (the original
 * is never touched; the caller persists only after the final validate passes —
 * GDD §10.6 "副本上执行、全链成功且终验通过才落盘").
 */
export function migrateRawSave(raw: unknown, foundVersion: number): MigrationOutcome {
  let doc: unknown = structuredClone(raw);
  for (let v = foundVersion; v < CURRENT_SAVE_VERSION; v++) {
    const link = SAVE_MIGRATIONS.find((m) => m.from === v);
    if (!link) return { ok: false, failedAtVersion: v, reason: 'missing-link' };
    try {
      doc = link.migrate(doc);
    } catch (error) {
      return { ok: false, failedAtVersion: v, reason: 'threw', error };
    }
  }
  return { ok: true, doc };
}
