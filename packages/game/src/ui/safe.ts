/**
 * safe.ts — guard for sim-derived display values.
 *
 * The M1 streams land in parallel; sim skeleton functions throw TODO errors until the
 * sim stream merges. The always-on HUD must never take the whole scene down because a
 * derivation is not wired yet, so display-only calls go through `safe()` (errors are
 * logged once per call site label).
 */
const warned = new Set<string>();

export function safe<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (!warned.has(label)) {
      warned.add(label);
      console.warn(`[ui] ${label} unavailable, using fallback:`, err);
    }
    return fallback;
  }
}
