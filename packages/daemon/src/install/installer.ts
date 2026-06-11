/**
 * Hooks installer / uninstaller — the ONLY code that ever writes a user file,
 * and it writes exactly one: the injected `settingsFile` (`~/.claude/settings.json`
 * in real use). Three hard constraints (tech-stack §4.1-1, PRD 03 US48–50):
 *
 *   ① BEFORE the first codestead write, copy settingsFile → backupFile
 *      (`settings.json.codestead-bak`); never overwrite an existing backup.
 *   ② Every entry codestead writes carries the namespace marker; uninstall
 *      removes ONLY marked entries and never touches user hooks.
 *   ③ If the user already has hooks on an event, APPEND alongside — never replace.
 *
 * Also: re-running install is idempotent (byte-identical settings file), and a
 * corrupted settings JSON fails SAFELY (no write, clear error, file untouched).
 * `dryRun` computes the same merge but writes NOTHING and returns a line diff.
 *
 * Real execution against the real home dir happens ONLY when the user runs
 * `codestead install` — tests inject temp paths (hard rule).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DAEMON_HOST, DAEMON_PORT_BASE, DAEMON_PORT_MAX, HOOKS_PATH } from '@codestead/shared';

import { renderSettingsDiff } from './diff.js';

/**
 * Minimal event set (tech-stack §4.1-1; research/hooks.md §5.4). All entries
 * are `{ type: 'http', url: <hooksUrl>, timeout: HOOK_TIMEOUT_SECONDS }`.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Seconds — hook HTTP timeout; a dead daemon must never stall Claude Code. */
export const HOOK_TIMEOUT_SECONDS = 3;

/**
 * Namespace marker (constraint ②). For HTTP entries the marker is the URL
 * itself: an entry is codestead-owned iff `isCodesteadHookEntry` recognizes
 * its url as a codestead hooks endpoint (127.0.0.1, HOOKS_PATH, port in the
 * 43110–43119 window). Centralized here so install/uninstall can never drift.
 */
export function isCodesteadHookEntry(entry: unknown): boolean {
  if (!isJsonObject(entry)) return false;
  if (entry['type'] !== 'http' || typeof entry['url'] !== 'string') return false;
  let url: URL;
  try {
    url = new URL(entry['url']);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || url.hostname !== DAEMON_HOST || url.pathname !== HOOKS_PATH) {
    return false;
  }
  const port = Number(url.port);
  return Number.isInteger(port) && port >= DAEMON_PORT_BASE && port <= DAEMON_PORT_MAX;
}

export interface InstallerOptions {
  /** Injected — tests use temp files ONLY (never the real ~/.claude). */
  readonly settingsFile: string;
  readonly backupFile: string;
  /** e.g. `http://127.0.0.1:43110/hooks` (handshakeUrl sibling, HOOKS_PATH). */
  readonly hooksUrl: string;
  /** When true: compute the merge, write NOTHING, return `diff`. */
  readonly dryRun?: boolean;
}

export interface InstallResult {
  /** False when already installed (idempotent re-run). */
  readonly changed: boolean;
  readonly backupCreated: boolean;
  readonly eventsInstalled: readonly HookEventName[];
  /** Present only on dryRun: line diff of the would-be settings change. */
  readonly diff?: string;
}

export interface UninstallResult {
  readonly changed: boolean;
  readonly entriesRemoved: number;
  /** Present only on dryRun: line diff of the would-be settings change. */
  readonly diff?: string;
}

export type InstallerErrorCode =
  | 'corrupt-settings'
  | 'invalid-settings-structure'
  | 'invalid-hooks-url';

/** Safe-failure carrier: thrown BEFORE any write — the settings file is untouched. */
export class InstallerError extends Error {
  readonly code: InstallerErrorCode;
  constructor(code: InstallerErrorCode, message: string) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
  }
}

export async function installHooks(opts: InstallerOptions): Promise<InstallResult> {
  const entryTemplate = makeCodesteadEntry(opts.hooksUrl);
  if (!isCodesteadHookEntry(entryTemplate)) {
    throw new InstallerError(
      'invalid-hooks-url',
      `hooksUrl "${opts.hooksUrl}" is not a codestead hooks endpoint ` +
        `(expected http://${DAEMON_HOST}:${String(DAEMON_PORT_BASE)}-${String(DAEMON_PORT_MAX)}${HOOKS_PATH}) — ` +
        `uninstall would not recognize the entries it writes`,
    );
  }

  const { content: originalContent, settings } = await readSettingsFile(opts.settingsFile);
  const hooksSection = readHooksSection(settings);

  const nextHooks: JsonObject = { ...hooksSection };
  for (const event of HOOK_EVENTS) {
    const raw = nextHooks[event] ?? [];
    if (!Array.isArray(raw)) {
      throw new InstallerError(
        'invalid-settings-structure',
        `settings hooks.${event} is not an array — refusing to modify the file`,
      );
    }
    // Idempotent + converging: drop any previous codestead entries (possibly an
    // older port), then append ours. User groups keep their position (constraint ③).
    const { groups } = stripCodesteadEntries(raw);
    groups.push({ hooks: [makeCodesteadEntry(opts.hooksUrl)] });
    nextHooks[event] = groups;
  }

  const nextSettings: JsonObject = { ...settings, hooks: nextHooks };
  const nextContent = serializeSettings(nextSettings);
  const changed = nextContent !== originalContent;

  if (opts.dryRun === true) {
    return {
      changed,
      backupCreated: false,
      eventsInstalled: HOOK_EVENTS,
      diff: renderSettingsDiff(
        originalContent ?? '',
        changed ? nextContent : (originalContent ?? ''),
      ),
    };
  }
  if (!changed) {
    return { changed: false, backupCreated: false, eventsInstalled: HOOK_EVENTS };
  }

  // Constraint ①: back up the pre-write file once; never overwrite a backup.
  let backupCreated = false;
  if (originalContent !== null) {
    backupCreated = await writeBackupOnce(opts.backupFile, originalContent);
  }
  await writeFileAtomic(opts.settingsFile, nextContent);
  return { changed: true, backupCreated, eventsInstalled: HOOK_EVENTS };
}

