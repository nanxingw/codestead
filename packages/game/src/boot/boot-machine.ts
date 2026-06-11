/**
 * boot-machine.ts — the §10.4 startup loading state machine (M1 cut).
 *
 *  BOOT (persist() fire-and-forget; Web Locks = M5) → LOADING
 *    ├─ empty → NEW_GAME (initial doc, written to disk immediately) → RUNNING
 *    └─ doc found:
 *       ├─ version == CURRENT → VALIDATE(safeParse) → RUNNING | RECOVERY
 *       ├─ version <  CURRENT → MIGRATING (on a copy; chain empty in M1) → RECOVERY
 *       └─ version >  CURRENT → TOO_NEW (read-only + export-only, never writes)
 *  RECOVERY (M1 two-option, low-pressure): [import JSON] [new farm] — the
 *  damaged data is NOT deleted (it stays in the slot until the player chooses).
 *
 * This module is scene-free: BootScene calls runBootLoad() and routes on the
 * outcome; the driver holds the 'boot_gate' pause source until the first
 * "back to the farm" click (which also unlocks audio autoplay, GDD §2.4/§11.6).
 */
import type { SaveDoc, RestorableSaveDoc } from '@codestead/shared';

import {
  advanceMeta,
  composeSaveDoc,
  createFreshMeta,
  validateSaveDoc,
} from '../storage/save-codec';
import { classifyRawSave, migrateRawSave } from '../storage/migrations';
import { sanitizeSaveDoc } from '../storage/sanitize';
import type { SaveStorage } from '../storage/save-storage';

export type RecoveryReason = 'parse' | 'schema' | 'migration' | 'storage';

export type BootOutcome =
  /** Ready to play. `persisted` is false only when the new-game first write failed (IDB). */
  | {
      state: 'running';
      doc: SaveDoc;
      isNewGame: boolean;
      persisted: boolean;
      /** Tolerant-load downgrade notes (§10.9) — surface gently, never a scary modal. */
      warnings: string[];
    }
  /** Low-pressure two-option screen: [import JSON] [new farm]; slot data untouched. */
  | { state: 'recovery'; reason: RecoveryReason; issues: string[] }
  /** Read-only + export-only; never write the slot, never migrate downward. */
  | { state: 'too_new'; foundVersion: number; raw: unknown };

export interface BootDeps {
  storage: SaveStorage;
  /**
   * New-game factory — the integrator wires `() => newGameSim(generateSeed(),
   * mapMeta).serialize()` (sim owns the §10.2 initial values: gold 100, day 1,
   * 6:00, spring, forced-sunny day 1, hoe/can in slots 0/1, spawn from MapMeta).
   */
  createNewGame: () => RestorableSaveDoc;
  appVersion: string;
  /** Injectable wall clock (meta is display-only); defaults to Date.now. */
  now?: () => number;
}

/**
 * Fire-and-forget persistent-storage request (GDD §10.1): being denied is
 * silent by design — no popup, JSON export remains the real backstop.
 */
export function requestPersistentStorage(): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => undefined);
    }
  } catch {
    // Never let a storage-permission quirk break boot.
  }
}

/** Run LOADING → outcome. Pure I/O orchestration; throws only on programming bugs. */
export async function runBootLoad(deps: BootDeps): Promise<BootOutcome> {
  requestPersistentStorage();
  const now = deps.now ?? (() => Date.now());

  let raw: unknown;
  try {
    raw = await deps.storage.read();
  } catch (error) {
    return {
      state: 'recovery',
      reason: 'storage',
      issues: [error instanceof Error ? error.message : 'failed to read save storage'],
    };
  }

  const classified = classifyRawSave(raw);
  switch (classified.kind) {
    case 'empty':
      return startNewGame(deps, now());
    case 'current':
      return validateAndRun(classified.raw);
    case 'older': {
      const migrated = migrateRawSave(classified.raw, classified.foundVersion);
      if (!migrated.ok) {
        return {
          state: 'recovery',
          reason: 'migration',
          issues: [`no migration path from save version ${classified.foundVersion}`],
        };
      }
      return validateAndRun(migrated.doc);
    }
    case 'too_new':
      return { state: 'too_new', foundVersion: classified.foundVersion, raw: classified.raw };
    case 'malformed':
      return {
        state: 'recovery',
        reason: 'parse',
        issues: ['stored data is not a Codestead save document'],
      };
  }
}

/**
 * NEW_GAME: build the initial doc and write it immediately (§10.4 "初始值建档
 * 立即写盘"). A failing first write still enters the game (M1: gentle export
 * hint, §10.1) — `persisted: false` tells the caller to show it.
 */
export async function startNewGame(deps: BootDeps, nowMs: number): Promise<BootOutcome> {
  const restorable = deps.createNewGame();
  const meta = advanceMeta(createFreshMeta({ appVersion: deps.appVersion, now: nowMs }), {
    now: nowMs,
    elapsedRealSeconds: 0,
  });
  const validated = validateSaveDoc(composeSaveDoc(restorable, meta));
  if (!validated.ok) {
    // A fresh save failing its own schema is a build defect, not a player state.
    throw new Error(`new-game save failed self-check: ${validated.issues.join('; ')}`);
  }
  let persisted = true;
  try {
    await deps.storage.write(validated.doc);
  } catch {
    persisted = false;
  }
  return { state: 'running', doc: validated.doc, isNewGame: true, persisted, warnings: [] };
}

function validateAndRun(raw: unknown): BootOutcome {
  const validated = validateSaveDoc(raw);
  if (!validated.ok) {
    return { state: 'recovery', reason: 'schema', issues: validated.issues };
  }
  const sanitized = sanitizeSaveDoc(validated.doc);
  return {
    state: 'running',
    doc: sanitized.doc,
    isNewGame: false,
    persisted: true,
    warnings: sanitized.warnings,
  };
}
