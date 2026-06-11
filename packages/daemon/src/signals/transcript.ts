/**
 * Transcript signal source — fs.watch over the `<claudeProjectsDir>` jsonl
 * tree, i.e. `<encoded-cwd>/<session_id>.jsonl` files (priority 'transcript';
 * the Esc-interrupt blind-spot net, hud-sessions §7.3 rows 9–10,
 * tech-stack §4.1-2).
 *
 * Responsibilities:
 * - jsonl append → emit `transcriptAppend` (reducer applies it only when hooks
 *   are missing/stale — arbitration lives in the reducer, NOT here);
 * - tolerant parse of `ai-title` / `last-prompt` metadata lines for HUD
 *   title/subtitle (research/hooks.md §4.2). The jsonl format has NO stability
 *   guarantee (risk #6): every parse failure degrades to nulls, and the
 *   mtime/append signal itself never depends on line contents;
 * - silence (≥90s) is NOT detected here: the daemon's tick loop emits `tick`
 *   and the reducer applies row 10 against `lastSignalAt`.
 *
 * PRIVACY: only `ai-title` and a truncated `last-prompt` may leave this module
 * (they are wire fields). Raw transcript lines never appear in logs or events.
 *
 * All dependencies are injected — tests point `projectsDir` at a temp dir and
 * never touch the real `~/.claude` (hard rule).
 */
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import type { SessionEvent, TranscriptAppendEvent } from '../state/events.js';
import { IDLE_REAP_APPROX_MS } from '../state/types.js';
import type { SignalEmit, SignalSource } from './types.js';

export interface TranscriptWatchOptions {
  /** Injected `<home>/.claude/projects` equivalent (temp dir in tests). */
  readonly projectsDir: string;
  /** Clock used to stamp `at` on emitted events. */
  readonly now: () => number;
}

/**
 * Wire-payload bound for `subtitle` (truncated last-prompt). This is NOT the
 * display truncation (that is the HUD's, hud-sessions §2.2) — it only keeps
 * the WS payload small. Whole prompts never leave this module.
 */
export const SUBTITLE_MAX_CHARS = 120;

/** Tail window read per transcript during the restart rebuild scan (risk #6: bounded, tolerant). */
const REBUILD_TAIL_BYTES = 64 * 1024;

interface DisplayFields {
  title: string | null;
  subtitle: string | null;
}

/** Tolerant single-line parse — updates `fields` from `ai-title` / `last-prompt` metadata lines. */
function applyMetadataLine(line: string, fields: DisplayFields): void {
  const trimmed = line.trim();
  if (trimmed === '') return;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null) return;
    const rec = obj as Record<string, unknown>;
    if (rec['type'] === 'ai-title' && typeof rec['aiTitle'] === 'string') {
      fields.title = rec['aiTitle'];
    } else if (rec['type'] === 'last-prompt' && typeof rec['lastPrompt'] === 'string') {
      fields.subtitle = rec['lastPrompt'].slice(0, SUBTITLE_MAX_CHARS);
    }
  } catch {
    // jsonl has no stability guarantee (risk #6) — unparseable lines are ignored;
    // the append signal itself never depends on line contents.
  }
}

/** `<encoded-cwd>/<session_id>.jsonl` → session id; transcripts live exactly one level deep. */
function sessionIdOf(absPath: string): string {
  return basename(absPath, '.jsonl');
}

function isTranscriptRelPath(relPath: string): boolean {
  const parts = relPath.split(sep);
  return parts.length === 2 && parts[1] !== undefined && parts[1].endsWith('.jsonl');
}

/** Read bytes [from, to) of a file as UTF-8. */
async function readRange(absPath: string, from: number, to: number): Promise<string> {
  const fh = await open(absPath, 'r');
  try {
    const length = to - from;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, from);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** List absolute paths of all `<dir>/<encoded-cwd>/<session>.jsonl` files. Missing dir → []. */
async function listTranscripts(projectsDir: string): Promise<string[]> {
  const out: string[] = [];
  let groups;
  try {
    groups = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return out; // projects dir absent (Claude Code never ran) — nothing to watch yet.
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = join(projectsDir, group.name);
    try {
      const entries = await readdir(groupDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(groupDir, entry.name));
      }
    } catch {
      // Group vanished mid-scan — fine.
    }
  }
  return out;
}