export async function uninstallHooks(opts: InstallerOptions): Promise<UninstallResult> {
  const { content: originalContent, settings } = await readSettingsFile(opts.settingsFile);
  if (originalContent === null || !('hooks' in settings)) {
    return { changed: false, entriesRemoved: 0, ...(opts.dryRun === true ? { diff: '' } : {}) };
  }
  const hooksSection = readHooksSection(settings);

  let entriesRemoved = 0;
  const nextHooks: JsonObject = {};
  for (const [event, raw] of Object.entries(hooksSection)) {
    if (!Array.isArray(raw)) {
      // Unknown shape — not something we wrote; leave it untouched (constraint ②).
      nextHooks[event] = raw;
      continue;
    }
    const { groups, removed } = stripCodesteadEntries(raw);
    entriesRemoved += removed;
    if (removed > 0 && groups.length === 0) continue; // drop the key we emptied
    nextHooks[event] = groups;
  }

  if (entriesRemoved === 0) {
    // Nothing of ours present — never rewrite (not even formatting).
    return { changed: false, entriesRemoved: 0, ...(opts.dryRun === true ? { diff: '' } : {}) };
  }

  const nextSettings: JsonObject = { ...settings };
  if (Object.keys(nextHooks).length === 0) {
    delete nextSettings['hooks'];
  } else {
    nextSettings['hooks'] = nextHooks;
  }
  const nextContent = serializeSettings(nextSettings);
  const changed = nextContent !== originalContent;

  if (opts.dryRun === true) {
    return { changed, entriesRemoved, diff: renderSettingsDiff(originalContent, nextContent) };
  }
  if (changed) {
    await writeFileAtomic(opts.settingsFile, nextContent);
  }
  // The backup file is deliberately preserved (PRD 03 US50).
  return { changed, entriesRemoved };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeCodesteadEntry(hooksUrl: string): JsonObject {
  return { type: 'http', url: hooksUrl, timeout: HOOK_TIMEOUT_SECONDS };
}

interface SettingsFileRead {
  /** Raw bytes, or null when the file does not exist yet. */
  readonly content: string | null;
  readonly settings: JsonObject;
}

async function readSettingsFile(file: string): Promise<SettingsFileRead> {
  let content: string | null;
  try {
    content = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return { content: null, settings: {} };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InstallerError(
      'corrupt-settings',
      `${file} is not valid JSON — refusing to write; fix or remove the file, then re-run`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new InstallerError(
      'invalid-settings-structure',
      `${file} top level is not a JSON object — refusing to write`,
    );
  }
  return { content, settings: parsed };
}

function readHooksSection(settings: JsonObject): JsonObject {
  const hooks = settings['hooks'] ?? {};
  if (!isJsonObject(hooks)) {
    throw new InstallerError(
      'invalid-settings-structure',
      `settings "hooks" is not an object — refusing to modify the file`,
    );
  }
  return hooks;
}

/**
 * Remove codestead-owned entries from one event's matcher-group array.
 * User entries are NEVER touched; a group is dropped only when our removal
 * emptied it (groups that were already empty stay as the user left them).
 */
function stripCodesteadEntries(eventGroups: readonly unknown[]): {
  groups: unknown[];
  removed: number;
} {
  const groups: unknown[] = [];
  let removed = 0;
  for (const group of eventGroups) {
    if (!isJsonObject(group) || !Array.isArray(group['hooks'])) {
      groups.push(group);
      continue;
    }
    const kept = group['hooks'].filter((h) => !isCodesteadHookEntry(h));
    const removedHere = group['hooks'].length - kept.length;
    removed += removedHere;
    if (removedHere === 0) {
      groups.push(group);
    } else if (kept.length > 0) {
      groups.push({ ...group, hooks: kept });
    }
    // else: group contained only codestead entries — drop it entirely.
  }
  return { groups, removed };
}

function serializeSettings(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** `wx` flag = create-only: an existing backup is never overwritten (constraint ①). */
async function writeBackupOnce(backupFile: string, content: string): Promise<boolean> {
  await mkdir(dirname(backupFile), { recursive: true });
  try {
    await writeFile(backupFile, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) return false;
    throw err;
  }
}

/** Write-then-rename so a crash mid-write can never leave a truncated settings file. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.codestead-tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
