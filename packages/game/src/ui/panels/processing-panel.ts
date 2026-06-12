/**
 * processing-panel.ts — workshop (6 slots) & drying rack (2 slots) interaction
 * (M3, GDD §8.2; ruling A-12; PRD 04 US16/US19).
 *
 * Top half: the facility's job slots — empty / 「还需 N 夜」 / done (click to
 * collect; a full bag blocks with the single-reason toast — goods wait forever,
 * zero-loss). Bottom half: eligible inventory inputs; clicking one loads it into
 * the first free slot with its recipe spelled out (果酱 2 夜 / 蛋黄酱 1 夜 / 干货
 * 1 夜 — prices via the §4.5 table baked into ItemDefs).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { getItemDef } from '../../sim/data/items';
import { maxAddable } from '../../sim/inventory';
import type { ItemId } from '../../sim/data/items';
import { DEPTH, FACILITY_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import { asSimCommand, eligibleInputs, structuresOf } from './build-model';
import type { Panel, UiHost } from './host';

const ROW_HEIGHT = 16;
const CLICK_DEBOUNCE_MS = 150;

export class ProcessingPanel implements Panel {
  readonly id: UiPanelId = 'processing';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private lastClickAt = -Infinity;

  constructor(
    private host: UiHost,
    private instanceId: string,
  ) {
    const scene = host.scene;
    const p = FACILITY_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const p = FACILITY_PANEL;
    const facility = this.facility();
    if (!facility) return;
    const { kind, jobs } = facility;

    this.text(
      p.x + p.width / 2,
      p.y + 8,
      t(kind === 'workshop' ? 'process.title_workshop' : 'process.title_rack'),
      PALETTE.gold.light,
    ).setOrigin(0.5, 0);

    // ---- job slots ----
    jobs.forEach((job, slot) => {
      const y = p.y + 32 + slot * ROW_HEIGHT;
      if (!job) {
        this.text(p.x + 16, y, `${slot + 1}. ${t('process.slot_empty')}`, PALETTE.ui.textDim);
        return;
      }
      const inName = t(safeNameKey(job.inputItemId));
      const outName = t(safeNameKey(job.outputItemId));
      if (job.daysLeft > 0) {
        this.text(
          p.x + 16,
          y,
          `${slot + 1}. ${t('process.slot_progress', { name: inName, out: outName, days: job.daysLeft })}`,
          PALETTE.amber,
        );
        return;
      }
      const row = this.text(
        p.x + 16,
        y,
        `${slot + 1}. ${t('process.slot_done', { out: outName })}`,
        PALETTE.green.light,
      );
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.collect(slot, job.outputItemId));
    });

    // ---- eligible inputs ----
    const inputsTop = p.y + 32 + jobs.length * ROW_HEIGHT + 12;
    this.text(p.x + 16, inputsTop, t('process.inputs'), PALETTE.ui.textDim);
    const inputs = eligibleInputs(this.host.state(), kind);
    if (inputs.length === 0) {
      this.text(p.x + 16, inputsTop + ROW_HEIGHT, t('process.no_inputs'), PALETTE.ui.textDim);
    }
    const maxRows = Math.floor((p.y + p.height - 24 - (inputsTop + ROW_HEIGHT)) / ROW_HEIGHT);
    inputs.slice(0, Math.max(0, maxRows)).forEach((input, i) => {
      const y = inputsTop + ROW_HEIGHT + i * ROW_HEIGHT;
      const name = t(getItemDef(input.itemId).nameKey);
      const tag = t('process.recipe_tag', {
        out: t(safeNameKey(input.recipe.outputItemId)),
        days: input.recipe.days,
        gold: input.recipe.outputPrice,
      });
      const row = this.text(p.x + 16, y, `${name} ×${input.count}  ${tag}`, PALETTE.ui.text);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.load(input.itemId));
    });

    this.text(p.x + 16, p.y + p.height - 20, t('bin.close'), PALETTE.ui.textDim);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.host.closeTop();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.rowObjects) obj.destroy();
    for (const obj of this.objects) obj.destroy();
    this.rowObjects = [];
    this.objects = [];
  }

  // ---- data & actions ----

  private facility(): {
    kind: 'workshop' | 'dryingRack';
    jobs: readonly ({ inputItemId: string; outputItemId: string; daysLeft: number } | null)[];
  } | null {
    const s = structuresOf(this.host.state()).find((x) => x.instanceId === this.instanceId);
    if (s?.data?.kind === 'workshop' || s?.data?.kind === 'dryingRack') {
      return { kind: s.data.kind, jobs: s.data.jobs };
    }
    return null;
  }

  private load(itemId: ItemId): void {
    if (!this.debounced()) return;
    const facility = this.facility();
    if (!facility) return;
    const slot = facility.jobs.findIndex((j) => j === null);
    if (slot === -1) {
      this.host.toast('toast.process_no_slot');
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch(
      asSimCommand({
        type: 'startProcessingJob',
        instanceId: this.instanceId,
        slot,
        inputItemId: itemId,
      }),
    );
    this.host.playSfx(SFX.seedPlant); // load-in beat; M3 audio pass swaps the canonical key
    this.refresh();
  }

  private collect(slot: number, outputItemId: string): void {
    if (!this.debounced()) return;
    if (maxAddable(this.host.state().inventory, outputItemId as ItemId) === 0) {
      this.host.toast('toast.inventory_full'); // goods wait in the slot forever (zero-loss)
      this.host.playSfx(SFX.uiError);
      return;
    }
    this.host.dispatch(
      asSimCommand({ type: 'collectProcessedGood', instanceId: this.instanceId, slot }),
    );
    this.host.toast('toast.process_collected', { name: t(safeNameKey(outputItemId)) });
    this.host.playSfx(SFX.itemGet); // process_done beat lands with the M3 audio pass
    this.refresh();
  }

  private debounced(): boolean {
    const now = this.host.scene.time.now;
    if (now - this.lastClickAt < CLICK_DEBOUNCE_MS) return false;
    this.lastClickAt = now;
    return true;
  }

  private text(x: number, y: number, content: string, color: string): Phaser.GameObjects.Text {
    const obj = uiText(this.host.scene, x, y, content, { color }).setDepth(DEPTH.panel + 1);
    this.rowObjects.push(obj);
    return obj;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}

/** nameKey for ids that may come from a future save (unknown id → echo the id). */
function safeNameKey(itemId: string): string {
  try {
    return getItemDef(itemId).nameKey;
  } catch {
    return itemId;
  }
}
