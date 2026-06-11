/**
 * File-backed DaemonRuntimeStore tests — always against a TEMP dir standing in
 * for ~/.codestead (hard rule: tests never touch the real one).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileDaemonRuntimeStore } from '../src/config/runtime-store.js';
import type { DaemonRuntimeInfo } from '../src/config/token.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codestead-home-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const info: DaemonRuntimeInfo = {
  port: 43110,
  wsPath: '/ws',
  token: 'tok-abc',
  daemonVersion: '0.1.0',
  pid: 4321,
};

describe('createFileDaemonRuntimeStore', () => {
  it('write → read roundtrips and creates parent dirs', async () => {
    const file = join(home, '.codestead', 'daemon.json');
    const store = createFileDaemonRuntimeStore(file);
    await store.write(info);
    expect(await store.read()).toEqual(info);
  });

  it('the file is owner-only (0600) — it contains the local token', async () => {
    const file = join(home, '.codestead', 'daemon.json');
    const store = createFileDaemonRuntimeStore(file);
    await store.write(info);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('read() is null for an absent, corrupted, or wrong-shape file', async () => {
    const file = join(home, '.codestead', 'daemon.json');
    const store = createFileDaemonRuntimeStore(file);
    expect(await store.read()).toBeNull(); // absent

    await store.write(info);
    await writeFile(file, 'not json {{{');
    expect(await store.read()).toBeNull(); // corrupted

    await writeFile(file, JSON.stringify({ port: 'not-a-number' }));
    expect(await store.read()).toBeNull(); // wrong shape
  });

  it('remove() deletes the advertisement and is idempotent (no stale daemon.json)', async () => {
    const file = join(home, '.codestead', 'daemon.json');
    const store = createFileDaemonRuntimeStore(file);
    await store.write(info);
    await store.remove();
    expect(await store.read()).toBeNull();
    await expect(store.remove()).resolves.toBeUndefined(); // already gone — fine
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});
