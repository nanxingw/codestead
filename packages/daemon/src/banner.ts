/** Pure helper for the startup banner — kept pure so it is trivially testable. */
export function formatStartupBanner(daemonVersion: string, protocolVersion: number): string {
  return `codestead daemon v${daemonVersion} · protocol v${protocolVersion} · M0 placeholder (no server, no hooks)`;
}
