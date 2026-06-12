/**
 * build-catalog-panel.ts — the CATALOG page of the §8.3 build machine (M3; PRD 04
 * US1~US4, US28~30). Menu-state panel (tick stops); three tabs: 图纸 | 搬迁 | 拆除.
 *
 * 图纸: ALL blueprints listed — locked rows greyed with their unlock condition
 * (可预期的「明日之诺」, US3), unaffordable rows greyed with the exact deficit (US4),
 * per-blueprint limits and the farmhouse chain stage surfaced inline. Selecting an
 * available plot blueprint closes the UI stack and enters world PLACING via the
 * build controller; farmhouse upgrades skip PLACING straight to CONFIRM (§8.2 chain).
 *
 * 搬迁: movable instances — free & instant forever, all internal state preserved
 * (§8.3). Selecting one enters PLACING with the move exemption.
 *
 * 拆除: demolishable instances with the §8.3 refund preview: deco/station = instant
 * 100% (no dialog), site = single confirm 100%, built building = double confirm
 * floor(50%); blocked rows (non-empty chest / goods that would not fit) explain why.
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { BLUEPRINTS_BY_ID, type BlueprintDef } from '../../sim/data/buildings';
import type { PlacedStructure } from '@codestead/shared';
import { formatGold } from '../format';
import { BUILD_PANEL, DEPTH } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import { requestPlacing } from '../../world/build-bridge';
import {
  asSimCommand,
  catalogRows,
  demolishPlan,
  demolishablesOf,
  materialCount,
  movablesOf,
  refundPreview,
  type BuildCatalogRow,
  type BuildConfirmRequest,
  type RefundPreview,
} from './build-model';
import type { Panel, UiHost } from './host';

const ROW_HEIGHT = 16;
const ROWS_TOP = 60;
const MAX_VISIBLE_ROWS = 15;
const CLICK_DEBOUNCE_MS = 150;

export type BuildTab = 'blueprints' | 'move' | 'demolish';

/** "{gold}g · 木×{wood} · 石×{stone}" with zero parts omitted (cost & refund lines). */
export function costParts(parts: RefundPreview): string {
  const out: string[] = [];
  if (parts.gold > 0) out.push(`${formatGold(parts.gold)}g`);
  if (parts.wood > 0) out.push(`木×${parts.wood}`);
  if (parts.stone > 0) out.push(`石×${parts.stone}`);
  return out.length > 0 ? out.join(' · ') : '0g';
}

