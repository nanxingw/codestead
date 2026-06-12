/**
 * build-confirm-panel.ts — the CONFIRM dialog of the §8.3 build machine (M3; PRD 04
 * US8/US29). Dialog-state panel (tick stops). Three payload kinds:
 *   - placeBuilding:    金额 + 工期 + 余额复验 before a multi-thousand order (US8);
 *   - farmhouseUpgrade: same, for the map-fixed upgrade chain (§8.2, skips PLACING);
 *   - demolish:         site = single confirm @100%, built building = DOUBLE confirm
 *                       @floor(50%) with the refund spelled out (§8.3 table, US29).
 *
 * Success is probed from the snapshot (structures/farmhouse deltas), not from event
 * shapes — blocked dispatches return [] and leave state untouched (sim authority).
 */
import type Phaser from 'phaser';

import { SFX } from '../../AssetKeys';
import { BLUEPRINTS_BY_ID, getBlueprint } from '../../sim/data/buildings';
import { getBuildController } from '../../world/build-bridge';
import { formatGold } from '../format';
import { BUILD_CONFIRM_PANEL, DEPTH } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import { costParts } from './build-catalog-panel';
import {
  asSimCommand,
  farmhouseOf,
  materialCount,
  refundPreview,
  structuresOf,
  type BuildConfirmRequest,
} from './build-model';
import type { Panel, UiHost } from './host';

export class BuildConfirmPanel implements Panel {
  readonly id: UiPanelId = 'buildConfirm';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private title!: Phaser.GameObjects.Text;
  private body!: Phaser.GameObjects.Text;
  /** Built-building demolition is a DOUBLE confirm (§8.3); step 1 re-asks. */
  private demolishStep = 0;

  constructor(
    private host: UiHost,
    private request: BuildConfirmRequest,
  ) {
    const scene = host.scene;
    const p = BUILD_CONFIRM_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.title = this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, '', { color: PALETTE.gold.light, align: 'center' })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.body = this.track(
      uiText(scene, p.x + 12, p.y + 32, '', {
        color: PALETTE.ui.text,
        wrapWidth: p.width - 24,
      }).setDepth(DEPTH.panel + 1),
    );
    const confirm = new TextButton(scene, p.x + 16, p.y + p.height - 28, t('ui.confirm'), {
      width: 92,
      onClick: () => this.confirm(),
    });
    const cancel = new TextButton(scene, p.x + p.width - 108, p.y + p.height - 28, t('ui.cancel'), {
      width: 92,
      onClick: () => this.cancel(),
    });
    confirm.setDepth(DEPTH.panel + 1);
    cancel.setDepth(DEPTH.panel + 1);
    this.track(confirm);
    this.track(cancel);
    this.refresh();
  }

  refresh(): void {
    const state = this.host.state();
    const req = this.request;
    if (req.kind === 'placeBuilding' || req.kind === 'farmhouseUpgrade') {
      const def = getBlueprint(req.defId);
      const cost = { gold: def.cost.gold, wood: def.cost.wood ?? 0, stone: def.cost.stone ?? 0 };
      this.title.setText(t('build.confirm_order_title', { name: t(def.nameKey) }));
      this.body.setText(
        t(
          req.kind === 'farmhouseUpgrade'
            ? 'build.confirm_upgrade_body'
            : 'build.confirm_order_body',
          {
            parts: costParts(cost),
            days: def.buildDays,
            gold: formatGold(state.economy.gold),
            wood: materialCount(state, 'wood'),
            stone: materialCount(state, 'stone'),
          },
        ),
      );
      return;
    }
    // demolish
    const s = structuresOf(state).find((x) => x.instanceId === req.instanceId);
    const def = s ? BLUEPRINTS_BY_ID.get(s.defId) : undefined;
    if (!s || !def) {
      this.title.setText('');
      this.body.setText('');
      return;
    }
    const parts = costParts(refundPreview(def, s.state));
    if (req.flow === 'confirm_site') {
      this.title.setText(t('build.demolish_site_title'));
      this.body.setText(t('build.demolish_site_body', { parts }));
    } else if (this.demolishStep === 0) {
      this.title.setText(t('build.demolish_built_title', { name: t(def.nameKey) }));
      this.body.setText(t('build.demolish_built_body', { parts }));
    } else {
      this.title.setText(t('build.demolish_built_title', { name: t(def.nameKey) }));
      this.body.setText(t('build.demolish_built_again', { name: t(def.nameKey) }));
    }
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
      this.confirm();
      return true;
    }
    if (event.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  destroy(): void {
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  // ---- actions ----

  private confirm(): void {
    const req = this.request;
    switch (req.kind) {
      case 'placeBuilding': {
        const before = structuresOf(this.host.state()).length;
        this.host.dispatch(
          asSimCommand({ type: 'placeStructure', defId: req.defId, origin: req.origin }),
        );
        const placed = structuresOf(this.host.state()).length > before;
        this.host.closeTop();
        if (placed) {
          getBuildController(this.host.scene)?.confirmCommitted();
          this.host.playSfx(SFX.itemGet); // build_place beat lands with the M3 audio pass
        } else {
          // Balance re-check failed at commit time (§8.3 复验): stay in PLACING.
          getBuildController(this.host.scene)?.confirmCancelled();
          this.host.toast('toast.build_not_enough');
          this.host.playSfx(SFX.uiError);
        }
        return;
      }
      case 'farmhouseUpgrade': {
        this.host.dispatch(asSimCommand({ type: 'orderFarmhouseUpgrade', defId: req.defId }));
        const ordered = farmhouseOf(this.host.state()).construction !== null;
        this.host.closeTop();
        if (ordered) {
          this.host.playSfx(SFX.itemGet);
        } else {
          this.host.toast('toast.build_not_enough');
          this.host.playSfx(SFX.uiError);
        }
        return;
      }
      case 'demolish': {
        if (req.flow === 'confirm_built' && this.demolishStep === 0) {
          this.demolishStep = 1; // double confirm (§8.3 大额操作可逆且透明)
          this.refresh();
          return;
        }
        const existedBefore = structuresOf(this.host.state()).some(
          (s) => s.instanceId === req.instanceId,
        );
        this.host.dispatch(asSimCommand({ type: 'demolishStructure', instanceId: req.instanceId }));
        const gone =
          existedBefore &&
          !structuresOf(this.host.state()).some((s) => s.instanceId === req.instanceId);
        this.host.closeTop();
        if (gone) {
          this.host.toast(
            req.flow === 'confirm_site'
              ? 'toast.build_cancelled_order'
              : 'toast.build_demolished_building',
          );
          this.host.playSfx(SFX.coins);
        } else {
          this.host.playSfx(SFX.uiError);
        }
        return;
      }
    }
  }

  private cancel(): void {
    const wasPlacing = this.request.kind === 'placeBuilding';
    this.host.closeTop();
    // PLACING survives a cancelled CONFIRM so the player can re-aim (§8.3 回退).
    if (wasPlacing) getBuildController(this.host.scene)?.confirmCancelled();
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
