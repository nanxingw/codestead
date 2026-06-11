/**
 * save-storage.ts — the persistence port of the storage layer.
 *
 * Architecture (PRD 01 / tech-stack §1): storage layer = `SaveStorage` interface
 * + idb-keyval implementation; the rest of the game talks to the interface only.
 * idb-keyval imports are ESLint-fenced to packages/game/src/storage/** (GDD §10.1).
 *
 * M1 scope ruling (GDD §10.1): single IndexedDB-backed slot under key `save:slot0`
 * in a dedicated store `createStore('codestead', 'kv')`. Backup rotation
 * (`save:slot0:backup`), corrupt evidence (`save:slot0:corrupt`), the
 * IDB → localStorage → memory degradation chain and Web Locks are all M5.
 * The slot dimension in the key is reserved for future multi-slot saves.
 */
import { createStore, del, get, set, type UseStore } from 'idb-keyval';

/** IDB key of the single M1 save slot (GDD §10.1 key table). */
export const SAVE_KEY_SLOT0 = 'save:slot0';

/**
 * Persistence port. Documents are stored as plain structured-clone objects
 * (no JSON stringification needed in IDB); a single-key put is atomic (§10.1).
 */
export interface SaveStorage {
  /** The raw stored document, or `undefined` when the slot is empty. */
  read(): Promise<unknown>;
  /** Overwrite the slot with `doc` (callers run the safeParse self-check first). */
  write(doc: unknown): Promise<void>;
  /** Empty the slot. M1 UI never deletes a save; kept for tests/future flows. */
  clear(): Promise<void>;
}

/** IndexedDB adapter (idb-keyval). Construction is cheap; the DB opens lazily. */
export class IdbSaveStorage implements SaveStorage {
  private readonly store: UseStore;
  private readonly key: string;

  constructor(key: string = SAVE_KEY_SLOT0) {
    this.store = createStore('codestead', 'kv');
    this.key = key;
  }

  read(): Promise<unknown> {
    return get<unknown>(this.key, this.store);
  }

  write(doc: unknown): Promise<void> {
    return set(this.key, doc, this.store);
  }

  clear(): Promise<void> {
    return del(this.key, this.store);
  }
}

/**
 * In-memory adapter — used by unit tests (Node has no IndexedDB) and reserved
 * as the last link of the M5 degradation chain (playable but lost on refresh).
 */
export class MemorySaveStorage implements SaveStorage {
  private doc: unknown = undefined;

  read(): Promise<unknown> {
    return Promise.resolve(this.doc);
  }

  write(doc: unknown): Promise<void> {
    this.doc = doc;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.doc = undefined;
    return Promise.resolve();
  }
}
