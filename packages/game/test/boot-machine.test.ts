import { describe, expect, it } from 'vitest';

import { runBootLoad, type BootDeps } from '../src/boot/boot-machine';
import { introLetterFor } from '../src/boot/new-game';
import { MemorySaveStorage } from '../src/storage/save-storage';
import { makeRestorable, makeSaveDoc, makeSaveDocV1 } from './helpers/save-fixture';

function deps(storage: MemorySaveStorage, overrides: Partial<BootDeps> = {}): BootDeps {
  return {
    storage,
    createNewGame: () => makeRestorable(),
    appVersion: '0.1.0',
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('runBootLoad (§10.4 state machine, M1 cut)', () => {
  it('empty slot → NEW_GAME: initial doc validated and written immediately', async () => {
    const storage = new MemorySaveStorage();
    const outcome = await runBootLoad(deps(storage));
    expect(outcome.state).toBe('running');
    if (outcome.state !== 'running') return;
    expect(outcome.isNewGame).toBe(true);
    expect(outcome.persisted).toBe(true);
    expect(outcome.doc.player.gold).toBe(100);
    expect(outcome.doc.meta.saveCount).toBe(1);
    await expect(storage.read()).resolves.toEqual(outcome.doc);
    // Onboarding: the porch letter is delivered unread on a fresh farm (§1.9).
    expect(introLetterFor(outcome.doc)).toEqual({ interactableId: 'intro_letter', unread: true });
  });

  it('valid current-version doc → VALIDATE → RUNNING (resume)', async () => {
    const storage = new MemorySaveStorage();
    const doc = makeSaveDoc();
    await storage.write(doc);
    const outcome = await runBootLoad(deps(storage));
    expect(outcome).toMatchObject({ state: 'running', isNewGame: false, persisted: true });
    if (outcome.state === 'running') expect(outcome.doc).toEqual(doc);
  });

  it('schema-invalid doc → RECOVERY, damaged data left in place', async () => {
    const storage = new MemorySaveStorage();
    const broken = { ...makeSaveDoc(), player: 'nope' };
    await storage.write(broken);
    const outcome = await runBootLoad(deps(storage));
    expect(outcome.state).toBe('recovery');
    if (outcome.state === 'recovery') expect(outcome.reason).toBe('schema');
    await expect(storage.read()).resolves.toEqual(broken); // never deleted (US94)
  });

  it('older version with no migration link → RECOVERY(migration)', async () => {
    const storage = new MemorySaveStorage();
    await storage.write({ schemaVersion: 0 }); // malformed (min version is 1)
    expect((await runBootLoad(deps(storage))).state).toBe('recovery');
  });

  it('v1 slot → MIGRATING → RUNNING with migration provenance (US37 retro seam)', async () => {
    const storage = new MemorySaveStorage();
    await storage.write(makeSaveDocV1());
    const outcome = await runBootLoad(deps(storage));
    expect(outcome.state).toBe('running');
    if (outcome.state !== 'running') return;
    expect(outcome.doc.schemaVersion).toBe(2);
    expect(outcome.migratedFromVersion).toBe(1);
  });

  it('current-version resume carries no migration provenance (US37 seam)', async () => {
    const storage = new MemorySaveStorage();
    await storage.write(makeSaveDoc());
    const outcome = await runBootLoad(deps(storage));
    expect(outcome.state).toBe('running');
    if (outcome.state === 'running') expect(outcome.migratedFromVersion).toBeUndefined();
  });

  it('newer version → TOO_NEW: read-only, never writes the slot', async () => {
    const storage = new MemorySaveStorage();
    const future = { ...makeSaveDoc(), schemaVersion: 3, fromTheFuture: true };
    await storage.write(future);
    const outcome = await runBootLoad(deps(storage));
    expect(outcome).toMatchObject({ state: 'too_new', foundVersion: 3 });
    await expect(storage.read()).resolves.toEqual(future);
  });

  it('storage read failure → RECOVERY(storage), not a crash', async () => {
    const storage = new MemorySaveStorage();
    storage.read = () => Promise.reject(new Error('idb exploded'));
    const outcome = await runBootLoad(deps(storage));
    expect(outcome).toMatchObject({ state: 'recovery', reason: 'storage' });
  });

  it('a failing first write still enters the game with persisted=false (gentle hint)', async () => {
    const storage = new MemorySaveStorage();
    storage.write = () => Promise.reject(new Error('quota'));
    const outcome = await runBootLoad(deps(storage));
    expect(outcome).toMatchObject({ state: 'running', isNewGame: true, persisted: false });
  });

  it('tolerant load surfaces §10.9 downgrade warnings on resume', async () => {
    const storage = new MemorySaveStorage();
    const restorable = makeRestorable();
    restorable.inventory.slots[3] = { itemId: 'item_from_v9', count: 1 };
    await storage.write(makeSaveDoc({}, restorable));
    const outcome = await runBootLoad(deps(storage));
    expect(outcome.state).toBe('running');
    if (outcome.state !== 'running') return;
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.doc.inventory.slots[3]).toBeNull();
  });
});
