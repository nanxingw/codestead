/**
 * HUD store — pure reducers + display selectors. ZERO Phaser, ZERO sim
 * (ESLint-enforced; hud-sessions §13-5). The subscription primitive follows
 * the project's hand-rolled store convention (tech-stack §1: no state lib) —
 * see hud-store.ts; THIS file stays pure functions only.
 *
 * The HUD trusts the server completely: no semantic state transitions happen
 * here (§8.3). Everything below is connection bookkeeping + display math.
 */
import type { ServerMessage, SessionInfo, SessionState } from '@codestead/shared';

import type { HudSettings } from './settings.js';
import type {
  ConnectionEvent,
  ConnectionState,
  HudState,
  OverflowPlan,
  SessionCooldown,
  SessionStateCounts,
} from './types.js';
import { STATE_RANK } from './types.js';

// ---- Reconnect/backoff constants (hud-sessions §8.1 — values are design law) ----

/** CONNECTING/HANDSHAKING budget before BACKOFF. */
export const CONNECT_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** ±20% jitter, rand01 injected (no Math.random inside pure code). */
export const BACKOFF_JITTER_RATIO = 0.2;
/** After 10 consecutive failures the ladder parks at 60s. */
export const BACKOFF_LONG_AFTER_FAILURES = 10;
export const BACKOFF_LONG_MS = 60_000;
/** INCOMPATIBLE retries slowly — every 5 minutes (§8.1, US39). */
export const INCOMPATIBLE_RETRY_MS = 300_000;

/** Display-layer jitter merge window: a session re-sorts at most once per 10s (§5.3). */
export const RESORT_MERGE_WINDOW_MS = 10_000;
/** Row highlight: 600ms flash, ≥8s per-session cooldown (§6.1). */
export const HIGHLIGHT_MS = 600;
export const HIGHLIGHT_COOLDOWN_MS = 8_000;
/** Sound: global 20s cooldown (§3.4). */
export const SOUND_GLOBAL_COOLDOWN_MS = 20_000;

/** Panel hard cap: blocked may temporarily widen the window, never past 9 rows (§5.2). */
export const HARD_CAP_ROWS = 9;
/** Overflow tooltip lists at most 12 folded sessions (§11-12). */
export const OVERFLOW_PREVIEW_MAX = 12;

/** Pure backoff ladder: 1s,2,4,…cap 30s ±20% jitter; ≥10 failures → flat 60s. */
export function computeBackoffDelayMs(attempt: number, rand01: number): number {
  const failures = Math.max(1, Math.floor(attempt));
  if (failures >= BACKOFF_LONG_AFTER_FAILURES) return BACKOFF_LONG_MS;
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
  const jitter = 1 + (rand01 * 2 - 1) * BACKOFF_JITTER_RATIO;
  return Math.round(base * jitter);
}

// ---- Reducers (pure; table-driven testable, hud-sessions §8.1/§13) ----

export function createInitialHudState(settings: HudSettings, everConnected: boolean): HudState {
  return {
    conn: {
      phase: 'connecting',
      attempt: 0,
      gotHello: false,
      daemonVersion: null,
      daemonProtocol: null,
      lastMessageAt: null,
    },
    everConnected,
    sessions: new Map<string, SessionInfo>(),
    hasSnapshot: false,
    cooldowns: new Map(),
    settings,
  };
}

