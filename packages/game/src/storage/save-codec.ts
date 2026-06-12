/**
 * save-codec.ts — pure (de)composition between the sim's meta-less snapshot
 * (`RestorableSaveDocV2`) and the persisted `SaveDoc` v2 (the CURRENT document
 * since M3; v1 documents reach this layer only through the §10.6 migration chain).
 *
 * Contract (GDD §10.2 / sim/sim.ts header): `SimApi.serialize()` returns the
 * meta-less shape; this layer wraps it with `{ schemaVersion, meta }` and runs
 * the zod safeParse self-check BEFORE every write (failure = programming bug,
 * the previous good save is never overwritten, GDD §10.4).
 *
 * `meta` is display-only and never feeds game logic; wall-clock values live
 * exclusively here (the "real time never enters the sim" discipline, §10.2).
 * All wall-clock reads are injected (`now` parameters) for testability.
 */
import {
  SAVE_SCHEMA_VERSION_V2,
  SaveDocV2Schema,
  type RestorableSaveDocV2,
  type SaveDocV2,
  type SaveMeta,
} from '@codestead/shared';

/** Fresh meta block for a brand-new save (saveCount 0 — bumped by advanceMeta on write). */
export function createFreshMeta(args: {
  appVersion: string;
  /** Wall-clock epoch ms (display only). */
  now: number;
  /** Injectable for tests; defaults to crypto.randomUUID(). */
  saveId?: string;
}): SaveMeta {
  return {
    saveId: args.saveId ?? crypto.randomUUID(),
    appVersion: args.appVersion,
    createdAtReal: args.now,
    savedAtReal: args.now,
    saveCount: 0,
    playTimeRealSeconds: 0,
  };
}

/** Meta block for the next persisted write: bump saveCount, accumulate play time. */
export function advanceMeta(
  prev: SaveMeta,
  args: { now: number; elapsedRealSeconds: number; appVersion?: string },
): SaveMeta {
  return {
    ...prev,
    appVersion: args.appVersion ?? prev.appVersion,
    savedAtReal: args.now,
    saveCount: prev.saveCount + 1,
    playTimeRealSeconds: prev.playTimeRealSeconds + Math.max(0, args.elapsedRealSeconds),
  };
}

/** Wrap a sim snapshot into the persisted document shape (no validation here). */
export function composeSaveDoc(restorable: RestorableSaveDocV2, meta: SaveMeta): SaveDocV2 {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION_V2,
    meta,
    time: restorable.time,
    player: restorable.player,
    tools: restorable.tools,
    inventory: restorable.inventory,
    world: restorable.world,
    progress: restorable.progress,
    quests: restorable.quests,
  };
}

/**
 * Strip `meta`/`schemaVersion` so the sim restore path cannot see wall-clock
 * data even by accident (type discipline, GDD §10.2 / PRD 01 US99).
 */
export function toRestorable(doc: SaveDocV2): RestorableSaveDocV2 {
  const { meta: _meta, schemaVersion: _schemaVersion, ...restorable } = doc;
  return restorable;
}

export type ValidationResult = { ok: true; doc: SaveDocV2 } | { ok: false; issues: string[] };

/** safeParse wrapper with human-readable issue paths (for the recovery/import UI). */
export function validateSaveDoc(value: unknown): ValidationResult {
  const result = SaveDocV2Schema.safeParse(value);
  if (result.success) return { ok: true, doc: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
