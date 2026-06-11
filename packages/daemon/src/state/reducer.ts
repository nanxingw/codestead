/**
 * Session reducer — THE highest-value test seam of M2 (PRD 03 testing decision 1).
 *
 * Contract:
 * - hand-written PURE function `(table, event) => table` — no clock, no fs, no
 *   network; time arrives on the event (`at`), randomness does not exist here;
 * - implements EXACTLY the 14-row transition table of hud-sessions §7.3
 *   (event kinds in ./events.ts) plus the four arbitration/staleness rules
 *   of §7.4:
 *     1. source priority hooks > transcript > process (SOURCE_PRIORITY) —
 *        lower-priority signals only correct when higher ones are missing/stale;
 *     2. idempotent transitions — a same-state event refreshes `lastSignalAt`
 *        but NEVER resets `since` (“已工作 47m” must survive heartbeats);
 *     3. staleness discipline — working silent ≥90s → done (row 10), done
 *        ≥30min → idle (row 11), blocked never expires; M2 first-cut: idle ≥12h
 *        → deregister (PRD 03 US19). With ps reaping live (M2-end) the idle
 *        reap applies ONLY to records with pid === null (cwd collection failed
 *        — no ps row could be associated, hud-sessions §7 分期注记/§13-11):
 *        live idle sessions with an associated pid are never delisted, and a
 *        mis-reaped session returns via the per-poll ps re-discovery (unknown)
 *        or its next hook/transcript signal;
 *     4. restart recovery is NOT in the reducer: the transcript source replays
 *        a scan as events (§7.4-4), then the server pushes a full snapshot —
 *        reducer-side, those scan events take the ordinary row-9 path.
 *
 * Implementation law (decisions encoded below; any change goes through the
 * design docs first):
 * - Session identity: `sessionId` is the table key (hooks/transcript carry the
 *   real id; ps-discovered sessions get a synthetic `ps-<pid>` id until row 13
 *   merges them). `cwd` is display/correlation data only, '' when unknown
 *   (hud-sessions §12-D2-A3 — the HUD owns the fallback chain, §2.1).
 * - Register-then-apply: hook events for unregistered sessions register the
 *   session AND apply their semantics (self-healing after missed events,
 *   research/hooks.md §5.3) — e.g. a lone `Stop` registers the session as done.
 * - Row 1 explicitly resets `since` (“注册会话；重置 since”) — this row-level
 *   note takes precedence over the generic idempotence rule for idle→idle.
 * - Row 6 has a restricted from-set (working/blocked, plus unknown via row 13):
 *   on a REGISTERED idle session, Stop only refreshes `lastSignalAt`.
 * - `lastSignalAt` bookkeeping (single per-session timestamp, §7.4-1):
 *   confirming events (same implied state) refresh it from ANY source — this
 *   is what keeps row 10's “transcript 静默” timer honest during long
 *   no-tool-call generation; contradicting lower-priority signals that LOSE
 *   arbitration are discarded entirely (no refresh), which is what lets
 *   transcript take over once hooks have been silent ≥90s. The freshness
 *   horizon for “hooks 缺失/过期” reuses TRANSCRIPT_SILENCE_TO_DONE_MS.
 * - Row 10 stamps `source: 'transcript'` (its §7.3 信号源 column is fs.watch);
 *   row 11 is the timer row — it keeps the existing source.
 * - Rows 12–14 (M2-end): the reducer guards against duplicate rows since pid↔
 *   sessionId cannot be observed directly — a discovered pid is correlated by
 *   cwd to a pid-less record (attach, no wire change); cwd is collected by the
 *   ps source via lsof/procfs (hud-sessions §12-D2-A3), so this attach is the
 *   live path that makes row-14 reaping cover hooks/transcript sessions. With
 *   no cwd and any pid-less record present the discovery is held back (better
 *   to miss an unknown than to ghost-duplicate every hook session) — the ps
 *   source re-emits `processDiscovered` for every live pid on every sweep, so
 *   hold-back really is re-evaluated each poll and resolves once the pid-less
 *   record disappears. Headless tty `??`/`?` is re-checked here as
 *   defense-in-depth (primary filter lives in signals/ps.ts; quest sessions
 *   also run with disableAllHooks so they never speak here, §7.4-5).
 * - PRIVACY: nothing in this module logs; events carry no prompt/transcript
 *   content by construction (see ./events.ts).
 *
 * Tests replay recorded fixtures (daemon/test/fixtures, written by the M2
 * recorder — install/recorder.ts) through `normalizeHookEvent` + this reducer,
 * table-driven per row (test/state-reducer.contract.test.ts).
 */
