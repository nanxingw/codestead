/**
 * quest-settings-rows.ts — pure row model for 设置 ▸ 村民与 AI 任务 (ai-quests §6.4).
 *
 * Mirrors hud/settings-rows.ts: pure, unit-tested row descriptors; the Phaser
 * shell (a panel) renders them. The page exposes exactly the §6.4 controls:
 *   - 村民任务 master toggle (off ⇒ villagers只闲聊);
 *   - 允许 AI 根据我的工作出题 toggle (+ the额度说明文案 §3.4 / §6.4 / E12);
 *     greyed + reason when claude CLI is unavailable (§9 feature-detect);
 *   - 出题间隔 two档 only: 偶尔(≥30,默认) / 常来(≥15) — no higher frequency (§6.4);
 *   - 每日预算 USD (0–5.00);
 *   - 任务到达提示音 toggle;
 *   - 思考笔记位置 display-only (~/.codestead/notes/，仅本机);
 *   - the §2.3 hint row "想听新问题？允许 AI 根据你的工作出题" when the local pool
 *     is exhausted AND AI is off.
 *
 * The toggles that live game-side (村民任务 enabled, 出题间隔档) write QuestPrefs
 * (localStorage) and re-emit clientPrefs (§4.7). The daemon-side ones (AI开关,
 * 每日预算) flow over WS to the daemon config (or are applied at daemon start +
 * hot-pushed — §6.4 leaves the channel to实现). SKELETON: row descriptors + the
 * pure builder signature; the copy/value-cycle bodies are the settings sub-task.
 */
import type { QuestFrequency, QuestPrefs } from './quest-store.js';

/** Which side owns persistence of a row (drives where the host writes the change). */
export type QuestSettingScope = 'game' | 'daemon';

export type QuestSettingRowId =
  | 'villagerTasks' // game: QuestPrefs.enabled
  | 'aiGeneration' // daemon: aiQuests.aiGeneration
  | 'frequency' // game: QuestPrefs.frequency (low/normal)
  | 'dailyBudget' // daemon: aiQuests.dailyBudgetUsd
  | 'arrivalSound' // game: arrival-sound toggle (§3.5 ≤0.3s 轻音)
  | 'notesLocation' // display-only
  | 'aiHint'; // §2.3 hint row (conditional)

/** A rendered settings row (label + current value text + how to cycle it). */
export interface QuestSettingRow {
  readonly id: QuestSettingRowId;
  readonly scope: QuestSettingScope;
  /** Strings-table key for the label. */
  readonly labelKey: string;
  /** Resolved current-value display (e.g. "偶尔（≥30 分钟）" or "开"). */
  readonly value: string;
  /** True when greyed/disabled (e.g. AI toggle with no claude CLI, §9). */
  readonly disabled: boolean;
  /** Reason shown when disabled (feature-detect note, §9); null otherwise. */
  readonly disabledReason: string | null;
}

/** Read-only inputs the row builder needs (game prefs + daemon-reported state). */
export interface QuestSettingsViewModel {
  readonly prefs: QuestPrefs;
  /** Daemon-reported AI generation switch (§3.1 aiGeneration). */
  readonly aiGeneration: boolean;
  /** Daemon-reported daily budget USD (§3.1). */
  readonly dailyBudgetUsd: number;
  /** Arrival-sound preference (§3.5). */
  readonly arrivalSound: boolean;
  /** claude CLI availability from feature-detect (§9); false ⇒ AI row greyed. */
  readonly aiPathAvailable: boolean;
  /** Reason the AI path is unavailable (settings note), or null. */
  readonly aiUnavailableReason: string | null;
  /** Local pool exhausted AND AI off ⇒ show the §2.3 hint row. */
  readonly showAiHint: boolean;
  /** Notes directory for display (~/.codestead/notes/). */
  readonly notesLocation: string;
}

/** Map the 出题间隔 row value to the档 (and back) — the only two档 (§6.4). */
export function frequencyLabelKey(freq: QuestFrequency): string {
  return freq === 'normal' ? 'quest.settings.frequency.normal' : 'quest.settings.frequency.low';
}

const ON = '开';
const OFF = '关';

