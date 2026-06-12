/**
 * Readiness probe for the M4 daemon quest skeletons (PRD 05).
 *
 * The contract layer ships every quest pure-function as a SKELETON that throws
 * `not implemented: …` until its implementation sub-task lands. Mirrors the sim
 * layer's `moduleReady` discipline (game/src/sim/__tests__/fixtures.ts): a probe
 * returns false ONLY for the documented skeleton throw, so behavioural assertions
 * are gated behind it WHILE keeping an explicit "implementation landed?" check —
 * a body that lands flips the probe to true and the guarded suite runs for real,
 * never silently skipped.
 *
 * `it.runIf(ready(fn))` is the gate: green now (body throws ⇒ guarded-out), and
 * the moment the daemon implementation lands these become live regression tests.
 */

/** The exact skeleton marker the quest contract bodies throw with. */
const SKELETON_MARKER = 'not implemented';

/** True when `probe()` does NOT throw the skeleton "not implemented" error. */
export function questModuleReady(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes(SKELETON_MARKER)) return false;
    // A different throw means the body IS implemented and threw for another
    // (test-relevant) reason — treat as ready so the real assertion surfaces it.
    return true;
  }
}

/** Async variant: a rejected Promise carrying the skeleton marker counts as not-ready. */
export async function questModuleReadyAsync(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes(SKELETON_MARKER)) return false;
    return true;
  }
}