/** Connection machine — exactly the §8.1 edges, nothing more. */
export function reduceConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  const { phase } = state;
  switch (event.kind) {
    case 'wsOpen':
      return phase === 'connecting' ? { ...state, phase: 'handshaking' } : state;
    case 'wsClose':
    case 'wsError':
      // Any active phase → BACKOFF; BACKOFF/INCOMPATIBLE are already off-socket.
      return phase === 'backoff' || phase === 'incompatible'
        ? state
        : { ...state, phase: 'backoff', attempt: state.attempt + 1, gotHello: false };
    case 'connectTimeout':
      // 10s budget spans CONNECTING + HANDSHAKING (until snapshot ⇒ LIVE).
      return phase === 'connecting' || phase === 'handshaking'
        ? { ...state, phase: 'backoff', attempt: state.attempt + 1, gotHello: false }
        : state;
    case 'helloOk':
      // LIVE requires HELLO_OK **and** SNAPSHOT (§8.1) — stay HANDSHAKING here.
      return phase === 'handshaking'
        ? { ...state, gotHello: true, daemonVersion: event.daemonVersion, daemonProtocol: null }
        : state;
    case 'protoMismatch':
      return phase === 'connecting' || phase === 'handshaking'
        ? { ...state, phase: 'incompatible', gotHello: false, daemonProtocol: event.daemonProtocol }
        : state;
    case 'snapshotReceived':
      // Reaching LIVE resets the failure ladder (§8.1).
      return phase === 'handshaking' && state.gotHello
        ? { ...state, phase: 'live', attempt: 0 }
        : state;
    case 'anyMessage': {
      const touched = { ...state, lastMessageAt: event.at };
      // STALE → LIVE on any message (§8.1 diagram).
      return phase === 'stale' ? { ...touched, phase: 'live' } : touched;
    }
    case 'heartbeatTimeout':
      return phase === 'live' ? { ...state, phase: 'stale' } : state;
    case 'retryTimer':
      return phase === 'backoff' || phase === 'incompatible'
        ? { ...state, phase: 'connecting', gotHello: false }
        : state;
  }
}

/**
 * HudState-level connection event: wraps reduceConnection and applies the
 * §8.1 table side effect — entering BACKOFF clears the session list (stale
 * `working` rows must never lie to the player, US35) and drops the
 * per-connection snapshot latch. Cooldowns are KEPT (anti highlight-storm).
 */
export function applyConnectionEvent(state: HudState, event: ConnectionEvent): HudState {
  const conn = reduceConnection(state.conn, event);
  if (conn === state.conn) return state;
  const enteredBackoff = conn.phase === 'backoff' && state.conn.phase !== 'backoff';
  if (!enteredBackoff) return { ...state, conn };
  return {
    ...state,
    conn,
    sessions: new Map<string, SessionInfo>(),
    hasSnapshot: false,
  };
}

const NO_COOLDOWN: SessionCooldown = { lastHighlightAt: null, lastSoundAt: null };

/** True when the settings' sound tier covers an entry into `state` (§3.4). */
function soundCovers(settings: HudSettings, state: SessionState): boolean {
  if (settings.sound === 'off') return false;
  if (settings.sound === 'blocked') return state === 'blocked';
  return state === 'blocked' || state === 'done';
}

/** Latest sound timestamp across all sessions — the global 20s gate (§3.4). */
function lastGlobalSoundAt(cooldowns: ReadonlyMap<string, SessionCooldown>): number {
  let last = -Infinity;
  for (const cd of cooldowns.values()) {
    if (cd.lastSoundAt !== null && cd.lastSoundAt > last) last = cd.lastSoundAt;
  }
  return last;
}

/**
 * Apply one (already safeParse-validated) server frame:
 * - snapshot: replace the table wholesale, KEEP cooldowns by sessionId (§8.1);
 * - sessionUpsert/sessionRemoved before the first snapshot: DROPPED (§11-7);
 * - sessionRemoved: also the renderer's cue to close a hovering tooltip (§11-17);
 * - hello/heartbeat: connection bookkeeping only (first hello flips the
 *   everConnected gate, §8.2).
 * Entering blocked/done via an upsert stamps the highlight cooldown (600ms
 * flash, 8s per-session cooldown) and — when the sound setting covers it —
 * the sound timestamp (global 20s gate). Snapshot replaces NEVER stamp
 * (no highlight storm after a daemon restart, §11-4).
 */
