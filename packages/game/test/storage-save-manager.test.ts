import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaveDoc } from '@codestead/shared';

import { SaveManager, type SaveTrigger } from '../src/storage/save-manager';
import { MemorySaveStorage, type SaveStorage } from '../src/storage/save-storage';
import { TIME } from '../src/sim/data/constants';
import { makeMeta, makeRestorable } from './helpers/save-fixture';

function makeManager(opts: {
  storage?: SaveStorage;
  onSaved?: (info: { trigger: SaveTrigger }) => void;
  onSaveFailed?: () => void;
}) {
  const storage = opts.storage ?? new MemorySaveStorage();
  const manager = new SaveManager({
    storage,
    snapshot: () => makeRestorable(),
    meta: makeMeta({ saveCount: 1 }),
    appVersion: '0.1.0',
    now: () => Date.now(), // driven by vi fake timers
    onSaved: opts.onSaved,
    onSaveFailed: opts.onSaveFailed,
  });
  return { storage, manager };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SaveManager', () => {
  it('manual save writes a schema-valid doc and advances meta', async () => {
    const { storage, manager } = makeManager({});
    await expect(manager.saveNow('manual')).resolves.toBe(true);
    const doc = (await storage.read()) as SaveDoc;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.meta.saveCount).toBe(2);
    expect(manager.meta.saveCount).toBe(2);
  });

  it('blur path: debounced save lands within AUTOSAVE_DEBOUNCE_MS (§2.9 acceptance)', async () => {
    const saved: SaveTrigger[] = [];
    const { manager } = makeManager({ onSaved: ({ trigger }) => saved.push(trigger) });

    // Construction marks "now" — a blur right away waits out the 5s spacing.
    manager.requestDebouncedSave();
    manager.requestDebouncedSave(); // coalesces, no second timer
    expect(manager.hasPendingDebouncedSave).toBe(true);

    await vi.advanceTimersByTimeAsync(TIME.AUTOSAVE_DEBOUNCE_MS);
    expect(saved).toEqual(['blur']);
    expect(manager.hasPendingDebouncedSave).toBe(false);
  });

  it('keeps blur saves spaced ≥ AUTOSAVE_DEBOUNCE_MS apart', async () => {
    const saved: SaveTrigger[] = [];
    const { manager } = makeManager({ onSaved: ({ trigger }) => saved.push(trigger) });

    await vi.advanceTimersByTimeAsync(TIME.AUTOSAVE_DEBOUNCE_MS); // spacing window elapsed
    manager.requestDebouncedSave();
    await vi.advanceTimersByTimeAsync(0); // eligible immediately, ≥5s since last write
    expect(saved).toEqual(['blur']);

    manager.requestDebouncedSave(); // immediately after a write → must wait the full window
    await vi.advanceTimersByTimeAsync(TIME.AUTOSAVE_DEBOUNCE_MS - 1);
    expect(saved).toEqual(['blur']);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual(['blur', 'blur']);
  });

  it('hidden path: flushImmediate saves now and cancels a pending debounce', async () => {
    const saved: SaveTrigger[] = [];
    const { manager } = makeManager({ onSaved: ({ trigger }) => saved.push(trigger) });

    manager.requestDebouncedSave();
    await manager.flushImmediate();
    expect(saved).toEqual(['hidden']);
    expect(manager.hasPendingDebouncedSave).toBe(false);
    await vi.advanceTimersByTimeAsync(TIME.AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saved).toEqual(['hidden']); // the debounced save was truly cancelled
  });

  it('coalesces saves requested while a write is in flight into one follow-up', async () => {
    let writes = 0;
    let release: (() => void) | undefined;
    const slowStorage: SaveStorage = {
      read: () => Promise.resolve(undefined),
      write: () => {
        writes += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      clear: () => Promise.resolve(),
    };
    const { manager } = makeManager({ storage: slowStorage });

    const first = manager.saveNow('manual');
    void manager.saveNow('night'); // queued
    void manager.saveNow('hidden'); // merges into the same queued slot
    expect(writes).toBe(1);

    release?.();
    await first;
    await vi.advanceTimersByTimeAsync(0); // let the queued follow-up start
    expect(writes).toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toBe(2); // exactly one merged follow-up, not three writes
  });

  it('retries a failed write once, then reports an io failure (gentle export hint)', async () => {
    let attempts = 0;
    const failingStorage: SaveStorage = {
      read: () => Promise.resolve(undefined),
      write: () => {
        attempts += 1;
        return Promise.reject(new Error('QuotaExceeded'));
      },
      clear: () => Promise.resolve(),
    };
    const failures: unknown[] = [];
    const manager = new SaveManager({
      storage: failingStorage,
      snapshot: () => makeRestorable(),
      meta: makeMeta(),
      appVersion: '0.1.0',
      onSaveFailed: (info) => failures.push(info.failure),
    });

    await expect(manager.saveNow('night')).resolves.toBe(false);
    expect(attempts).toBe(2);
    expect(failures).toMatchObject([{ kind: 'io' }]);
    expect(manager.meta.saveCount).toBe(makeMeta().saveCount); // meta not advanced
  });

  it('a throwing snapshot degrades to onSaveFailed({kind:"io"}), not an unhandled throw (A-9)', async () => {
    const failures: { trigger: SaveTrigger; kind: string }[] = [];
    const storage = new MemorySaveStorage();
    const manager = new SaveManager({
      storage,
      snapshot: () => {
        throw new Error('serialize exploded mid-save');
      },
      meta: makeMeta({ saveCount: 1 }),
      appVersion: '0.1.0',
      now: () => Date.now(),
      onSaveFailed: ({ trigger, failure }) => failures.push({ trigger, kind: failure.kind }),
    });
    await expect(manager.saveNow('night')).resolves.toBe(false); // resolves, never rejects
    expect(failures).toEqual([{ trigger: 'night', kind: 'io' }]);
    expect(manager.meta.saveCount).toBe(1); // meta/playtime bookkeeping untouched
    // …and the manager still works once the snapshot recovers (next night save):
    const healthy = makeManager({});
    await expect(healthy.manager.saveNow('night')).resolves.toBe(true);
  });

  it('refuses to write a snapshot that fails the safeParse self-check', async () => {
    const storage = new MemorySaveStorage();
    await storage.write({ marker: 'previous good save' });
    const broken = makeRestorable();
    broken.player.gold = -1; // programming bug by contract
    const failures: unknown[] = [];
    const manager = new SaveManager({
      storage,
      snapshot: () => broken,
      meta: makeMeta(),
      appVersion: '0.1.0',
      onSaveFailed: (info) => failures.push(info.failure),
    });

    await expect(manager.saveNow('manual')).resolves.toBe(false);
    expect(failures).toMatchObject([{ kind: 'validation' }]);
    await expect(storage.read()).resolves.toEqual({ marker: 'previous good save' });
  });
});
