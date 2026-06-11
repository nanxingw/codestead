/**
 * aim.ts — facing-tile interaction model (GDD §1.7, pure / Phaser-free).
 *
 * Keyboard aim: target = facing tile, with the FOOT-TILE FALLBACK (standing on a
 * mature crop and pressing E harvests it). Mouse aim: target = hover tile when within
 * Chebyshev distance ≤1 of the player tile (the 3×3 reach); outside that, no pathing,
 * no movement — just a 120ms grey "too far" flash. Keyboard E and mouse click MUST
 * converge into the same `interact` sim command (GDD §1.7 equivalence, PRD 01 US21).
 */
import type { Facing, TilePos } from '../sim/types';

export type AimMode = 'keyboard' | 'mouse';

/** Mouse movement (accumulated) needed to steal aim from the keyboard (GDD §1.7). */
export const MOUSE_TAKEOVER_PX = 8;

export const FACING_DELTA: Readonly<Record<Facing, TilePos>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function chebyshev(a: TilePos, b: TilePos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function sameTile(a: TilePos | null, b: TilePos | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y;
}

export interface ResolveArgs {
  playerTile: TilePos;
  facing: Facing;
  aimMode: AimMode;
  /** Tile under the mouse cursor (mouse aim only). */
  hoverTile: TilePos | null;
  /** `sim.queryAction(t, activeItem).valid` for the keyboard fallback decision. */
  isValid: (tile: TilePos) => boolean;
}

export interface ResolvedTarget {
  /** Target tile, or null when the mouse points outside the 3×3 reach. */
  tile: TilePos | null;
  /** Mouse aim only: hover is outside reach → flash the grey cursor (GDD §1.7). */
  tooFar: boolean;
}

/** Direct transcription of the GDD §1.7 `resolveTargetTile` pseudocode. */
export function resolveTargetTile(args: ResolveArgs): ResolvedTarget {
  const { playerTile, facing, aimMode, hoverTile, isValid } = args;
  if (aimMode === 'keyboard') {
    const delta = FACING_DELTA[facing];
    const ahead = { x: playerTile.x + delta.x, y: playerTile.y + delta.y };
    if (!isValid(ahead) && isValid(playerTile)) {
      return { tile: playerTile, tooFar: false }; // foot-tile fallback
    }
    return { tile: ahead, tooFar: false };
  }
  if (hoverTile === null) return { tile: null, tooFar: false };
  if (chebyshev(hoverTile, playerTile) <= 1) return { tile: hoverTile, tooFar: false };
  return { tile: null, tooFar: true };
}

/**
 * Facing after clicking a tile in the 3×3 reach: turn toward it without moving
 * (GDD §1.7). Dominant axis wins; exact diagonals resolve horizontally (deterministic);
 * clicking the player's own tile keeps the current facing.
 */
export function facingToward(from: TilePos, to: TilePos, current: Facing): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return current;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
