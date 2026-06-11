/**
 * inventory-panel.ts — the 232×156 backpack panel at (204,102) (GDD §6.2/§6.6/§6.7).
 *
 * M1.5: the panel is a thin shell over the pure drag store (ui/inventory/drag-model):
 * press picks up (virtual hold — the stack never leaves its sim slot until an op
 * lands), hover highlights the drop target, release drops (place/merge/swap), invalid
 * targets bounce the ghost back to the origin; Shift+click quick-moves hotbar↔reserve;
 * R tidies the reserve slots (GDD §6.2); the trash can defers destruction into the
 * undo slot — single-step regret, no confirm dialog (GDD §6.3). The M1-core
 * click-move path is preserved by the same machine (press+release on one slot =
 * cursor hold; press again to place). Right button (GDD §6.7/§6.8): pick ⌈n/2⌉ /
 * place exactly 1 — routed via pointer.rightButtonDown()/rightButtonReleased()
 * (UIScene already disables the browser context menu). The store emits ONLY
 * `moveItem`/`splitItem`/`discardItem` SimCommands, so InventoryApi and the save
 * schema stay untouched (PRD 02 red line; splitItem ratification: backlog B-11);
 * a convergence guard resyncs from the sim if the mirror ever drifts (should never).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { INVENTORY } from '../../sim/data/constants';
import { getItemDef } from '../../sim/data/items';
import {
  applyOp,
  classifyTarget,
  createDragState,
  expectedSimSlots,
  heldStack,
  type DragFx,
  type DragOp,
  type DragSimOp,
  type DragState,
  type DropTarget,
} from '../inventory/drag-model';
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
const ROW_PITCH = SLOT_SIZE + GRID_GAP + 8; // 8px headroom for the 1..9 corner labels
const TOTAL_GRID_SLOTS = 18; // 9 hotbar + 9 reserve cells (6 locked in M1)
const BOUNCE_MS = 120; // ghost fly-back on invalid release (skipped on reducedMotion)

export class InventoryPanel implements Panel {
  readonly id: UiPanelId = 'inventory';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private slots: SlotView[] = [];
  private trashSlot!: SlotView;
  private undoSlot!: SlotView;
  private tooltip!: Phaser.GameObjects.Text;
  private heldGhost!: Phaser.GameObjects.Text;
  /** Pure drag/undo/tidy store — the render truth while the panel is open. */
  private model: DragState;
  private cursor = 0;
  private hovered: DropTarget | null = null;
  private bouncing = false;
  private destroyed = false;
  private readonly gridX: number;
  private readonly gridY: number;
  private readonly trashX: number;
  private readonly trashY: number;
  private readonly undoX: number;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = INVENTORY_PANEL;
    this.model = createDragState(host.state().inventory.slots);
    this.gridX = p.x + 8;
    this.gridY = p.y + 24;
    this.trashX = this.gridX + 8 * (SLOT_SIZE + GRID_GAP);
    this.trashY = this.gridY + 2 * ROW_PITCH;
    this.undoX = this.gridX + 6 * (SLOT_SIZE + GRID_GAP);

    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + 8, p.y + 4, t('inventory.title'), { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );

    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = this.gridX + col * (SLOT_SIZE + GRID_GAP);
      const y = this.gridY + row * ROW_PITCH;
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
      view.zone.on('pointerdown', (pointer: Phaser.Input.Pointer) =>
        this.onPress({ kind: 'slot', index: i }, pointer),
      );
      view.zone.on('pointerover', () => this.onSlotHover(i));
      view.zone.on('pointerout', () => this.tooltip.setVisible(false));
    }

    // Trash can — the ONLY discard entry; no confirm, the undo slot is the regret
    // path (GDD §6.3) — plus the undo slot itself (M1.5).
    this.trashSlot = this.buildExtraSlot(this.trashX, this.trashY, t('inventory.trash'));
    this.trashSlot.zone.on('pointerdown', (pointer: Phaser.Input.Pointer) =>
      this.onPress({ kind: 'trash' }, pointer),
    );
    this.undoSlot = this.buildExtraSlot(this.undoX, this.trashY, t('inventory.undo'));
    this.undoSlot.zone.on('pointerdown', (pointer: Phaser.Input.Pointer) =>
      this.onPress({ kind: 'undo' }, pointer),
    );
    this.undoSlot.zone.on('pointerover', () => this.onUndoHover());
    this.undoSlot.zone.on('pointerout', () => this.tooltip.setVisible(false));

    this.track(
      uiText(scene, p.x + 8, p.y + p.height - 36, t('inventory.locked_slot'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.track(
      uiText(scene, p.x + 8, p.y + p.height - 22, t('inventory.sort_hint'), {
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
    scene.input.on('pointerup', this.onPointerUp);
    scene.input.on('pointerupoutside', this.onPointerUpOutside);
    this.refresh();
  }

  refresh(): void {
    if (this.destroyed) return;
    const state = this.host.state();
    const capacity = this.model.slots.length;
    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      const view = this.slots[i];
      if (i >= capacity) {
        view.setLocked(true);
        continue;
      }
      view.setLocked(false);
      view.setStack(this.model.slots[i] ?? null, state.tools);
      view.setSelected(i === this.cursor || i === (this.model.held?.from ?? -1));
    }
    this.undoSlot.setStack(this.model.undo?.stack ?? null);
    this.refreshHighlights();
    const held = heldStack(this.model);
    if (held && !this.bouncing) {
      this.heldGhost.setText(`${t(getItemDef(held.itemId).nameKey)} ×${held.count}`);
      if (!this.heldGhost.visible && this.model.held) {
        // Keyboard pickup: seed the ghost beside the source slot until the pointer moves.
        const view = this.slots[this.model.held.from];
        this.heldGhost.setPosition(view.x + SLOT_SIZE + 4, view.y - 4);
      }
      this.heldGhost.setVisible(true);
    } else if (!this.bouncing) {
      this.heldGhost.setVisible(false);
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    const capacity = this.model.slots.length;
    switch (event.key) {
      case 'ArrowLeft':
        this.cursor = Math.max(0, this.cursor - 1);
        this.refresh();
        return true;
      case 'ArrowRight':
        this.cursor = Math.min(capacity - 1, this.cursor + 1);
        this.refresh();
        return true;
      case 'ArrowUp':
        this.cursor = Math.max(0, this.cursor - COLS);
        this.refresh();
        return true;
      case 'ArrowDown':
        this.cursor = Math.min(capacity - 1, this.cursor + COLS);
        this.refresh();
        return true;
      case 'e':
      case 'E':
      case 'Enter': {
        // Keyboard pick/place — same store, identical semantics to the mouse path.
        const target: DropTarget = { kind: 'slot', index: this.cursor };
        if (this.model.held === null) {
          this.apply({ op: 'press', target, shift: event.shiftKey });
          this.apply({ op: 'release', target }); // click-pickup completes, stays in hand
        } else {
          this.apply({ op: 'press', target });
        }
        return true;
      }
      case 'r':
      case 'R':
        this.apply({ op: 'sort' }); // reserve-only tidy (GDD §6.2)
        return true;
      case 'Tab':
      case 'i':
      case 'I':
      case 'Escape':
        this.host.closeTop(); // destroy() runs the close op: hand returns, undo finalizes
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      // GDD §6.7: closing returns the hand (virtual — nothing to do in the sim) and
      // §6.3: clears the undo slot — i.e. the deferred discardItem finally lands.
      const result = applyOp(this.model, { op: 'close' });
      this.model = result.state;
      this.dispatchSimOps(result.simOps);
    }
    const input = this.host.scene.input;
    input.off('pointermove', this.onPointerMove);
    input.off('pointerup', this.onPointerUp);
    input.off('pointerupoutside', this.onPointerUpOutside);
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  // ---- store driving ----

  private apply(op: DragOp): void {
    const result = applyOp(this.model, op);
    this.model = result.state;
    this.dispatchSimOps(result.simOps);
    this.runFx(result.fx);
    this.syncGuard();
    this.refresh();
  }

  private dispatchSimOps(ops: DragSimOp[]): void {
    for (const op of ops) {
      switch (op.kind) {
        case 'move':
          this.host.dispatch({ type: 'moveItem', from: op.from, to: op.to });
          break;
        case 'split': // §6.7 right-button ops (拿半堆/放 1) — additive SimCommand (B-11)
          this.host.dispatch({ type: 'splitItem', from: op.from, to: op.to, count: op.count });
          break;
        case 'discard':
          this.host.dispatch({ type: 'discardItem', slot: op.slot });
          break;
      }
    }
  }

  /** The store provably converges with the sim (model tests); resync if it ever drifts. */
  private syncGuard(): void {
    const expected = expectedSimSlots(this.model);
    const actual = this.host.state().inventory.slots;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      console.warn('[inventory] drag store diverged from sim — resyncing (drops hold/undo)');
      this.model = createDragState(actual);
    }
  }

  private runFx(fxList: DragFx[]): void {
    for (const fx of fxList) {
      switch (fx.fx) {
        case 'reject-not-discardable':
          this.trashSlot.shake(); // double-block + head-shake (GDD §6.3)
          this.host.toast('toast.not_discardable');
          this.host.playSfx(SFX.uiError);
          break;
        case 'reject-locked':
          this.host.playSfx(SFX.uiError);
          break;
        case 'reject-full': // right pick needs a free slot to anchor the split half
          this.host.toast('toast.inventory_full');
          this.host.playSfx(SFX.uiError);
          break;
        case 'undo-blocked':
          this.host.toast('toast.inventory_full');
          this.host.playSfx(SFX.uiError);
          break;
        case 'undo-take':
          this.host.playSfx(SFX.itemGet); // reuses the M1 8-SFX set (PRD 02 §11.5)
          break;
        case 'bounce':
          this.bounceGhostTo(fx.toSlot);
          break;
        default:
          break; // drop/pickup/putback/swap/overflow/trash/sort/quick-move: silent success (§6.7)
      }
    }
  }

  /** Invalid-target release: the ghost flies back to the origin slot (无效位回弹). */
  private bounceGhostTo(slotIndex: number): void {
    const view = this.slots[slotIndex];
    if (!view || !this.heldGhost.visible || this.host.reducedMotion()) {
      this.heldGhost.setVisible(false);
      return;
    }
    this.bouncing = true;
    this.host.scene.tweens.add({
      targets: this.heldGhost,
      x: view.x + SLOT_SIZE / 2,
      y: view.y + SLOT_SIZE / 2,
      alpha: 0.2,
      duration: BOUNCE_MS,
      onComplete: () => {
        this.bouncing = false;
        if (this.destroyed) return;
        this.heldGhost.setVisible(false).setAlpha(1);
        this.refresh();
      },
    });
  }

  // ---- pointer wiring (release is hit-tested geometrically so it works anywhere) ----

  private onPress(target: DropTarget, pointer: Phaser.Input.Pointer): void {
    const shift = (pointer.event as MouseEvent | undefined)?.shiftKey === true;
    // Right button = §6.7 拿半堆 / 放 1 (GDD §6.8 背包 column); the browser context
    // menu is globally disabled by UIScene (input.mouse.disableContextMenu()).
    const button = pointer.rightButtonDown() ? 'right' : 'left';
    if (target.kind === 'slot' && target.index < this.model.slots.length) {
      this.cursor = target.index;
    }
    this.apply({ op: 'press', target, shift, button });
  }

  private readonly onPointerUp = (pointer: Phaser.Input.Pointer): void => {
    if (this.model.held?.pickupPress !== true) return;
    const button = pointer.rightButtonReleased() ? 'right' : 'left';
    this.apply({ op: 'release', target: this.hitTarget(pointer.x, pointer.y), button });
  };

  private readonly onPointerUpOutside = (): void => {
    if (this.model.held?.pickupPress !== true) return;
    this.apply({ op: 'release', target: { kind: 'outside' } });
  };

  private onPointerMove = (pointer: Phaser.Input.Pointer): void => {
    if (this.heldGhost.visible && !this.bouncing) {
      this.heldGhost.setPosition(Math.round(pointer.x) + 8, Math.round(pointer.y) - 4);
    }
    const target = this.hitTarget(pointer.x, pointer.y);
    const prev = this.hovered;
    this.hovered = target.kind === 'outside' ? null : target;
    if (JSON.stringify(prev) !== JSON.stringify(this.hovered)) this.refreshHighlights();
  };

  /** Hover highlight from the pure classifier (悬停高亮, GDD §6.7). */
  private refreshHighlights(): void {
    const kind = classifyTarget(this.model, this.hovered);
    const active = kind !== 'none' && kind !== 'invalid';
    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      this.slots[i].setHighlight(
        active && this.hovered?.kind === 'slot' && this.hovered.index === i,
      );
    }
    this.trashSlot.setHighlight(kind === 'trash-ok');
    this.undoSlot.setHighlight(kind === 'undo-ready');
  }

  private hitTarget(x: number, y: number): DropTarget {
    for (let i = 0; i < TOTAL_GRID_SLOTS; i += 1) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = this.gridX + col * (SLOT_SIZE + GRID_GAP);
      const cy = this.gridY + row * ROW_PITCH;
      if (x >= cx && x < cx + SLOT_SIZE && y >= cy && y < cy + SLOT_SIZE) {
        return { kind: 'slot', index: i };
      }
    }
    if (this.inRect(x, y, this.trashX, this.trashY)) return { kind: 'trash' };
    if (this.inRect(x, y, this.undoX, this.trashY)) return { kind: 'undo' };
    return { kind: 'outside' };
  }

  private inRect(x: number, y: number, rx: number, ry: number): boolean {
    return x >= rx && x < rx + SLOT_SIZE && y >= ry && y < ry + SLOT_SIZE;
  }

  // ---- tooltips ----

  private onSlotHover(index: number): void {
    if (index >= this.model.slots.length) return;
    const stack = this.model.slots[index];
    if (!stack) return;
    const def = getItemDef(stack.itemId);
    const lines = [t(def.nameKey), t(`category.${def.category}`)];
    if (def.sellPrice !== undefined) {
      lines.push(`${t('inventory.sell_price')} ${def.sellPrice}g`);
    }
    this.showTooltip(lines.join('\n'), this.slots[index].x, this.slots[index].y);
  }

  private onUndoHover(): void {
    const undo = this.model.undo;
    if (!undo) return;
    const def = getItemDef(undo.stack.itemId);
    this.showTooltip(
      `${t(def.nameKey)} ×${undo.stack.count}\n${t('inventory.undo_hint')}`,
      this.undoX,
      this.trashY,
    );
  }

  private showTooltip(text: string, anchorX: number, anchorY: number): void {
    this.tooltip
      .setText(text)
      .setPosition(anchorX + SLOT_SIZE + 4, anchorY)
      .setVisible(true);
    // Keep the tooltip inside the 640-wide stage when anchored near the right edge.
    const overflow = this.tooltip.x + this.tooltip.width - 636;
    if (overflow > 0) this.tooltip.setX(this.tooltip.x - overflow);
  }

  private buildExtraSlot(x: number, y: number, label: string): SlotView {
    const scene = this.host.scene;
    const view = new SlotView(scene, x, y);
    view.setDepth(DEPTH.panel + 1);
    this.track(view);
    this.track(
      uiText(scene, x + SLOT_SIZE / 2, y - 13, label, { color: PALETTE.ui.textDim })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    return view;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
