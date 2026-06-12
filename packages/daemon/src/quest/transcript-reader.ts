/**
 * Transcript reader (ai-quests §4.2 / §11-E6) — extracts ONLY the safe subset of
 * a session's `<session_id>.jsonl` into a structured context, BEFORE sanitize().
 *
 * Field whitelist (§4.2):
 *   ✅ latest `ai-title`        → work theme
 *   ✅ latest `last-prompt`     → user's latest intent
 *   ✅ last 30 message lines: `user` (userType:"external", string content only)
 *       + `assistant` `text` blocks → discussion thread
 *   ❌ tool_use.input / tool_result / toolUseResult  (highest leak risk — DROP)
 *   ❌ thinking blocks, file-history-snapshot, attachments, system lines
 *
 * Robustness (§11-E6): read ONLY the trailing 256KB; parse line-by-line inside
 * try/catch (bad lines skipped); jsonl has NO stability guarantee, so the worst
 * outcome of any parse failure is "no quest this tick", never a crash.
 *
 * SKELETON: the extracted shape + reader interface (fs injected so tests use
 * fixtures, never the real ~/.claude). Body filled in by the transcript sub-task.
 */

/** Trailing bytes read from the transcript tail (§11-E6). */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** Window of recent message lines considered (§4.2). */
export const TRANSCRIPT_MESSAGE_WINDOW = 30;

/** One extracted conversational turn (already field-filtered, NOT yet sanitized). */
export interface TranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Whitelisted extraction from a transcript tail (§4.2). All fields pre-sanitize. */
export interface ExtractedContext {
  readonly title: string | null;
  readonly lastPrompt: string | null;
  readonly turns: readonly TranscriptTurn[];
}

/** Reads a bounded tail of a file; injected so tests never touch the real fs. */
export interface TranscriptTailReader {
  /** Read up to `maxBytes` from the END of `path`; '' on any error (§11-E6). */
  readTail(path: string, maxBytes: number): Promise<string>;
}

/**
 * Parse a transcript tail into the whitelisted ExtractedContext. PURE over the
 * raw text (the fs read is the injected reader's job). SKELETON — body per §4.2:
 * split lines, JSON.parse each in try/catch, keep only whitelisted kinds, take
 * the last TRANSCRIPT_MESSAGE_WINDOW messages, drop everything in the ❌ list.
 */
/** A jsonl line, already JSON.parsed into a record (or null if it was not an object). */
function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    // jsonl has NO stability guarantee (§11-E6): a bad line is skipped, never thrown.
    return null;
  }
}

/**
 * Extract the `text` of a user line IF it is a real external string input
 * (§4.2: userType:"external", content a plain string). Tool results and
 * structured content blocks are NOT real input → null (dropped). The transcript
 * carries the message under `message.content`; some lines also carry a top-level
 * `userType`. We require the content to be a STRING — array content means it is a
 * tool_result / attachment carrier and is dropped wholesale (highest leak risk).
 */
function externalUserText(rec: Record<string, unknown>): string | null {
  if (rec['userType'] !== 'external') return null;
  const message = rec['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  // Only a plain-string content is a real typed prompt; arrays carry tool_result
  // / images / other blocks which §4.2 drops entirely.
  return typeof content === 'string' ? content : null;
}

/**
 * Extract the concatenated `text` blocks of an assistant line (§4.2). Only
 * `type: 'text'` blocks are kept; `tool_use`, `thinking`, and anything else are
 * dropped. Returns null when the line yields no text.
 */
function assistantText(rec: Record<string, unknown>): string | null {
  const message = rec['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    // Keep ONLY text blocks; drop tool_use / thinking / etc. (§4.2 ❌ list).
    if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'] !== '') {
      parts.push(b['text']);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export function extractContext(tailText: string): ExtractedContext {
  let title: string | null = null;
  let lastPrompt: string | null = null;
  const allTurns: TranscriptTurn[] = [];

  // A mid-file tail read can clip the first line — drop the partial fragment so we
  // never JSON.parse half a record. (Callers pass the trailing 256KB.)
  const lines = tailText.split('\n');

  for (const line of lines) {
    const rec = parseLine(line);
    if (rec === null) continue;
    const kind = rec['type'];

    // ✅ latest ai-title / last-prompt metadata lines (§4.2). Latest wins → just
    // overwrite as we scan forward (tail is already chronological).
    if (kind === 'ai-title') {
      if (typeof rec['aiTitle'] === 'string') title = rec['aiTitle'];
      continue;
    }
    if (kind === 'last-prompt') {
      if (typeof rec['lastPrompt'] === 'string') lastPrompt = rec['lastPrompt'];
      continue;
    }

    // ✅ user (external string content) / assistant (text blocks). Everything else
    // — tool_use/tool_result/toolUseResult/thinking/file-history-snapshot/system —
    // is dropped by falling through (§4.2 ❌ list).
    if (kind === 'user') {
      const text = externalUserText(rec);
      if (text !== null && text !== '') allTurns.push({ role: 'user', text });
    } else if (kind === 'assistant') {
      const text = assistantText(rec);
      if (text !== null) allTurns.push({ role: 'assistant', text });
    }
  }

  // Keep only the last TRANSCRIPT_MESSAGE_WINDOW conversational turns (§4.2).
  const turns =
    allTurns.length > TRANSCRIPT_MESSAGE_WINDOW
      ? allTurns.slice(allTurns.length - TRANSCRIPT_MESSAGE_WINDOW)
      : allTurns;

  return { title, lastPrompt, turns };
}

/** Read + extract in one step using the injected reader (tail-bounded, §11-E6). */
export async function readTranscriptContext(
  reader: TranscriptTailReader,
  path: string,
): Promise<ExtractedContext> {
  const tail = await reader.readTail(path, TRANSCRIPT_TAIL_BYTES);
  return extractContext(tail);
}
