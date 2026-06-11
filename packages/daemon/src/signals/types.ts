/**
 * Unified signal-source interface (tech-stack §3 `daemon/src/signals/`).
 *
 * Three sources, priority hooks > transcript > process (state/types.ts
 * SOURCE_PRIORITY). Each source normalizes its raw input into `SessionEvent`s
 * (state/events.ts) and pushes them through `emit` — sources never touch the
 * session table directly, and the reducer never sees raw input.
 *
 * M2 phasing (hud-sessions §7 分期注记): first version ships hooks + transcript;
 * the ps source lands at M2-end. The interface is identical for all three.
 */
import type { SessionEvent } from '../state/events.js';

export type SignalEmit = (event: SessionEvent) => void;

export interface SignalSource {
  /** Matches SessionInfo.source values; also used in logs (names only — never payloads). */
  readonly name: 'hooks' | 'transcript' | 'process';
  /** Begin emitting. Idempotent start is not required; callers start once. */
  start(emit: SignalEmit): Promise<void>;
  /** Stop watchers/timers and release resources. Must be safe to call once after start. */
  stop(): Promise<void>;
}
