/**
 * Standalone fixture scrubber entry — the second half of the recording
 * pipeline (see record-main.ts and test/fixtures/README.md):
 *
 *   pnpm --filter @codestead/daemon exec tsx src/install/scrub-main.ts <in.jsonl> <out.jsonl> [username]
 *
 * Reads a raw recording, whitelists fields to HookWireEventSchema's names,
 * replaces the account username (auto-detected from cwd/transcript_path when
 * not given) with `user`, marks lines scrubbed=true, and DROPS lines that are
 * not replayable hook events. Prints only line counts — never content.
 */
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { scrubFixture } from './scrub.js';

async function main(): Promise<number> {
  const [inFile, outFile, username] = process.argv.slice(2);
  if (inFile === undefined || inFile === '' || outFile === undefined || outFile === '') {
    console.error('usage: tsx src/install/scrub-main.ts <in.jsonl> <out.jsonl> [username]');
    return 1;
  }
  const raw = await readFile(inFile, 'utf8');
  const scrubbed = scrubFixture(raw, username);
  await writeFile(outFile, scrubbed, 'utf8');

  const inLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  const outLines = scrubbed.split('\n').filter((l) => l.trim() !== '').length;
  console.log(
    `[codestead scrub] ${String(inLines)} line(s) in → ${String(outLines)} scrubbed line(s) out ` +
      `(${String(inLines - outLines)} dropped); review ${outFile} by hand before committing.`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`[codestead scrub] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
