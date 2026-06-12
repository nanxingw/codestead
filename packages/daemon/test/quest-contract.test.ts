/**
 * Quest module CONTRACT test (PRD 05) — pins the load-bearing constants the
 * implementation sub-tasks must not drift: the §4.5 exec flag set + the
 * codestead-quest launch marker (backlog E-3), the §4.3 sanitize regex classes,
 * the §2.3 local pool (30 entries, per-NPC affinity), the §5/§10 timing constants
 * and the §8.1 reward bounds. These are契约 assertions, not behaviour — the
 * skeleton functions throw "not implemented" until their sub-task lands.
 */
import { describe, expect, it } from 'vitest';

import { QUEST_GOLD_MAX, QUEST_XP_MAX } from '@codestead/shared';

import { QUEST_LAUNCH_ARG_MARKER } from '../src/signals/ps.js';
import {
  CLAUDE_FIXED_FLAGS,
  QUEST_LAUNCH_ARG_MARKER as EXEC_MARKER,
  questGenJsonSchema,
} from '../src/quest/exec-claude.js';
import { CONTROL_CHARS_RE, MAX_TOTAL_CHARS, SECRET_PATTERNS } from '../src/quest/sanitize.js';
import { LOCAL_POOL, LOCAL_POOL_SIZE } from '../src/quest/local-pool.js';
import {
  BACKOFF_CAP_MINUTES,
  BACKOFF_SEQUENCE_MINUTES,
  CONSECUTIVE_FAILURE_THRESHOLD,
  GEN_SIGKILL_GRACE_MS,
  GEN_SIGTERM_MS,
  MAX_CONTEXT_CHARS,
  MIN_CONTEXT_CHARS,
  MIN_INTERVAL_LOW_MINUTES,
  MIN_INTERVAL_NORMAL_MINUTES,
} from '../src/quest/types.js';
import { DEFAULT_AI_QUESTS_CONFIG, PER_CALL_BUDGET_CEILING_USD } from '../src/quest/config.js';

describe('exec-claude argv contract (ai-quests §4.5 / tech-stack §1)', () => {
  it('includes every fixed headless flag verbatim, and NEVER --bare or --resume', () => {
    const flags = CLAUDE_FIXED_FLAGS;
    expect(flags).toContain('-p');
    expect(flags).toContain('--strict-mcp-config');
    expect(flags).toContain('--output-format');
    expect(flags).toContain('json');
    expect(flags).toContain('--json-schema');
    expect(flags).toContain('--max-turns');
    expect(flags).toContain('4');
    expect(flags).toContain('--max-budget-usd');
    expect(flags).toContain('--no-session-persistence');
    expect(flags).toContain('--allowedTools');
    expect(flags).toContain('Read');
    expect(flags).toContain('--model');
    expect(flags).toContain('--fallback-model');
    expect(flags).toContain('sonnet');
    // disableAllHooks travels as the --settings JSON value.
    expect(flags).toContain('--settings');
    expect(flags.some((f) => f.includes('"disableAllHooks": true'))).toBe(true);
    // Banned: --bare, --resume (single-turn, §0/§4.5).
    expect(flags).not.toContain('--bare');
    expect(flags).not.toContain('--resume');
  });

  it('pins the codestead-quest launch marker as ONE shared token (backlog E-3)', () => {
    expect(QUEST_LAUNCH_ARG_MARKER).toBe('codestead-quest');
    // exec-claude re-exports the SAME marker the ps source filters on (double filter).
    expect(EXEC_MARKER).toBe(QUEST_LAUNCH_ARG_MARKER);
  });

  it('emits a JSON schema from QuestGenSchema for --json-schema', () => {
    const schema = questGenJsonSchema() as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        'npcId',
        'kind',
        'title',
        'opener',
        'body',
        'options',
        'closer',
        'contextEcho',
      ]),
    );
  });
});

