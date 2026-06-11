/**
 * hotbar.ts — the always-on hotbar at (222,336), 9 slots of 20×20 with 2px gaps
 * (GDD §6.6). Slots are inventory indices 0..8; selection lifts the slot 2px and
 * shows the gold outline (§6.2). Clicking a slot selects it (selection only — item
 * moves happen in the inventory panel).
 */
import type Phaser from 'phaser';

import { INVENTORY } from '../../sim/data/constants';
import type { WorldState } from '../../sim/types';
import { DEPTH, HOTBAR, SLOT_GAP, SLOT_SIZE } from '../layout';
import { PALETTE } from '../palette';
import { SlotView } from '../widgets/slot-view';
import { uiText } from '../widgets/text';

export class Hotbar {
  private slots: SlotView[] = [];
  private lastSignature = '';

  constructor(
    private readonly scene: Phaser.Scene,
    onSelect: (slot: number) => void,
  ) {
    for (let i = 0; i < INVENTORY.HOTBAR_SIZE; i += 1) {
      const x = HOTBAR.x + i * (SLOT_SIZE + SLOT_GAP);
      const slot = new SlotView(scene, x, HOTBAR.y);
      slot.setDepth(DEPTH.hud);
      slot.zone.on('pointerdown', () => onSelect(i));
      this.slots.push(slot);
      // 1..9 corner label (GDD §6.6 mock).
      uiText(scene, x + 2, HOTBAR.y - 1, String(i + 1), { color: PALETTE.ui.textDim }).setDepth(
        DEPTH.hud + 1,
      );
    }
  }

  /**
   * Landing bounce on the slot that just received an item (GDD §6.4 「300ms 槽位
   * bounce」). Callers skip it under reducedMotion (§10.8 — bounce is pure motion).
   */
  bounce(slot: number): void {
    const view = this.slots[slot];
    if (!view) return;
    this.scene.tweens.killTweensOf(view);
    const baseY = view.y;
    this.scene.tweens.add({
      targets: view,
      y: baseY - 3,
      duration: 60,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        view.setY(baseY);
        this.lastSignature = ''; // let the next update() re-derive the resting y
      },
    });
  }

  update(state: Readonly<WorldState>): void {
    const inv = state.inventory;
    const signature =
      inv.slots
        .slice(0, INVENTORY.HOTBAR_SIZE)
        .map((s) => (s ? `${s.itemId}:${s.count}` : '_'))
        .join('|') + `#${inv.selected}#${state.tools.hoe}${state.tools.wateringCan}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (let i = 0; i < this.slots.length; i += 1) {
      const view = this.slots[i];
      view.setStack(inv.slots[i] ?? null, state.tools);
      const selected = inv.selected === i;
      view.setSelected(selected);
      view.setY(HOTBAR.y - (selected ? 2 : 0)); // selected slot floats 2px (§6.2)
    }
  }
}
