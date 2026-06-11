/**
 * visibility.ts — wires visibilitychange/blur/focus to the driver's pause-source
 * set and the autosave triggers (GDD §2.4 / §10.4 trigger B).
 *
 * The pause SEMANTICS live in the driver: a non-empty Set<PauseSource> simply
 * means sim.advanceMinutes is never called ("关页即停" — the sim has no notion
 * of real time). This module only translates DOM events into:
 *   - 'tab_hidden'  pause source  (visibilitychange; save immediately on hide);
 *   - 'window_blur' pause source  (blur/focus; gated by pauseOnBlur, default
 *     true per ruling B-8; save debounced ≥5s);
 * and re-QUERIES visibilityState/hasFocus before releasing a source — rAF vs
 * visibilitychange ordering differs across browsers, the query result wins
 * (GDD §2.9). Autosave on blur fires regardless of pauseOnBlur: trigger B is
 * about data safety, the pause source is about time.
 *
 * While paused, rendering and the session HUD keep running (GDD §2.4) — that
 * is the driver's business, not this module's.
 */
import type { PauseSource } from '../sim/types';

export type VisibilityPauseSource = Extract<PauseSource, 'tab_hidden' | 'window_blur'>;

export interface VisibilityPauseHooks {
  addPauseSource(source: VisibilityPauseSource): void;
  removePauseSource(source: VisibilityPauseSource): void;
  /** 'immediate' → SaveManager.flushImmediate(); 'debounced' → requestDebouncedSave(). */
  requestAutosave(mode: 'immediate' | 'debounced'): void;
  /** Read the live setting each event (default true, ruling B-8 / GDD §2.4). */
  pauseOnBlur?: () => boolean;
}

/** Structural targets so unit tests can drive fake documents/windows. */
export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  hasFocus(): boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface VisibilityWindowLike {
  addEventListener(type: 'blur' | 'focus', listener: () => void): void;
  removeEventListener(type: 'blur' | 'focus', listener: () => void): void;
}

/**
 * Bind the event lines. Performs an initial sync (booting in a hidden tab
 * starts paused). Returns an unbind function (listeners only; it does not
 * mutate pause sources, shutdown sequencing belongs to the caller).
 */
export function bindVisibilityPause(
  hooks: VisibilityPauseHooks,
  target: { doc?: VisibilityDocumentLike; win?: VisibilityWindowLike } = {},
): () => void {
  const doc: VisibilityDocumentLike = target.doc ?? document;
  const win: VisibilityWindowLike = target.win ?? window;
  const pauseOnBlur = hooks.pauseOnBlur ?? (() => true);

  // Query-based sync (§2.9): events are hints, the current state is the truth.
  const sync = (): void => {
    if (doc.visibilityState === 'hidden') hooks.addPauseSource('tab_hidden');
    else hooks.removePauseSource('tab_hidden');

    if (pauseOnBlur() && !doc.hasFocus()) hooks.addPauseSource('window_blur');
    else hooks.removePauseSource('window_blur');
  };

  const onVisibilityChange = (): void => {
    sync();
    if (doc.visibilityState === 'hidden') hooks.requestAutosave('immediate');
  };

  const onBlur = (): void => {
    sync();
    hooks.requestAutosave('debounced');
  };

  const onFocus = (): void => {
    sync();
  };

  doc.addEventListener('visibilitychange', onVisibilityChange);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  sync();

  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
  };
}
