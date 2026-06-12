/**
 * Cost accounting + error log (ai-quests §4.5 / §10; verification A7).
 *
 * Two append-only journals under the injected quests dir (paths injected, never
 * the real ~/.codestead — hard rule):
 *  - `costs.jsonl`  one line per call: {ts, questId, model, totalCostUsd, durationMs, ok}
 *                   (totalCostUsd from the CLI envelope `total_cost_usd`, §4.5);
 *  - `errors.log`   invalidOutput raw sample (≤2KB) for排查 (§10).
 *
 * Files are 0600 (§12-4). SKELETON: record shapes + appender interface; the fs
 * appender (atomic-ish append + chmod) is implemented by the accounting sub-task.
 */
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AiQuestsConfig } from './config.js';

/** One costs.jsonl row (§4.5). */
export interface CostRecord {
  /** ISO 8601. */
  readonly ts: string;
  readonly questId: string | null; // null for a failed call that produced no quest
  readonly model: AiQuestsConfig['model'];
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly ok: boolean;
}

/** Truncation cap for the errors.log raw sample (§10 invalidOutput). */
export const ERROR_SAMPLE_MAX_BYTES = 2 * 1024;

/** Append-only journals; injected so tests point at a temp dir. */
export interface QuestJournals {
  /** Append one cost row (creates the file 0600 on first write). */
  appendCost(record: CostRecord): Promise<void>;
  /** Append a truncated (≤ERROR_SAMPLE_MAX_BYTES) error sample. */
  appendError(questId: string | null, rawSample: string): Promise<void>;
}

/** File mode for the journals (§12-4). */
const JOURNAL_FILE_MODE = 0o600;

/** Trim a raw sample to ≤ERROR_SAMPLE_MAX_BYTES (byte-accurate). */
function clampSample(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') <= ERROR_SAMPLE_MAX_BYTES) return raw;
  let s = raw.slice(0, ERROR_SAMPLE_MAX_BYTES);
  while (Buffer.byteLength(s, 'utf8') > ERROR_SAMPLE_MAX_BYTES) s = s.slice(0, -1);
  return s;
}

/**
 * fs-backed journals under the injected `questsDir` (never the real
 * ~/.codestead). `costs.jsonl` gets one JSON line per call; `errors.log` gets a
 * timestamped, byte-clamped raw sample. Both files are created 0600 (§12-4).
 *
 * PRIVACY: these journals carry NO transcript-derived content for costs (only
 * ids/numbers); errors.log carries a clamped RAW MODEL OUTPUT sample for排查 —
 * which is the model's own text, not the user's transcript — and lives 0600 in
 * the local data dir, never over the wire.
 */
export function createFileQuestJournals(questsDir: string): QuestJournals {
  const costsFile = join(questsDir, 'costs.jsonl');
  const errorsFile = join(questsDir, 'errors.log');

  async function appendLine(file: string, line: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line, { mode: JOURNAL_FILE_MODE });
    // appendFile's mode only applies on create; chmod defensively keeps 0600 even
    // if the file pre-existed with a wider mode.
    try {
      await chmod(file, JOURNAL_FILE_MODE);
    } catch {
      // best-effort — a chmod failure must not break accounting
    }
  }

  return {
    appendCost(record: CostRecord): Promise<void> {
      return appendLine(costsFile, `${JSON.stringify(record)}\n`);
    },
    appendError(questId: string | null, rawSample: string): Promise<void> {
      const entry = {
        ts: new Date().toISOString(),
        questId,
        sample: clampSample(rawSample),
      };
      return appendLine(errorsFile, `${JSON.stringify(entry)}\n`);
    },
  };
}