export function applyServerMessage(state: HudState, message: ServerMessage, at: number): HudState {
  // Every validated frame refreshes liveness (STALE → LIVE on any message).
  let next: HudState = { ...state, conn: reduceConnection(state.conn, { kind: 'anyMessage', at }) };
  switch (message.type) {
    case 'hello': {
      next = {
        ...next,
        conn: reduceConnection(next.conn, {
          kind: 'helloOk',
          daemonVersion: message.payload.daemonVersion,
        }),
        everConnected: true,
      };
      return next;
    }
    case 'snapshot': {
      const sessions = new Map<string, SessionInfo>();
      for (const session of message.payload.sessions) sessions.set(session.sessionId, session);
      // Preserve cooldown stamps for surviving sessions only.
      const cooldowns = new Map<string, SessionCooldown>();
      for (const [id, cd] of state.cooldowns) {
        if (sessions.has(id)) cooldowns.set(id, cd);
      }
      return {
        ...next,
        conn: reduceConnection(next.conn, { kind: 'snapshotReceived' }),
        sessions,
        cooldowns,
        hasSnapshot: true,
      };
    }
    case 'sessionUpsert': {
      if (!next.hasSnapshot) return next; // dropped before the first snapshot (§11-7)
      const session = message.payload.session;
      const prev = next.sessions.get(session.sessionId);
      const sessions = new Map(next.sessions);
      sessions.set(session.sessionId, session);
      let cooldowns: ReadonlyMap<string, SessionCooldown> = next.cooldowns;
      const entered =
        (session.state === 'blocked' || session.state === 'done') && prev?.state !== session.state;
      if (entered) {
        const cd = next.cooldowns.get(session.sessionId) ?? NO_COOLDOWN;
        let stamped = cd;
        if (at - (cd.lastHighlightAt ?? -Infinity) >= HIGHLIGHT_COOLDOWN_MS) {
          stamped = { ...stamped, lastHighlightAt: at };
        }
        if (
          soundCovers(next.settings, session.state) &&
          at - lastGlobalSoundAt(next.cooldowns) >= SOUND_GLOBAL_COOLDOWN_MS
        ) {
          stamped = { ...stamped, lastSoundAt: at };
        }
        if (stamped !== cd) {
          const mutable = new Map(next.cooldowns);
          mutable.set(session.sessionId, stamped);
          cooldowns = mutable;
        }
      }
      return { ...next, sessions, cooldowns };
    }
    case 'sessionRemoved': {
      if (!next.hasSnapshot) return next; // dropped before the first snapshot (§11-7)
      if (!next.sessions.has(message.payload.sessionId)) return next;
      const sessions = new Map(next.sessions);
      sessions.delete(message.payload.sessionId);
      const cooldowns = new Map(next.cooldowns);
      cooldowns.delete(message.payload.sessionId);
      return { ...next, sessions, cooldowns };
    }
    case 'heartbeat':
      return next; // liveness bookkeeping already applied above
  }
}

// ---- Display selectors (pure; the render shell computes NOTHING itself) ----

/** Parse `since` for sorting; invalid dates sort last within their rank (§10.2). */
function sinceMs(session: SessionInfo): number {
  const ms = Date.parse(session.since);
  return Number.isNaN(ms) ? Infinity : ms;
}

/** §5.1 ordering tuple: STATE_RANK asc → since asc (waited-longest blocked first) → sessionId. */
export function sortSessionRows(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    const since = sinceMs(a) - sinceMs(b);
    if (since !== 0) return since;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
}

/**
 * §5.2 pre-filter (M2-end settings tier): showIdle=false / showUnknown=false
 * removes those states from BOTH the visible rows and the overflow count
 * (“彻底安静”). Apply before sortSessionRows/planOverflow.
 */
export function filterDisplaySessions(
  sessions: readonly SessionInfo[],
  settings: HudSettings,
): SessionInfo[] {
  return sessions.filter((s) => {
    if (s.state === 'idle' && !settings.showIdle) return false;
    if (s.state === 'unknown' && !settings.showUnknown) return false;
    return true;
  });
}

