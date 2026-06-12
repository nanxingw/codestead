/**
 * sanitize() — the privacy red line (ai-quests §4.3 / §12; verification A3).
 *
 * Runs IN-PROCESS (本机) before prompt assembly; the sanitized text is the ONLY
 * work content allowed to enter the prompt. The seven secret-pattern regexes
 * below are the single source of truth — the A3 test asserts 0 hits against a
 * fixture transcript seeded with one example of every class, and that `$HOME`
 * never appears in the prompt.
 *
 * SKELETON: the regex table, length constants, control-char set, and the pure
 * `sanitize()` signature are fixed (load-bearing — they ARE the contract). The
 * replacement body is implemented by the sanitize sub-task; it MUST apply, in
 * order: (1) $HOME→`~` path rewrite, (2) secret regex → `[REDACTED]`, (3) per-
 * message + whole-text length truncation, (4) control-char stripping.
 */

/** Replacement token for any matched secret (§4.3-2). */
export const REDACTED = '[REDACTED]';

/** Per-message length cap; >cap ⇒ first 300 + `[...截断...]` + last 150 (§4.3-3). */
export const MAX_MESSAGE_CHARS = 500;
export const MESSAGE_HEAD_CHARS = 300;
export const MESSAGE_TAIL_CHARS = 150;
export const MESSAGE_TRUNCATION_MARKER = '[...截断...]';

/** Whole-text cap fed downstream / to stdin (§4.3-3 / §4.5). */
export const MAX_TOTAL_CHARS = 6_000;

/**
 * Control characters stripped to prevent terminal injection (§4.3-4):
 * \x00-\x08, \x0b, \x0c, \x0e-\x1f (TAB \x09 and LF \x0a are preserved).
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * The seven secret-pattern classes (§4.3-2). On a match the WHOLE token is
 * replaced with REDACTED (the assignment-form replaces only the value part).
 * Order is not significant — every pattern is applied. Each is `g`-flagged so
 * all occurrences are caught.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic key (before the generic sk- so it wins)
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-form key
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM block
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(?<=(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi, // assignment value
];

/** Inputs to sanitize: the injected $HOME so the rewrite never reads process.env in the pure fn. */
export interface SanitizeContext {
  /** Absolute home dir whose prefix is rewritten to `~` (§4.3-1). Injected (no os.homedir in the pure fn). */
  readonly homeDir: string;
}

/**
 * Sanitize one block of extracted work text into the prompt-safe form (§4.3).
 * PURE. SKELETON — body implemented by the sanitize sub-task in the documented
 * four-step order. The A3 contract: for every pattern in SECRET_PATTERNS, the
 * OUTPUT must contain 0 matches; `homeDir` must not appear; output length ≤
 * MAX_TOTAL_CHARS; CONTROL_CHARS_RE finds nothing in the output.
 */
/**
 * Truncate a single message to MAX_MESSAGE_CHARS: keep the first MESSAGE_HEAD_CHARS
 * and last MESSAGE_TAIL_CHARS with the marker between (§4.3-3). Measured in code
 * units (JS string length) — the schema/CLI bounds are likewise char-based.
 */
function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return (
    text.slice(0, MESSAGE_HEAD_CHARS) +
    MESSAGE_TRUNCATION_MARKER +
    text.slice(text.length - MESSAGE_TAIL_CHARS)
  );
}

export function sanitize(text: string, ctx: SanitizeContext): string {
  // (1) $HOME → `~` path rewrite. Replace every occurrence of the absolute home
  //     prefix; relative project paths are left intact (§4.3-1). homeDir is
  //     injected so the pure fn never reads process.env / os.homedir().
  let out = text;
  if (ctx.homeDir.length > 0) {
    out = out.split(ctx.homeDir).join('~');
  }

  // (2) secret regex → [REDACTED]. Every pattern is applied (order-independent);
  //     the assignment-form pattern uses a lookbehind so only the VALUE token is
  //     replaced (§4.3-2). All patterns are g-flagged; reset lastIndex defensively.
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }

  // (3) per-message truncation then whole-text cap (§4.3-3). "Per message" here is
  //     per-line: the extracted context is line-oriented (title / lastPrompt /
  //     turns each on their own line, joined by '\n' upstream in buildPrompt).
  out = out
    .split('\n')
    .map((line) => truncateMessage(line))
    .join('\n');

  // (4) strip control characters BEFORE the final cap so length is measured on the
  //     clean text (§4.3-4). TAB (\x09) and LF (\x0a) are preserved.
  CONTROL_CHARS_RE.lastIndex = 0;
  out = out.replace(CONTROL_CHARS_RE, '');

  // Whole-text ceiling: take the head (most-recent context is appended last by the
  // caller, but the floor for "enough context" is enforced AFTER this; the cap only
  // bounds cost & leak surface). Slice rather than truncate-with-marker — this is a
  // hard size gate, not a human-facing message.
  if (out.length > MAX_TOTAL_CHARS) out = out.slice(0, MAX_TOTAL_CHARS);

  return out;
}
