import { describe, expect, it } from 'vitest';

import { resolveCodesteadPaths } from '../src/config/paths.js';
import { generateToken } from '../src/config/token.js';
import {
  DONE_TO_IDLE_MS,
  IDLE_REAP_APPROX_MS,
  PS_POLL_INTERVAL_MS,
  SOURCE_PRIORITY,
  TRANSCRIPT_SILENCE_TO_DONE_MS,
} from '../src/state/types.js';
import { HOOK_EVENTS, HOOK_TIMEOUT_SECONDS } from '../src/install/installer.js';

describe('config: injectable paths (hard rule — no real ~/.claude in tests)', () => {
  it('derives every path from the injected home dir', () => {
    const p = resolveCodesteadPaths('/tmp/fake-home');
    expect(p.claudeSettingsFile).toBe('/tmp/fake-home/.claude/settings.json');
    expect(p.claudeSettingsBackupFile).toBe('/tmp/fake-home/.claude/settings.json.codestead-bak');
    expect(p.claudeProjectsDir).toBe('/tmp/fake-home/.claude/projects');
    expect(p.codesteadDir).toBe('/tmp/fake-home/.codestead');
    expect(p.daemonRuntimeFile).toBe('/tmp/fake-home/.codestead/daemon.json');
  });
});

describe('config: local token', () => {
  it('is URL/JSON-safe base64url of 32 bytes and unique per call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 base64url chars, no padding
  });

  it('accepts an injected RNG (determinism seam)', () => {
    const token = generateToken((size) => Buffer.alloc(size, 7));
    expect(token).toBe(Buffer.alloc(32, 7).toString('base64url'));
  });
});

describe('state-machine constants (values are design law — hud-sessions §7)', () => {
  it('pins the staleness thresholds', () => {
    expect(TRANSCRIPT_SILENCE_TO_DONE_MS).toBe(90_000);
    expect(DONE_TO_IDLE_MS).toBe(1_800_000);
    expect(IDLE_REAP_APPROX_MS).toBe(43_200_000);
    expect(PS_POLL_INTERVAL_MS).toBe(2_000);
  });

  it('pins arbitration priority hooks > transcript > process (§7.4-1)', () => {
    expect(SOURCE_PRIORITY.hooks).toBeGreaterThan(SOURCE_PRIORITY.transcript);
    expect(SOURCE_PRIORITY.transcript).toBeGreaterThan(SOURCE_PRIORITY.process);
  });
});

describe('installer constants (tech-stack §4.1-1 minimal event set)', () => {
  it('installs exactly the 10-event minimal set, http type, 3s timeout', () => {
    expect([...HOOK_EVENTS]).toEqual([
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
    ]);
    expect(HOOK_TIMEOUT_SECONDS).toBe(3);
  });
});