/**
 * Build the ordered §6.4 row list from the view model. PURE. Emits the rows in
 * §6.4 order; greys the AI row (disabled + reason) when !aiPathAvailable (§9
 * feature-detect); includes the aiHint row ONLY when showAiHint is true (§2.3).
 *
 * Value strings are the resolved DISPLAY text (the panel renders them verbatim);
 * `labelKey` is a strings-table key the panel resolves through ui/strings.ts.
 */
export function buildQuestSettingRows(vm: QuestSettingsViewModel): QuestSettingRow[] {
  const rows: QuestSettingRow[] = [
    {
      id: 'villagerTasks',
      scope: 'game',
      labelKey: 'quest.settings.villagerTasks',
      value: vm.prefs.enabled ? ON : OFF,
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'aiGeneration',
      scope: 'daemon',
      labelKey: 'quest.settings.aiGeneration',
      // Greyed reflects the actual switch state but cannot be toggled when the AI
      // path is unavailable (no claude CLI / missing flag, §9).
      value: vm.aiGeneration ? ON : OFF,
      disabled: !vm.aiPathAvailable,
      disabledReason: vm.aiPathAvailable ? null : vm.aiUnavailableReason,
    },
    {
      id: 'frequency',
      scope: 'game',
      labelKey: 'quest.settings.frequency',
      // Two档 only — resolved label key carries the display text (§6.4).
      value: frequencyValueText(vm.prefs.frequency),
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'dailyBudget',
      scope: 'daemon',
      labelKey: 'quest.settings.dailyBudget',
      value: formatBudget(vm.dailyBudgetUsd),
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'arrivalSound',
      scope: 'game',
      labelKey: 'quest.settings.arrivalSound',
      value: vm.arrivalSound ? ON : OFF,
      disabled: false,
      disabledReason: null,
    },
    {
      id: 'notesLocation',
      scope: 'game',
      labelKey: 'quest.settings.notesLocation',
      value: vm.notesLocation,
      disabled: true, // display-only
      disabledReason: null,
    },
  ];

  // §2.3 hint row: ONLY when the local pool is exhausted AND AI is off.
  if (vm.showAiHint) {
    rows.push({
      id: 'aiHint',
      scope: 'game',
      labelKey: 'quest.settings.aiHint',
      value: '',
      disabled: true, // informational, not interactive
      disabledReason: null,
    });
  }

  return rows;
}

/** The next档 when the 出题间隔 row is cycled — two档 only, low ↔ normal (§6.4). */
export function nextFrequency(freq: QuestFrequency): QuestFrequency {
  return freq === 'low' ? 'normal' : 'low';
}

/**
 * Compute the game-scope change a row-cycle implies (§6.4), as a pure mapping the
 * panel applies through QuestHud:
 *  - villagerTasks → flip prefs.enabled;
 *  - frequency     → low ↔ normal;
 *  - arrivalSound  → flip the arrival-sound preference.
 * Returns null for daemon-scope / display rows (the panel does not cycle them in
 * this pass — the AI toggle's enable path is the §3.4 consent flow). PURE.
 */
export interface QuestSettingChange {
  /** Patch for QuestHud.updatePrefs (villagerTasks / frequency), if any. */
  readonly prefsPatch?: Partial<QuestPrefs>;
  /** New arrival-sound value for QuestHud.setArrivalSound, if this row was it. */
  readonly arrivalSound?: boolean;
}

export function cycleQuestSetting(
  id: QuestSettingRowId,
  vm: QuestSettingsViewModel,
): QuestSettingChange | null {
  switch (id) {
    case 'villagerTasks':
      return { prefsPatch: { enabled: !vm.prefs.enabled } };
    case 'frequency':
      return { prefsPatch: { frequency: nextFrequency(vm.prefs.frequency) } };
    case 'arrivalSound':
      return { arrivalSound: !vm.arrivalSound };
    default:
      return null; // aiGeneration / dailyBudget / notesLocation / aiHint: not game-cycled
  }
}

/** Resolved 出题间隔 display text for the two档 (§6.4). */
function frequencyValueText(freq: QuestFrequency): string {
  return freq === 'normal' ? '常来（≥15 分钟）' : '偶尔（≥30 分钟，默认）';
}

/** Format the daily budget as "X.XX 美元" (§6.4; 0–5.00 range owned by the daemon). */
function formatBudget(usd: number): string {
  return `${usd.toFixed(2)} 美元`;
}
