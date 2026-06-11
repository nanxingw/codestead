/**
 * Wire-side throttle for lastSignalAt-only sessionUpserts (hud-sessions §10.2
 * lastSignalAt row): every PostToolUse heartbeat and every transcript append
 * refreshes `lastSignalAt`, and `diffSessionTables` faithfully turns each one
 * into an upsert — during an active session that is several frames per second
 * of wire traffic whose ONLY change is a field the HUD display layer never
 * reads. The daemon-side answer (the HUD side has its own projection compare,
 * §5.3): an upsert whose payload differs from the LAST SENT info for that
 * session only in `lastSignalAt` is held back until ≥5s have passed since the
 * last sent frame for that session.
 *
 * Liveness is unaffected: the 25s `heartbeat` frame keeps the client out of
 * STALE (§8.1), and `getSnapshot` reads the live table, so new clients always
 * see fresh data. Removals and any state/title/cwd/error change pass through
 * untouched.
 *
 * Stateful by necessity (per-session last-sent bookkeeping) but injectable and
 * clock-free: `at` arrives with each call.
 */
import type { SessionInfo } from '@codestead/shared';

import type { SessionPatch } from './reducer.js';

/** Minimum spacing between lastSignalAt-only upserts per session. */
export const LAST_SIGNAL_ONLY_THROTTLE_MS = 5_000;

export type UpsertThrottle = (patches: readonly SessionPatch[], at: number) => SessionPatch[];

/** True when a and b differ AT MOST in `lastSignalAt`. */
function equalsIgnoringLastSignal(a: SessionInfo, b: SessionInfo): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.cwd === b.cwd &&
    a.state === b.state &&
    a.since === b.since &&
    a.source === b.source &&
    (a.error?.kind ?? null) === (b.error?.kind ?? null)
  );
}

export function createUpsertThrottle(minIntervalMs = LAST_SIGNAL_ONLY_THROTTLE_MS): UpsertThrottle {
  /** Last info actually sent per session + when it was sent. */
  const sent = new Map<string, { info: SessionInfo; at: number }>();

  return (patches, at) => {
    const out: SessionPatch[] = [];
    for (const patch of patches) {
      if (patch.kind === 'removed') {
        sent.delete(patch.sessionId);
        out.push(patch);
        continue;
      }
      const prev = sent.get(patch.session.sessionId);
      const lastSignalOnly =
        prev !== undefined && equalsIgnoringLastSignal(prev.info, patch.session);
      if (lastSignalOnly && at - prev.at < minIntervalMs) {
        // Held back. `sent` is NOT updated: the next candidate still compares
        // against the last frame that actually reached the wire.
        continue;
      }
      sent.set(patch.session.sessionId, { info: patch.session, at });
      out.push(patch);
    }
    return out;
  };
}
