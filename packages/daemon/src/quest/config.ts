/**
 * Ai-quest configuration (`~/.codestead/config.json` → `aiQuests` node).
 *
 * Source of truth (LITERAL): ai-quests.md §3.1 (key / default / range table).
 * SKELETON: schema + defaults + clamp contract. The loader/writer (read config,
 * clamp out-of-range values, log a hint) is implemented by the config sub-task.
 *
 * Clamp law (§3.1 / §11-E13): `cooldownMinutes` < 15 is the constitutional hard
 * floor — read-time clamp back to 15 with a log line (NOT an error). All numeric
 * ranges below are enforced by zod with `.catch`-free clamping done in the loader
 * (the schema REJECTS out-of-range so the loader can detect & clamp + log; a
 * silent coercion would hide a hand-edit the user should be told about).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

/** Hard constitutional floor: ≤1 quest / 15 real minutes. Below this ⇒ clamp + log (§11-E13). */
export const COOLDOWN_FLOOR_MINUTES = 15;
export const COOLDOWN_CEILING_MINUTES = 120;

/** Per-call budget ceiling is the constitutional value 0.20 (§3.1, fed to --max-budget-usd). */
export const PER_CALL_BUDGET_CEILING_USD = 0.2;

/**
 * Raw `aiQuests` node as it may appear in config.json. Every field optional so a
 * partial / absent node falls back to defaults; the loader applies DEFAULTS then
 * CLAMPS (§3.1). Kept permissive on parse so a hand-edit is repaired, not rejected.
 */
export const AiQuestsConfigSchema = z.object({
  /** 总开关 (§3.1). false ⇒ quest模块 does not start at all (§9 / A1). */
  enabled: z.boolean().default(true),
  /** AI生成开关 (§3.1). DEFAULT false — needs in-game one-time consent (§3.4 / A10). */
  aiGeneration: z.boolean().default(false),
  /** Min minutes between generation ATTEMPTS; clamp [15,120] (§3.1). */
  cooldownMinutes: z.number().default(COOLDOWN_FLOOR_MINUTES),
  /** Per-calendar-day AI generation cap (§3.1). */
  dailyMaxQuests: z.number().int().default(8),
  /** Per-day soft cost ceiling USD; reached ⇒ local pool for the day (§3.1). */
  dailyBudgetUsd: z.number().default(1.0),
  /** Per-call budget USD → --max-budget-usd; clamp ≤0.20 (§3.1). */
  perCallBudgetUsd: z.number().default(PER_CALL_BUDGET_CEILING_USD),
  /** Generation model; --fallback-model sonnet is fixed (§3.1 / §4.5). */
  model: z.enum(['haiku', 'sonnet']).default('haiku'),
  /** Whether the local pool may serve when AI is off/degraded (§3.1). */
  localTemplates: z.boolean().default(true),
});
export type AiQuestsConfig = z.infer<typeof AiQuestsConfigSchema>;

/** Canonical factory-default config (§3.1 default column). */
export const DEFAULT_AI_QUESTS_CONFIG: AiQuestsConfig = AiQuestsConfigSchema.parse({});

/**
 * Apply the §3.1 ranges as CLAMPS (not rejections), returning the corrected
 * config plus the list of clamp notes the loader should log (§11-E13).
 * PURE — no fs, no logger; the loader injects the logger. SKELETON: signature +
 * the cooldown floor case sketched; the remaining range clamps are filled in by
 * the config sub-task per the §3.1 table.
 */
export interface ConfigClampResult {
  readonly config: AiQuestsConfig;
  /** Human-readable clamp notes, e.g. "cooldownMinutes 5 → 15 (constitutional floor)". */
  readonly notes: readonly string[];
}

/** Daily generation count clamp range (§3.1). */
const DAILY_MAX_QUESTS_FLOOR = 1;
const DAILY_MAX_QUESTS_CEILING = 16;
/** Daily budget clamp range USD (§3.1). */
const DAILY_BUDGET_FLOOR_USD = 0;
const DAILY_BUDGET_CEILING_USD = 5.0;
/** Per-call budget clamp range USD (§3.1); ceiling is the constitutional 0.20. */
const PER_CALL_BUDGET_FLOOR_USD = 0.05;

/** Clamp `value` into `[min,max]`; null when no change, else the clamped number. */
function clampInto(value: number, min: number, max: number): number | null {
  const clamped = Math.min(Math.max(value, min), max);
  return clamped === value ? null : clamped;
}

