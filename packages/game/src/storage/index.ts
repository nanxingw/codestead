/**
 * storage/ — the persistence layer (GDD §10; PRD 01 architecture).
 *
 * Boundary: this is the ONLY directory allowed to import idb-keyval (ESLint).
 * The sim never sees wall-clock meta (RestorableSaveDoc type discipline); the
 * scene layer talks to SaveManager + the boot machine (src/boot/**), never to
 * idb-keyval directly.
 */
export { IdbSaveStorage, MemorySaveStorage, SAVE_KEY_SLOT0 } from './save-storage';
export type { SaveStorage } from './save-storage';
export {
  advanceMeta,
  composeSaveDoc,
  createFreshMeta,
  toRestorable,
  validateSaveDoc,
} from './save-codec';
export type { ValidationResult } from './save-codec';
export {
  classifyRawSave,
  CURRENT_SAVE_VERSION,
  migrateRawSave,
  SAVE_MIGRATIONS,
} from './migrations';
export type { LoadClassification, MigrationOutcome, SaveMigration } from './migrations';
export { sanitizeSaveDoc } from './sanitize';
export type { SanitizeResult } from './sanitize';
export {
  applyImportedSave,
  downloadSaveDoc,
  exportFileName,
  exportSaveJson,
  parseImportedSave,
} from './export-import';
export type { ImportFailureStage, ImportResult } from './export-import';
export { SaveManager } from './save-manager';
export type { SaveFailure, SaveManagerOptions, SaveTrigger } from './save-manager';
