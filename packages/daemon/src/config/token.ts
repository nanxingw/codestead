/**
 * Local auth token — third leg of the security tripod (tech-stack §4.1-5):
 * bind 127.0.0.1 + Origin check + first-frame `auth { token }`.
 *
 * The token is generated per daemon start, exposed to the browser ONLY via
 * `GET /handshake`, and persisted to `daemon.json` (CLI/local tools only).
 * It never appears in logs.
 */
import { randomBytes } from 'node:crypto';

/** 32 random bytes, base64url — URL/JSON-safe, no padding. RNG injectable for tests. */
export function generateToken(rng: (size: number) => Buffer = randomBytes): string {
  return rng(32).toString('base64url');
}

/**
 * Shape of `~/.codestead/daemon.json` (daemon-internal file, NOT wire protocol —
 * the wire contract is `HandshakeResponseSchema` in @codestead/shared).
 * `pid` lets the CLI implement status/stop later.
 */
export interface DaemonRuntimeInfo {
  readonly port: number;
  readonly wsPath: string;
  readonly token: string;
  readonly daemonVersion: string;
  readonly pid: number;
}

/**
 * Persistence seam for DaemonRuntimeInfo — backed by `paths.daemonRuntimeFile`
 * in production; in-memory in tests. Implementation lands with the server (M2).
 */
export interface DaemonRuntimeStore {
  read(): Promise<DaemonRuntimeInfo | null>;
  write(info: DaemonRuntimeInfo): Promise<void>;
  /** Remove on clean shutdown so stale files never advertise a dead daemon. */
  remove(): Promise<void>;
}
