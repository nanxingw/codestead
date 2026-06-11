/**
 * Standalone recorder entry — interim bin script until `codestead record`
 * is wired in cli.ts (M2 build-out). Run explicitly, by a human:
 *
 *   pnpm --filter @codestead/daemon exec tsx src/install/record-main.ts <outFile.jsonl> [basePort]
 *
 * Privacy: this process prints ONLY the port and event counts — never bodies.
 * It touches nothing under ~/.claude; it only listens on a 127.0.0.1 port and
 * appends raw (scrubbed=false) lines to <outFile>. Scrub with scrub-main.ts
 * before committing anything to test/fixtures (see test/fixtures/README.md).
 */
import process from 'node:process';

import { HOOKS_PATH } from '@codestead/shared';

import { startHookRecorder } from './recorder.js';

async function main(): Promise<number> {
  const [outFile, basePortArg] = process.argv.slice(2);
  if (outFile === undefined || outFile === '') {
    console.error('usage: tsx src/install/record-main.ts <outFile.jsonl> [basePort]');
    return 1;
  }
  let basePort: number | undefined;
  if (basePortArg !== undefined) {
    basePort = Number(basePortArg);
    if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535) {
      console.error(`basePort must be an integer port number, got "${basePortArg}"`);
      return 1;
    }
  }

  const recorder = await startHookRecorder({ outFile, basePort });
  console.log(
    `[codestead recorder] listening on http://127.0.0.1:${String(recorder.port)}${HOOKS_PATH}`,
  );
  console.log(`[codestead recorder] appending RAW (scrubbed=false) events to ${outFile}`);
  console.log(
    '[codestead recorder] use Claude Code normally, then Ctrl-C here; scrub before committing.',
  );

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await recorder.close();
  console.log(`[codestead recorder] stopped — ${String(recorder.eventCount())} event(s) recorded.`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(
      `[codestead recorder] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  },
);
