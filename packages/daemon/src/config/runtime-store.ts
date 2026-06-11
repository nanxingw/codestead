/**
 * File-backed DaemonRuntimeStore — persists `DaemonRuntimeInfo` to the injected
 * `daemon.json` path (config/paths.ts `daemonRuntimeFile`; CLI & local tools
 * ONLY — browsers discover the daemon via GET /handshake, hud-sessions §10.4-2).
 *
 * The file contains the local auth token, so it is written 0600 and removed on
 * clean shutdown (a stale file must never advertise a dead daemon). The path is
 * always injected — tests point it at a temp dir, never the real ~/.codestead
 * (hard rule).
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { DaemonRuntimeInfo, DaemonRuntimeStore } from './token.js';

/** Daemon-internal file shape — NOT wire protocol (see config/token.ts). */
const DaemonRuntimeInfoSchema = z.object({
  port: z.int().min(1).max(65535),
  wsPath: z.string(),
  token: z.string(),
  daemonVersion: z.string(),
  pid: z.int(),
});

export function createFileDaemonRuntimeStore(file: string): DaemonRuntimeStore {
  return {
    async read(): Promise<DaemonRuntimeInfo | null> {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return null; // absent = no daemon advertised
      }
      try {
        const parsed = DaemonRuntimeInfoSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null; // corrupted file behaves like an absent one
      }
    },

    async write(info: DaemonRuntimeInfo): Promise<void> {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
      // writeFile's mode only applies on creation — enforce on rewrite too.
      await chmod(file, 0o600);
    },

    async remove(): Promise<void> {
      await rm(file, { force: true });
    },
  };
}
