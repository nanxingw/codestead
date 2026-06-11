/**
 * Daemon endpoint discovery — the ONLY HTTP contract outside the WebSocket
 * (hud-sessions §10.3 P2 / §10.4 ruling #2; tech-stack §5 endpoint discovery).
 *
 * The browser cannot read `~/.codestead/daemon.json` (that file is for the CLI
 * and local tools only), so the game discovers the daemon by probing
 * `GET http://127.0.0.1:<port>/handshake` over ports 43110–43119 in order
 * (tech-stack risk #13: the daemon increments its port when 43110 is taken).
 *
 * Security invariants pinned here (tech-stack §4.1-5):
 * - the daemon binds 127.0.0.1 ONLY — never 0.0.0.0;
 * - CORS on /handshake allows only the dev-time Vite origin whitelist
 *   (M5: daemon serves the game → same origin, no CORS surface);
 * - the token returned here must be sent as the first WS frame (`auth`).
 */
import { z } from 'zod';

/** Loopback only — a daemon bound anywhere else is a contract violation. */
export const DAEMON_HOST = '127.0.0.1';

/** First port the daemon tries and the game probes (tech-stack §4.1). */
export const DAEMON_PORT_BASE = 43110;
/** Last port (inclusive) of the probe window (hud-sessions §10.3 P2). */
export const DAEMON_PORT_MAX = 43119;

/** Probe order for the game client: 43110, 43111, … 43119 (strictly ascending). */
export const DAEMON_PROBE_PORTS: readonly number[] = Object.freeze(
  Array.from({ length: DAEMON_PORT_MAX - DAEMON_PORT_BASE + 1 }, (_, i) => DAEMON_PORT_BASE + i),
);

/** HTTP path of the discovery endpoint. */
export const HANDSHAKE_PATH = '/handshake';
/** HTTP path Claude Code hooks POST to (installer writes this URL; tech-stack §4.1-1). */
export const HOOKS_PATH = '/hooks';
/** Default WS upgrade path — clients MUST still honor `wsPath` from the handshake. */
export const DEFAULT_WS_PATH = '/ws';

/** `GET /handshake` 200 response body (hud-sessions §10.3 P2). */
export const HandshakeResponseSchema = z.object({
  port: z.int().min(1).max(65535),
  wsPath: z.string(),
  token: z.string(),
  daemonVersion: z.string(),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

/** Canonical handshake URL for one probe step. */
export function handshakeUrl(port: number): string {
  return `http://${DAEMON_HOST}:${String(port)}${HANDSHAKE_PATH}`;
}
