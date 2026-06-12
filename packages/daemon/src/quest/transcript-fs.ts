/**
 * fs-backed TranscriptTailReader (ai-quests §4.2 / §11-E6) — reads ONLY the
 * trailing `maxBytes` of a transcript jsonl, '' on any error (deleted / unreadable
 * / not a file). This is the SOLE real-fs leg of the transcript pipeline; the
 * parse + whitelist (extractContext) is the injected-pure part. The path is the
 * session's transcript_path (from the hook event) — never reconstructed.
 *
 * PRIVACY: the bytes read here are the user's transcript tail; they go STRAIGHT
 * into sanitize() in the same process and never touch a log or the wire.
 */
import { open, stat } from 'node:fs/promises';

import type { TranscriptTailReader } from './transcript-reader.js';

export function createTranscriptTailReader(): TranscriptTailReader {
  return {
    async readTail(path: string, maxBytes: number): Promise<string> {
      let size: number;
      try {
        const s = await stat(path);
        if (!s.isFile()) return '';
        size = s.size;
      } catch {
        return ''; // absent / unreadable — "no quest this tick", never a crash (§11-E6)
      }
      const from = Math.max(0, size - maxBytes);
      const length = size - from;
      if (length <= 0) return '';
      let fh;
      try {
        fh = await open(path, 'r');
      } catch {
        return '';
      }
      try {
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, from);
        // A mid-file start may clip a partial first line — extractContext is
        // line-tolerant (bad/partial lines are skipped), so no trimming here.
        return buf.toString('utf8');
      } catch {
        return '';
      } finally {
        await fh.close();
      }
    },
  };
}
