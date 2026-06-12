/**
 * quest-prefs.ts — localStorage persistence for the game-side quest preferences
 * (ai-quests §6.4 / GDD §10.7). Mirrors hud/settings.ts: a machine/browser
 * preference, NOT game progress — it never enters the farm save schema or the JSON
 * export. Corrupted storage silently resets to defaults.
 *
 * Only the two GAME-owned settings live here (GDD §10.7): the villager-tasks
 * master switch (`enabled`) and the 出题间隔档 (`frequency` low/normal). The
 * daemon-side settings (AI开关, 每日预算) are NOT persisted client-side — they live
 * in ~/.codestead/config.json and are reported back over WS.
 */
import { z } from 'zod';

import { DEFAULT_QUEST_PREFS, type QuestPrefs } from './quest-store.js';

/** localStorage key for the quest prefs object. */
export const QUEST_PREFS_KEY = 'codestead.quests.v1';

/** Arrival-sound preference (§3.5 ≤0.3s 轻音) — separate game-side toggle. */
export const QUEST_ARRIVAL_SOUND_KEY = 'codestead.quests.v1.arrivalSound';

const QuestPrefsSchema = z.object({
  enabled: z.boolean().default(DEFAULT_QUEST_PREFS.enabled),
  frequency: z.enum(['low', 'normal']).default(DEFAULT_QUEST_PREFS.frequency),
});

/** Minimal storage surface (localStorage satisfies it; tests fake it). */
export type QuestPrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Tolerant parse: any corruption → silent reset to defaults. */
export function parseQuestPrefs(raw: unknown): QuestPrefs {
  const result = QuestPrefsSchema.safeParse(raw);
  return result.success ? result.data : { ...DEFAULT_QUEST_PREFS };
}

/** Load prefs from storage; missing/corrupted/unavailable → defaults, silently. */
export function loadQuestPrefs(storage: QuestPrefsStorage | null): QuestPrefs {
  try {
    const raw = storage?.getItem(QUEST_PREFS_KEY);
    if (raw === null || raw === undefined) return { ...DEFAULT_QUEST_PREFS };
    return parseQuestPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_QUEST_PREFS };
  }
}

/** Persist prefs; storage failures (private mode etc.) are silent. */
export function saveQuestPrefs(storage: QuestPrefsStorage | null, prefs: QuestPrefs): void {
  try {
    storage?.setItem(QUEST_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — prefs live for the session only.
  }
}

/** Arrival-sound default is ON (§3.5: one ≤0.3s soft cue, opt-out). */
export function loadArrivalSound(storage: QuestPrefsStorage | null): boolean {
  try {
    return storage?.getItem(QUEST_ARRIVAL_SOUND_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the arrival-sound preference. */
export function saveArrivalSound(storage: QuestPrefsStorage | null, on: boolean): void {
  try {
    storage?.setItem(QUEST_ARRIVAL_SOUND_KEY, on ? 'true' : 'false');
  } catch {
    // Storage unavailable — preference holds for this session only.
  }
}
