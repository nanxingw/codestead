/**
 * achievements-panel.ts — the Esc-menu 「成就」 tab (M1.5 simple page, GDD §5.6/§5.8;
 * PRD 02 US12/US13; paging upgrade M3, PRD 04 §I).
 *
 * M3 widens the visible set to the live milestones (M1.5 #1~#14 + M3 #15~#18/#21/#22)
 * and turns the static 14-row layout into pages (↑/↓ or PgUp/PgDn flip; mouse arrows
 * too). M4 rows (#19/#20) stay folded until their milestone ships — same discipline
 * as §5.3 "Lv6+ 条目一律折叠". Unlocked rows show name + reward; locked rows show the
 * condition plus a live counter ("37/100") where the target is cumulative. Never shows
 * countdowns or daily tasks (§5.6 principle ① 零焦虑红线). Pure render: truth lives in
 * sim state (progress.achievements + counters).
 */
import type Phaser from 'phaser';

import { progressView } from '../../sim/achievements';
import {
  ACHIEVEMENTS,
  type AchievementDef,
  type AchievementMilestone,
} from '../../sim/data/achievements';
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
const ROWS_PER_PAGE = 13;

/** Milestones whose rows this build SHOWS (M4 stays folded — §5.3 折叠纪律). */
const VISIBLE_MILESTONES: ReadonlySet<AchievementMilestone> = new Set(['M1.5', 'M3']);

/** Visible defs in §5.6 table order (pure, exported for the panel test). */
export function visibleAchievements(): AchievementDef[] {
  return ACHIEVEMENTS.filter((def) => VISIBLE_MILESTONES.has(def.milestone)).sort(
    (a, b) => a.num - b.num,
  );
}

export class AchievementsPanel implements Panel {
  readonly id: UiPanelId = 'achievements';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private title!: Phaser.GameObjects.Text;
  private pageHint!: Phaser.GameObjects.Text;
  private page = 0;

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
    this.pageHint = this.track(
      uiText(scene, p.x + p.width - 12, p.y + p.height - 18, '', { color: PALETTE.ui.textDim })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );
    for (const [arrow, dir] of [
      ['▲', -1],
      ['▼', 1],
    ] as const) {
      const y = dir < 0 ? p.y + 8 : p.y + p.height - 18;
      const btn = this.track(
        uiText(scene, p.x + 12, y, arrow, { color: PALETTE.ui.text }).setDepth(DEPTH.panel + 1),
      );
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => this.turn(dir));
    }
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const p = SETTINGS_PANEL;
    const state = this.host.state();
    const unlocked = new Set(state.progress.achievements);
    const view = progressView(state);
    const defs = visibleAchievements();
    const pageCount = Math.max(1, Math.ceil(defs.length / ROWS_PER_PAGE));
    this.page = Math.min(this.page, pageCount - 1);

    this.title.setText(
      t('achievement.title', {
        n: defs.filter((d) => unlocked.has(d.id)).length,
        total: defs.length,
      }),
    );
    this.pageHint.setText(t('achievement.page_hint', { page: this.page + 1, total: pageCount }));

    defs.slice(this.page * ROWS_PER_PAGE, (this.page + 1) * ROWS_PER_PAGE).forEach((def, i) => {
      const y = p.y + ROW_START_Y + i * ROW_STEP;
      const name = t(`achv.${def.id}.name`);
      let leftText: string;
      let rightText: string;
      let color: string;
      if (unlocked.has(def.id)) {
        leftText = `✓ ${name}`;
        rightText = rewardText(def);
        color = PALETTE.gold.light;
      } else {
        leftText = `· ${name}`;
        const { current, target } = def.progress(view);
        // Live counter only where the target is cumulative (§5.8 「37/100」);
        // boolean-shaped firsts just show their condition.
        const counter = target > 1 ? ` ${current}/${target}` : '';
        rightText = `${t(`achv.${def.id}.cond`)}${counter}`;
        color = PALETTE.ui.textDim;
      }
      this.rowObjects.push(
        uiText(this.host.scene, p.x + 12, y, leftText, { color }).setDepth(DEPTH.panel + 1),
        uiText(this.host.scene, p.x + p.width - 12, y, rightText, {
          color: unlocked.has(def.id) ? PALETTE.gold.mid : PALETTE.ui.textDim,
          align: 'right',
        })
          .setOrigin(1, 0)
          .setDepth(DEPTH.panel + 1),
      );
    });
  }

  handleKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowUp':
      case 'PageUp':
        this.turn(-1);
        return true;
      case 'ArrowDown':
      case 'PageDown':
        this.turn(1);
        return true;
      case 'Escape':
        this.host.closeTop(); // back to the pause menu (§6.5 nesting)
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    for (const obj of this.rowObjects) obj.destroy();
    for (const obj of this.objects) obj.destroy();
    this.rowObjects = [];
    this.objects = [];
  }

  private turn(dir: number): void {
    const pageCount = Math.max(1, Math.ceil(visibleAchievements().length / ROWS_PER_PAGE));
    this.page = (this.page + dir + pageCount) % pageCount;
    this.refresh();
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
