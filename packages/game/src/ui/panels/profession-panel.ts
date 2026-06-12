/**
 * profession-panel.ts — the Lv5 certificate-desk two-way choice (M3, GDD §5.3;
 * ruling A-13; PRD 04 US38). Player-initiated, dialog-state (tick stops).
 *
 * 园艺师 (crops ×1.10) vs 工匠 (artisan goods ×1.25) — DOUBLE confirm spelling out
 * permanence; choosing never blocks level-ups; once signed the panel shows the held
 * certificate and offers nothing else (irreversible forever, #18 signed_papers).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { effectiveLevel } from '../../sim/leveling';
import { PROFESSION_MIN_LEVEL } from '../../sim/profession';
import type { Profession } from '../../sim/types';
import { DEPTH, PROFESSION_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { safe } from '../safe';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import { asSimCommand } from './build-model';
import type { Panel, UiHost } from './host';

export class ProfessionPanel implements Panel {
  readonly id: UiPanelId = 'profession';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private body!: Phaser.GameObjects.Text;
  private hortBtn!: TextButton;
  private artisanBtn!: TextButton;
  private confirmBtn!: TextButton;
  /** Double-confirm holding area: the candidate awaiting the second confirm. */
  private pending: Profession | null = null;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = PROFESSION_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, t('profession.title'), {
        color: PALETTE.gold.light,
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.body = this.track(
      uiText(scene, p.x + 16, p.y + 28, '', {
        color: PALETTE.ui.text,
        wrapWidth: p.width - 32,
      }).setDepth(DEPTH.panel + 1),
    );

    const half = (p.width - 48) / 2;
    this.hortBtn = this.button(p.x + 16, p.y + 96, half, '', () => this.pick('horticulturist'));
    this.artisanBtn = this.button(p.x + 32 + half, p.y + 96, half, '', () => this.pick('artisan'));
    this.track(
      uiText(scene, p.x + 16 + half / 2, p.y + 116, t('profession.horticulturist_desc'), {
        color: PALETTE.ui.textDim,
        align: 'center',
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + 32 + half + half / 2, p.y + 116, t('profession.artisan_desc'), {
        color: PALETTE.ui.textDim,
        align: 'center',
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    this.confirmBtn = this.button(p.x + 16, p.y + p.height - 28, p.width - 32, '', () =>
      this.confirmPending(),
    );
    this.refresh();
  }

  refresh(): void {
    const state = this.host.state();
    const held = state.progress.profession;
    const level = safe('profession.level', () => effectiveLevel(state.progress.xp), 1);
    const allowed = held === null && level >= PROFESSION_MIN_LEVEL;

    this.hortBtn.setLabel(t('profession.horticulturist')).setDisabled(!allowed);
    this.artisanBtn.setLabel(t('profession.artisan')).setDisabled(!allowed);

    if (held !== null) {
      this.body.setText(t('profession.chosen', { name: t(`profession.${held}`) }));
      this.confirmBtn.setLabel(t('ui.close')).setDisabled(false);
      this.pending = null;
      return;
    }
    if (!allowed) {
      this.body.setText(`${t('profession.body')}\n${t('profession.locked')}`);
      this.confirmBtn.setLabel(t('ui.close')).setDisabled(false);
      return;
    }
    if (this.pending !== null) {
      // Second step of the double confirm — permanence spelled out (§5.3).
      this.body.setText(
        `${t('profession.confirm_title', { name: t(`profession.${this.pending}`) })}\n${t('profession.confirm_body')}`,
      );
      this.confirmBtn.setLabel(t('ui.confirm')).setDisabled(false);
      return;
    }
    this.body.setText(t('profession.body'));
    this.confirmBtn.setLabel(t('ui.cancel')).setDisabled(false);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      if (this.pending !== null) {
        this.pending = null; // back out of the second step, nothing signed
        this.refresh();
      } else {
        this.host.closeTop();
      }
      return true;
    }
    if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
      this.confirmPending();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  // ---- actions ----

  private pick(profession: Profession): void {
    this.pending = profession;
    this.refresh();
  }

  private confirmPending(): void {
    if (this.pending === null) {
      this.host.closeTop();
      return;
    }
    const choice = this.pending;
    this.pending = null;
    this.host.dispatch(asSimCommand({ type: 'chooseProfession', profession: choice }));
    const signed = this.host.state().progress.profession === choice;
    if (signed) {
      this.host.playSfx(SFX.jingleLevelup); // #18 toast arrives via the achievement sweep
    } else {
      this.host.playSfx(SFX.uiError);
    }
    this.refresh();
  }

  private button(
    x: number,
    y: number,
    width: number,
    label: string,
    onClick: () => void,
  ): TextButton {
    const btn = new TextButton(this.host.scene, x, y, label, { width, onClick });
    btn.setDepth(DEPTH.panel + 1);
    this.track(btn);
    return btn;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
