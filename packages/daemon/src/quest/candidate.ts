/**
 * Candidate-session selection (ai-quests §3.3) — PURE projection over the M2
 * session table + per-session prompt bookkeeping.
 *
 * Selection order (§3.3, first match wins):
 *  1. state === 'working' AND transcript mtime < 10 real minutes (fresh, §3.3-①);
 *  2. ≥2 new external prompts since this session was last quizzed (§3.3-②);
 *  3. multiple candidates → take the most-recent UserPromptSubmit; the session of
 *     the LAST quest is down-weighted (sorted after others) (§3.3-③);
 *  4. (the <300-char abandon is enforced AFTER sanitize, in the pipeline, §3.3-④).
 *
 * SKELETON: the input projection + signature. The body is filled in by the
 * candidate sub-task. This module is PURE — it takes a read-only view, no fs.
 */
import type { CandidateSession } from './trigger.js';
import { CANDIDATE_FRESHNESS_MS, MIN_NEW_PROMPTS } from './types.js';

/** One row of the candidate projection (subset of SessionInfo + bookkeeping). */
export interface CandidateRow {
  readonly sessionId: string;
  readonly cwd: string;
  readonly state: 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
  readonly transcriptPath: string | null;
  readonly transcriptMtimeMs: number | null;
  readonly newExternalPrompts: number;
  readonly lastPromptAtMs: number;
  readonly wasLastQuestSession: boolean;
}

/**
 * Pick the best candidate, or null if none qualifies (§3.3). PURE. `nowMs` feeds
 * the freshness gate (CANDIDATE_FRESHNESS_MS). SKELETON — body per §3.3 order;
 * the constants (CANDIDATE_FRESHNESS_MS / MIN_NEW_PROMPTS) are pinned in types.ts.
 */
export function selectCandidate(
  rows: readonly CandidateRow[],
  nowMs: number,
): CandidateSession | null {
  // Gate each row against §3.3 ①+② BEFORE ranking:
  //  ① state === 'working' AND transcript mtime within CANDIDATE_FRESHNESS_MS;
  //  ② ≥ MIN_NEW_PROMPTS new external prompts since last quizzed.
  // A row missing a transcript path can never be read → not a candidate.
  const eligible = rows.filter(
    (r) =>
      r.state === 'working' &&
      r.transcriptPath !== null &&
      r.transcriptMtimeMs !== null &&
      nowMs - r.transcriptMtimeMs < CANDIDATE_FRESHNESS_MS &&
      r.newExternalPrompts >= MIN_NEW_PROMPTS,
  );
  if (eligible.length === 0) return null;

  // ③ ranking: prefer rows that were NOT the last quest's session (down-weight the
  // repeat); within each group take the most-recent UserPromptSubmit. Stable: a
  // copy is sorted so the caller's array is never mutated.
  const ranked = [...eligible].sort((a, b) => {
    if (a.wasLastQuestSession !== b.wasLastQuestSession) {
      return a.wasLastQuestSession ? 1 : -1; // non-repeat first
    }
    return b.lastPromptAtMs - a.lastPromptAtMs; // most-recent prompt first
  });

  const top = ranked[0];
  if (top === undefined) return null;
  // top passed the ① gate so transcriptPath / transcriptMtimeMs are non-null.
  return {
    sessionId: top.sessionId,
    cwd: top.cwd,
    transcriptPath: top.transcriptPath as string,
    transcriptMtimeMs: top.transcriptMtimeMs as number,
    newExternalPrompts: top.newExternalPrompts,
    lastPromptAtMs: top.lastPromptAtMs,
    wasLastQuestSession: top.wasLastQuestSession,
  };
}
