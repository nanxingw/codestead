/**
 * achievements-panel.ts — the Esc-menu 「成就」 tab (M1.5 simple page, GDD §5.6/§5.8;
 * PRD 02 US12/US13).
 *
 * Shows ONLY the 14 M1.5 achievements — #15~#22 never appear in the M1 UI (same
 * folding discipline as §5.3 "Lv6+ 条目一律折叠"). Unlocked rows show name + reward;
 * locked rows show the condition plus a live counter ("37/100") where the target is
 * cumulative. Never shows countdowns or daily tasks (§5.6 principle ① 零焦虑红线).
 * Pure render: truth lives in sim state (progress.achievements + counters).
 */
import type Phaser from 'phaser';

import { progressView } from '../../sim/achievements';
import { M1_5_ACHIEVEMENTS, type AchievementDef } from '../../sim/data/achievements';
import { DEPTH, SETTINGS_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

const ROW_START_Y = 32;
const ROW_STEP = 17;

export class AchievementsPanel implements Panel {
  readonly id: UiPanelId = 'achievements';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private title!: Phaser.GameObjects.Text;
  private rows: {
    def: AchievementDef;
    left: Phaser.GameObjects.Text;
    right: Phaser.GameObjects.Text;
  }[] = [];

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = SETTINGS_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.title = this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, '', { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const defs = [...M1_5_ACHIEVEMENTS].sort((a, b) => a.num - b.num);
    defs.forEach((def, i) => {
      const y = p.y + ROW_START_Y + i * ROW_STEP;
      const left = this.track(uiText(scene, p.x + 12, y, '').setDepth(DEPTH.panel + 1));
      const right = this.track(
        uiText(scene, p.x + p.width - 12, y, '', { align: 'right' })
          .setOrigin(1, 0)
          .setDepth(DEPTH.panel + 1),
      );
      this.rows.push({ def, left, right });
    });

    this.refresh();
  }

  refresh(): void {
    const state = this.host.state();
    const unlocked = new Set(state.progress.achievements);
    const view = progressView(state);

    this.title.setText(
      t('achievement.title', {
        n: this.rows.filter((r) => unlocked.has(r.def.id)).length,
        total: this.rows.length,
      }),
    );

    for (const { def, left, right } of this.rows) {
      const name = t(`achv.${def.id}.name`);
      if (unlocked.has(def.id)) {
        left.setText(`✓ ${name}`).setColor(PALETTE.gold.light);
        right.setText(rewardText(def)).setColor(PALETTE.gold.mid);
      } else {
        left.setText(`· ${name}`).setColor(PALETTE.ui.textDim);
        const { current, target } = def.progress(view);
        // Live counter only where the target is cumulative (§5.8 「37/100」);
        // boolean-shaped firsts just show their condition.
        const counter = target > 1 ? ` ${current}/${target}` : '';
        right.setText(`${t(`achv.${def.id}.cond`)}${counter}`).setColor(PALETTE.ui.textDim);
      }
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.host.closeTop(); // back to the pause menu (§6.5 nesting)
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
    this.rows = [];
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}

/** "+10 XP · +20g" — §5.6 reward column rendered for unlocked rows. */
function rewardText(def: AchievementDef): string {
  const parts: string[] = [];
  if (def.reward.xp > 0) parts.push(t('achievement.reward_xp', { xp: def.reward.xp }));
  if (def.reward.gold > 0) parts.push(t('achievement.reward_gold', { gold: def.reward.gold }));
  return parts.join(' · ');
}
