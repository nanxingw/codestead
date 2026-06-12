/**
 * AiQuests config (ai-quests §3.1 / §11-E13) — daemon-quest owner tests.
 * Defaults, clamp ranges (cooldown floor = constitutional 15, perCall ceiling =
 * 0.20), the load+clamp-from-file path, and the consent-flow patch writer.
 * Paths are temp dirs — never the real ~/.codestead.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clampAiQuestsConfig,
  DEFAULT_AI_QUESTS_CONFIG,
  loadAiQuestsConfig,
  patchAiQuestsConfig,
  AiQuestsConfigSchema,
} from '../src/quest/config.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmpFile(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codestead-cfg-'));
  dirs.push(d);
  return join(d, 'config.json');
}

describe('DEFAULT_AI_QUESTS_CONFIG (§3.1 default column)', () => {
  it('ships 总开关 on, AI off, cooldown 15, perCall 0.20', () => {
    expect(DEFAULT_AI_QUESTS_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AI_QUESTS_CONFIG.aiGeneration).toBe(false);
    expect(DEFAULT_AI_QUESTS_CONFIG.cooldownMinutes).toBe(15);
    expect(DEFAULT_AI_QUESTS_CONFIG.dailyMaxQuests).toBe(8);
    expect(DEFAULT_AI_QUESTS_CONFIG.dailyBudgetUsd).toBe(1.0);
    expect(DEFAULT_AI_QUESTS_CONFIG.perCallBudgetUsd).toBe(0.2);
    expect(DEFAULT_AI_QUESTS_CONFIG.model).toBe('haiku');
    expect(DEFAULT_AI_QUESTS_CONFIG.localTemplates).toBe(true);
  });
});

describe('clampAiQuestsConfig (§3.1 / §11-E13)', () => {
  it('clamps cooldown <15 to the constitutional floor 15 with a note', () => {
    const r = clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, cooldownMinutes: 5 });
    expect(r.config.cooldownMinutes).toBe(15);
    expect(r.notes.join(' ')).toMatch(/cooldownMinutes 5 → 15/);
    expect(r.notes.join(' ')).toMatch(/floor/);
  });

  it('clamps cooldown >120 down to 120', () => {
    expect(
      clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, cooldownMinutes: 999 }).config
        .cooldownMinutes,
    ).toBe(120);
  });

  it('clamps perCallBudgetUsd >0.20 to the constitutional ceiling 0.20', () => {
    const r = clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, perCallBudgetUsd: 5 });
    expect(r.config.perCallBudgetUsd).toBe(0.2);
    expect(r.notes.join(' ')).toMatch(/ceiling/);
  });

  it('clamps dailyMaxQuests to [1,16] and dailyBudgetUsd to [0,5]', () => {
    expect(
      clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, dailyMaxQuests: 0 }).config.dailyMaxQuests,
    ).toBe(1);
    expect(
      clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, dailyMaxQuests: 99 }).config
        .dailyMaxQuests,
    ).toBe(16);
    expect(
      clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, dailyBudgetUsd: -1 }).config
        .dailyBudgetUsd,
    ).toBe(0);
    expect(
      clampAiQuestsConfig({ ...DEFAULT_AI_QUESTS_CONFIG, dailyBudgetUsd: 10 }).config
        .dailyBudgetUsd,
    ).toBe(5);
  });

  it('emits NO notes when everything is in range', () => {
    expect(clampAiQuestsConfig(DEFAULT_AI_QUESTS_CONFIG).notes).toEqual([]);
  });
});

describe('loadAiQuestsConfig (load + clamp from file)', () => {
  it('returns clamped defaults when the file is absent', async () => {
    const r = await loadAiQuestsConfig(await tmpFile());
    expect(r.config).toEqual(DEFAULT_AI_QUESTS_CONFIG);
    expect(r.notes).toEqual([]);
  });

  it('reads the aiQuests node and clamps a hand-edited cooldown <15 (§11-E13)', async () => {
    const file = await tmpFile();
    await writeFile(file, JSON.stringify({ aiQuests: { cooldownMinutes: 1, aiGeneration: true } }));
    const r = await loadAiQuestsConfig(file);
    expect(r.config.cooldownMinutes).toBe(15);
    expect(r.config.aiGeneration).toBe(true);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('degrades to factory defaults on a corrupt file (never throws)', async () => {
    const file = await tmpFile();
    await writeFile(file, '{ not json');
    const r = await loadAiQuestsConfig(file);
    expect(r.config).toEqual(DEFAULT_AI_QUESTS_CONFIG);
  });

  it('a wrong-typed field falls back to its default (schema repair)', async () => {
    const file = await tmpFile();
    await writeFile(file, JSON.stringify({ aiQuests: { enabled: 'yes please' } }));
    const r = await loadAiQuestsConfig(file);
    expect(r.config.enabled).toBe(true); // default, not the string
  });
});

describe('patchAiQuestsConfig (consent flow, §3.4)', () => {
  it('sets aiGeneration=true and preserves other keys', async () => {
    const file = await tmpFile();
    await writeFile(file, JSON.stringify({ aiQuests: { dailyMaxQuests: 4 }, somethingElse: 7 }));
    const merged = await patchAiQuestsConfig(file, { aiGeneration: true });
    expect(merged.aiGeneration).toBe(true);
    expect(merged.dailyMaxQuests).toBe(4);
    const root = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(root['somethingElse']).toBe(7); // unrelated key untouched
  });

  it('sets enabled=false (总开关 off via consent choice c)', async () => {
    const file = await tmpFile();
    const merged = await patchAiQuestsConfig(file, { enabled: false });
    expect(merged.enabled).toBe(false);
  });

  it('creates the file when absent', async () => {
    const file = await tmpFile();
    await patchAiQuestsConfig(file, { aiGeneration: true });
    const root = JSON.parse(await readFile(file, 'utf8')) as {
      aiQuests: { aiGeneration: boolean };
    };
    expect(root.aiQuests.aiGeneration).toBe(true);
  });
});

describe('AiQuestsConfigSchema (permissive parse)', () => {
  it('an empty object parses to the full defaulted config', () => {
    expect(AiQuestsConfigSchema.parse({})).toEqual(DEFAULT_AI_QUESTS_CONFIG);
  });
});
