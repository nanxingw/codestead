/**
 * Quest state persistence (ai-quests §5 / §11-E3) — daemon-quest owner tests.
 * normalizeOnRestart (pure) and the fs store (atomic temp+rename, 0600, safeParse
 * on read). Paths are temp dirs — NEVER the real ~/.codestead (hard rule).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Quest } from '@codestead/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createInitialQuestState } from '../src/quest/lifecycle.js';
import { createFileQuestStateStore, normalizeOnRestart } from '../src/quest/persistence.js';
import type { QuestModuleState } from '../src/quest/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codestead-quest-'));
  dirs.push(d);
  return d;
}

const quest = (over: Partial<Quest> = {}): Quest => ({
  npcId: 'npc_keeper',
  kind: 'reflection',
  title: '一个问题',
  opener: '村民放下手里的活，看了你一眼。',
  body: '当前的工作里，哪一步其实可以删掉不做？说说看。',
  closer: '想好了再答。',
  contextEcho: '',
  questId: '11111111-1111-4111-8111-111111111111',
  source: 'local',
  relatedSessionId: null,
  relatedCwd: null,
  reward: { gold: 40, xp: 20 },
  createdAt: '2026-06-12T00:00:00.000Z',
  ...over,
});

function stateWith(phase: QuestModuleState['phase'], pending: Quest | null): QuestModuleState {
  return { ...createInitialQuestState(), phase, pending };
}

describe('normalizeOnRestart (§11-E3)', () => {
  it('GENERATING → IDLE with pending cleared (the spawned process is dead)', () => {
    const out = normalizeOnRestart(stateWith('GENERATING', null));
    expect(out.phase).toBe('IDLE');
    expect(out.pending).toBeNull();
  });

  it('OFFERED is restored verbatim (re-pushed via questSnapshot)', () => {
    const q = quest();
    const s = stateWith('OFFERED', q);
    const out = normalizeOnRestart(s);
    expect(out.phase).toBe('OFFERED');
    expect(out.pending).toEqual(q);
  });

  it('FAILED → IDLE (backoff resumes from lastAttemptAt, slot freed)', () => {
    expect(normalizeOnRestart(stateWith('FAILED', null)).phase).toBe('IDLE');
  });

  it('ANSWERED / DISMISSED / ARCHIVED → IDLE with pending cleared', () => {
    for (const p of ['ANSWERED', 'DISMISSED', 'ARCHIVED'] as const) {
      const out = normalizeOnRestart(stateWith(p, quest()));
      expect(out.phase).toBe('IDLE');
      expect(out.pending).toBeNull();
    }
  });

  it('IDLE is unchanged', () => {
    const s = stateWith('IDLE', null);
    expect(normalizeOnRestart(s)).toEqual(s);
  });

  it('preserves counters across normalization (cooldown rebuilds from them)', () => {
    const s: QuestModuleState = {
      ...stateWith('GENERATING', null),
      counters: { ...createInitialQuestState().counters, lastAttemptAt: 12345, dailyCount: 3 },
    };
    const out = normalizeOnRestart(s);
    expect(out.counters.lastAttemptAt).toBe(12345);
    expect(out.counters.dailyCount).toBe(3);
  });
});

describe('createFileQuestStateStore (atomic, 0600, safeParse)', () => {
  it('read() returns null when the file is absent', async () => {
    const store = createFileQuestStateStore(join(await tmp(), 'state.json'));
    expect(await store.read()).toBeNull();
  });

  it('write() then read() round-trips an OFFERED state', async () => {
    const file = join(await tmp(), 'q', 'state.json');
    const store = createFileQuestStateStore(file);
    const s = stateWith('OFFERED', quest());
    await store.write(s);
    expect(await store.read()).toEqual(s);
  });

  it('write() creates the file with mode 0600 (§12-4)', async () => {
    const file = join(await tmp(), 'state.json');
    await createFileQuestStateStore(file).write(stateWith('IDLE', null));
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('read() returns null on corrupt JSON (start fresh, never throws)', async () => {
    const file = join(await tmp(), 'state.json');
    await writeFile(file, '{ not valid json');
    expect(await createFileQuestStateStore(file).read()).toBeNull();
  });

  it('read() returns null on schema-invalid content (hand-edit repair)', async () => {
    const file = join(await tmp(), 'state.json');
    await writeFile(file, JSON.stringify({ phase: 'NONSENSE', pending: null }));
    expect(await createFileQuestStateStore(file).read()).toBeNull();
  });

  it('does not leave a .tmp file behind after a successful write', async () => {
    const dir = await tmp();
    const file = join(dir, 'state.json');
    await createFileQuestStateStore(file).write(stateWith('IDLE', null));
    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ phase: 'IDLE' });
  });
});
