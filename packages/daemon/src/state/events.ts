/**
 * SessionEvent — the normalized input alphabet of the session reducer.
 *
 * One union member per TRIGGER ROW of the authoritative 14-row transition
 * table (docs/design/hud-sessions.md §7.3). Raw hook HTTP bodies are turned
 * into these by `signals/hooks-wire.ts#normalizeHookEvent`; the reducer never
 * sees raw hook payloads.
 *
 * Row map (§7.3 → event kind):
 *   1  SessionStart(startup/resume/clear) → idle ......... hookSessionStart (startSource ≠ 'compact')
 *   2  SessionStart(compact) → working ................... hookSessionStart (startSource = 'compact')
 *   3  UserPromptSubmit → working (dissolves done) ....... hookUserPromptSubmit
 *   4  Pre/PostToolUse(Failure) → working (heartbeat) .... hookToolHeartbeat
 *   5  PermissionRequest ∪ Notification(permission_prompt) → blocked ... hookBlocked
 *   6  Stop ∪ Notification(idle_prompt) → done ........... hookDone
 *   7  StopFailure → blocked (+error.kind) ............... hookStopFailure
 *   8  SessionEnd → deregister ........................... hookSessionEnd
 *   9  transcript jsonl append → working (only when hooks missing/stale, §7.4-1) ... transcriptAppend
 *   10 transcript silent ≥90s ∧ no blocked → done ........ tick (staleness sweep vs lastSignalAt)
 *   11 done for 30 min → idle ........................... tick (staleness sweep)
 *   12 ps finds claude process with no hook → unknown ..... processDiscovered (M2-end)
 *   13 first hook on an unknown session → per-hook state .. any hook* event (reducer rule, not a new event)
 *   14 process gone (kill -9 …) → deregister ............. processGone (M2-end)
 *   (M2 first-cut only: idle ≥12h reaping also rides on `tick` — PRD 03 US19.)
 *
 * Privacy: events deliberately carry NO prompt text and NO transcript content.
 * Display strings are limited to the tolerant `ai-title` / truncated
 * `last-prompt` parsed by the transcript source (title/subtitle below) — the
 * same fields that are allowed on the wire. Nothing here may be logged.
 */

export type HookStartSource = 'startup' | 'resume' | 'clear' | 'compact';
export type ToolHeartbeatHook = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
export type BlockedVia = 'PermissionRequest' | 'NotificationPermissionPrompt';
export type DoneVia = 'Stop' | 'NotificationIdlePrompt';

/** All events carry `at` (epoch ms). The reducer is pure: the clock arrives via events, never `Date.now()`. */
interface SessionEventBase {
  readonly at: number;
}

interface HookEventBase extends SessionEventBase {
  readonly sessionId: string;
}

/** Rows 1–2. Registers the session (row 1 resets `since`; row 2 keeps/forces working). */
export interface HookSessionStartEvent extends HookEventBase {
  readonly kind: 'hookSessionStart';
  readonly startSource: HookStartSource;
  readonly cwd: string;
  readonly transcriptPath: string | null;
}

/** Row 3. Any state → working; simultaneously dissolves done (= user has seen the result). */
export interface HookUserPromptSubmitEvent extends HookEventBase {
  readonly kind: 'hookUserPromptSubmit';
}

/** Row 4. Work heartbeat: same-state idempotent — refreshes `lastSignalAt`, NEVER resets `since` (§7.4-2). */
export interface HookToolHeartbeatEvent extends HookEventBase {
  readonly kind: 'hookToolHeartbeat';
  readonly hook: ToolHeartbeatHook;
}

/** Row 5. Any state → blocked (waiting for user authorization/input). */
export interface HookBlockedEvent extends HookEventBase {
  readonly kind: 'hookBlocked';
  readonly via: BlockedVia;
}

/** Row 6. working/blocked → done (one round finished, not yet viewed). */
export interface HookDoneEvent extends HookEventBase {
  readonly kind: 'hookDone';
  readonly via: DoneVia;
}

/** Row 7. Any state → blocked with `error.kind` (rate_limit / overloaded / authentication_failed / billing_error / …). */
export interface HookStopFailureEvent extends HookEventBase {
  readonly kind: 'hookStopFailure';
  readonly errorKind: string;
}

/** Row 8. Any state → deregistered; server broadcasts `sessionRemoved`. */
export interface HookSessionEndEvent extends HookEventBase {
  readonly kind: 'hookSessionEnd';
}

/**
 * Row 9. Low-priority working signal — effective ONLY when hooks signals are
 * missing/stale for this session (§7.4-1). Also ferries the tolerant
 * `ai-title` / truncated `last-prompt` parse for HUD display fields.
 */
export interface TranscriptAppendEvent extends HookEventBase {
  readonly kind: 'transcriptAppend';
  readonly transcriptPath: string;
  readonly title: string | null;
  readonly subtitle: string | null;
}

/**
 * Rows 10–11 (+ M2 first-cut idle≥12h reap): periodic staleness sweep. The
 * reducer compares `at` against each session's `lastSignalAt`/`since` —
 * blocked is legitimately long-lived and never expires (§7.4-3).
 */
export interface TickEvent extends SessionEventBase {
  readonly kind: 'tick';
}

/**
 * Row 12 (M2-end). A claude process with no hook record → register as
 * `unknown` (source 'process'). `cwd` is best-effort and may be null
 * (hud-sessions §12-D2-A3); the daemon synthesizes a sessionId until the
 * first hook arrives (row 13 then merges by correlation).
 * Headless quest sessions are filtered OUT before this event is ever
 * emitted (tty rule + launch-arg marker, §7.4-5) — they never reach the reducer.
 */
export interface ProcessDiscoveredEvent extends SessionEventBase {
  readonly kind: 'processDiscovered';
  readonly pid: number;
  readonly tty: string;
  readonly cwd: string | null;
}

/** Row 14 (M2-end). Process vanished (kill -9 …) → deregister, no ghosts. */
export interface ProcessGoneEvent extends SessionEventBase {
  readonly kind: 'processGone';
  readonly pid: number;
}

export type SessionEvent =
  | HookSessionStartEvent
  | HookUserPromptSubmitEvent
  | HookToolHeartbeatEvent
  | HookBlockedEvent
  | HookDoneEvent
  | HookStopFailureEvent
  | HookSessionEndEvent
  | TranscriptAppendEvent
  | TickEvent
  | ProcessDiscoveredEvent
  | ProcessGoneEvent;

/** Narrow helper: the hook-sourced subset (rows 1–8; also what resolves an `unknown` session, row 13). */
export type HookSessionEvent =
  | HookSessionStartEvent
  | HookUserPromptSubmitEvent
  | HookToolHeartbeatEvent
  | HookBlockedEvent
  | HookDoneEvent
  | HookStopFailureEvent
  | HookSessionEndEvent;
