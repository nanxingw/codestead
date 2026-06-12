/**
 * CodesteadPaths — every filesystem location the daemon may touch, resolved
 * from an EXPLICIT home directory. There are deliberately no defaults reading
 * `os.homedir()` here:
 *
 *   HARD RULE (PRD 03 / workflow): development and tests NEVER read or write
 *   the real `~/.claude` or `~/.codestead`. All code paths take an injected
 *   `CodesteadPaths`; only the user-invoked CLI (`src/cli.ts`) is allowed to
 *   call `resolveCodesteadPaths(os.homedir())`.
 */
import { join } from 'node:path';

export interface CodesteadPaths {
  /** `<home>/.claude/settings.json` — the ONLY user file the installer writes. */
  readonly claudeSettingsFile: string;
  /** `<home>/.claude/settings.json.codestead-bak` — created once before first write (tech-stack §4.1-1 ①). */
  readonly claudeSettingsBackupFile: string;
  /** `<home>/.claude/projects` — transcript jsonl tree (fs.watch source + restart rebuild, hud-sessions §7.4-4). */
  readonly claudeProjectsDir: string;
  /** `<home>/.codestead` — daemon-owned state dir. */
  readonly codesteadDir: string;
  /** `<home>/.codestead/daemon.json` — port/token for CLI & local tools ONLY (browsers use GET /handshake, hud-sessions §10.4-2). */
  readonly daemonRuntimeFile: string;
  /** `<home>/.codestead/config.json` — user-editable config (aiQuests node, ai-quests §3.1). */
  readonly configFile: string;
  /** `<home>/.codestead/quests` — quest state/journals dir (state.json, costs.jsonl, errors.log; M4). */
  readonly questsDir: string;
  /** `<home>/.codestead/quests/state.json` — quest lifecycle persistence (ai-quests §5). */
  readonly questStateFile: string;
  /** `<home>/.codestead/notes` — thinking notes (Markdown + index.jsonl; ai-quests §7.1). */
  readonly notesDir: string;
}

/** Pure path resolution — no fs access, trivially unit-testable with a temp home. */
export function resolveCodesteadPaths(homeDir: string): CodesteadPaths {
  const claudeDir = join(homeDir, '.claude');
  const codesteadDir = join(homeDir, '.codestead');
  const questsDir = join(codesteadDir, 'quests');
  return {
    claudeSettingsFile: join(claudeDir, 'settings.json'),
    claudeSettingsBackupFile: join(claudeDir, 'settings.json.codestead-bak'),
    claudeProjectsDir: join(claudeDir, 'projects'),
    codesteadDir,
    daemonRuntimeFile: join(codesteadDir, 'daemon.json'),
    configFile: join(codesteadDir, 'config.json'),
    questsDir,
    questStateFile: join(questsDir, 'state.json'),
    notesDir: join(codesteadDir, 'notes'),
  };
}
