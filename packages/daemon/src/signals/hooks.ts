/**
 * Hooks signal source (semantic main path; priority 'hooks', the highest).
 *
 * Unlike the other two sources it has no watcher of its own: the HTTP server
 * (server/server.ts) feeds every `POST /hooks` body into `handleHookBody`,
 * which runs `normalizeHookEvent` and emits the result. The HTTP response is
 * ALWAYS an empty 2xx and is sent regardless of what happens here — the
 * daemon listens and never speaks back to Claude Code (tech-stack §4.1-1).
 */
import type { SessionEvent } from '../state/events.js';
import type { SignalEmit, SignalSource } from './types.js';

export interface HooksSignalSource extends SignalSource {
  readonly name: 'hooks';
  /**
   * Called by the server for each hook POST. Must never throw (malformed
   * bodies normalize to null and are dropped) and must never log the body.
   * Events are forwarded to the `emit` received via `start()`.
   */
  handleHookBody(body: unknown, at: number): void;
}

export function createHooksSignalSource(
  normalize: (body: unknown, at: number) => SessionEvent | null,
): HooksSignalSource {
  let emit: SignalEmit | null = null;

  return {
    name: 'hooks',

    start(emitFn: SignalEmit): Promise<void> {
      emit = emitFn;
      return Promise.resolve();
    },

    stop(): Promise<void> {
      emit = null;
      return Promise.resolve();
    },

    handleHookBody(body: unknown, at: number): void {
      // Bodies arriving before start() or after stop() are dropped — the HTTP
      // layer has already answered its empty 2xx either way.
      if (emit === null) return;
      try {
        const event = normalize(body, at);
        if (event !== null) emit(event);
      } catch {
        // Must never throw and must never log the body (privacy red line).
      }
    },
  };
}
