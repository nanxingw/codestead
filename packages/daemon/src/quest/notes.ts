/**
 * Thinking-notes writer + backfill interface (ai-quests §7; verification A8).
 *
 * On every ANSWERED quest, write ONE Markdown file
 * `~/.codestead/notes/YYYY-MM-DD/<questId>.md` (YYYY-MM-DD = local answer date)
 * with a YAML frontmatter (NoteFrontmatter below) + the player's words verbatim,
 * AND append one structurally-identical JSON line (no body, with `file` relpath)
 * to `~/.codestead/notes/index.jsonl`. Both writes are atomic; mode 0600 (§7.1).
 *
 * Privacy (§7.1 / §12-3): the note BODY is the player's text typed in-game; it
 * flows daemon-ward over WS (inward) and lands on disk — it NEVER leaves the
 * machine, and the WS reward回执 carries only questId.
 *
 * SKELETON: frontmatter shape, writer + NoteBackfill interfaces, and the §7.2
 * note path helper. The fs writer (atomic md + jsonl append, chmod) is the notes
 * sub-task; `injectNote` stays UNIMPLEMENTED in M4 (留接口, §7.2 / Out of Scope).
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { NpcId, QuestKind, QuestReward, QuestSource } from '@codestead/shared';

/** YAML frontmatter of a note file (§7.1 field list). */
export interface NoteFrontmatter {
  readonly questId: string;
  readonly source: QuestSource;
  readonly kind: QuestKind;
  readonly npcId: NpcId;
  readonly title: string;
  readonly relatedSessionId: string | null;
  readonly relatedCwd: string | null;
  readonly contextEcho: string;
  /** Question body as posed to the player. */
  readonly question: string;
  /** decision options with the chosen flag; absent for reflection (§7.1 example). */
  readonly options?: readonly { id: string; label: string; chosen?: boolean }[];
  readonly reward: QuestReward;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly answeredAt: string;
}

/** Compact note metadata (the index.jsonl row + NoteBackfill.listNotes result, §7.2). */
export interface NoteMeta {
  readonly questId: string;
  readonly relatedSessionId: string | null;
  readonly relatedCwd: string | null;
  readonly title: string;
  readonly answeredAt: string;
  /** Relative path under notes/, e.g. `2026-06-10/<questId>.md`. */
  readonly file: string;
}

/** Build the note relative path `YYYY-MM-DD/<questId>.md` from a local answer date (§7.1). */
export function noteRelPath(localDate: string, questId: string): string {
  return `${localDate}/${questId}.md`;
}

/** Writer for the two note artifacts (injected paths; tests use a temp dir). */
export interface NotesWriter {
  /**
   * Write the .md (frontmatter + body verbatim) and append the index.jsonl row,
   * both atomic + 0600. Returns the relative file path (→ noteRef / save noteRefs).
   * Throw on fs failure so the caller can withhold the reward (§11-E11 — no
   * note白拿奖励). SKELETON — body by the notes sub-task.
   */
  write(frontmatter: NoteFrontmatter, body: string): Promise<string>;
}

/**
 * Note backfill接口 (§7.2). M4 implements listNotes + renderNote; injectNote is
 * deliberately ABSENT in M4 (自动回填 deferred until per-note user confirmation
 * exists, §7.2 / Out of Scope). M5+ adds injectNote via `claude --resume` or a
 * project-local notes file — both gated on per-note opt-in.
 */
export interface NoteBackfill {
  /** List note metas, optionally filtered by session / cwd / since-date (§7.2). */
  listNotes(filter?: {
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly since?: string;
  }): Promise<NoteMeta[]>;
  /** Render a note as an injectable text block (question + options + answer) (§7.2). */
  renderNote(questId: string): Promise<string>;
  // injectNote(questId): NOT in M4 — see header.
}

/** File mode for note artifacts (§7.1 / §12-4). */
const NOTE_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// YAML frontmatter serialization (hand-rolled — no yaml dep; runtime deps stay
// ws + zod only). The body is written BYTE-FOR-BYTE verbatim after the closing
// `---`; only frontmatter values are escaped.
// ---------------------------------------------------------------------------

/** Quote a scalar as a YAML double-quoted string (safe for any text). */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** A scalar value line for `key: value`, picking quoting by type. */
function yamlScalar(value: string | number | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  return yamlString(value);
}

