/**
 * coop-panel.ts — coop interaction (M3, GDD §8.2 row 1; rulings A-6/A-7; PRD 04
 * US13~US15 + 待裁决 3: hen trading is an in-coop interaction, NOT a shop row).
 *
 * Eggs are 「去拿」 — collection is a deliberate action here, never auto-bagged
 * (US15); a full bag blocks collection up-front with the single-reason toast
 * (zero-loss, §6.9 pattern — the sim additionally collects partially, min(eggs, room)).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { COOP } from '../../sim/data/buildings';
import { maxAddable } from '../../sim/inventory';
import { DEPTH, FACILITY_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import { asSimCommand, structuresOf } from './build-model';
import type { Panel, UiHost } from './host';

export class CoopPanel implements Panel {
  readonly id: UiPanelId = 'coop';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private hensText!: Phaser.GameObjects.Text;
  private eggsText!: Phaser.GameObjects.Text;
  private collectBtn!: TextButton;
  private buyBtn!: TextButton;
  private sellBtn!: TextButton;

  constructor(
    private host: UiHost,
    private instanceId: string,
  ) {
    const scene = host.scene;
    const p = FACILITY_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, t('coop.title'), { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.hensText = this.track(uiText(scene, p.x + 16, p.y + 40, '').setDepth(DEPTH.panel + 1));
    this.eggsText = this.track(
      uiText(scene, p.x + 16, p.y + 60, '', { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    this.track(
      uiText(scene, p.x + 16, p.y + 84, t('coop.hint'), {
        color: PALETTE.ui.textDim,
        wrapWidth: p.width - 32,
      }).setDepth(DEPTH.panel + 1),
    );

    const bx = p.x + 16;
    const bw = p.width - 32;
    this.collectBtn = this.button(bx, p.y + 120, bw, t('coop.collect'), () => this.collect());
    this.buyBtn = this.button(
      bx,
      p.y + 148,
      bw,
      t('coop.buy_hen', { gold: COOP.HEN_BUY_PRICE }),
      () => this.buyHen(),
    );
    this.sellBtn = this.button(
      bx,
      p.y + 176,
      bw,
      t('coop.sell_hen', { gold: COOP.HEN_SELL_PRICE }),
      () => this.sellHen(),
    );
    this.button(bx, p.y + p.height - 44, bw, t('ui.close'), () => host.closeTop());
    this.refresh();
  }

  refresh(): void {
    const data = this.coopData();
    const hens = data?.hens ?? 0;
    const eggs = data?.eggsReady ?? 0;
    this.hensText.setText(t('coop.hens', { n: hens, max: COOP.MAX_HENS }));
    this.eggsText.setText(t('coop.eggs', { n: eggs }));
    this.collectBtn.setDisabled(eggs === 0);
    this.buyBtn.setDisabled(
      hens >= COOP.MAX_HENS || this.host.state().economy.gold < COOP.HEN_BUY_PRICE,
    );
    this.sellBtn.setDisabled(hens === 0);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'e' || event.key === 'E' || event.key === 'Enter') {
      this.collect(); // E at the egg spot = 捡蛋 (US15)
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

  // ---- actions (sim re-validates everything; pre-checks give the single toast) ----

  private coopData(): { hens: number; eggsReady: number } | null {
    const s = structuresOf(this.host.state()).find((x) => x.instanceId === this.instanceId);
    return s?.data?.kind === 'coop' ? s.data : null;
  }

  private collect(): void {
    const data = this.coopData();
    if (!data || data.eggsReady === 0) {
      this.host.toast('toast.coop_no_eggs');
      this.host.playSfx(SFX.uiError);
      return;
    }
    if (maxAddable(this.host.state().inventory, 'animal_egg') === 0) {
      this.host.toast('toast.inventory_full'); // zero-loss: eggs stay ready (§6.9)
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch(asSimCommand({ type: 'collectEggs', instanceId: this.instanceId }));
    this.host.playSfx(SFX.itemGet); // egg_collect beat lands with the M3 audio pass
    this.refresh();
  }

  private buyHen(): void {
    const data = this.coopData();
    if (!data || data.hens >= COOP.MAX_HENS) {
      this.host.toast('toast.coop_full', { max: COOP.MAX_HENS });
      this.host.playSfx(SFX.uiError);
      return;
    }
    if (this.host.state().economy.gold < COOP.HEN_BUY_PRICE) {
      this.host.toast('toast.not_enough_gold');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch(asSimCommand({ type: 'buyHen', instanceId: this.instanceId }));
    this.host.playSfx(SFX.coins);
    this.refresh();
  }

  private sellHen(): void {
    const data = this.coopData();
    if (!data || data.hens === 0) {
      this.host.toast('toast.coop_no_hens');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch(asSimCommand({ type: 'sellHen', instanceId: this.instanceId }));
    this.host.playSfx(SFX.coins);
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
