/**
 * Save migration chain — the project's FIRST real migration (v1 → v2) and the
 * paradigm every later schema evolution must follow (GDD §10.6; PRD 04 §M):
 *
 *   1. migrations are PURE functions, one per version step (v → v+1), kept in
 *      SAVE_MIGRATIONS in ascending order — same PR as the schema change;
 *   2. the driver runs the whole chain ON A COPY; only if every step succeeds AND the
 *      terminal document passes the CURRENT schema may the caller persist anything
 *      ("副本上执行、全链成功且终验通过才落盘");
 *   3. each step ships with fixture unit tests, and a CI guard test asserts that a
 *      migration exists for EVERY version 1..CURRENT-1 (delete one ⇒ red).
 *
 * Scope note: this module migrates STRUCTURE only. Semantic load-time work — retro
 * level-up events for xp > Lv5 saves (GDD §5.3), reclaiming structures with illegal
 * footprints from hand-edited imports (GDD §8.5, 100% refund, never silent delete) —
 * needs the blueprint/map tables and therefore lives in the game's sim layer
 * (sim/profession.ts retroLevelUpEvents, sim/building.ts sanitizeStructures).
 */
import { SaveDocSchema, type SaveDoc } from './save.js';
import { SAVE_SCHEMA_VERSION_V2, SaveDocV2Schema, type SaveDocV2 } from './save-v2.js';

/** The version freshly-written saves carry. Bump together with a new migration step. */
export const CURRENT_SAVE_SCHEMA_VERSION = SAVE_SCHEMA_VERSION_V2;

// ---- v1 → v2 derivation constants (transcribed snapshots) ----
//
// `unlockedZones` did not exist in v1 (backlog B-2); the migration derives it from xp
// exactly like the M1 hydrate fallback did, so behaviour is unchanged for old saves
// (worst case: a fence that would have opened next morning opens at load — benign,
// player-positive, zero loss). shared/ cannot import the game's sim constants, so the
// two tables below are SNAPSHOTS of GDD §5.1 / §1.4-§1.5; a cross-package guard test in
// packages/game (sim/__tests__/save-v2-migration.test.ts) asserts they never drift.

/** GDD §5.1 cumulative XP thresholds (index i ⇒ Lv(i+1)). Snapshot — see note above. */
export const XP_THRESHOLDS_SNAPSHOT = [
  0, 100, 380, 770, 1_300, 2_150, 3_300, 4_800, 6_900, 10_000,
] as const;

/** GDD §1.4 / farm-map-meta unlockGroups. Snapshot — see note above. */
export const ZONE_UNLOCK_LEVELS_SNAPSHOT = [
  { zoneId: 'field_a', farmLevel: 1 },
  { zoneId: 'field_b', farmLevel: 3 },
  { zoneId: 'field_c', farmLevel: 5 },
] as const;

function levelForXpSnapshot(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS_SNAPSHOT.length; i++) {
    if (xp >= XP_THRESHOLDS_SNAPSHOT[i]) level = i + 1;
  }
  return level;
}

// ---- the v1 → v2 step ----

/**
 * Pure structural migration, zero loss by construction:
 * - every v1 field is carried over verbatim (ItemStack v1 ⊂ ItemStack v2 — `quality`
 *   absent means 'normal');
 * - new v2 blocks start at their "nothing happened yet" values: no structures, no
 *   sprinklers, farmhouse stage 0, no cleared resource nodes;
 * - `unlockedZones` is derived from xp (B-2; see snapshot note above).
 *
 * Callers pass a SaveDocSchema-validated document; the chain driver below enforces it.
 */
export function migrateV1toV2(doc: SaveDoc): SaveDocV2 {
  const level = levelForXpSnapshot(doc.progress.xp);
  return {
    ...doc,
    schemaVersion: SAVE_SCHEMA_VERSION_V2,
    world: {
      farmTiles: doc.world.farmTiles,
      shippingBin: doc.world.shippingBin,
      structures: [],
      sprinklers: [],
      farmhouse: { stage: 0, construction: null },
      unlockedZones: ZONE_UNLOCK_LEVELS_SNAPSHOT.filter((z) => level >= z.farmLevel).map(
        (z) => z.zoneId,
      ),
      clearedResourceNodes: [],
    },
  };
}

// ---- the chain ----

export interface SaveMigrationStep {
  /** Source schemaVersion this step consumes; it produces `from + 1`. */
  readonly from: number;
  /** Pure (validated doc in, next-version doc out); driver clones before calling. */
  readonly migrate: (doc: unknown) => unknown;
  /** Validates the INPUT shape for this step (the frozen schema of version `from`). */
  readonly inputSchema: { safeParse: (data: unknown) => { success: boolean } };
}

/**
 * Ascending, gap-free: SAVE_MIGRATIONS[i].from === i + 1, and the array length is
 * CURRENT_SAVE_SCHEMA_VERSION - 1. Guarded by shared/test/save-migrations.test.ts —
 * deleting any link turns CI red (GDD §10.6).
 */
export const SAVE_MIGRATIONS: readonly SaveMigrationStep[] = [
  {
    from: 1,
    inputSchema: SaveDocSchema,
    migrate: (doc) => migrateV1toV2(doc as SaveDoc),
  },
];

export type MigrateSaveResult =
  | { ok: true; doc: SaveDocV2; fromVersion: number }
  /** Newer than this build understands: read-only + export-only, never write (§10.4). */
  | { ok: false; reason: 'too_new'; foundVersion: number }
  | { ok: false; reason: 'invalid_input' }
  | { ok: false; reason: 'migration_failed'; atVersion: number };

/**
 * Chain driver (GDD §10.4 MIGRATING / §10.6). Runs on a deep copy; the input document
 * is never mutated. Persisting the result (and the pre-migration backup) is the
 * storage layer's job — this function only computes.
 */
export function migrateSaveDoc(raw: unknown): MigrateSaveResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid_input' };
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (version > CURRENT_SAVE_SCHEMA_VERSION) {
    return { ok: false, reason: 'too_new', foundVersion: version };
  }

  // Deep copy via JSON — a SaveDoc is a JSON document by definition (§10.6 export
  // contract), and shared/ targets a lib level without structuredClone typings.
  let doc: unknown = JSON.parse(JSON.stringify(raw)) as unknown;
  for (const step of SAVE_MIGRATIONS) {
    if (step.from < version) continue;
    if (!step.inputSchema.safeParse(doc).success) {
      return step.from === version
        ? { ok: false, reason: 'invalid_input' }
        : { ok: false, reason: 'migration_failed', atVersion: step.from };
    }
    doc = step.migrate(doc);
  }

  const final = SaveDocV2Schema.safeParse(doc);
  if (!final.success) {
    return version === CURRENT_SAVE_SCHEMA_VERSION
      ? { ok: false, reason: 'invalid_input' }
      : { ok: false, reason: 'migration_failed', atVersion: CURRENT_SAVE_SCHEMA_VERSION };
  }
  return { ok: true, doc: final.data, fromVersion: version };
}
