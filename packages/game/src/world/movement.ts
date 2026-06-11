/**
 * movement.ts — pure player-displacement core (GDD §1.6), Phaser-free so the
 * anti-tunneling contract is headless-testable (backlog A-10).
 *
 * Anti-tunneling discipline:
 *  - frame deltas are clamped to MAX_MOVE_DELTA_MS (a throttled/woken-up tab must
 *    not teleport the player), and
 *  - each frame's displacement is applied in slices of ≤ MAX_MOVE_STEP_PX per
 *    collision test, so no 16px wall can ever be stepped over in a single check.
 *
 * Corner forgiveness (GDD §1.6): when the blocking overlap on the perpendicular
 * axis is within CORNER_FORGIVENESS_PX, slide 1px toward the clear side instead of
 * stopping dead — applied once per axis-move call, exactly like M1-core.
 */
import type { Dir } from './input-stack';

export const MAX_MOVE_DELTA_MS = 100;
export const MAX_MOVE_STEP_PX = 8;

/** Foot-center collision predicate (the caller wraps its AABB + map bounds). */
export type BodyCollides = (x: number, y: number) => boolean;

export interface Position {
  x: number;
  y: number;
}

/** One axis-aligned move attempt with corner forgiveness; ≤ MAX_MOVE_STEP_PX please. */
export function moveAxisOnce(
  pos: Position,
  dx: number,
  dy: number,
  collides: BodyCollides,
  forgivenessPx: number,
): Position {
  const nx = pos.x + dx;
  const ny = pos.y + dy;
  if (!collides(nx, ny)) return { x: nx, y: ny };
  if (dx !== 0) {
    for (let nudge = 1; nudge <= forgivenessPx; nudge++) {
      if (!collides(nx, pos.y - nudge)) return { x: pos.x, y: pos.y - 1 };
      if (!collides(nx, pos.y + nudge)) return { x: pos.x, y: pos.y + 1 };
    }
  } else if (dy !== 0) {
    for (let nudge = 1; nudge <= forgivenessPx; nudge++) {
      if (!collides(pos.x - nudge, ny)) return { x: pos.x - 1, y: pos.y };
      if (!collides(pos.x + nudge, ny)) return { x: pos.x + 1, y: pos.y };
    }
  }
  return pos; // fully blocked
}

/**
 * Apply one frame of movement: clamp the delta, then advance in ≤8px slices —
 * every slice re-tests collision, so large deltas cannot tunnel (backlog A-10).
 */
export function moveSliced(
  pos: Position,
  dir: Dir,
  speedPxPerS: number,
  deltaMs: number,
  collides: BodyCollides,
  forgivenessPx: number,
): Position {
  let current = pos;
  let remaining = (speedPxPerS * Math.min(deltaMs, MAX_MOVE_DELTA_MS)) / 1000;
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_MOVE_STEP_PX);
    remaining -= step;
    const dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
    const dy = dir === 'up' ? -step : dir === 'down' ? step : 0;
    const next = moveAxisOnce(current, dx, dy, collides, forgivenessPx);
    if (next.x === current.x && next.y === current.y) break; // blocked: stop early
    current = next;
  }
  return current;
}
