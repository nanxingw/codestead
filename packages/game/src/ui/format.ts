/**
 * format.ts — small pure display formatters (GDD §4.1 thousands separator,
 * §2.2 clock display). Phaser-free so they are unit-testable in node.
 */

/** Thousands-separated gold figure: 1234 → "1,234" (GDD §4.1 display rule). */
export function formatGold(gold: number): string {
  return Math.trunc(gold)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "14:05" → "14:00" stepping handled by sim timeView; this just zero-pads. */
export function formatClock(hh: number, mm: number): string {
  return `${hh}:${mm.toString().padStart(2, '0')}`;
}
