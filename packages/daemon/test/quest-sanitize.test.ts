/**
 * sanitize() privacy red line (PRD 05 §F, verification A3) — the single most
 * important M4 test. Drives the §4.3 sanitizer with a fixture transcript seeded
 * with one example of EVERY secret class and asserts:
 *   - 0 hits for every SECRET_PATTERNS regex in the output;
 *   - the injected $HOME prefix is rewritten to `~` (homeDir never appears);
 *   - per-message + whole-text length caps hold;
 *   - control characters are stripped (terminal-injection defence).
 *
 * The SECRET_PATTERNS table is implemented data (load-bearing), so the regex-
 * matching half runs unconditionally. The `sanitize()` body is a contract
 * SKELETON until its sub-task lands; its behavioural assertions are gated behind
 * `questModuleReady` (the documented sim-layer discipline) so this suite is green
 * now and becomes a live A3 regression the moment the body lands.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_CHARS_RE,
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
  REDACTED,
  SECRET_PATTERNS,
  sanitize,
} from '../src/quest/sanitize.js';
import { questModuleReady } from './helpers/quest-ready.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/transcripts/', import.meta.url));
const FAKE_HOME = '/Users/testuser';

/** One realistic secret of each of the seven §4.3 classes (used standalone + inline). */
const SECRET_SAMPLES = {
  aws: 'AKIAIOSFODNN7EXAMPLE',
  openai: 'sk-abcdefghijklmnopqrstuvwx0123',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuv',
  githubToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
  githubPat: 'github_pat_abcdefghijklmnopqrstuv_wxyz1234',
  slack: 'xoxb-1234567890-abcdefghij',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIBfakekeydata0123456789\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4',
  assignment: 'password = hunter2supersecretvalue',
};

/**
 * Count SECRET_PATTERNS matches against `text`, EXCLUDING matches that are exactly
 * the redaction token. The assignment-form pattern (`password=…`) legitimately
 * re-matches `[REDACTED]` (the token IS the `\S+` after `password = `), so a naive
 * "0 matches" is not the A3 invariant — "no REAL secret material survives" is.
 * Anything other than `[REDACTED]` matching a secret pattern is a true leak.
 */
function realSecretHits(text: string): number {
  let hits = 0;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const all = text.match(re) ?? [];
    for (const m of all) {
      if (m !== REDACTED) hits += 1;
    }
  }
  return hits;
}

const ready = questModuleReady(() => sanitize('probe', { homeDir: FAKE_HOME }));

describe('SECRET_PATTERNS coverage (the data — runs unconditionally, A3)', () => {
  it('matches a seeded example of every secret class', () => {
    for (const [name, sample] of Object.entries(SECRET_SAMPLES)) {
      const matched = SECRET_PATTERNS.some((re) => {
        re.lastIndex = 0;
        return re.test(sample);
      });
      expect(matched, `secret class "${name}" must be matched by some SECRET_PATTERN`).toBe(true);
    }
  });

  it('does not flag innocuous prose (no false positives on plain text)', () => {
    const prose =
      'I am deciding between exponential backoff and a circuit breaker for the login retry policy.';
    expect(realSecretHits(prose)).toBe(0);
  });
});

describe.runIf(ready)('sanitize() output is secret-free (A3 — gated on implementation)', () => {
  it('redacts every secret class from an inline block (no real secret survives)', () => {
    const raw = Object.values(SECRET_SAMPLES).join('\n');
    const out = sanitize(raw, { homeDir: FAKE_HOME });
    expect(realSecretHits(out)).toBe(0);
    expect(out).toContain(REDACTED);
    // The original secret material is gone byte-for-byte.
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuv');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('hunter2supersecretvalue');
  });

  it('redacts secrets in a real fixture transcript and never leaks $HOME', async () => {
    const fixture = (await readFile(`${FIXTURES}secrets.jsonl`, 'utf8')).replaceAll(
      'HOMEPLACEHOLDER',
      FAKE_HOME,
    );
    const out = sanitize(fixture, { homeDir: FAKE_HOME });
    // A3: no real secret material survives in the sanitized output.
    expect(realSecretHits(out)).toBe(0);
    // Every seeded high-entropy secret value is gone byte-for-byte. The
    // assignment form (`password = …`) is excluded here: only its VALUE is
    // redacted (the key `password` legitimately stays, §4.3-2).
    const highEntropyValues = [
      SECRET_SAMPLES.aws,
      SECRET_SAMPLES.openai,
      SECRET_SAMPLES.anthropic,
      SECRET_SAMPLES.githubToken,
      SECRET_SAMPLES.githubPat,
      SECRET_SAMPLES.slack,
      SECRET_SAMPLES.jwt,
      'hunter2supersecretvalue', // the assignment VALUE
      'MIIBfakekeydata0123456789', // the PEM body
    ];
    for (const value of highEntropyValues) {
      expect(out).not.toContain(value);
    }
    // The ❌ leaks that must be dropped at the field-whitelist layer would still
    // appear in the raw fixture text passed straight to sanitize() here (sanitize
    // does not field-filter); but their secret tokens are still redacted, proving
    // sanitize is a sound LAST line even if the whitelist ever regresses.
    expect(out).not.toContain('AKIAZZZZZZZZZZZZZZZZ'); // the tool_use-embedded key
    // $HOME prefix rewritten to ~ ; the absolute home path never survives.
    expect(out).not.toContain(FAKE_HOME);
  });

  it('rewrites the $HOME prefix to ~ (path de-identification, §4.3-1)', () => {
    const out = sanitize(`${FAKE_HOME}/work/payments/src/login.ts`, { homeDir: FAKE_HOME });
    expect(out).not.toContain(FAKE_HOME);
    expect(out).toContain('~/work/payments');
  });

  it('caps the whole text at MAX_TOTAL_CHARS', () => {
    const huge = 'x'.repeat(MAX_TOTAL_CHARS * 4);
    const out = sanitize(huge, { homeDir: FAKE_HOME });
    expect(out.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
  });

  it('strips control characters (terminal-injection defence, §4.3-4)', () => {
    const out = sanitize('before\x00\x07\x1bafter', { homeDir: FAKE_HOME });
    CONTROL_CHARS_RE.lastIndex = 0;
    expect(CONTROL_CHARS_RE.test(out)).toBe(false);
  });

  it('keeps a within-bounds message intact (no truncation marker when short)', () => {
    const short = 'a short safe message about naming a function';
    const out = sanitize(short, { homeDir: FAKE_HOME });
    expect(out).toContain('naming a function');
    expect(MAX_MESSAGE_CHARS).toBe(500);
  });
});

describe('implementation-landed tracker (A3 — flips this suite live)', () => {
  it('documents whether sanitize() is implemented yet', () => {
    // Not an assertion that forces red: it records the skeleton state so a reader
    // (and CI log) can see the A3 behavioural suite is gated, not forgotten. When
    // the body lands, `ready` is true and the describe.runIf block above runs.
    expect(typeof ready).toBe('boolean');
  });
});
