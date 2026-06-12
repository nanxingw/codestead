/**
 * codex-panel.ts — the 图鉴 Esc-menu tab (M3, GDD §4.8/§5.7/§5.8; PRD 04 US49/US50).
 *
 * Passive collection view over `collectionLog` (recorded since M1): sold rows light
 * up with name + first-sold day, unsold rows are silhouettes (？？？ + dim glyph) —
 * never a task list, no countdowns (§5.6 principle ①). Pages by item category
 * (crop / artisan_good / material); ←/→ cycles, Esc returns to the pause menu.
 */
import type Phaser from 'phaser';

import { DEPTH, CODEX_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { glyphFor } from '../widgets/slot-view';
import { uiText } from '../widgets/text';
import { codexPages, cyclePage } from './codex-model';
import type { Panel, UiHost } from './host';

const ROW_HEIGHT = 16;
const ROWS_TOP = 52;

export class CodexPanel implements Panel {
  readonly id: UiPanelId = 'codex';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private title!: Phaser.GameObjects.Text;
  private pageTitle!: Phaser.GameObjects.Text;
  private page = 0;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = CODEX_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.title = this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, '', { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.pageTitle = this.track(
      uiText(scene, p.x + p.width / 2, p.y + 28, '', { color: PALETTE.ui.textDim })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    for (const [arrow, dir] of [
      ['◀', -1],
      ['▶', 1],
    ] as const) {
      const x = dir < 0 ? p.x + 16 : p.x + p.width - 16;
      const btn = this.track(
        uiText(scene, x, p.y + 28, arrow, { color: PALETTE.ui.text })
          .setOrigin(dir < 0 ? 0 : 1, 0)
          .setDepth(DEPTH.panel + 1),
      );
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => this.turn(dir));
    }
    this.track(
      uiText(scene, p.x + 8, p.y + p.height - 16, t('codex.hint'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const p = CODEX_PANEL;
    const view = codexPages(this.host.state());
    this.title.setText(t('codex.title', { n: view.collected, total: view.total }));
    if (view.pages.length === 0) return;
    this.page = Math.min(this.page, view.pages.length - 1);
    const page = view.pages[this.page];
    this.pageTitle.setText(
      `${t('codex.page', { category: t(`category.${page.category}`), n: page.collected, total: page.entries.length })} · ${this.page + 1}/${view.pages.length}`,
    );
    page.entries.forEach((entry, i) => {
      const y = p.y + ROWS_TOP + i * ROW_HEIGHT;
      const sold = entry.firstSoldDay !== null;
      const glyph = glyphFor(entry.category);
      const name = sold ? t(entry.nameKey) : t('codex.unknown');
      const left = uiText(this.host.scene, p.x + 16, y, `${glyph} ${name}`, {
        color: sold ? PALETTE.ui.text : PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1);
      const right = uiText(
        this.host.scene,
        p.x + p.width - 16,
        y,
        sold ? t('codex.first_sold', { day: entry.firstSoldDay ?? 0 }) : t('codex.unsold'),
        { color: sold ? PALETTE.gold.light : PALETTE.ui.textDim },
      )
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1);
      this.rowObjects.push(left, right);
    });
  }

  handleKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowLeft':
        this.turn(-1);
        return true;
      case 'ArrowRight':
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
    const count = codexPages(this.host.state()).pages.length;
    this.page = cyclePage(this.page, dir, count);
    this.refresh();
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
