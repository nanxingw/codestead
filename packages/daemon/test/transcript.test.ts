/**
 * Transcript signal source tests — fs.watch append detection + tolerant
 * ai-title/last-prompt parse + restart rebuild scan (hud-sessions §7.3 row 9,
 * §7.4-4). Everything runs against a TEMP projects dir: the real ~/.claude is
 * never touched (hard rule).
 */
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent, TranscriptAppendEvent } from '../src/state/events.js';
import type { SignalSource } from '../src/signals/types.js';
import {
  createTranscriptWatchSource,
  scanTranscriptsForRebuild,
  SUBTITLE_MAX_CHARS,
} from '../src/signals/transcript.js';

let projectsDir: string;
let source: SignalSource | null = null;

beforeEach(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), 'codestead-transcripts-'));
});

afterEach(async () => {
  await source?.stop();
  source = null;
  await rm(projectsDir, { recursive: true, force: true });
});

const jsonl = (...objects: unknown[]): string =>
  objects.map((o) => `${JSON.stringify(o)}\n`).join('');

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const appends = (events: SessionEvent[]): TranscriptAppendEvent[] =>
  events.filter((e): e is TranscriptAppendEvent => e.kind === 'transcriptAppend');

describe('createTranscriptWatchSource — jsonl append → transcriptAppend', () => {
  it('emits on append with tolerant title/subtitle parse; history is primed, not replayed', async () => {
    const group = join(projectsDir, '-Users-me-proj');
    await mkdir(group, { recursive: true });
    const file = join(group, 'sess-watch-1.jsonl');
    await writeFile(file, jsonl({ type: 'ai-title', aiTitle: 'OLD-TITLE' }));

    const events: SessionEvent[] = [];
    source = createTranscriptWatchSource({ projectsDir, now: () => 4242 });
    await source.start((event) => events.push(event));

    await sleep(120);
    expect(events).toEqual([]); // pre-existing content does not replay at start

    await appendFile(
      file,
      jsonl(
        { type: 'ai-title', aiTitle: '重构 hud store' },
        { type: 'last-prompt', lastPrompt: 'p'.repeat(SUBTITLE_MAX_CHARS + 200) },
        { type: 'assistant', message: { content: [] } },
      ),
    );

    await until(() => appends(events).length >= 1);
    const event = appends(events)[0];
    expect(event).toMatchObject({
      kind: 'transcriptAppend',
      at: 4242,
      sessionId: 'sess-watch-1',
      transcriptPath: file,
      title: '重构 hud store',
    });
    expect(event?.subtitle).toHaveLength(SUBTITLE_MAX_CHARS);
  });

  it('a new session file appearing after start emits with null display fields', async () => {
    const group = join(projectsDir, '-Users-me-proj');
    await mkdir(group, { recursive: true });

    const events: SessionEvent[] = [];
    source = createTranscriptWatchSource({ projectsDir, now: () => 1 });
    await source.start((event) => events.push(event));

    const file = join(group, 'sess-new-2.jsonl');
    await writeFile(file, jsonl({ type: 'user', message: { role: 'user', content: 'hi' } }));

    await until(() => appends(events).some((e) => e.sessionId === 'sess-new-2'));
    expect(appends(events).find((e) => e.sessionId === 'sess-new-2')).toMatchObject({
      title: null,
      subtitle: null,
      transcriptPath: file,
    });
  });

  it('unparseable lines and non-transcript files are ignored without dying', async () => {
    const group = join(projectsDir, '-Users-me-proj');
    await mkdir(join(group, 'sess-deep', 'subagents'), { recursive: true });

    const events: SessionEvent[] = [];
    source = createTranscriptWatchSource({ projectsDir, now: () => 2 });
    await source.start((event) => events.push(event));

    // Nested (depth ≠ 2) jsonl and non-jsonl files never emit.
    await writeFile(join(group, 'sess-deep', 'subagents', 'x.jsonl'), jsonl({ type: 'user' }));
    await writeFile(join(group, 'notes.txt'), 'not a transcript');

    // A garbage line still counts as an append signal (mtime semantics, risk #6)…
    const file = join(group, 'sess-tolerant.jsonl');
    await writeFile(file, 'this is } not json\n');
    await until(() => appends(events).some((e) => e.sessionId === 'sess-tolerant'));

    // …and only the real transcript emitted.
    expect(appends(events).map((e) => e.sessionId)).toEqual(['sess-tolerant']);
    expect(appends(events)[0]).toMatchObject({ title: null, subtitle: null });
  });

  it('a missing projects dir leaves the source inert instead of throwing', async () => {
    source = createTranscriptWatchSource({
      projectsDir: join(projectsDir, 'does-not-exist'),
      now: () => 3,
    });
    await expect(source.start(() => undefined)).resolves.toBeUndefined();
  });
});

