/**
 * session-settings-panel.ts — 设置 → 会话面板 (hud-sessions §9/§12-D6; PRD 03
 * US27/29/30/31/32 + M2-end US12/19 tier; GDD §6.5 M2 row, §10.7).
 *
 * All 10 HUD settings (§9 table order) cycle through their value sets via
 * SessionHudHandle.updateSettings — persisted immediately to localStorage
 * `codestead.hud.v1`, NEVER the farm save (appendix A-21). The connection
 * block at the top satisfies US39 (both version numbers; daemon protocol vs
 * ours in INCOMPATIBLE) and US40 (connection status + `npx codestead` install
 * guidance — this page is exempt from the everConnected gate, §8.2).
 *
 * Row models and copy live in src/hud/settings-rows.ts (pure, unit-tested);
 * this file is the thin Phaser shell.
 */
import type Phaser from 'phaser';

import {
  INSTALL_HINT,
  SESSION_SETTING_ROWS,
  connectionStatusLine,
  installHintVisible,
  versionLine,
} from '../../hud/settings-rows';
import { DEPTH, SETTINGS_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export class SessionSettingsPanel implements Panel {
  readonly id: UiPanelId = 'sessionSettings';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private versionText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private rowButtons: { index: number; button: TextButton }[] = [];

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = SETTINGS_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 4, t('settings.sessions_section'), {
        color: PALETTE.gold.light,
      })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const x = p.x + 12;
    const valueX = p.x + p.width - 12;
    let y = p.y + 22;

    // ---- connection block (US39/US40; NOT gated by everConnected, §8.2) ----
    this.statusText = this.track(
      uiText(scene, x, y, '', { color: PALETTE.ui.text }).setDepth(DEPTH.panel + 1),
    );
    y += 14;
    this.versionText = this.track(
      uiText(scene, x, y, '', { color: PALETTE.ui.textDim }).setDepth(DEPTH.panel + 1),
    );
    y += 14;
    this.hintText = this.track(
      uiText(scene, x, y, INSTALL_HINT, { color: PALETTE.ui.textDim }).setDepth(DEPTH.panel + 1),
    );
    y += 18;

    // ---- the 10 settings rows (§9 table order; copy from settings-rows.ts) ----
    const hud = host.sessionHud;
    SESSION_SETTING_ROWS.forEach((row, index) => {
      this.track(
        uiText(scene, x, y, row.label, {
          color: hud ? PALETTE.ui.text : PALETTE.ui.textDim,
        }).setDepth(DEPTH.panel + 1),
      );
      const button = new TextButton(scene, valueX - 64, y - 2, '', {
        width: 64,
        disabled: hud === undefined,
        onClick: () => {
          const handle = this.host.sessionHud;
          if (!handle) return;
          const settings = handle.settings();
          if (row.enabled !== undefined && !row.enabled(settings)) return;
          handle.updateSettings(row.next(settings)); // persists immediately (§9)
          this.refresh();
        },
      });
      button.setDepth(DEPTH.panel + 1);
      this.track(button);
      this.rowButtons.push({ index, button });
      y += 18;
    });

    this.refresh();
  }

  refresh(): void {
    const hud = this.host.sessionHud;
    if (!hud) {
      this.statusText.setText('连接状态：不可用');
      this.versionText.setText('');
      this.hintText.setVisible(true);
      return;
    }
    const state = hud.hudState();
    this.statusText.setText(connectionStatusLine(state));
    this.versionText.setText(versionLine(state));
    this.hintText.setVisible(installHintVisible(state)); // US40 — actionable whenever not serving
    const settings = hud.settings();
    for (const { index, button } of this.rowButtons) {
      const row = SESSION_SETTING_ROWS[index];
      button.setLabel(row.value(settings));
      button.setDisabled(row.enabled !== undefined && !row.enabled(settings));
    }
  }

  handleKey(event: KeyboardEvent): boolean {
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

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
