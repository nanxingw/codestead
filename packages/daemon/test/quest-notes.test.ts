/**
 * Thinking-notes writer + backfill (ai-quests §7 / A8) — daemon-quest owner tests.
 * Asserts: the .md exists at notes/YYYY-MM-DD/<questId>.md, the body is byte-for-byte
 * the player's text, frontmatter fields are present, index.jsonl is appended, files
 * are 0600, and NoteBackfill listNotes/renderNote work (injectNote is absent in M4).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFileNotes, noteRelPath, type NoteFrontmatter } from '../src/quest/notes.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codestead-notes-'));
  dirs.push(d);
  return d;
}

const fm = (over: Partial<NoteFrontmatter> = {}): NoteFrontmatter => ({
  questId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  source: 'ai',
  kind: 'decision',
  npcId: 'npc_keeper',
  title: '登录失败往哪引',
  relatedSessionId: '53b273d5-9f1c-467b-aa8f-46f816bf61ef',
  relatedCwd: 'payments',
  contextEcho: '正在为登录服务设计失败重试策略',
  question: '登录失败之后，水往哪儿引？',
  options: [
    { id: 'a', label: '指数退避重试，封顶 5 次', chosen: true },
    { id: 'b', label: '立即熔断，亮灯等人' },
  ],
  reward: { gold: 120, xp: 60 },
  createdAt: '2026-06-12T09:12:31.000Z',
  answeredAt: '2026-06-12T09:15:02.000Z',
  ...over,
});

describe('createFileNotes — write (A8)', () => {
  it('writes notes/<date>/<questId>.md and returns its relative path', async () => {
    const dir = await tmp();
    const notes = createFileNotes(dir);
    const rel = await notes.writerFor('2026-06-12').write(fm(), 'my answer');
    expect(rel).toBe(noteRelPath('2026-06-12', fm().questId));
    const abs = join(dir, rel);
    await expect(stat(abs)).resolves.toBeDefined();
  });

  it('preserves the player body BYTE-FOR-BYTE after the frontmatter (A8)', async () => {
    const dir = await tmp();
    const body =
      '登录失败大多是瞬时网络问题，但要给熔断留口子：\n连续 5 次失败后亮灯转人工。\n\t缩进也要保留。';
    const rel = await createFileNotes(dir).writerFor('2026-06-12').write(fm(), body);
    const content = await readFile(join(dir, rel), 'utf8');
    // Everything after the closing `---\n\n` must equal the body exactly.
    const marker = '---\n\n';
    const idx = content.lastIndexOf(marker);
    expect(idx).toBeGreaterThan(0);
    expect(content.slice(idx + marker.length)).toBe(body);
  });

  it('frontmatter carries the §7.1 fields including chosen option flag', async () => {
    const dir = await tmp();
    const rel = await createFileNotes(dir).writerFor('2026-06-12').write(fm(), 'x');
    const content = await readFile(join(dir, rel), 'utf8');
    expect(content).toContain('questId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"');
    expect(content).toContain('source: "ai"');
    expect(content).toContain('kind: "decision"');
    expect(content).toContain('npcId: "npc_keeper"');
    expect(content).toContain('reward: { gold: 120, xp: 60 }');
    expect(content).toContain('chosen: true');
    expect(content).toContain('relatedCwd: "payments"'); // basename only (§12-3)
  });

  it('appends a structurally-identical row to index.jsonl (no body, with file relpath)', async () => {
    const dir = await tmp();
    const rel = await createFileNotes(dir).writerFor('2026-06-12').write(fm(), 'the body text');
    const index = await readFile(join(dir, 'index.jsonl'), 'utf8');
    const row = JSON.parse(index.trim()) as Record<string, unknown>;
    expect(row).toEqual({
      questId: fm().questId,
      relatedSessionId: fm().relatedSessionId,
      relatedCwd: 'payments',
      title: fm().title,
      answeredAt: fm().answeredAt,
      file: rel,
    });
    expect(JSON.stringify(row)).not.toContain('the body text'); // body never in the index
  });

  it('note files are mode 0600 (§7.1 / §12-4)', async () => {
    const dir = await tmp();
    const rel = await createFileNotes(dir).writerFor('2026-06-12').write(fm(), 'x');
    expect(await stat(join(dir, rel)).then((s) => s.mode & 0o777)).toBe(0o600);
    expect(await stat(join(dir, 'index.jsonl')).then((s) => s.mode & 0o777)).toBe(0o600);
  });

  it('a reflection note (no options) omits the options block', async () => {
    const dir = await tmp();
    const rel = await createFileNotes(dir)
      .writerFor('2026-06-12')
      .write(fm({ kind: 'reflection', options: undefined }), 'reflective answer');
    const content = await readFile(join(dir, rel), 'utf8');
    expect(content).not.toContain('options:');
  });
});

describe('createFileNotes — NoteBackfill (§7.2)', () => {
  it('listNotes returns all, then filters by sessionId / cwd / since', async () => {
    const dir = await tmp();
    const notes = createFileNotes(dir);
    await notes.writerFor('2026-06-10').write(
      fm({
        questId: 'q1',
        relatedSessionId: 'sess-A',
        relatedCwd: 'payA',
        answeredAt: '2026-06-10T00:00:00.000Z',
      }),
      'a',
    );
    await notes.writerFor('2026-06-12').write(
      fm({
        questId: 'q2',
        relatedSessionId: 'sess-B',
        relatedCwd: 'payB',
        answeredAt: '2026-06-12T00:00:00.000Z',
      }),
      'b',
    );
    expect(await notes.backfill.listNotes()).toHaveLength(2);
    expect((await notes.backfill.listNotes({ sessionId: 'sess-A' })).map((m) => m.questId)).toEqual(
      ['q1'],
    );
    expect((await notes.backfill.listNotes({ cwd: 'payB' })).map((m) => m.questId)).toEqual(['q2']);
    expect((await notes.backfill.listNotes({ since: '2026-06-11' })).map((m) => m.questId)).toEqual(
      ['q2'],
    );
  });

  it('renderNote returns the full note text for an existing questId', async () => {
    const dir = await tmp();
    const notes = createFileNotes(dir);
    await notes.writerFor('2026-06-12').write(fm({ questId: 'qX' }), 'my words');
    const rendered = await notes.backfill.renderNote('qX');
    expect(rendered).toContain('my words');
    expect(rendered).toContain('登录失败之后，水往哪儿引？');
  });

  it('renderNote rejects an unknown questId', async () => {
    const notes = createFileNotes(await tmp());
    await expect(notes.backfill.renderNote('missing')).rejects.toThrow();
  });

  it('injectNote is NOT part of the M4 backfill surface (§7.2 Out of Scope)', () => {
    const notes = createFileNotes('/unused');
    expect('injectNote' in notes.backfill).toBe(false);
  });
});