import type { SessionInfo, SessionSource, SessionState } from '@codestead/shared';

import type {
  HookDoneEvent,
  HookSessionEndEvent,
  HookSessionStartEvent,
  ProcessDiscoveredEvent,
  ProcessGoneEvent,
  SessionEvent,
  TickEvent,
  TranscriptAppendEvent,
} from './events.js';
import {
  DONE_TO_IDLE_MS,
  IDLE_REAP_APPROX_MS,
  SOURCE_PRIORITY,
  TRANSCRIPT_SILENCE_TO_DONE_MS,
} from './types.js';
import type { SessionRecord, SessionTable } from './types.js';

/** The four core states a signal can apply (unknown is display-only, §7.1). */
type CoreState = Exclude<SessionState, 'unknown'>;

/** Synthetic id for ps-discovered sessions (row 12) until row 13 merges them. */
export const SYNTHETIC_PROCESS_SESSION_PREFIX = 'ps-';

export function syntheticProcessSessionId(pid: number): string {
  return `${SYNTHETIC_PROCESS_SESSION_PREFIX}${String(pid)}`;
}

/** Pure transition function. MUST NOT mutate `table`. Returns the SAME table reference on no-ops. */
export function reduceSessions(table: SessionTable, event: SessionEvent): SessionTable {
  switch (event.kind) {
    case 'hookSessionStart': // rows 1–2
      return onHookSessionStart(table, event);
    case 'hookUserPromptSubmit': // row 3 (dissolves done = viewed)
      return applyHookTarget(table, event.sessionId, event.at, 'working');
    case 'hookToolHeartbeat': // row 4 (heartbeat; idempotence is rule §7.4-2)
      return applyHookTarget(table, event.sessionId, event.at, 'working');
    case 'hookBlocked': // row 5 (both vias land here; no error on permission-blocked)
      return applyHookTarget(table, event.sessionId, event.at, 'blocked');
    case 'hookDone': // row 6 (restricted from-set)
      return onHookDone(table, event);
    case 'hookStopFailure': // row 7 (blocked + error.kind, §2.4)
      return applyHookTarget(table, event.sessionId, event.at, 'blocked', {
        kind: event.errorKind,
      });
    case 'hookSessionEnd': // row 8 (deregister)
      return onHookSessionEnd(table, event);
    case 'transcriptAppend': // row 9 (+ §7.4-4 rebuild registration)
      return onTranscriptAppend(table, event);
    case 'tick': // rows 10–11 + M2 first-cut idle reap
      return onTick(table, event);
    case 'processDiscovered': // row 12 (M2-end)
      return onProcessDiscovered(table, event);
    case 'processGone': // row 14 (M2-end)
      return onProcessGone(table, event);
  }
}

/**
 * Wire diff between two reducer outputs → broadcast frames. Pure; the server
 * maps 'upsert' → `sessionUpsert`, 'removed' → `sessionRemoved`. Comparing
 * `info` by value keeps “no state change → no frame” true. Heartbeats that
 * only touch `lastSignalAt` DO produce an upsert here (lastSignalAt is a wire
 * field) — the composition root rate-limits those through
 * state/upsert-throttle.ts (≥5s per session, hud-sessions §10.2) before
 * broadcasting. Patch order is deterministic: removals first, then upserts,
 * each sorted by sessionId.
 */
export type SessionPatch =
  | { readonly kind: 'upsert'; readonly session: SessionInfo }
  | { readonly kind: 'removed'; readonly sessionId: string };

export function diffSessionTables(prev: SessionTable, next: SessionTable): SessionPatch[] {
  const patches: SessionPatch[] = [];
  if (prev === next) return patches;
  const removedIds = [...prev.keys()].filter((id) => !next.has(id)).sort();
  for (const sessionId of removedIds) patches.push({ kind: 'removed', sessionId });
  const upserts: { readonly id: string; readonly session: SessionInfo }[] = [];
  for (const [id, record] of next) {
    const before = prev.get(id);
    if (before === undefined || !sessionInfoEquals(before.info, record.info)) {
      upserts.push({ id, session: record.info });
    }
  }
  upserts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { session } of upserts) patches.push({ kind: 'upsert', session });
  return patches;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** Rows 1–2. Registers (with row-13 merge) or re-registers; row 1 resets `since`. */
