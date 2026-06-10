/**
 * M0 placeholder entry: start -> print version -> exit cleanly.
 *
 * Scope guard (PRD 00, implementation decision 10 — privacy first, perceive don't intervene):
 * - opens NO port,
 * - reads/writes NOTHING under `~/.claude` or `~/.codestead`,
 * - spawns NO process.
 * Session monitoring, HTTP/WS server and hooks installer all belong to M2 (PRD 03).
 */
import { readFileSync } from 'node:fs';

import { PROTOCOL_VERSION } from '@codestead/shared';

import { formatStartupBanner } from './banner.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

console.log(formatStartupBanner(pkg.version, PROTOCOL_VERSION));
// No listeners, no timers: the process exits cleanly (code 0) right after printing.
