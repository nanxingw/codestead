/**
 * Fixture scrubbing — the privacy gate between a raw recording and a
 * committed fixture (red line: session data never leaves this machine, and
 * the repo must never contain prompt/transcript content).
 *
 * Pipeline (documented in test/fixtures/README.md):
 *   recorder (scrubbed=false, raw bodies) → scrubFixture → scrubbed=true lines
 *
 * Scrubbing does two things:
 *   1. FIELD WHITELIST — keep ONLY the string fields HookWireEventSchema
 *      names (the whitelist is derived from the schema's own keys so the two
 *      can never drift); `prompt`, `tool_input`, `tool_output`, `message` and
 *      every unknown field are dropped.
 *   2. USERNAME REPLACEMENT — the macOS/Linux account name (detected from
 *      `cwd` / `transcript_path`, or passed explicitly) is replaced with
 *      `user` in every kept value, including the `-Users-name-…` encoded form
 *      inside transcript paths.
 *
 * Lines whose scrubbed body does not parse as a hook wire event are DROPPED —
 * committed fixtures only contain replayable events. `isScrubbedRecordedEvent`
 * is the mechanical guard test/fixtures.test.ts runs over every committed
 * fixture line.
 */
import { HookWireEventSchema } from '../signals/hooks-wire.js';
import type { RecordedHookEvent } from './recorder.js';

/** Placeholder every detected username is replaced with. */
export const SCRUB_USERNAME_PLACEHOLDER = 'user';

/** Whitelist = exactly the fields HookWireEventSchema names (single source). */
export const SCRUB_KEEP_FIELDS: readonly string[] = Object.freeze(
  Object.keys(HookWireEventSchema.shape),
);

/** Best-effort account-name detection from `cwd` / `transcript_path`. */
export function detectUsername(body: unknown): string | null {
  if (!isJsonObject(body)) return null;
  for (const key of ['cwd', 'transcript_path']) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    const match = /^\/(?:Users|home)\/([^/]+)/.exec(value);
    if (match) return match[1];
  }
  return null;
}

/**
 * Whitelist + replace; returns null when the body is not an object (raw
 * recordings keep unparseable bodies as strings — those cannot be scrubbed
 * into anything useful and are dropped by scrubFixture).
 */
export function scrubHookBody(
  body: unknown,
  username?: string | null,
): Record<string, string> | null {
  if (!isJsonObject(body)) return null;
  const name = username ?? detectUsername(body);
  const out: Record<string, string> = {};
  for (const key of SCRUB_KEEP_FIELDS) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    out[key] =
      name !== null && name !== '' && name !== SCRUB_USERNAME_PLACEHOLDER
        ? value.split(name).join(SCRUB_USERNAME_PLACEHOLDER)
        : value;
  }
  return out;
}

/**
 * Scrub one recorded line; null = drop (not an object body, or the scrubbed
 * result is not a valid hook wire event and therefore useless for replay).
 */
export function scrubRecordedEvent(
  event: RecordedHookEvent,
  username?: string | null,
): RecordedHookEvent | null {
  const body = scrubHookBody(event.body, username);
  if (body === null) return null;
  if (!HookWireEventSchema.safeParse(body).success) return null;
  return { at: event.at, body, scrubbed: true };
}

/**
 * Scrub a whole JSONL recording (file content in, file content out).
 * Malformed lines and non-replayable events are dropped.
 */
export function scrubFixture(content: string, username?: string | null): string {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecordedHookEvent(parsed)) continue;
    const scrubbed = scrubRecordedEvent(parsed, username);
    if (scrubbed === null) continue;
    out.push(JSON.stringify(scrubbed));
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

/**
 * Mechanical commit gate: true iff the line is a RecordedHookEvent with
 * scrubbed=true, an ISO timestamp, and a body that is whitelist-only string
 * fields. test/fixtures.test.ts applies this to EVERY committed fixture line.
 */
export function isScrubbedRecordedEvent(value: unknown): boolean {
  if (!isRecordedHookEvent(value)) return false;
  if (value.scrubbed !== true) return false;
  if (Number.isNaN(Date.parse(value.at))) return false;
  if (!isJsonObject(value.body)) return false;
  return Object.entries(value.body).every(
    ([key, fieldValue]) => SCRUB_KEEP_FIELDS.includes(key) && typeof fieldValue === 'string',
  );
}

function isRecordedHookEvent(value: unknown): value is RecordedHookEvent {
  return (
    isJsonObject(value) &&
    typeof value['at'] === 'string' &&
    'body' in value &&
    typeof value['scrubbed'] === 'boolean'
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
