/**
 * Minimal line diff for the installer's `--dry-run` output: '-' / '+' / ' '
 * prefixed lines (no hunk headers), long unchanged runs elided. Pure and
 * deterministic, zero deps — settings files are tiny, so a classic LCS table
 * is plenty (with a size guard falling back to whole-file before/after).
 */

const CONTEXT_LINES = 3;
/** Above this LCS table size, fall back to a plain before/after listing. */
const MAX_LCS_CELLS = 4_000_000;

export function renderSettingsDiff(before: string, after: string): string {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);

  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)].join('\n');
  }

  const ops = diffOps(a, b);
  return elideUnchanged(ops).join('\n');
}

interface DiffOp {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

function splitLines(text: string): string[] {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** Classic LCS dynamic program + backtrack into an edit script. */
function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: '-', line: a[i] });
  for (; j < b.length; j++) ops.push({ kind: '+', line: b[j] });
  return ops;
}

/** Keep CONTEXT_LINES of context around changes; collapse longer ' ' runs. */
function elideUnchanged(ops: readonly DiffOp[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  let seenChange = false;

  const flushRun = (isEnd: boolean): void => {
    const head = seenChange ? Math.min(CONTEXT_LINES, run.length) : 0;
    const tail = isEnd ? 0 : Math.min(CONTEXT_LINES, run.length - head);
    const elided = run.length - head - tail;
    for (let k = 0; k < head; k++) out.push(`  ${run[k]}`);
    if (elided > 0) out.push(`  ... (${String(elided)} unchanged lines)`);
    for (let k = run.length - tail; k < run.length; k++) out.push(`  ${run[k]}`);
    run = [];
  };

  for (const op of ops) {
    if (op.kind === ' ') {
      run.push(op.line);
      continue;
    }
    flushRun(false);
    seenChange = true;
    out.push(`${op.kind} ${op.line}`);
  }
  flushRun(true);
  return out;
}
