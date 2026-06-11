/**
 * Real argv entry for the CLI runner (interim until the npm `bin` wiring at
 * M5, PRD 06). This is the ONLY place in the package allowed to pass the real
 * home directory (config/paths.ts hard rule) — and it runs ONLY when a human
 * explicitly invokes it:
 *
 *   pnpm --filter @codestead/daemon dev               # = tsx src/cli-main.ts start
 *   pnpm --filter @codestead/daemon record <out.jsonl> [port]
 *   pnpm --filter @codestead/daemon install:dry-run
 *
 * Tests NEVER import this file — they call runCli with a temp homeDir.
 */
import { homedir } from 'node:os';
import process from 'node:process';

import { runCli } from './cli.js';

runCli(process.argv.slice(2), {
  homeDir: homedir(),
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`[codestead] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
