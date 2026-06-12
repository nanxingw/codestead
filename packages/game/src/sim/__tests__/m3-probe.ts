/**
 * M3 readiness probes — the same gating pattern M1 used for its TODO skeletons
 * (see fixtures.ts moduleReady): the M3 contract pass shipped binding signatures with
 * bodies that throw "… contract stub — M3 implementer: <fn> not implemented".
 *
 * Suites written against those signatures are gated with `describe.skipIf(!ready)` so
 * they are SKIPPED (visibly, never red) while the stub is in place and ARM THEMSELVES
 * the moment the implementer lands the body — any later contract regression is then a
 * red test. When all M3 bodies have landed, delete this helper and the gates exactly
 * like M1 did ("skipIf gates removed … a false probe is a loud red").
 */
export function m3Implemented(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (err) {
    return !(err instanceof Error && err.message.includes('contract stub'));
  }
}
