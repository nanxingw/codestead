/**
 * confirm-dialog.ts — the sleep confirmation (ruling A-20: M1 door = bed; settlement
 * identical to 22:00). The global no-confirm-popup rule (GDD §6.7) does not apply:
 * sleeping ends the day, and the dialog is player-initiated, never auto-opened.
 */
import type Phaser from 'phaser';

import { effectiveLevel } from '../../sim/leveling';
import { PROFESSION_MIN_LEVEL } from '../../sim/profession';
import { DEPTH, DIALOG_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { safe } from '../safe';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export class SleepConfirmPanel implements Panel {
  readonly id: UiPanelId = 'sleepConfirm';
  private objects: Phaser.GameObjects.GameObject[] = [];

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = DIALOG_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 16, t('sleep.question'), {
        color: PALETTE.ui.text,
        align: 'center',
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    const yes = new TextButton(scene, p.x + 16, p.y + p.height - 32, t('sleep.yes'), {
      width: 76,
      onClick: () => this.confirm(),
    });
    const no = new TextButton(scene, p.x + p.width - 92, p.y + p.height - 32, t('sleep.no'), {
      width: 76,
      onClick: () => host.closeTop(),
    });
    yes.setDepth(DEPTH.panel + 1);
    no.setDepth(DEPTH.panel + 1);
    this.track(yes);
    this.track(no);

    // M3 certificate desk entry (GDD §5.3): the desk lives in the farmhouse and the
    // door is the M1 farmhouse surface (ruling A-20) — from Lv5 the dialog offers the
    // certificate. Player-initiated only, never a nag (PRD 04 US38/US39).
    const level = safe('sleep.level', () => effectiveLevel(host.state().progress.xp), 1);
    this.deskAvailable = level >= PROFESSION_MIN_LEVEL;
    if (this.deskAvailable) {
      const desk = new TextButton(scene, p.x + 16, p.y + 40, `[P] ${t('sleep.profession')}`, {
        width: p.width - 32,
        onClick: () => this.openDesk(),
      });
      desk.setDepth(DEPTH.panel + 1);
      this.track(desk);
    }
  }

  /** Lv5+ only — keyboard parity via the P key (dual-channel promise, §6.8). */
  private deskAvailable = false;

  private openDesk(): void {
    this.host.closeTop();
    this.host.openChild('profession');
  }

  refresh(): void {
    // Static dialog.
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
      this.confirm();
      return true;
    }
    if ((event.key === 'p' || event.key === 'P') && this.deskAvailable) {
      this.openDesk(); // M3 certificate desk, keyboard path (§6.8 equivalence)
      return true;
    }
    if (event.key === 'Escape') {
      this.host.closeTop();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  private confirm(): void {
    this.host.closeTop();
    // Manual sleep is the SAME command pathway as everything else; the sim runs the
    // 22:00-isomorphic NightUpdate and emits DayEnded → day-summary auto-opens.
    this.host.dispatch({ type: 'sleep' });
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