/** §5.2 overflow: maxRows window, blocked never folded, hard cap 9 rows / 146px. */
export function planOverflow(sorted: readonly SessionInfo[], maxRows: number): OverflowPlan {
  const blockedCount = sorted.filter((s) => s.state === 'blocked').length;
  // blocked rows are never folded — the window temporarily widens to fit them
  // all, but never past the 9-row hard cap (§5.2 / §11-11/§11-12).
  const window = Math.min(Math.max(maxRows, Math.min(blockedCount, HARD_CAP_ROWS)), HARD_CAP_ROWS);
  const visible = sorted.slice(0, window);
  const folded = sorted.slice(visible.length);
  return {
    visible,
    overflowCount: folded.length,
    overflowPreview: folded.slice(0, OVERFLOW_PREVIEW_MAX),
  };
}

/** Last path segment; '' for empty/root-ish paths. Handles both / and \ separators. */
function pathSegments(p: string): string[] {
  return p.split(/[/\\]+/).filter((seg) => seg.length > 0);
}

function baseDisplayName(session: SessionInfo): string {
  const title = session.title?.trim();
  if (title) return title;
  const segs = pathSegments(session.cwd);
  const basename = segs.at(-1);
  if (basename) return basename;
  // NOTE: §2.1 lists tty before sessionId, but SessionInfo has no tty field
  // (M2-end gap flagged against shared schema; any addition needs a design-doc
  // revision first) — the chain skips to the sessionId prefix.
  return session.sessionId.slice(0, 8);
}

/**
 * §2.1 display name: title → cwd basename → (tty: see note) → sessionId first
 * 8 chars; same-name collisions get `·父目录名` (then the renderer truncates
 * by pixel width). Pure string math — pixel truncation is render-side.
 */
export function displayName(session: SessionInfo, all: readonly SessionInfo[]): string {
  const name = baseDisplayName(session);
  const collides = all.some(
    (other) => other.sessionId !== session.sessionId && baseDisplayName(other) === name,
  );
  if (!collides) return name;
  const parent = pathSegments(session.cwd).at(-2);
  return parent ? `${name}·${parent}` : name;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** §2.3 coarse duration: 刚刚 / 12m / 1h23m / 12h / 2d; negatives clamp to 0; refreshed every 5s by the shell. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms); // clock skew clamps to 0 (§11-18)
  if (clamped < MINUTE_MS) return '刚刚';
  if (clamped < HOUR_MS) return `${Math.floor(clamped / MINUTE_MS)}m`;
  const hours = Math.floor(clamped / HOUR_MS);
  if (hours < 10) return `${hours}h${Math.floor((clamped % HOUR_MS) / MINUTE_MS)}m`;
  if (clamped < DAY_MS) return `${hours}h`;
  return `${Math.floor(clamped / DAY_MS)}d`;
}

/** §4.6 day-end line feed; renderer (day-cycle) omits the whole line when disconnected or 0 sessions. */
export function stateCounts(sessions: ReadonlyMap<string, SessionInfo>): SessionStateCounts {
  const counts = { blocked: 0, done: 0, working: 0, idle: 0, unknown: 0 };
  for (const session of sessions.values()) counts[session.state] += 1;
  return counts;
}

/** §4.6 group order & copy: the example leads with working, then blocked, then done. */
const DAY_END_GROUPS: readonly { key: keyof SessionStateCounts; glyph: string; label: string }[] = [
  { key: 'working', glyph: '◐', label: '工作中' },
  { key: 'blocked', glyph: '!', label: '等待输入' },
  { key: 'done', glyph: '✓', label: '已完成' },
  { key: 'idle', glyph: '○', label: '空闲' },
  { key: 'unknown', glyph: '?', label: '未知' },
];

