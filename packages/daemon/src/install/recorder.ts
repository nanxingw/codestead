/**
 * Hook event recorder — THE FIRST M2 deliverable (tech-stack §9-3; PRD 03
 * US56 / impl. decision 6). A standalone HTTP sink that captures a real
 * multi-session hook event stream to a JSONL fixture file; those fixtures are
 * the replay assets that guard the state machine against hooks semantic drift
 * (risk #2): upgrade Claude Code → re-record → replay failure = drift alarm.
 *
 * Behaves exactly like the daemon's /hooks endpoint from Claude Code's point
 * of view: empty 2xx always, never blocks, same 43110-window port semantics
 * so existing installed hooks point at it without reconfiguration.
 *
 * Fixture privacy (red line): raw hook bodies can contain `prompt` text.
 * Fixtures live under daemon/test/fixtures and are COMMITTED — before commit
 * they MUST be scrubbed of prompt/tool payload content (keep only the fields
 * HookWireEventSchema names; see scrub.ts). The recorder writes a
 * `scrubbed: boolean` flag per line so unscrubbed fixtures are mechanically
 * detectable in CI/review.
 *
 * Like every daemon listener: binds 127.0.0.1 ONLY, and never logs bodies.
 */
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';

import { DAEMON_HOST, DAEMON_PORT_BASE, DAEMON_PORT_MAX, HOOKS_PATH } from '@codestead/shared';

/** One JSONL line per received hook event. */
export interface RecordedHookEvent {
  /** ISO 8601 receive time — replay uses it to reconstruct `at`. */
  readonly at: string;
  /** Raw POST body (verbatim when scrubbed=false; field-whitelisted when true). */
  readonly body: unknown;
  readonly scrubbed: boolean;
}

export interface HookRecorderOptions {
  /** JSONL output path — injected; tests use temp files. */
  readonly outFile: string;
  /** Port window to bind, defaults to 43110–43119 (same as the daemon). 0 = OS-assigned (tests). */
  readonly basePort?: number;
  readonly maxPort?: number;
  readonly now?: () => number;
}

export interface HookRecorder {
  readonly port: number;
  /** Events written so far (observability for `codestead record` CLI output). */
  eventCount(): number;
  close(): Promise<void>;
}

export async function startHookRecorder(opts: HookRecorderOptions): Promise<HookRecorder> {
  const basePort = opts.basePort ?? DAEMON_PORT_BASE;
  const maxPort =
    opts.maxPort ?? (basePort === 0 ? 0 : basePort + (DAEMON_PORT_MAX - DAEMON_PORT_BASE));
  const now = opts.now ?? Date.now;

  await mkdir(dirname(opts.outFile), { recursive: true });

  let count = 0;
  const record = (rawBody: string): void => {
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Keep the raw string — scrub.ts drops lines that never parse.
    }
    const line: RecordedHookEvent = { at: new Date(now()).toISOString(), body, scrubbed: false };
    appendFileSync(opts.outFile, `${JSON.stringify(line)}\n`, 'utf8');
    count++;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respondEmpty2xx = (): void => {
      res.statusCode = 204;
      res.end();
    };
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || path !== HOOKS_PATH) {
      // Same listen-only stance as the daemon: anything else still gets an
      // empty 2xx so a probing/misconfigured client is never blocked.
      req.resume();
      respondEmpty2xx();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        record(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Disk trouble must never stall Claude Code — still answer 2xx.
      }
      respondEmpty2xx();
    });
    req.on('error', respondEmpty2xx);
  });

  const port = await listenWithinWindow(server, basePort, maxPort);

  return {
    port,
    eventCount: () => count,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** EADDRINUSE → try the next port, up to maxPort (same semantics as the daemon). */
async function listenWithinWindow(
  server: Server,
  basePort: number,
  maxPort: number,
): Promise<number> {
  for (let port = basePort; ; port++) {
    try {
      return await listenOnce(server, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && port < maxPort) continue;
      throw err;
    }
  }
}

function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, DAEMON_HOST);
  });
}