export class BuildCatalogPanel implements Panel {
  readonly id: UiPanelId = 'buildCatalog';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];
  private tab: BuildTab = 'blueprints';
  private cursor = 0;
  private scrollTop = 0;
  private lastClickAt = -Infinity;
  private holdingsText!: Phaser.GameObjects.Text;
  private tabLabels: { tab: BuildTab; label: Phaser.GameObjects.Text }[] = [];

  constructor(
    private host: UiHost,
    initialTab: BuildTab = 'blueprints',
  ) {
    this.tab = initialTab;
    const scene = host.scene;
    const p = BUILD_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + 8, p.y + 4, t('build.title'), { color: PALETTE.gold.light }).setDepth(
        DEPTH.panel + 1,
      ),
    );
    this.holdingsText = this.track(
      uiText(scene, p.x + p.width - 8, p.y + 4, '', { color: PALETTE.ui.textDim })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const tabs: { tab: BuildTab; key: string; x: number }[] = [
      { tab: 'blueprints', key: 'build.tab_blueprints', x: p.x + 8 },
      { tab: 'move', key: 'build.tab_move', x: p.x + 64 },
      { tab: 'demolish', key: 'build.tab_demolish', x: p.x + 120 },
    ];
    for (const { tab, key, x } of tabs) {
      const label = this.track(uiText(scene, x, p.y + 22, t(key)).setDepth(DEPTH.panel + 1));
      label.setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => this.switchTab(tab));
      this.tabLabels.push({ tab, label });
    }

    this.track(
      uiText(scene, p.x + 8, p.y + p.height - 16, t('build.keys'), {
        color: PALETTE.ui.textDim,
      }).setDepth(DEPTH.panel + 1),
    );
    this.refresh();
  }

  refresh(): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];
    const state = this.host.state();
    this.holdingsText.setText(
      t('build.holdings', {
        gold: formatGold(state.economy.gold),
        wood: materialCount(state, 'wood'),
        stone: materialCount(state, 'stone'),
      }),
    );
    for (const { tab, label } of this.tabLabels) {
      label.setColor(tab === this.tab ? PALETTE.gold.light : PALETTE.ui.textDim);
    }
    switch (this.tab) {
      case 'blueprints':
        this.renderBlueprints();
        break;
      case 'move':
        this.renderInstances('move');
        break;
      case 'demolish':
        this.renderInstances('demolish');
        break;
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case 'ArrowUp':
        this.cursor = Math.max(0, this.cursor - 1);
        this.refresh();
        return true;
      case 'ArrowDown':
        this.cursor += 1;
        this.refresh();
        return true;
      case 'ArrowLeft':
        this.cycleTab(-1);
        return true;
      case 'ArrowRight':
        this.cycleTab(1);
        return true;
      case 'e':
      case 'E':
      case 'Enter':
        this.activateCursor();
        return true;
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
    this.tabLabels = [];
  }

  setCovered(covered: boolean): void {
    for (const obj of [...this.objects, ...this.rowObjects]) {
      (obj as Partial<Phaser.GameObjects.Components.Visible>).setVisible?.(!covered);
    }
  }

  // ---- 图纸 tab ----

  private renderBlueprints(): void {
    const rows = catalogRows(this.host.state());
    this.cursor = Math.min(this.cursor, Math.max(0, rows.length - 1));
    this.clampScroll(rows.length);
    rows.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_ROWS).forEach((row, vi) => {
      const i = this.scrollTop + vi;
      const y = BUILD_PANEL.y + ROWS_TOP + vi * ROW_HEIGHT;
      this.addBlueprintRow(row, i, y);
    });
    this.addScrollMarkers(rows.length);
  }

  private addBlueprintRow(row: BuildCatalogRow, index: number, y: number): void {
    const p = BUILD_PANEL;
    const { def, status, deficit } = row;
    const selectable = status === 'available';
    const name = t(def.nameKey);
    const nameColor = selectable
      ? index === this.cursor
        ? PALETTE.gold.light
        : PALETTE.ui.text
      : index === this.cursor
        ? PALETTE.sand
        : PALETTE.ui.textDim;
    this.text(p.x + 12, y, name, nameColor);

    let tag: string;
    let tagColor: string = PALETTE.ui.textDim;
    switch (status) {
      case 'locked':
        tag =
          def.unlock.requires !== undefined && def.id === 'farmhouse_2'
            ? `${t('build.locked_lv', { level: def.unlock.farmLevel })} · ${t('build.requires_farmhouse1')}`
            : t('build.locked_lv', { level: def.unlock.farmLevel });
        break;
      case 'done':
        tag = t('build.done');
        tagColor = PALETTE.green.light;
        break;
      case 'in_progress':
        tag = t('build.in_progress');
        tagColor = PALETTE.amber;
        break;
      case 'limit':
        tag = t('build.limit', { n: row.count, limit: def.limit ?? 0 });
        tagColor = PALETTE.green.light;
        break;
      case 'unaffordable':
        tag = `${costParts(this.costOf(def))} · ${t('build.deficit', { parts: costParts(deficit) })}`;
        break;
      default: {
        tag = costParts(this.costOf(def));
        if (def.buildDays > 0) tag += ` · ${t('build.days', { days: def.buildDays })}`;
        tagColor = PALETTE.gold.light;
      }
    }
    this.text(p.x + p.width - 12, y, tag, tagColor).setOrigin(1, 0);

    const zone = this.addRowZone(p.x + 8, y, p.width - 16);
    zone.on('pointerdown', () => {
      this.cursor = index;
      this.activateBlueprint(row);
    });
  }

  private costOf(def: BlueprintDef): RefundPreview {
    return { gold: def.cost.gold, wood: def.cost.wood ?? 0, stone: def.cost.stone ?? 0 };
  }

  private activateBlueprint(row: BuildCatalogRow): void {
    if (!this.debounced()) return;
    const { def, status } = row;
    switch (status) {
      case 'locked':
        this.blockedToast('toast.build_locked');
        return;
      case 'limit':
      case 'done':
      case 'in_progress':
        this.blockedToast('toast.build_limit');
        return;
      case 'unaffordable':
        this.blockedToast('toast.build_not_enough');
        return;
      default:
        break;
    }
    if (def.placement === 'farmhouse') {
      // §8.3: the farmhouse is map-fixed — skip PLACING, straight to CONFIRM.
      const request: BuildConfirmRequest = {
        kind: 'farmhouseUpgrade',
        defId: def.id as 'farmhouse_1' | 'farmhouse_2',
      };
      this.host.openChild('buildConfirm', request);
      return;
    }
    // CATALOG → PLACING (§8.3): leave the menu (time resumes) and hand the world
    // controller the blueprint; commit/cancel/22:00 semantics live there.
    this.host.closeAll();
    requestPlacing(this.host.scene, { defId: def.id, movingInstanceId: null });
  }

  // ---- 搬迁 / 拆除 tabs ----

  private renderInstances(mode: 'move' | 'demolish'): void {
    const p = BUILD_PANEL;
    const state = this.host.state();
    const list = mode === 'move' ? movablesOf(state) : demolishablesOf(state);
    if (list.length === 0) {
      this.rowObjects.push(
        this.text(
          p.x + 12,
          p.y + ROWS_TOP,
          t(mode === 'move' ? 'build.empty_move' : 'build.empty_demolish'),
          PALETTE.ui.textDim,
        ),
      );
      return;
    }
    if (mode === 'move') {
      this.rowObjects.push(this.text(p.x + 12, p.y + 40, t('build.move_free'), PALETTE.ui.textDim));
    }
    this.cursor = Math.min(this.cursor, list.length - 1);
    this.clampScroll(list.length);
    list.slice(this.scrollTop, this.scrollTop + MAX_VISIBLE_ROWS).forEach((s, vi) => {
      const i = this.scrollTop + vi;
      const y = p.y + ROWS_TOP + vi * ROW_HEIGHT;
      this.addInstanceRow(mode, s, i, y);
    });
    this.addScrollMarkers(list.length);
  }

  private addInstanceRow(
    mode: 'move' | 'demolish',
    s: PlacedStructure,
    index: number,
    y: number,
  ): void {
    const p = BUILD_PANEL;
    const def = BLUEPRINTS_BY_ID.get(s.defId);
    const name = def ? t(def.nameKey) : s.defId;
    const site = s.state === 'underConstruction';
    const label = `${name}（${s.origin.x},${s.origin.y}）${site ? ` · ${t('build.in_progress')}` : ''}`;
    this.text(p.x + 12, y, label, index === this.cursor ? PALETTE.gold.light : PALETTE.ui.text);

    if (mode === 'demolish' && def) {
      const plan = demolishPlan(this.host.state(), s);
      const tag = plan.blocked
        ? t(
            plan.blocked === 'CHEST_NOT_EMPTY'
              ? 'toast.chest_not_empty'
              : 'toast.demolish_inventory_full',
          )
        : t('build.refund_tag', { parts: costParts(refundPreview(def, s.state)) });
      this.text(
        p.x + p.width - 12,
        y,
        tag,
        plan.blocked ? PALETTE.red.mid : PALETTE.ui.textDim,
      ).setOrigin(1, 0);
    }

    const zone = this.addRowZone(p.x + 8, y, p.width - 16);
    zone.on('pointerdown', () => {
      this.cursor = index;
      if (mode === 'move') this.activateMove(s);
      else this.activateDemolish(s);
    });
  }

  private activateMove(s: PlacedStructure): void {
    if (!this.debounced()) return;
    this.host.closeAll();
    requestPlacing(this.host.scene, { defId: s.defId, movingInstanceId: s.instanceId });
  }

  private activateDemolish(s: PlacedStructure): void {
    if (!this.debounced()) return;
    const plan = demolishPlan(this.host.state(), s);
    if (plan.blocked === 'CHEST_NOT_EMPTY') {
      this.blockedToast('toast.chest_not_empty');
      return;
    }
    if (plan.blocked === 'INVENTORY_FULL') {
      this.blockedToast('toast.demolish_inventory_full');
      return;
    }
    if (plan.blocked === 'NOT_DEMOLISHABLE') {
      this.host.playSfx(SFX.uiError);
      return;
    }
    if (plan.flow === 'instant') {
      // 即拆即返无对话框 (§8.3 摆错零成本).
      this.host.dispatch(asSimCommand({ type: 'demolishStructure', instanceId: s.instanceId }));
      this.host.toast('toast.build_demolished');
      this.host.playSfx(SFX.coins);
      this.refresh();
      return;
    }
    const request: BuildConfirmRequest = {
      kind: 'demolish',
      instanceId: s.instanceId,
      flow: plan.flow,
    };
    this.host.openChild('buildConfirm', request);
  }

  // ---- shared plumbing ----

  private activateCursor(): void {
    const state = this.host.state();
    switch (this.tab) {
      case 'blueprints': {
        const row = catalogRows(state)[this.cursor];
        if (row) this.activateBlueprint(row);
        return;
      }
      case 'move': {
        const s = movablesOf(state)[this.cursor];
        if (s) this.activateMove(s);
        return;
      }
      case 'demolish': {
        const s = demolishablesOf(state)[this.cursor];
        if (s) this.activateDemolish(s);
        return;
      }
    }
  }

  private switchTab(tab: BuildTab): void {
    this.tab = tab;
    this.cursor = 0;
    this.scrollTop = 0;
    this.refresh();
  }

  private cycleTab(dir: -1 | 1): void {
    const order: BuildTab[] = ['blueprints', 'move', 'demolish'];
    const next = order[(order.indexOf(this.tab) + dir + order.length) % order.length];
    this.switchTab(next);
  }

  private clampScroll(total: number): void {
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + MAX_VISIBLE_ROWS) {
      this.scrollTop = this.cursor - MAX_VISIBLE_ROWS + 1;
    }
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, total - MAX_VISIBLE_ROWS)));
  }

  /** "↑ / ↓ more" markers when the list exceeds the window. */
  private addScrollMarkers(total: number): void {
    const p = BUILD_PANEL;
    if (this.scrollTop > 0) {
      this.text(p.x + p.width - 16, p.y + ROWS_TOP - 12, '▲', PALETTE.ui.textDim);
    }
    if (this.scrollTop + MAX_VISIBLE_ROWS < total) {
      this.text(
        p.x + p.width - 16,
        p.y + ROWS_TOP + MAX_VISIBLE_ROWS * ROW_HEIGHT,
        '▼',
        PALETTE.ui.textDim,
      );
    }
  }

  private blockedToast(key: string): void {
    this.host.toast(key);
    this.host.playSfx(SFX.uiError);
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