/**
 * §4.6 day-end settlement line: `会话 · ◐ 工作中 2 ｜ ! 等待输入 1 ｜ ✓ 已完成 1`.
 * Non-zero groups only; null ⇒ the renderer omits the WHOLE line — when
 * disconnected (anything but LIVE/STALE) or with 0 sessions the settlement
 * screen stays clean (never "无会话"). Calm statement, no animation, no button.
 */
export function formatDayEndSessionLine(
  counts: SessionStateCounts,
  phase: ConnectionState['phase'],
): string | null {
  if (phase !== 'live' && phase !== 'stale') return null;
  const parts = DAY_END_GROUPS.filter((g) => counts[g.key] > 0).map(
    (g) => `${g.glyph} ${g.label} ${String(counts[g.key])}`,
  );
  if (parts.length === 0) return null;
  return `会话 · ${parts.join(' ｜ ')}`;
}

/**
 * Display projection — a value summary of EVERYTHING the panel layout reads
 * (per session: state/since/title/subtitle/cwd/source/error; plus conn.phase,
 * the everConnected gate and the settings object). The render shell compares
 * consecutive projections and skips the relayout when they are equal, so
 * heartbeat frames and lastSignalAt-only upserts never rasterize a single
 * Text object (§5.3 anti-jitter / "HUD 每帧零分配"; see also the daemon-side
 * throttle, §10.2). Cooldown stamps are deliberately NOT included: highlights
 * are drawn per-frame from `cooldowns` without a relayout.
 */
export function displayProjection(state: HudState): string {
  const parts: string[] = [
    state.conn.phase,
    String(state.everConnected),
    JSON.stringify(state.settings),
  ];
  // Map iteration order is insertion order — include ids so reorderings of
  // table membership are visible regardless.
  for (const s of state.sessions.values()) {
    parts.push(
      `${s.sessionId} ${s.state} ${s.since} ${s.title ?? ''} ${
        s.subtitle ?? ''
      } ${s.cwd} ${s.source} ${s.error?.kind ?? ''}`,
    );
  }
  return parts.join('\n');
}

// ---- Resort discipline helpers (§5.3 — display-layer jitter merge) ----

/**
 * Row ids whose RELATIVE order against shared peers changed between two
 * orders (insertions/removals shifting indices do NOT count as a move —
 * §5.3 allows add/remove to reflow immediately).
 */
export function movedRowIds(prev: readonly string[], next: readonly string[]): string[] {
  const prevIndex = new Map(prev.map((id, i) => [id, i]));
  const nextIndex = new Map(next.map((id, i) => [id, i]));
  const shared = prev.filter((id) => nextIndex.has(id));
  const moved = new Set<string>();
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const a = shared[i];
      const b = shared[j];
      const before = prevIndex.get(a)! < prevIndex.get(b)!;
      const after = nextIndex.get(a)! < nextIndex.get(b)!;
      if (before !== after) {
        moved.add(a);
        moved.add(b);
      }
    }
  }
  return [...moved];
}

/**
 * §5.3 merge window: a state-change resort is DEFERRED when any row that
 * would move re-sorted less than RESORT_MERGE_WINDOW_MS ago. Returns the
 * remaining cooldown (>0 ⇒ defer and re-check after that many ms; the last
 * stable value wins), or 0 ⇒ apply now. Snapshot / add / remove / settings
 * triggers bypass this check entirely (they always reflow, §5.3).
 */
export function resortDeferMs(
  prev: readonly string[],
  next: readonly string[],
  lastMovedAt: ReadonlyMap<string, number>,
  now: number,
): number {
  let wait = 0;
  for (const id of movedRowIds(prev, next)) {
    const movedAt = lastMovedAt.get(id);
    if (movedAt === undefined) continue;
    const remaining = RESORT_MERGE_WINDOW_MS - (now - movedAt);
    if (remaining > wait) wait = remaining;
  }
  return Math.max(0, wait);
}