export function clampAiQuestsConfig(raw: AiQuestsConfig): ConfigClampResult {
  const notes: string[] = [];
  const config = { ...raw };

  // cooldownMinutes → [15,120]; the 15 floor is the constitutional hard limit (§11-E13).
  const cooldown = clampInto(raw.cooldownMinutes, COOLDOWN_FLOOR_MINUTES, COOLDOWN_CEILING_MINUTES);
  if (cooldown !== null) {
    config.cooldownMinutes = cooldown;
    notes.push(
      cooldown === COOLDOWN_FLOOR_MINUTES
        ? `cooldownMinutes ${String(raw.cooldownMinutes)} → ${String(cooldown)} (constitutional floor)`
        : `cooldownMinutes ${String(raw.cooldownMinutes)} → ${String(cooldown)} (clamped to [15,120])`,
    );
  }

  // dailyMaxQuests → [1,16] (integer range).
  const dailyMax = clampInto(raw.dailyMaxQuests, DAILY_MAX_QUESTS_FLOOR, DAILY_MAX_QUESTS_CEILING);
  if (dailyMax !== null) {
    config.dailyMaxQuests = dailyMax;
    notes.push(
      `dailyMaxQuests ${String(raw.dailyMaxQuests)} → ${String(dailyMax)} (clamped to [1,16])`,
    );
  }

  // dailyBudgetUsd → [0,5.00].
  const dailyBudget = clampInto(
    raw.dailyBudgetUsd,
    DAILY_BUDGET_FLOOR_USD,
    DAILY_BUDGET_CEILING_USD,
  );
  if (dailyBudget !== null) {
    config.dailyBudgetUsd = dailyBudget;
    notes.push(
      `dailyBudgetUsd ${String(raw.dailyBudgetUsd)} → ${String(dailyBudget)} (clamped to [0,5.00])`,
    );
  }

  // perCallBudgetUsd → [0.05,0.20]; the 0.20 ceiling is the constitutional value (§3.1).
  const perCall = clampInto(
    raw.perCallBudgetUsd,
    PER_CALL_BUDGET_FLOOR_USD,
    PER_CALL_BUDGET_CEILING_USD,
  );
  if (perCall !== null) {
    config.perCallBudgetUsd = perCall;
    notes.push(
      perCall === PER_CALL_BUDGET_CEILING_USD
        ? `perCallBudgetUsd ${String(raw.perCallBudgetUsd)} → ${String(perCall)} (constitutional ceiling)`
        : `perCallBudgetUsd ${String(raw.perCallBudgetUsd)} → ${String(perCall)} (clamped to [0.05,0.20])`,
    );
  }

  return { config, notes };
}

/**
 * Load + clamp the `aiQuests` node from `config.json` (path injected — NEVER the
 * real ~/.codestead). A missing file / missing node / hand-edit falls back to
 * DEFAULTS then CLAMPS (§3.1 / §11-E13). Returns the clamped config plus any
 * clamp notes the caller should log (counts/values only — never content).
 *
 * Parse is permissive: an unknown field passes through, a wrong-typed field is
 * replaced by its default by the schema, an out-of-range numeric is clamped here.
 * The whole thing NEVER throws — a corrupt file degrades to factory defaults.
 */
export async function loadAiQuestsConfig(configFile: string): Promise<ConfigClampResult> {
  let node: unknown = {};
  try {
    const raw = await readFile(configFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'aiQuests' in parsed) {
      node = (parsed as Record<string, unknown>)['aiQuests'];
    }
  } catch {
    // absent / corrupt → factory defaults
    node = {};
  }
  const parsed = AiQuestsConfigSchema.safeParse(node);
  const config = parsed.success ? parsed.data : DEFAULT_AI_QUESTS_CONFIG;
  return clampAiQuestsConfig(config);
}

/**
 * Patch the `aiQuests` node of `config.json` (used by the first-consent flow, §3.4
 * — a→aiGeneration=true, c→enabled=false). Preserves any other top-level keys and
 * unknown aiQuests fields; atomic-ish via a single write. NEVER throws on a missing
 * file (it is created). Returns the merged config (clamped).
 */
export async function patchAiQuestsConfig(
  configFile: string,
  patch: Partial<AiQuestsConfig>,
): Promise<AiQuestsConfig> {
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(configFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) root = parsed as Record<string, unknown>;
  } catch {
    root = {};
  }
  const existing = AiQuestsConfigSchema.safeParse(root['aiQuests']);
  const base = existing.success ? existing.data : DEFAULT_AI_QUESTS_CONFIG;
  const merged = clampAiQuestsConfig({ ...base, ...patch }).config;
  root['aiQuests'] = merged;
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  return merged;
}