/** Serialize the frontmatter to the §7.1 layout (block question + inline option list). */
function renderFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`questId: ${yamlScalar(fm.questId)}`);
  lines.push(`source: ${yamlScalar(fm.source)}`);
  lines.push(`kind: ${yamlScalar(fm.kind)}`);
  lines.push(`npcId: ${yamlScalar(fm.npcId)}`);
  lines.push(`title: ${yamlScalar(fm.title)}`);
  lines.push(`relatedSessionId: ${yamlScalar(fm.relatedSessionId)}`);
  lines.push(`relatedCwd: ${yamlScalar(fm.relatedCwd)}`);
  lines.push(`contextEcho: ${yamlScalar(fm.contextEcho)}`);
  // Question as a YAML block scalar so newlines survive (§7.1 example uses `|`).
  lines.push('question: |');
  for (const qline of fm.question.split('\n')) lines.push(`  ${qline}`);
  if (fm.options !== undefined && fm.options.length > 0) {
    lines.push('options:');
    for (const opt of fm.options) {
      const chosen = opt.chosen === true ? ', chosen: true' : '';
      lines.push(`  - { id: ${opt.id}, label: ${yamlString(opt.label)}${chosen} }`);
    }
  }
  lines.push(`reward: { gold: ${String(fm.reward.gold)}, xp: ${String(fm.reward.xp)} }`);
  lines.push(`createdAt: ${yamlScalar(fm.createdAt)}`);
  lines.push(`answeredAt: ${yamlScalar(fm.answeredAt)}`);
  lines.push('---');
  return lines.join('\n');
}

/** Build the index.jsonl row (no body, with `file` relpath, §7.1). */
function indexRow(fm: NoteFrontmatter, file: string): NoteMeta {
  return {
    questId: fm.questId,
    relatedSessionId: fm.relatedSessionId,
    relatedCwd: fm.relatedCwd,
    title: fm.title,
    answeredAt: fm.answeredAt,
    file,
  };
}

/** Atomic write (temp + rename), mode 0600. */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await writeFile(tmp, content, { mode: NOTE_FILE_MODE });
  await rename(tmp, file);
}

/**
 * fs-backed notes writer + backfill rooted at the injected `notesDir` (never the
 * real ~/.codestead). Writes `<notesDir>/<YYYY-MM-DD>/<questId>.md` (frontmatter +
 * body verbatim) AND appends one structurally-identical JSON line to
 * `<notesDir>/index.jsonl`; both 0600 (§7.1). The .md is atomic (temp+rename);
 * the index append is best-effort-ordered after the .md so a crash leaves the
 * file present and the index re-derivable.
 *
 * `localDate` (YYYY-MM-DD, machine tz) is INJECTED by the caller so this stays
 * deterministic and never reads a clock.
 */
export function createFileNotes(notesDir: string): {
  writerFor(localDate: string): NotesWriter;
  backfill: NoteBackfill;
} {
  const indexFile = join(notesDir, 'index.jsonl');

  function writerFor(localDate: string): NotesWriter {
    return {
      async write(frontmatter: NoteFrontmatter, body: string): Promise<string> {
        const rel = noteRelPath(localDate, frontmatter.questId);
        const absMd = join(notesDir, rel);
        // Frontmatter + a blank line + the player's words verbatim (no trailing
        // mutation — A8 requires byte-for-byte body fidelity).
        const content = `${renderFrontmatter(frontmatter)}\n\n${body}`;
        await atomicWrite(absMd, content);
        // index.jsonl append (atomic at the line granularity via O_APPEND). The
        // .md write is the authoritative artifact; the index is a derived cache.
        await mkdir(dirname(indexFile), { recursive: true });
        await appendFile(indexFile, `${JSON.stringify(indexRow(frontmatter, rel))}\n`, {
          mode: NOTE_FILE_MODE,
        });
        return rel;
      },
    };
  }

  async function readIndex(): Promise<NoteMeta[]> {
    let raw: string;
    try {
      raw = await readFile(indexFile, 'utf8');
    } catch {
      return [];
    }
    const out: NoteMeta[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const obj: unknown = JSON.parse(trimmed);
        if (typeof obj === 'object' && obj !== null) out.push(obj as NoteMeta);
      } catch {
        // tolerant — a bad index line is skipped, the .md files remain authoritative
      }
    }
    return out;
  }

  const backfill: NoteBackfill = {
    async listNotes(filter): Promise<NoteMeta[]> {
      const all = await readIndex();
      if (filter === undefined) return all;
      return all.filter((m) => {
        if (filter.sessionId !== undefined && m.relatedSessionId !== filter.sessionId) return false;
        if (filter.cwd !== undefined && m.relatedCwd !== filter.cwd) return false;
        if (filter.since !== undefined && m.answeredAt < filter.since) return false;
        return true;
      });
    },

    async renderNote(questId: string): Promise<string> {
      const metas = await readIndex();
      const meta = metas.find((m) => m.questId === questId);
      if (meta === undefined) {
        throw new Error(`note not found: ${questId}`);
      }
      // Render the full .md (frontmatter + body) as the injectable text block; M5+
      // injectNote will distil this further, but renderNote returns the source of
      // truth so the caller decides how much to inject (§7.2).
      return readFile(join(notesDir, meta.file), 'utf8');
    },
  };

  return { writerFor, backfill };
}