function onHookSessionStart(table: SessionTable, event: HookSessionStartEvent): SessionTable {
  const target: CoreState = event.startSource === 'compact' ? 'working' : 'idle';
  const existing = table.get(event.sessionId);
  if (existing === undefined) {
    const record: SessionRecord = {
      info: makeInfo({
        sessionId: event.sessionId,
        state: target,
        source: 'hooks',
        at: event.at,
        cwd: event.cwd,
      }),
      transcriptPath: event.transcriptPath,
      pid: null,
    };
    // Row 13: a brand-new hook session absorbs a matching ps-discovered ghost.
    return mergeUnknownByCwd(
      withRecord(table, event.sessionId, record),
      event.sessionId,
      event.cwd,
    );
  }
  let info = applyState(existing.info, target, event.at, 'hooks');
  if (event.startSource !== 'compact') {
    // Row 1's explicit “重置 since” outranks the generic same-state idempotence.
    info = { ...info, since: toIso(event.at) };
  }
  if (event.cwd !== '') info = { ...info, cwd: event.cwd };
  const record: SessionRecord = {
    ...existing,
    info,
    transcriptPath: event.transcriptPath ?? existing.transcriptPath,
  };
  return withRecord(table, event.sessionId, record);
}

/** Row 6. done only from working/blocked (and unknown via row 13); idle just records the signal. */
function onHookDone(table: SessionTable, event: HookDoneEvent): SessionTable {
  const existing = table.get(event.sessionId);
  if (existing === undefined) {
    // Register-then-apply: a missed-prefix session whose turn just ended IS done.
    return applyHookTarget(table, event.sessionId, event.at, 'done');
  }
  if (existing.info.state === 'idle') {
    // Outside the row-6 from-set: state untouched, hooks signal still observed.
    const info: SessionInfo = { ...existing.info, lastSignalAt: toIso(event.at) };
    return withRecord(table, event.sessionId, { ...existing, info });
  }
  return applyHookTarget(table, event.sessionId, event.at, 'done');
}

/** Row 8. Deregister; the server diff turns this into `sessionRemoved`. */
function onHookSessionEnd(table: SessionTable, event: HookSessionEndEvent): SessionTable {
  if (!table.has(event.sessionId)) return table;
  const next = new Map(table);
  next.delete(event.sessionId);
  return next;
}

/** Row 9 (+ §7.4-4 rebuild registration). Transcript is the low-priority working signal. */
function onTranscriptAppend(table: SessionTable, event: TranscriptAppendEvent): SessionTable {
  const existing = table.get(event.sessionId);
  if (existing === undefined) {
    // Restart-rebuild path: scan-synthesized appends re-register sessions as
    // working(transcript); the next tick degrades stale ones via row 10.
    const record: SessionRecord = {
      info: makeInfo({
        sessionId: event.sessionId,
        state: 'working',
        source: 'transcript',
        at: event.at,
        cwd: '',
        title: event.title,
        subtitle: event.subtitle,
      }),
      transcriptPath: event.transcriptPath,
      pid: null,
    };
    return withRecord(table, event.sessionId, record);
  }
  const { info } = existing;
  // Display metadata is not subject to arbitration: tolerant-parsed title /
  // subtitle update whenever present (nulls = parse failure, keep last known).
  const title = event.title ?? info.title;
  const subtitle = event.subtitle ?? info.subtitle;
  let nextInfo: SessionInfo;
  if (info.state === 'working') {
    // Confirming signal: refresh lastSignalAt (feeds row 10), never reset since.
    nextInfo = { ...applyState(info, 'working', event.at, 'transcript'), title, subtitle };
  } else if (
    (info.state === 'idle' || info.state === 'done') &&
    hooksMissingOrStale(info, event.at)
  ) {
    // Row 9 proper: idle/done → working, only when hooks are missing/stale.
    nextInfo = { ...applyState(info, 'working', event.at, 'transcript'), title, subtitle };
  } else {
    // Arbitration denied (fresh hooks) or outside the row-9 from-set (blocked
    // is sacred, unknown is hooks-resolved only): the state signal is
    // DISCARDED — including lastSignalAt, so a stale high-priority source
    // cannot be kept artificially fresh by the signal it is suppressing.
    nextInfo = { ...info, title, subtitle };
  }
  const record: SessionRecord = {
    ...existing,
    info: nextInfo,
    transcriptPath: event.transcriptPath,
  };
  return recordEquals(existing, record) ? table : withRecord(table, event.sessionId, record);
}

