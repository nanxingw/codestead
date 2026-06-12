/**
 * quest-settings-panel.ts — 设置 → 村民与 AI 任务 (ai-quests §6.4).
 *
 * The thin Phaser shell over the PURE row model (quest/quest-settings-rows.ts,
 * unit-tested). It renders exactly the §6.4 controls in order:
 *   - 村民任务 master toggle            (game-scope → QuestHud.updatePrefs.enabled)
 *   - 允许 AI 根据我的工作出题 toggle    (daemon-scope; see note below)
 *   - 出题间隔 two档 low/normal         (game-scope → QuestHud.updatePrefs.frequency)
 *   - 每日预算 USD                       (daemon-scope; see note below)
 *   - 任务到达提示音 toggle              (game-scope → QuestHud.setArrivalSound)
 *   - 思考笔记位置 display-only
 *   - §2.3 hint row (conditional)
 *
 * Game-scope rows round-trip end-to-end here: villager-tasks `enabled` and 出题间隔
 * persist to localStorage (`codestead.quests.v1`) and re-emit `clientPrefs` (§4.7);
 * arrival-sound persists separately (§3.5). The AI generation toggle's authoritative
 * enable path is the in-dialogue 首次同意 consent flow (§3.4) plus
 * `~/.codestead/config.json`; the daemon owns 每日预算. Until the daemon reports its
 * config back over WS, those two rows are SHOWN (so the page is complete and the
 * state visible) but read-only, with the §6.4 额度说明 note — never a misleading live
 * toggle the game can't actually honour. The AI row also greys when the claude CLI
 * is unavailable (§9 feature-detect, when that becomes known).
 */
import type Phaser from 'phaser';

import {
  buildQuestSettingRows,
  cycleQuestSetting,
  type QuestSettingRow,
  type QuestSettingsViewModel,
} from '../../quest/quest-settings-rows';
import type { QuestFrequency } from '../../quest/quest-store';
import { DEPTH, SETTINGS_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, QuestHudHandle, UiHost } from './host';

/** Default notes directory shown read-only (§6.4; the daemon owns the real path). */
const NOTES_DIR = '~/.codestead/notes/';

export class QuestSettingsPanel implements Panel {
  readonly id: UiPanelId = 'questSettings';
  private objects: Phaser.GameObjects.GameObject[] = [];
  /** Per-row value buttons, by row id, so refresh() can re-label after a change. */
  private rowButtons = new Map<QuestSettingRow['id'], TextButton>();
  private noteText!: Phaser.GameObjects.Text;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = SETTINGS_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 4, t('quest.settings.title'), {
        color: PALETTE.gold.light,
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const x = p.x + 12;
    const valueX = p.x + p.width - 12;
    let y = p.y + 24;

    const quest = host.questHud;
    for (const row of buildQuestSettingRows(this.viewModel())) {
      const labelColor = row.disabled ? PALETTE.ui.textDim : PALETTE.ui.text;
      this.label(x, y, t(row.labelKey), labelColor);
      // Interactive rows get a value button; display-only / informational rows
      // (notesLocation, aiHint) and unavailable ones render their value as dim text.
      if (this.isInteractive(row) && quest) {
        const button = new TextButton(scene, valueX - 96, y - 2, row.value, {
          width: 96,
          disabled: row.disabled,
          onClick: () => this.cycle(row.id),
        });
        button.setDepth(DEPTH.panel + 1);
        this.track(button);
        this.rowButtons.set(row.id, button);
      } else if (row.value !== '') {
        this.label(valueX - 96, y, row.value, PALETTE.ui.textDim);
      }
      y += 18;
      // The AI row carries the §6.4 / §3.4 额度说明 note directly beneath it.
      if (row.id === 'aiGeneration') {
        this.noteText = this.track(
          uiText(scene, x + 8, y, t('quest.settings.aiGeneration.note'), {
            color: PALETTE.ui.textDim,
            wrapWidth: p.width - 32,
          }).setDepth(DEPTH.panel + 1),
        );
        y += this.noteText.height + 4;
      }
      // A disabled row's reason (feature-detect / governed-elsewhere) shows dim.
      if (row.disabled && row.disabledReason !== null) {
        this.label(x + 8, y, row.disabledReason, PALETTE.ui.textDim);
        y += 14;
      }
    }

    this.refresh();
  }

  refresh(): void {
    const rows = buildQuestSettingRows(this.viewModel());
    for (const row of rows) {
      const button = this.rowButtons.get(row.id);
      if (button) {
        button.setLabel(row.value);
        button.setDisabled(row.disabled);
      }
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.host.closeTop();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
    this.rowButtons.clear();
  }

  // ---- view model + row wiring ----

  /**
   * Build the row view model from the game-scope sources we own (QuestHud prefs +
   * arrival-sound). The daemon-scope fields (aiGeneration / dailyBudgetUsd /
   * aiPathAvailable) are not yet reported to the game; we present conservative,
   * honest display values and keep those rows read-only (see file header). When the
   * daemon→game config feed lands, only this method changes.
   */
  private viewModel(): QuestSettingsViewModel {
    const quest = this.host.questHud;
    const prefs = quest?.prefs() ?? { enabled: true, frequency: 'low' as QuestFrequency };
    const arrivalSound = quest?.arrivalSoundOn() ?? true;
    return {
      prefs,
      // Daemon-reported state is not on the wire yet — present the factory default
      // (AI off until 首次同意, §3.1) and the default budget, both read-only.
      aiGeneration: false,
      dailyBudgetUsd: 1.0,
      arrivalSound,
      // Without a feature-detect feed we cannot confirm the CLI; mark the AI row
      // governed-elsewhere (read-only) rather than falsely greyed-as-broken.
      aiPathAvailable: true,
      aiUnavailableReason: null,
      // The §2.3 hint depends on daemon pool state we don't track game-side yet.
      showAiHint: false,
      notesLocation: NOTES_DIR,
    };
  }

  /** Only the three game-scope rows are interactive in this pass (§6.4). */
  private isInteractive(row: QuestSettingRow): boolean {
    return row.id === 'villagerTasks' || row.id === 'frequency' || row.id === 'arrivalSound';
  }

  /** Cycle a game-scope row's value and persist via the QuestHud (§6.4). */
  private cycle(id: QuestSettingRow['id']): void {
    const quest: QuestHudHandle | undefined = this.host.questHud;
    if (!quest) return;
    const change = cycleQuestSetting(id, this.viewModel());
    if (change === null) return; // daemon-scope / display rows are not cycled here
    if (change.prefsPatch !== undefined) quest.updatePrefs(change.prefsPatch);
    if (change.arrivalSound !== undefined) quest.setArrivalSound(change.arrivalSound);
    this.refresh();
  }

  private label(x: number, y: number, text: string, color: string = PALETTE.ui.text): void {
    this.track(uiText(this.host.scene, x, y, text, { color }).setDepth(DEPTH.panel + 1));
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
