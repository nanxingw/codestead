/**
 * save-manager.ts — owns WHEN and HOW the save is written (GDD §10.4).
 *
 * M1 autosave triggers (GDD §10.1 ruling / §2.8):
 *   A  night settlement (NightUpdate #11) — unconditional, performed by THIS
 *      layer with the post-night state (`saveNow('night')`); a write failure
 *      never blocks the summary screen (gentle "export JSON" hint instead);
 *   B  tab hidden / window blur — hidden saves immediately
 *      (`flushImmediate()`), blur is debounced ≥5s (`requestDebouncedSave()`,
 *      TIME.AUTOSAVE_DEBOUNCE_MS; acceptance §2.9: blur lands on disk ≤5s);
 *   E  manual save (pause menu) — immediate (`saveNow('manual')`).
 * Triggers C/D/F (key events, 30s dirty sweep, pagehide) are M5.
 *
 * Write atomicity (GDD §10.4): immutable snapshot via SimApi.serialize()
 * (async write never pauses the sim) → safeParse self-check (failure =
 * programming bug, DO NOT write, previous good save survives) → single
 * in-flight write with queued-merge (a second request during a write coalesces
 * into exactly one follow-up write with a fresh snapshot). IDB failures retry
 * once, then surface the gentle export hint (§10.9; backup/corrupt keys M5).
 *
 * Wall clock here is allowed: autosave debounce is on the §2.4 real-time
 * whitelist, and `meta` is display-only by contract.
 */
import type { RestorableSaveDoc, SaveMeta } from '@codestead/shared';

import { TIME } from '../sim/data/constants';
import { advanceMeta, composeSaveDoc, validateSaveDoc } from './save-codec';
import type { SaveStorage } from './save-storage';

export type SaveTrigger = 'night' | 'blur' | 'hidden' | 'manual';

export type SaveFailure =
  /** safeParse self-check failed — programming bug; nothing was written. */
  | { kind: 'validation'; issues: string[] }
  /** Storage write failed after one retry — UI should offer JSON export. */
  | { kind: 'io'; error: unknown };

export interface SaveManagerOptions {
  storage: SaveStorage;
  /** Immutable snapshot provider — SimApi.serialize (meta-less by type). */
  snapshot: () => RestorableSaveDoc;
  /** Meta carried across the session (from boot: loaded doc or fresh new-game meta). */
  meta: SaveMeta;
  appVersion: string;
  /** Injectable wall clock (tests); defaults to Date.now. */
  now?: () => number;
  onSaved?: (info: { trigger: SaveTrigger; meta: SaveMeta }) => void;
  onSaveFailed?: (info: { trigger: SaveTrigger; failure: SaveFailure }) => void;
}

export class SaveManager {
  private readonly storage: SaveStorage;
  private readonly snapshot: () => RestorableSaveDoc;
  private readonly appVersion: string;
  private readonly now: () => number;
  private readonly onSaved?: SaveManagerOptions['onSaved'];
  private readonly onSaveFailed?: SaveManagerOptions['onSaveFailed'];

  private currentMeta: SaveMeta;
  /** Wall-clock ms of the last successful write (also the playtime accumulator mark). */
  private lastSavedAt: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private queuedTrigger: SaveTrigger | null = null;
  private disposed = false;

  constructor(options: SaveManagerOptions) {
    this.storage = options.storage;
    this.snapshot = options.snapshot;
    this.appVersion = options.appVersion;
    this.now = options.now ?? (() => Date.now());
    this.onSaved = options.onSaved;
    this.onSaveFailed = options.onSaveFailed;
    this.currentMeta = options.meta;
    this.lastSavedAt = this.now();
  }

  /** Display-only meta as of the last successful write. */
  get meta(): SaveMeta {
    return this.currentMeta;
  }

  /** True while a debounced (blur) save is scheduled but not yet executed. */
  get hasPendingDebouncedSave(): boolean {
    return this.debounceTimer !== null;
  }

  /**
   * Save immediately (night settlement / manual / hidden-flush). Cancels any
   * pending debounced save (it would be redundant). Resolves true on a
   * successful write; failures are reported via onSaveFailed and resolve false.
   */
  saveNow(trigger: SaveTrigger): Promise<boolean> {
    this.cancelDebounce();
    if (this.inFlight) {
      // Coalesce: exactly one follow-up write with a fresh snapshot (§10.4).
      this.queuedTrigger = trigger;
      return this.inFlight;
    }
    this.inFlight = this.performSave(trigger).finally(() => {
      this.inFlight = null;
      const queued = this.queuedTrigger;
      this.queuedTrigger = null;
      if (queued !== null && !this.disposed) void this.saveNow(queued);
    });
    return this.inFlight;
  }

  /**
   * Blur-path autosave: guaranteed to land within AUTOSAVE_DEBOUNCE_MS and
   * spaced ≥ AUTOSAVE_DEBOUNCE_MS from the previous write (GDD §10.4 trigger B).
   */
  requestDebouncedSave(): void {
    if (this.disposed || this.debounceTimer !== null) return;
    const wait = Math.max(0, this.lastSavedAt + TIME.AUTOSAVE_DEBOUNCE_MS - this.now());
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.saveNow('blur');
    }, wait);
  }

  /** Hidden-path autosave: immediate, no debounce (GDD §10.4 "hidden 立即"). */
  flushImmediate(): Promise<boolean> {
    return this.saveNow('hidden');
  }

  /** Unhook timers. Pending in-flight writes complete; queued follow-ups are dropped. */
  dispose(): void {
    this.disposed = true;
    this.cancelDebounce();
    this.queuedTrigger = null;
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async performSave(trigger: SaveTrigger): Promise<boolean> {
    // A throw from snapshot/advanceMeta/composeSaveDoc must degrade to the same
    // gentle onSaveFailed path as a storage error — never an unhandled rejection
    // that silently kills autosave (backlog A-9; §10.9 gentle-failure contract).
    let candidateMeta: SaveMeta;
    let doc: unknown;
    const now = this.now();
    try {
      candidateMeta = advanceMeta(this.currentMeta, {
        now,
        elapsedRealSeconds: (now - this.lastSavedAt) / 1000,
        appVersion: this.appVersion,
      });
      doc = composeSaveDoc(this.snapshot(), candidateMeta);
    } catch (error) {
      this.onSaveFailed?.({ trigger, failure: { kind: 'io', error } });
      return false;
    }

    const validated = validateSaveDoc(doc);
    if (!validated.ok) {
      // Programming bug by contract (GDD §10.4): keep the previous good save.
      this.onSaveFailed?.({ trigger, failure: { kind: 'validation', issues: validated.issues } });
      return false;
    }

    try {
      await this.writeWithRetry(validated.doc);
    } catch (error) {
      this.onSaveFailed?.({ trigger, failure: { kind: 'io', error } });
      return false;
    }

    // Commit meta/playtime bookkeeping only after the bytes actually landed.
    this.currentMeta = candidateMeta;
    this.lastSavedAt = now;
    this.onSaved?.({ trigger, meta: candidateMeta });
    return true;
  }

  /** One retry on failure (QuotaExceeded etc., §10.9); corrupt-key release is M5. */
  private async writeWithRetry(doc: unknown): Promise<void> {
    try {
      await this.storage.write(doc);
    } catch {
      await this.storage.write(doc);
    }
  }
}