export function createTranscriptWatchSource(opts: TranscriptWatchOptions): SignalSource {
  const { projectsDir, now } = opts;

  let watcher: FSWatcher | null = null;
  let emit: SignalEmit | null = null;
  /** Per-file read offset; primed to current size at start() so history is not re-read. */
  const offsets = new Map<string, number>();
  /** Latest tolerant title/subtitle per session — every append event carries the cache. */
  const display = new Map<string, DisplayFields>();
  /** Per-file serialization so overlapping fs.watch callbacks never interleave reads. */
  const queues = new Map<string, Promise<void>>();

  async function processAppend(absPath: string): Promise<void> {
    if (emit === null) return;
    let size: number;
    try {
      size = (await stat(absPath)).size;
    } catch {
      return; // deleted between event and stat
    }
    let offset = offsets.get(absPath) ?? 0;
    if (size < offset) offset = 0; // truncated/rotated — start over
    if (size === offset) return; // duplicate watch event, nothing appended
    let chunk: string;
    try {
      chunk = await readRange(absPath, offset, size);
    } catch {
      return;
    }

    // Consume COMPLETE lines only: the offset always advances to just past the
    // last '\n', so a half-written trailing line (or a multibyte char at the
    // read boundary) is re-read whole on the next event instead of being split.
    const lastNewline = chunk.lastIndexOf('\n');
    const completed = lastNewline === -1 ? '' : chunk.slice(0, lastNewline + 1);
    offsets.set(absPath, offset + Buffer.byteLength(completed, 'utf8'));

    const sessionId = sessionIdOf(absPath);
    const fields = display.get(sessionId) ?? { title: null, subtitle: null };
    for (const line of completed.split('\n')) applyMetadataLine(line, fields);
    display.set(sessionId, fields);

    const event: TranscriptAppendEvent = {
      kind: 'transcriptAppend',
      at: now(),
      sessionId,
      transcriptPath: absPath,
      title: fields.title,
      subtitle: fields.subtitle,
    };
    emit(event);
  }

  function enqueue(absPath: string): void {
    const prev = queues.get(absPath) ?? Promise.resolve();
    const next = prev.then(() => processAppend(absPath)).catch(() => undefined);
    queues.set(absPath, next);
  }

  return {
    name: 'transcript',

    async start(emitFn: SignalEmit): Promise<void> {
      emit = emitFn;
      // Prime offsets so the first real append does not replay history.
      // Historical titles/subtitles come from scanTranscriptsForRebuild instead.
      for (const file of await listTranscripts(projectsDir)) {
        try {
          offsets.set(file, (await stat(file)).size);
        } catch {
          // vanished mid-prime
        }
      }
      try {
        watcher = watch(projectsDir, { recursive: true }, (_eventType, filename) => {
          if (typeof filename !== 'string' || !isTranscriptRelPath(filename)) return;
          enqueue(join(projectsDir, filename));
        });
        watcher.on('error', () => {
          // Watcher died (dir removed, fd limits…) — source goes inert; the
          // hooks source remains the semantic main path (§7.4-1).
          watcher = null;
        });
      } catch {
        // projects dir absent — stay inert (no transcripts implies no sessions to cover).
        watcher = null;
      }
    },

    stop(): Promise<void> {
      watcher?.close();
      watcher = null;
      emit = null;
      return Promise.resolve();
    },
  };
}

/**
 * Daemon restart recovery (hud-sessions §7.4-4): scan transcript mtimes and
 * synthesize `transcriptAppend` events to rebuild the session table, after
 * which the server pushes a full `snapshot`. Pure with respect to the injected
 * fs facade; returns events in mtime order (ascending).
 *
 * Each event is stamped `at = mtime`, so the daemon's first `tick` immediately
 * applies the staleness rows (10/11) to long-silent sessions instead of waking
 * them all up as `working`. Files silent for ≥ IDLE_REAP_APPROX_MS are skipped
 * outright — the M2 first-cut reaper would deregister them on the same tick.
 */
export async function scanTranscriptsForRebuild(
  opts: TranscriptWatchOptions,
): Promise<SessionEvent[]> {
  const { projectsDir, now } = opts;
  const cutoff = now() - IDLE_REAP_APPROX_MS;

  const found: { mtimeMs: number; event: TranscriptAppendEvent }[] = [];
  for (const file of await listTranscripts(projectsDir)) {
    let mtimeMs: number;
    let size: number;
    try {
      const s = await stat(file);
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) continue;

    const fields: DisplayFields = { title: null, subtitle: null };
    try {
      const from = Math.max(0, size - REBUILD_TAIL_BYTES);
      const tail = await readRange(file, from, size);
      const lines = tail.split('\n');
      // A mid-file start clips the first line — drop the partial fragment.
      for (const line of from > 0 ? lines.slice(1) : lines) applyMetadataLine(line, fields);
    } catch {
      // Unreadable tail — the mtime signal alone still registers the session.
    }

    found.push({
      mtimeMs,
      event: {
        kind: 'transcriptAppend',
        at: Math.round(mtimeMs),
        sessionId: sessionIdOf(file),
        transcriptPath: file,
        title: fields.title,
        subtitle: fields.subtitle,
      },
    });
  }

  found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return found.map((f) => f.event);
}
