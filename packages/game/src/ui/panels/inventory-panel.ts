/**
 * inventory-panel.ts — the 232×156 backpack panel at (204,102) (GDD §6.2/§6.6/§6.7).
 *
 * Layout: row 1 = the 9 hotbar slots (1..9 corner labels), row 2 = 3 usable reserve
 * slots + 6 locked "农场升级后可扩容" placeholders (visible promise of the M3 upgrade),
 * plus the trash-can slot. M1-core interaction is CLICK-MOVE only (pick up / put down /
 * merge / swap via the sim `moveItem` command — drag state machine is M1.5). Closing by
 * any path simply clears the virtual hold: items never leave their slot until a
 * moveItem lands, so nothing can ever vanish (GDD §6.9).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { INVENTORY } from '../../sim/data/constants';
import { getItemDef } from '../../sim/data/items';
import { DEPTH, INVENTORY_PANEL, SLOT_SIZE } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { SlotView } from '../widgets/slot-view';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

const COLS = 9;
const GRID_GAP = 4;
const TOTAL_GRID_SLOTS = 18; // 9 hotbar + 9 reserve cells (6 locked in M1)

export class InventoryPanel implements Panel {
  readonly id: UiPanelId = 'inventory';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private slots: SlotView[] = [];
  private trashSlot!: SlotView;
  private tooltip!: Phaser.GameObjects.Text;
  private heldGhost!: Phaser.GameObjects.Text;
  /** Virtual hold: source slot index, or null. The stack stays in the sim slot. */
  private heldFrom: number | null = null;
  private cursor = 0;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = INVENTORY_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + 8, p.y + 4, t('inventory.title'), { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );

    const gridX = p.x + 8;
    const gridY = p.y + 24;
    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = gridX + col * (SLOT_SIZE + GRID_GAP);
      const y = gridY + row * (SLOT_SIZE + GRID_GAP + 8);
      const view = new SlotView(scene, x, y);
      view.setDepth(DEPTH.panel + 1);
      this.track(view);
      this.slots.push(view);
      if (i < INVENTORY.HOTBAR_SIZE) {
        this.track(
          uiText(scene, x + 2, y - 13, String(i + 1), { color: PALETTE.ui.textDim }).setDepth(
            DEPTH.panel + 1,
          ),
        );
      }
      view.zone.on('pointerdown', () => this.onSlotClick(i));
      view.zone.on('pointerover', () => this.onSlotHover(i));
      view.zone.on('pointerout', () => this.tooltip.setVisible(false));
    }

    // Trash can (the ONLY discard entry; destroy, no confirm — GDD §6.3).
    const trashX = gridX + 8 * (SLOT_SIZE + GRID_GAP);
    const trashY = gridY + 2 * (SLOT_SIZE + GRID_GAP + 8);
    this.trashSlot = new SlotView(scene, trashX, trashY);
    this.trashSlot.setDepth(DEPTH.panel + 1);
    this.track(this.trashSlot);
    this.track(
      uiText(scene, trashX - 4, trashY + 4, `${t('inventory.trash')} →`, {
        color: PALETTE.ui.textDim,
      })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.trashSlot.zone.on('pointerdown', () => this.onTrashClick());

    this.track(
      uiText(scene, p.x + 8, p.y + p.height - 36, t('inventory.locked_slot'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );

    this.tooltip = uiText(scene, 0, 0, '', { color: PALETTE.ui.text })
      .setDepth(DEPTH.tooltip)
      .setVisible(false);
    this.track(this.tooltip);
    this.heldGhost = uiText(scene, 0, 0, '', { color: PALETTE.gold.light })
      .setDepth(DEPTH.held)
      .setVisible(false);
    this.track(this.heldGhost);

    scene.input.on('pointermove', this.onPointerMove);
    this.refresh();
  }

  refresh(): void {
    const state = this.host.state();
    const inv = state.inventory;
    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      const view = this.slots[i];
      if (i >= inv.capacity) {
        view.setLocked(true);
        continue;
      }
      view.setLocked(false);
      view.setStack(inv.slots[i] ?? null, state.tools);
      view.setSelected(i === this.cursor || (this.heldFrom !== null && i === this.heldFrom));
    }
    if (this.heldFrom !== null) {
      const stack = inv.slots[this.heldFrom];
      if (!stack) {
        this.heldFrom = null;
        this.heldGhost.setVisible(false);
      } else {
        this.heldGhost.setText(`${t(getItemDef(stack.itemId).nameKey)} ×${stack.count}`);
        this.heldGhost.setVisible(true);
      }
    } else {
      this.heldGhost.setVisible(false);
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    const inv = this.host.state().inventory;
    switch (event.key) {
      case 'ArrowLeft':
        this.cursor = Math.max(0, this.cursor - 1);
        this.refresh();
        return true;
      case 'ArrowRight':
        this.cursor = Math.min(inv.capacity - 1, this.cursor + 1);
        this.refresh();
        return true;
      case 'ArrowUp':
        this.cursor = Math.max(0, this.cursor - COLS);
        this.refresh();
        return true;
      case 'ArrowDown':
        this.cursor = Math.min(inv.capacity - 1, this.cursor + COLS);
        this.refresh();
        return true;
      case 'e':
      case 'E':
      case 'Enter':
        this.onSlotClick(this.cursor);
        return true;
      case 'Tab':
      case 'i':
      case 'I':
      case 'Escape':
        this.host.closeTop(); // hold is virtual — nothing to return (GDD §6.7)
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    this.host.scene.input.off('pointermove', this.onPointerMove);
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  private onSlotClick(index: number): void {
    const inv = this.host.state().inventory;
    if (index >= inv.capacity) return; // locked placeholder
    this.cursor = index;
    if (this.heldFrom === null) {
      if (inv.slots[index]) this.heldFrom = index; // pick up
    } else if (this.heldFrom === index) {
      this.heldFrom = null; // put back in place
    } else {
      // put down / merge / swap — semantics live in sim inventory.move (GDD §6.2)
      this.host.dispatch({ type: 'moveItem', from: this.heldFrom, to: index });
      this.heldFrom = null;
    }
    this.refresh();
  }

  private onTrashClick(): void {
    if (this.heldFrom === null) return;
    const stack = this.host.state().inventory.slots[this.heldFrom];
    if (!stack) return;
    if (!getItemDef(stack.itemId).discardable) {
      this.trashSlot.shake(); // refuse + head-shake (GDD §6.3)
      this.host.toast('toast.not_discardable');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch({ type: 'discardItem', slot: this.heldFrom });
    this.heldFrom = null;
    this.refresh();
  }

  private onSlotHover(index: number): void {
    const state = this.host.state();
    if (index >= state.inventory.capacity) return;
    const stack = state.inventory.slots[index];
    if (!stack) return;
    const def = getItemDef(stack.itemId);
    const lines = [t(def.nameKey), t(`category.${def.category}`)];
    if (def.sellPrice !== undefined) {
      lines.push(`${t('inventory.sell_price')} ${def.sellPrice}g`);
    }
    const view = this.slots[index];
    this.tooltip
      .setText(lines.join('\n'))
      .setPosition(view.x + SLOT_SIZE + 4, view.y)
      .setVisible(true);
  }

  private onPointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (this.heldGhost.visible) {
      this.heldGhost.setPosition(Math.round(pointer.x) + 8, Math.round(pointer.y) - 4);
    }
  };

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
