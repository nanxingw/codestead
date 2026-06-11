/**
 * shipping-bin-panel.ts — the overnight-settlement bin UI (GDD §4.2 mock).
 *
 * Left column: bin contents (click = withdraw, reversible all day; Shift = whole
 * stack). Right column: inventory (click = deposit; only crop/material categories —
 * seeds refund at the shop instead, tools are never sellable). Footer: estimated
 * settlement total via economy.unitSalePrice (the single pricing entry point) and
 * the [F] ship-all shortcut (harvest → E → F → Esc ≤4 keys, GDD §4.2).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { getItemDef } from '../../sim/data/items';
import { unitSalePrice } from '../../sim/economy';
import type { WorldState } from '../../sim/types';
import { formatGold } from '../format';
import { BIN_PANEL, DEPTH } from '../layout';
import { PALETTE } from '../palette';
import { safe } from '../safe';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

const ROW_HEIGHT = 16;

export class ShippingBinPanel implements Panel {
  readonly id: UiPanelId = 'shippingBin';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private estimateText!: Phaser.GameObjects.Text;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = BIN_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 4, t('bin.title'), {
        color: PALETTE.gold.light,
        align: 'center',
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + 12, p.y + 24, t('bin.bin_column'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + p.width / 2 + 12, p.y + 24, t('bin.inv_column'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.estimateText = this.track(
      uiText(scene, p.x + 12, p.y + p.height - 36, '', { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    this.track(
      uiText(scene, p.x + 12, p.y + p.height - 18, `${t('bin.ship_all')}    ${t('bin.close')}`, {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + p.width - 12, p.y + p.height - 36, t('bin.stack_hint'), {
        color: PALETTE.ui.textDim,
      })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const state = this.host.state();
    const p = BIN_PANEL;

    // Left: bin contents → withdraw (reversible until sleep locks it, GDD §4.2).
    const bin = state.economy.shippingBin;
    if (bin.length === 0) {
      this.rowObjects.push(
        uiText(this.host.scene, p.x + 12, p.y + 44, t('bin.empty'), {
          color: PALETTE.ui.textDim,
        }).setDepth(DEPTH.panel + 1),
      );
    }
    bin.forEach((stack, index) => {
      const y = p.y + 40 + index * ROW_HEIGHT;
      const def = getItemDef(stack.itemId);
      const zone = this.addRowZone(p.x + 12, y, p.width / 2 - 24);
      this.rowObjects.push(
        uiText(this.host.scene, p.x + 12, y, `${t(def.nameKey)} ×${stack.count} ↩`).setDepth(
          DEPTH.panel + 1,
        ),
      );
      zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        const count = pointer.event.shiftKey ? stack.count : 1;
        const before = this.binTotal();
        this.host.dispatch({ type: 'withdrawFromBin', index, count });
        // 入包音 on success only — withdraw silently no-ops when the pack is full.
        if (this.binTotal() < before) this.host.playSfx(SFX.itemGet);
        this.refresh();
      });
    });

    // Right: inventory → deposit (crop/material only in M1, GDD §4.2 channel table).
    let row = 0;
    state.inventory.slots.forEach((stack, slot) => {
      if (!stack) return;
      const def = getItemDef(stack.itemId);
      const sellable = def.category === 'crop' || def.category === 'material';
      const y = p.y + 40 + row * ROW_HEIGHT;
      row += 1;
      const x = p.x + p.width / 2 + 12;
      const label = `${t(def.nameKey)} ×${stack.count}${sellable ? ' →' : ''}`;
      this.rowObjects.push(
        uiText(this.host.scene, x, y, label, {
          color: sellable ? PALETTE.ui.text : PALETTE.ui.textDim,
        }).setDepth(DEPTH.panel + 1),
      );
      const zone = this.addRowZone(x, y, p.width / 2 - 24);
      zone.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (!sellable) {
          this.host.toast('toast.not_sellable');
          this.host.playSfx(SFX.uiError);
          return;
        }
        const count = pointer.event.shiftKey ? stack.count : 1;
        const before = this.binTotal();
        this.host.dispatch({ type: 'depositToBin', slot, count });
        // Light receipt for the 卖 action (US103): the §11.5 item_get reused for
        // into-bin moves — no bin SimEvent exists, so the panel plays it directly.
        if (this.binTotal() > before) this.host.playSfx(SFX.itemGet);
        this.refresh();
      });
    });

    this.estimateText.setText(t('bin.estimate', { gold: formatGold(this.estimateGold(state)) }));
  }

  handleKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'f':
      case 'F': {
        const before = this.binTotal();
        this.host.dispatch({ type: 'depositAllToBin' }); // [F] ship-all (GDD §4.2)
        // Batch commit gets the money-flavored light receipt (coins, §11.5 M1 list).
        if (this.binTotal() > before) this.host.playSfx(SFX.coins);
        this.refresh();
        return true;
      }
      case 'Escape':
        this.host.closeTop();
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

  /** Total items currently in the bin — success probe for deposit/withdraw sounds
   *  (bin commands return no SimEvents by design, GDD §4.2/§12). */
  private binTotal(): number {
    return this.host.state().economy.shippingBin.reduce((sum, stack) => sum + stack.count, 0);
  }

  /** Estimated settlement: Σ unitSalePrice × count (display only; sim settles at night). */
  private estimateGold(state: Readonly<WorldState>): number {
    return state.economy.shippingBin.reduce((sum, stack) => {
      const def = getItemDef(stack.itemId);
      const unit = safe(
        'unitSalePrice',
        () => unitSalePrice(def, 'normal', { profession: state.progress.profession }),
        def.sellPrice ?? 0,
      );
      return sum + unit * stack.count;
    }, 0);
  }

  private addRowZone(x: number, y: number, width: number): Phaser.GameObjects.Zone {
    const zone = this.host.scene.add
      .zone(x, y, width, ROW_HEIGHT - 1)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTH.panel + 2);
    this.rowObjects.push(zone);
    return zone;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