describe('scanTranscriptsForRebuild — restart recovery (hud-sessions §7.4-4)', () => {
  it('synthesizes transcriptAppend events in mtime order, stamped at = mtime, tail-parsed', async () => {
    const now = Date.now();
    const group = join(projectsDir, '-Users-me-proj');
    await mkdir(group, { recursive: true });

    const older = join(group, 'sess-older.jsonl');
    await writeFile(
      older,
      jsonl({ type: 'ai-title', aiTitle: '旧会话' }, { type: 'last-prompt', lastPrompt: 'old' }),
    );
    await utimes(older, new Date(now - 600_000), new Date(now - 600_000)); // 10 min ago

    const fresh = join(group, 'sess-fresh.jsonl');
    await writeFile(
      fresh,
      `not json line\n${jsonl(
        { type: 'ai-title', aiTitle: '新会话' },
        { type: 'last-prompt', lastPrompt: 'q'.repeat(SUBTITLE_MAX_CHARS + 50) },
      )}`,
    );
    await utimes(fresh, new Date(now - 60_000), new Date(now - 60_000)); // 1 min ago

    const events = appends(await scanTranscriptsForRebuild({ projectsDir, now: () => now }));
    expect(events.map((e) => e.sessionId)).toEqual(['sess-older', 'sess-fresh']);

    expect(events[0]).toMatchObject({ title: '旧会话', subtitle: 'old', transcriptPath: older });
    expect(events[0]?.at).toBeGreaterThanOrEqual(now - 600_000 - 1000);
    expect(events[0]?.at).toBeLessThanOrEqual(now - 600_000 + 1000);

    expect(events[1]?.title).toBe('新会话');
    expect(events[1]?.subtitle).toHaveLength(SUBTITLE_MAX_CHARS);
  });

  it('skips transcripts silent ≥12h (the first-cut reaper would deregister them on the next tick)', async () => {
    const now = Date.now();
    const group = join(projectsDir, '-Users-me-proj');
    await mkdir(group, { recursive: true });

    const ancient = join(group, 'sess-ancient.jsonl');
    await writeFile(ancient, jsonl({ type: 'ai-title', aiTitle: 'ghost' }));
    const thirteenHoursAgo = new Date(now - 13 * 60 * 60_000);
    await utimes(ancient, thirteenHoursAgo, thirteenHoursAgo);

    const alive = join(group, 'sess-alive.jsonl');
    await writeFile(alive, jsonl({ type: 'ai-title', aiTitle: 'alive' }));

    const events = appends(await scanTranscriptsForRebuild({ projectsDir, now: () => now }));
    expect(events.map((e) => e.sessionId)).toEqual(['sess-alive']);
  });

  it('returns [] for a missing projects dir', async () => {
    const events = await scanTranscriptsForRebuild({
      projectsDir: join(projectsDir, 'nope'),
      now: () => Date.now(),
    });
    expect(events).toEqual([]);
  });
});