/** Rows 10–11 + idle≥12h reap backstop (pid-less records only once ps is live). */
function onTick(table: SessionTable, event: TickEvent): SessionTable {
  let changed = false;
  const next = new Map<string, SessionRecord>();
  for (const [id, record] of table) {
    const { info } = record;
    if (
      info.state === 'working' &&
      elapsedMs(event.at, info.lastSignalAt) >= TRANSCRIPT_SILENCE_TO_DONE_MS
    ) {
      // Row 10: transcript silent ≥90s and no blocked signal (state would be
      // blocked otherwise) → done. lastSignalAt is NOT refreshed: silence is
      // the absence of a signal.
      const info10: SessionInfo = {
        ...info,
        state: 'done',
        since: toIso(event.at),
        source: 'transcript',
      };
      next.set(id, { ...record, info: info10 });
      changed = true;
    } else if (info.state === 'done' && elapsedMs(event.at, info.since) >= DONE_TO_IDLE_MS) {
      // Row 11: done untouched for 30min → idle (timer row — source kept).
      const info11: SessionInfo = { ...info, state: 'idle', since: toIso(event.at) };
      next.set(id, { ...record, info: info11 });
      changed = true;
    } else if (
      info.state === 'idle' &&
      record.pid === null &&
      elapsedMs(event.at, info.since) >= IDLE_REAP_APPROX_MS
    ) {
      // M2 first-cut reaping (PRD 03 US19). With ps reaping live (row 14) this
      // fires ONLY for pid-less records — sessions no ps row could be
      // associated with (cwd collection failed, §12-D2-A3). Live idle sessions
      // with a pid are NEVER delisted here (hud-sessions §7 分期注记/§13-11).
      changed = true;
    } else {
      // blocked is legitimately long-lived (§7.4-3); unknown is maintained by
      // ps alone (row 14 reaps it) — neither expires here.
      next.set(id, record);
    }
  }
  return changed ? next : table;
}

/** Row 12 (M2-end). Discovery with anti-duplicate guards; see file header. */
function onProcessDiscovered(table: SessionTable, event: ProcessDiscoveredEvent): SessionTable {
  // Defense-in-depth headless filter (§7.4-5): signals/ps.ts is the primary
  // tty `??`/`?` + quest-marker filter; the reducer re-checks the tty rule so
  // a headless session is architecturally unable to enter the state machine.
  if (event.tty === '?' || event.tty === '??') return table;

  // 1) pid already tracked.
  for (const [id, record] of table) {
    if (record.pid !== event.pid) continue;
    if (record.info.state !== 'unknown') return table; // ps never freshens hook/transcript state
    // unknown is maintained solely by ps: refresh lastSignalAt, best-effort cwd fill (§12-D2-A3).
    const cwd = record.info.cwd === '' && event.cwd !== null ? event.cwd : record.info.cwd;
    const info: SessionInfo = { ...record.info, cwd, lastSignalAt: toIso(event.at) };
    return withRecord(table, id, { ...record, info });
  }

  // 2) correlate by cwd: attach the pid to a pid-less tracked session instead
  //    of ghost-duplicating it (deterministic pick: smallest sessionId).
  if (event.cwd !== null && event.cwd !== '') {
    const candidateIds = [...table.entries()]
      .filter(([, record]) => record.pid === null && record.info.cwd === event.cwd)
      .map(([id]) => id)
      .sort();
    const matchId = candidateIds[0];
    if (matchId !== undefined) {
      const match = table.get(matchId);
      if (match !== undefined) {
        return withRecord(table, matchId, { ...match, pid: event.pid });
      }
    }
    return registerUnknown(table, event, event.cwd);
  }

  // 3) cwd unobservable: if ANY pid-less record exists this pid may belong to
  //    it — hold back rather than risk a duplicate row (re-evaluated each poll).
  for (const record of table.values()) {
    if (record.pid === null) return table;
  }
  return registerUnknown(table, event, '');
}

/** Row 14 (M2-end). Process vanished (kill -9 …) → deregister from ANY state, no ghosts. */
function onProcessGone(table: SessionTable, event: ProcessGoneEvent): SessionTable {
  let changed = false;
  const next = new Map<string, SessionRecord>();
  for (const [id, record] of table) {
    if (record.pid === event.pid) {
      changed = true;
    } else {
      next.set(id, record);
    }
  }
  return changed ? next : table;
}

// ---------------------------------------------------------------------------
// Shared transition helpers
// ---------------------------------------------------------------------------

/**
 * Apply a hooks-sourced state signal to a session, registering it first when
 * unknown to the table (register-then-apply, research/hooks.md §5.3).
 * `error` is the RESULTING error value of the row: present only for row 7 —
 * every other state application clears it.
 */
function applyHookTarget(
  table: SessionTable,
  sessionId: string,
  at: number,
  target: CoreState,
  error?: { readonly kind: string },
): SessionTable {
  const existing = table.get(sessionId);
  if (existing === undefined) {
    const record: SessionRecord = {
      info: makeInfo({ sessionId, state: target, source: 'hooks', at, cwd: '', error }),
      transcriptPath: null,
      pid: null,
    };
    return withRecord(table, sessionId, record);
  }
  const info = applyState(existing.info, target, at, 'hooks', error);
  return withRecord(table, sessionId, { ...existing, info });
}

