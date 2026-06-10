/**
 * Five-state status color tokens (CODE-28 palette).
 *
 * Single source of truth for HUD and in-game UI colors — never use bare hex
 * for session states anywhere else.
 * Source of truth for values: docs/design/game-design.md §7.3 / §11.2 (appendix A-8).
 * Note (game-design §7.3): color is never the only encoding — every state also
 * has an icon shape (double-encoding rule, enforced at HUD implementation time, M2).
 *
 * The full CODE-28 game palette belongs to M1 (PRD 01); M0 ships only these tokens.
 */
import type { SessionState } from './session.js';

/** Status color per session state (game-design §7.3). */
export const SESSION_STATE_COLORS: Readonly<Record<SessionState, string>> = {
  working: '#4fa4e8', // water.light — ◐ spinner
  blocked: '#e8a33d', // amber — ! breathing (the only persistent animation)
  done: '#62a64f', // green.light — ✓
  idle: '#9aa0a6', // ui.textDim — ○
  unknown: '#8a8198', // ? dashed outline
};

/** Error modifier color (red.mid) — used when a blocked session carries `error` (StopFailure). */
export const ERROR_MODIFIER_COLOR = '#d96a6a';
