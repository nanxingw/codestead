/**
 * Integer-scaling helper for the pixel-art hard spec (game-design §0.3):
 * logical resolution 640x360, integer zoom only (x1 / x2 / x3 ...), no fractional offsets.
 */

export const GAME_WIDTH = 640;
export const GAME_HEIGHT = 360;

/**
 * Largest integer zoom that fits the logical resolution into the available area.
 * Windows smaller than 640x360 clamp to 1 (game-design §0.3: never below x1, never fractional).
 */
export function computeIntegerZoom(
  availableWidth: number,
  availableHeight: number,
  logicalWidth: number = GAME_WIDTH,
  logicalHeight: number = GAME_HEIGHT,
): number {
  const zoomX = Math.floor(availableWidth / logicalWidth);
  const zoomY = Math.floor(availableHeight / logicalHeight);
  return Math.max(1, Math.min(zoomX, zoomY));
}