/**
 * Core state application (§7.4-1/2):
 * - different state (incl. unknown → core, row 13) → transition: `since` = at,
 *   `source` = the signal's source;
 * - same state → idempotent confirm: `since` kept, `source` upgraded only if
 *   the confirming signal has HIGHER priority (it always stays the
 *   highest-confidence origin of the current state);
 * - `lastSignalAt` refreshes either way; `error` is replaced by the row's value.
 */
function applyState(
  info: SessionInfo,
  target: CoreState,
  at: number,
  source: SessionSource,
  error?: { readonly kind: string },
): SessionInfo {
  const sameState = info.state === target;
  const nextSource =
    sameState && SOURCE_PRIORITY[info.source] >= SOURCE_PRIORITY[source] ? info.source : source;
  const base: SessionInfo = {
    sessionId: info.sessionId,
    title: info.title,
    subtitle: info.subtitle,
    cwd: info.cwd,
    state: target,
    since: sameState ? info.since : toIso(at),
    lastSignalAt: toIso(at),
    source: nextSource,
  };
  return error === undefined ? base : { ...base, error };
}

/** Arbitration check for row 9: hooks are missing (state not hooks-owned) or stale (§7.4-1). */
function hooksMissingOrStale(info: SessionInfo, at: number): boolean {
  if (info.source !== 'hooks') return true;
  return elapsedMs(at, info.lastSignalAt) >= TRANSCRIPT_SILENCE_TO_DONE_MS;
}

/** Row 13 merge: remove the ps ghost matching the new hook session's cwd, inherit its pid. */
function mergeUnknownByCwd(table: SessionTable, inheritorId: string, cwd: string): SessionTable {
  if (cwd === '') return table;
  const ghosts = [...table.entries()]
    .filter(
      ([id, record]) =>
        id !== inheritorId && record.info.state === 'unknown' && record.info.cwd === cwd,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const ghost = ghosts[0];
  if (ghost === undefined) return table;
  const [ghostId, ghostRecord] = ghost;
  const next = new Map(table);
  next.delete(ghostId);
  const inheritor = next.get(inheritorId);
  if (inheritor !== undefined && inheritor.pid === null && ghostRecord.pid !== null) {
    next.set(inheritorId, { ...inheritor, pid: ghostRecord.pid });
  }
  return next;
}

/** Row 12 registration: synthetic id, display state unknown, lowest-confidence source. */
function registerUnknown(
  table: SessionTable,
  event: ProcessDiscoveredEvent,
  cwd: string,
): SessionTable {
  const sessionId = syntheticProcessSessionId(event.pid);
  const record: SessionRecord = {
    info: makeInfo({ sessionId, state: 'unknown', source: 'process', at: event.at, cwd }),
    transcriptPath: null,
    pid: event.pid,
  };
  return withRecord(table, sessionId, record);
}

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

function makeInfo(args: {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly source: SessionSource;
  readonly at: number;
  readonly cwd: string;
  readonly title?: string | null;
  readonly subtitle?: string | null;
  readonly error?: { readonly kind: string } | undefined;
}): SessionInfo {
  const iso = toIso(args.at);
  const base: SessionInfo = {
    sessionId: args.sessionId,
    title: args.title ?? null,
    subtitle: args.subtitle ?? null,
    cwd: args.cwd,
    state: args.state,
    since: iso,
    lastSignalAt: iso,
    source: args.source,
  };
  return args.error === undefined ? base : { ...base, error: args.error };
}

function withRecord(table: SessionTable, sessionId: string, record: SessionRecord): SessionTable {
  const next = new Map(table);
  next.set(sessionId, record);
  return next;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Clamped elapsed time. Unparseable timestamps and clock skew (at < t) both
 * yield 0 — time-based rules then simply do not fire (hud-sessions §11-18:
 * negative durations clamp to 0; never degrade on bad data).
 */
function elapsedMs(at: number, iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, at - t);
}

function sessionInfoEquals(a: SessionInfo, b: SessionInfo): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.cwd === b.cwd &&
    a.state === b.state &&
    a.since === b.since &&
    a.lastSignalAt === b.lastSignalAt &&
    a.source === b.source &&
    (a.error?.kind ?? null) === (b.error?.kind ?? null)
  );
}

function recordEquals(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.transcriptPath === b.transcriptPath && a.pid === b.pid && sessionInfoEquals(a.info, b.info)
  );
}
