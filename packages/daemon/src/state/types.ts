/**
 * Daemon session state machine — state shapes & timing constants.
 *
 * Semantics source of truth: docs/design/hud-sessions.md §7 (state set §7.1,
 * transition table §7.3 — 14 rows, arbitration & staleness §7.4). The reducer
 * implementation MUST NOT add or remove transitions.
 */
import type { SessionInfo, SessionSource } from '@codestead/shared';

/**
 * Internal per-session record: the wire-visible SessionInfo plus daemon-only
 * bookkeeping. Only `info` ever crosses the WebSocket — transcript paths, pids
 * and any transcript CONTENT never do (privacy red line, PRD 03 Further Notes).
 */
export interface SessionRecord {
  readonly info: SessionInfo;
  /** From hook `transcript_path` or the restart rebuild scan; null until known. */
  readonly transcriptPath: string | null;
  /** OS pid once correlated by the ps source (M2-end, reaping); null before. */
  readonly pid: number | null;
}

/** Whole-daemon session table keyed by sessionId. Reducer input/output — immutable by convention. */
export type SessionTable = ReadonlyMap<string, SessionRecord>;

export const EMPTY_SESSION_TABLE: SessionTable = new Map<string, SessionRecord>();

// ---- Timing constants (values are design law — do not tune in code) ----

/** §7.3 row 10: working + transcript silent ≥90s and no blocked signal → done (Esc-interrupt blind-spot). */
export const TRANSCRIPT_SILENCE_TO_DONE_MS = 90_000;

/** §7.3 row 11 / §7.2-⑦: done untouched for 30 minutes → idle (daemon-side only; HUD never self-degrades). */
export const DONE_TO_IDLE_MS = 30 * 60_000;

/**
 * M2 FIRST-CUT ghost reaping (PRD 03 US19, hud-sessions §7 分期注记): until the
 * ps source lands at M2-end, a session idle for ≥12h is removed. Replaced by
 * process-gone reaping (§7.3 row 14) at M2-end.
 */
export const IDLE_REAP_APPROX_MS = 12 * 60 * 60_000;

/** §7.3 row 12: ps poll cadence (M2-end; daemon spawns `ps -axo …` itself, no ps-list). */
export const PS_POLL_INTERVAL_MS = 2_000;

/**
 * §7.4-1 arbitration: hooks > transcript > ps. A lower-priority signal may only
 * correct the state when every higher-priority source is missing or stale
 * (checked against the per-session `lastSignalAt`). `SessionInfo.source` always
 * records the highest-confidence origin of the CURRENT state.
 */
export const SOURCE_PRIORITY: Readonly<Record<SessionSource, number>> = {
  hooks: 2,
  transcript: 1,
  process: 0,
};
