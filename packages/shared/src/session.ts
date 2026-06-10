/**
 * Session state & SessionInfo — single source of truth shared by daemon and game HUD.
 *
 * Source of truth for the shape: docs/design/tech-stack.md §5, as corrected by
 * docs/design/hud-sessions.md §10.4 (the field set MUST include `source` and `error?`).
 */
import { z } from 'zod';

/**
 * Five display states: the four core states (working / blocked / done / idle)
 * plus `unknown` for sessions detected without hooks (low-confidence sources).
 * See CLAUDE.md glossary and docs/design/hud-sessions.md.
 */
export const SessionStateSchema = z.enum(['working', 'blocked', 'done', 'idle', 'unknown']);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** Highest-confidence signal source that produced the current state (tech-stack §4.1). */
export const SessionSourceSchema = z.enum(['hooks', 'transcript', 'process']);
export type SessionSource = z.infer<typeof SessionSourceSchema>;

/**
 * SessionInfo — full field set per hud-sessions §10.4 ruling #1:
 * `lastSignalAt` (debugging), `source` (low-confidence outline in HUD) and
 * `error` (API error state rendering) are all part of the wire payload.
 * "Payload minimization" means transcript content never crosses the WS,
 * not a reduced field set.
 */
export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  /** From transcript ai-title (fault-tolerant parse); null when unavailable. */
  title: z.string().nullable(),
  /** Truncated last prompt; null when unavailable. */
  subtitle: z.string().nullable(),
  cwd: z.string(),
  state: SessionStateSchema,
  /** ISO 8601 — when the session entered its current state. */
  since: z.iso.datetime({ offset: true }),
  /** ISO 8601 — time of the last signal observed for this session. */
  lastSignalAt: z.iso.datetime({ offset: true }),
  source: SessionSourceSchema,
  /** Present on StopFailure (e.g. rate_limit / billing_error …). */
  error: z.object({ kind: z.string() }).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