describe('sanitize regex contract (ai-quests §4.3 / A3)', () => {
  it('covers the seven secret classes (≥7 patterns; redundant Anthropic split allowed)', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(7);
    const src = SECRET_PATTERNS.map((r) => r.source).join('\n');
    expect(src).toMatch(/AKIA/); // AWS
    expect(src).toMatch(/sk-ant-/); // Anthropic
    expect(src).toMatch(/gh\[pousr\]_/); // GitHub token
    expect(src).toMatch(/github_pat_/); // GitHub PAT
    expect(src).toMatch(/xox\[baprs\]-/); // Slack
    expect(src).toMatch(/PRIVATE KEY/); // PEM
    expect(src).toMatch(/eyJ/); // JWT
    expect(src).toMatch(/password\|passwd\|secret\|token/); // assignment form
  });

  it('every secret pattern is global (catches all occurrences)', () => {
    for (const re of SECRET_PATTERNS) expect(re.flags).toContain('g');
  });

  it('the patterns actually match a seeded example of each class', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      'sk-ant-api03-abcdefghijklmnopqrstuv',
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_abcdefghijklmnopqrstuv_wxyz',
      'xoxb-1234567890-abcdefghij',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4',
      'password = hunter2supersecret',
    ];
    for (const s of samples) {
      const hit = SECRET_PATTERNS.some((re) => {
        re.lastIndex = 0;
        return re.test(s);
      });
      expect(hit).toBe(true);
    }
  });

  it('pins the length cap and control-char set', () => {
    expect(MAX_TOTAL_CHARS).toBe(6_000);
    expect(MAX_CONTEXT_CHARS).toBe(6_000);
    // control set strips NUL..BS, VT, FF, SO..US but keeps TAB(\x09) and LF(\x0a).
    CONTROL_CHARS_RE.lastIndex = 0;
    expect('\t keep \n ok'.replace(CONTROL_CHARS_RE, '')).toBe('\t keep \n ok');
    expect('\x00\x07bad'.replace(CONTROL_CHARS_RE, '')).toBe('bad');
  });
});

describe('local pool contract (ai-quests §2.3)', () => {
  it('ships exactly 30 reflection questions', () => {
    expect(LOCAL_POOL_SIZE).toBe(30);
    expect(LOCAL_POOL).toHaveLength(30);
  });

  it('every entry has a unique id and a non-empty question', () => {
    const ids = new Set(LOCAL_POOL.map((e) => e.id));
    expect(ids.size).toBe(30);
    for (const e of LOCAL_POOL) expect(e.question.length).toBeGreaterThan(0);
  });

  it('affinity is balanced ~10 per NPC across the three villagers', () => {
    const counts = { npc_carpenter: 0, npc_grocer: 0, npc_keeper: 0 } as Record<string, number>;
    for (const e of LOCAL_POOL) counts[e.npcId] += 1;
    expect(counts.npc_carpenter).toBe(10);
    expect(counts.npc_grocer).toBe(10);
    expect(counts.npc_keeper).toBe(10);
  });
});

describe('timing & reward constants (ai-quests §4.5 / §5 / §10 / §8.1)', () => {
  it('pins the watchdog (90s SIGTERM → +5s SIGKILL)', () => {
    expect(GEN_SIGTERM_MS).toBe(90_000);
    expect(GEN_SIGKILL_GRACE_MS).toBe(5_000);
  });

  it('pins the backoff sequence and failure threshold', () => {
    expect(BACKOFF_SEQUENCE_MINUTES).toEqual([15, 30, 60]);
    expect(BACKOFF_CAP_MINUTES).toBe(60);
    expect(CONSECUTIVE_FAILURE_THRESHOLD).toBe(3);
  });

  it('pins the context floor/ceiling and interval档', () => {
    expect(MIN_CONTEXT_CHARS).toBe(300);
    expect(MAX_CONTEXT_CHARS).toBe(6_000);
    expect(MIN_INTERVAL_LOW_MINUTES).toBe(30); // factory default档
    expect(MIN_INTERVAL_NORMAL_MINUTES).toBe(15); // constitutional floor档
  });

  it('pins the per-call budget ceiling at the constitutional 0.20 and AI default OFF', () => {
    expect(PER_CALL_BUDGET_CEILING_USD).toBe(0.2);
    expect(DEFAULT_AI_QUESTS_CONFIG.perCallBudgetUsd).toBeLessThanOrEqual(0.2);
    // §3.1 / §3.4 / A10: aiGeneration ships OFF; 总开关 ships ON (villagers chat).
    expect(DEFAULT_AI_QUESTS_CONFIG.aiGeneration).toBe(false);
    expect(DEFAULT_AI_QUESTS_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AI_QUESTS_CONFIG.cooldownMinutes).toBe(15);
  });

  it('reward bounds match the shared single source (§8.1)', () => {
    expect(QUEST_XP_MAX).toBe(60);
    expect(QUEST_GOLD_MAX).toBe(120);
  });
});
