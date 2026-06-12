/**
 * Candidate-session selection (ai-quests §3.3) — daemon-quest owner tests.
 * Pins the §3.3 selection order: working+fresh gate (①), ≥2 new external prompts
 * (②), recency + last-quest-session down-weight ranking (③). PURE projection, no fs.
 */
import { describe, expect, it } from 'vitest';

import { selectCandidate, type CandidateRow } from '../src/quest/candidate.js';
import { CANDIDATE_FRESHNESS_MS, MIN_NEW_PROMPTS } from '../src/quest/types.js';

const NOW = 1_000_000_000;

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    sessionId: 's1',
    cwd: '/home/me/work/payments',
    state: 'working',
    transcriptPath: '/t/s1.jsonl',
    transcriptMtimeMs: NOW - 1000,
    newExternalPrompts: MIN_NEW_PROMPTS,
    lastPromptAtMs: NOW - 1000,
    wasLastQuestSession: false,
    ...over,
  };
}

describe('selectCandidate (§3.3 selection order)', () => {
  it('returns null on an empty table', () => {
    expect(selectCandidate([], NOW)).toBeNull();
  });

  it('① rejects non-working sessions', () => {
    for (const state of ['blocked', 'done', 'idle', 'unknown'] as const) {
      expect(selectCandidate([row({ state })], NOW)).toBeNull();
    }
  });

  it('① rejects a stale transcript (mtime ≥ 10 real minutes ago)', () => {
    const stale = row({ transcriptMtimeMs: NOW - CANDIDATE_FRESHNESS_MS - 1 });
    expect(selectCandidate([stale], NOW)).toBeNull();
    // exactly at the boundary is still stale (strict <)
    const atBoundary = row({ transcriptMtimeMs: NOW - CANDIDATE_FRESHNESS_MS });
    expect(selectCandidate([atBoundary], NOW)).toBeNull();
    const fresh = row({ transcriptMtimeMs: NOW - CANDIDATE_FRESHNESS_MS + 1 });
    expect(selectCandidate([fresh], NOW)?.sessionId).toBe('s1');
  });

  it('① rejects a session with no transcript path / mtime', () => {
    expect(selectCandidate([row({ transcriptPath: null })], NOW)).toBeNull();
    expect(selectCandidate([row({ transcriptMtimeMs: null })], NOW)).toBeNull();
  });

  it('② requires ≥ MIN_NEW_PROMPTS new external prompts since last quizzed', () => {
    expect(selectCandidate([row({ newExternalPrompts: MIN_NEW_PROMPTS - 1 })], NOW)).toBeNull();
    expect(selectCandidate([row({ newExternalPrompts: MIN_NEW_PROMPTS })], NOW)?.sessionId).toBe(
      's1',
    );
  });

  it('③ takes the most-recent UserPromptSubmit among eligible candidates', () => {
    const older = row({ sessionId: 'old', lastPromptAtMs: NOW - 5000 });
    const newer = row({ sessionId: 'new', lastPromptAtMs: NOW - 100 });
    expect(selectCandidate([older, newer], NOW)?.sessionId).toBe('new');
  });

  it('③ down-weights the last-quest session below an equally-eligible other', () => {
    // The repeat session has a MORE recent prompt but is down-weighted, so the
    // non-repeat wins (§3.3-③).
    const repeat = row({
      sessionId: 'repeat',
      lastPromptAtMs: NOW - 10,
      wasLastQuestSession: true,
    });
    const other = row({ sessionId: 'other', lastPromptAtMs: NOW - 5000 });
    expect(selectCandidate([repeat, other], NOW)?.sessionId).toBe('other');
  });

  it('falls back to the repeat session when it is the only eligible one', () => {
    const repeat = row({ sessionId: 'repeat', wasLastQuestSession: true });
    expect(selectCandidate([repeat], NOW)?.sessionId).toBe('repeat');
  });

  it('does not mutate the input array', () => {
    const rows = [
      row({ sessionId: 'a', lastPromptAtMs: 1 }),
      row({ sessionId: 'b', lastPromptAtMs: 9 }),
    ];
    const copy = [...rows];
    selectCandidate(rows, NOW);
    expect(rows).toEqual(copy);
  });

  it('projects the full CandidateSession shape from the winning row', () => {
    const c = selectCandidate([row()], NOW);
    expect(c).toEqual({
      sessionId: 's1',
      cwd: '/home/me/work/payments',
      transcriptPath: '/t/s1.jsonl',
      transcriptMtimeMs: NOW - 1000,
      newExternalPrompts: MIN_NEW_PROMPTS,
      lastPromptAtMs: NOW - 1000,
      wasLastQuestSession: false,
    });
  });
});
