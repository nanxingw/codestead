/**
 * settings-panel.ts — Esc → 设置 (GDD §10.7; M1 subset per PRD 01 US96).
 *
 * Live rows: master volume (0..100, default 80), muted, the M3 channel trio
 * bgm/sfx/ui (35/70/50 defaults, ruling A-10 — PRD 04 US56; bgm deliberately low),
 * language (zh-CN; en grayed until M5), reducedMotion three-state. Remaining grayed
 * structure row: 村民任务 (M4). Save import/export entries route to the storage
 * layer (GDD §10.6). Every change applies immediately and persists.
 */
import type Phaser from 'phaser';

import { connectionSummary } from '../../hud/settings-rows';
import { DEPTH, SETTINGS_PANEL } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

/** The four live volume rows (GDD §10.7; PRD 04 US56). */
type VolumeChannel = 'master' | 'bgm' | 'sfx' | 'ui';

export class SettingsPanel implements Panel {
  readonly id: UiPanelId = 'settings';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private volumeRedraws: (() => void)[] = [];
  private mutedButton!: TextButton;
  private rmButton!: TextButton;
  private sessionsButton!: TextButton;
  private fileInput: HTMLInputElement | null = null;
  private importStatus!: Phaser.GameObjects.Text;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = SETTINGS_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.title(p.x + p.width / 2, p.y + 4, t('settings.title'));

    let y = p.y + 24;
    const x = p.x + 12;
    const valueX = p.x + p.width - 12;

    // ---- audio: master + the M3 channel trio, all live sliders (US56) ----
    this.label(x, y, t('settings.audio'), PALETTE.gold.light);
    y += 16;
    this.volumeRow(x, y, valueX, t('settings.master'), 'master');
    y += 18;

    this.label(x, y, t('settings.muted'));
    this.mutedButton = this.toggleButton(valueX - 48, y - 2, 48, () => {
      this.host.settings.update({ audio: { muted: !this.host.settings.get().audio.muted } });
      this.refresh();
    });
    y += 20;

    // M3 channel rows — live since PRD 04 (defaults 35/70/50, ruling A-10).
    for (const [labelKey, channel] of [
      ['settings.bgm', 'bgm'],
      ['settings.sfx', 'sfx'],
      ['settings.ui_volume', 'ui'],
    ] as const) {
      this.volumeRow(x, y, valueX, t(labelKey), channel);
      y += 16;
    }
    y += 4;

    // ---- general ----
    this.label(x, y, t('settings.language'));
    this.label(valueX - 60, y, t('settings.lang_zh'), PALETTE.ui.text);
    y += 18;
    this.label(x, y, t('settings.reduced_motion'));
    this.rmButton = this.toggleButton(valueX - 64, y - 2, 64, () => {
      const order = ['system', 'on', 'off'] as const;
      const current = this.host.settings.get().accessibility.reducedMotion;
      const next = order[(order.indexOf(current) + 1) % order.length];
      this.host.settings.update({ accessibility: { reducedMotion: next } });
      this.refresh();
    });
    y += 22;

    // ---- 会话面板 entry (M2 live, hud-sessions §9/§12-D6) + M4 reserve ----
    // The row keeps its day-one position (GDD §10.7 设置页结构稳定) and is NOT
    // gated by everConnected (§8.2/US40): the button carries a compact
    // connection summary and opens the 会话面板 sub-page with the 10 HUD
    // settings + connection/version/install-guidance block.
    this.label(x, y, t('settings.sessions_section'));
    this.sessionsButton = new TextButton(scene, valueX - 108, y - 2, '', {
      width: 108,
      onClick: () => this.host.openChild('sessionSettings'),
    });
    this.sessionsButton.setDepth(DEPTH.panel + 1);
    this.track(this.sessionsButton);
    y += 16;
    this.label(x, y, t('settings.quests_section'), PALETTE.ui.textDim);
    this.label(valueX - 60, y, t('settings.quests_badge'), PALETTE.ui.textDim);
    y += 20;

    // ---- save import / export (GDD §10.6; storage stream implements SaveTransfer) ----
    this.label(x, y, t('settings.save_section'), PALETTE.gold.light);
    y += 16;
    const transfer = host.ctx.saveTransfer;
    const exportBtn = new TextButton(scene, x, y, t('settings.export'), {
      width: 116,
      disabled: transfer === undefined,
      onClick: () => void transfer?.exportSave(),
    });
    exportBtn.setDepth(DEPTH.panel + 1);
    this.track(exportBtn);
    const importBtn = new TextButton(scene, x + 124, y, t('settings.import'), {
      width: 116,
      disabled: transfer === undefined,
      onClick: () => this.pickImportFile(),
    });
    importBtn.setDepth(DEPTH.panel + 1);
    this.track(importBtn);
    y += 20;
    this.importStatus = this.track(
      uiText(scene, x, y, '', { color: PALETTE.ui.textDim }).setDepth(DEPTH.panel + 1),
    );

    // Storage status line (GDD §10.7).
    this.label(
      x,
      p.y + p.height - 16,
      transfer ? transfer.storageStatusText() : t('settings.storage_ok'),
      PALETTE.ui.textDim,
    );

    this.refresh();
  }

  refresh(): void {
    const s = this.host.settings.get();
    this.mutedButton.setLabel(s.audio.muted ? t('settings.on') : t('settings.off'));
    this.rmButton.setLabel(t(`settings.rm_${s.accessibility.reducedMotion}`));
    // Compact connection summary on the 会话面板 entry (US40 — never gated).
    const hud = this.host.sessionHud;
    this.sessionsButton.setLabel(hud ? `${connectionSummary(hud.hudState())} ▸` : '不可用');
    for (const redraw of this.volumeRedraws) redraw();
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.host.closeTop();
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const delta = event.key === 'ArrowLeft' ? -5 : 5;
      const master = this.host.settings.get().audio.master;
      this.host.settings.update({
        audio: { master: Math.min(100, Math.max(0, master + delta)) },
      });
      this.refresh();
      return true;
    }
    return false;
  }

  /** Hidden while the 会话面板 sub-page covers this page (GDD §6.5 nesting). */
  setCovered(covered: boolean): void {
    for (const obj of this.objects) {
      (obj as Partial<Phaser.GameObjects.Components.Visible>).setVisible?.(!covered);
    }
  }

  destroy(): void {
    this.fileInput?.remove();
    this.fileInput = null;
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  // ---- helpers ----

  /**
   * One live volume row: label + 96px slider bar + numeric value (US56). Bar geometry
   * matches the M1 master row (height 6, zone 14, 4px grid — GDD §11.3); changes
   * persist immediately and reach the audio system via the settings onChange push.
   */
  private volumeRow(
    x: number,
    y: number,
    valueX: number,
    label: string,
    channel: VolumeChannel,
  ): void {
    const scene = this.host.scene;
    const p = SETTINGS_PANEL;
    this.label(x, y, label);
    const bar = scene.add.graphics().setDepth(DEPTH.panel + 1);
    this.track(bar);
    const barX = p.x + 108;
    const barW = 96;
    const barY = y + 4;
    const value = this.track(
      uiText(scene, valueX, y, '', { color: PALETTE.ui.text })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );
    const zone = scene.add
      .zone(barX, barY - 4, barW, 14)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTH.panel + 2);
    this.track(zone);
    const setFromPointer = (pointer: Phaser.Input.Pointer): void => {
      const ratio = Math.min(1, Math.max(0, (pointer.x - barX) / barW));
      const patch: { master?: number; bgm?: number; sfx?: number; ui?: number } = {};
      patch[channel] = Math.round(ratio * 100);
      this.host.settings.update({ audio: patch });
      this.refresh();
    };
    zone.on('pointerdown', setFromPointer);
    zone.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) setFromPointer(pointer);
    });
    const redraw = (): void => {
      const s = this.host.settings.get();
      const volume = s.audio[channel];
      value.setText(String(volume));
      bar.clear();
      bar.fillStyle(hexToNum(PALETTE.ui.panelLight), 1);
      bar.fillRect(barX, barY, barW, 6);
      bar.fillStyle(hexToNum(s.audio.muted ? PALETTE.ui.textDim : PALETTE.water.light), 1);
      bar.fillRect(barX, barY, Math.round((barW * volume) / 100), 6);
      bar.lineStyle(1, hexToNum(PALETTE.ink), 1);
      bar.strokeRect(barX + 0.5, barY + 0.5, barW - 1, 5);
    };
    this.volumeRedraws.push(redraw);
    redraw();
  }

  /** DOM file input — the GDD-sanctioned exception for import (§10.6). */
  private pickImportFile(): void {
    const transfer = this.host.ctx.saveTransfer;
    if (!transfer) return;
    if (!this.fileInput) {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.accept = 'application/json,.json';
      this.fileInput.style.display = 'none';
      document.body.appendChild(this.fileInput);
      this.fileInput.addEventListener('change', () => {
        const file = this.fileInput?.files?.[0];
        if (!file) return;
        void transfer.importSave(file).then(({ ok }) => {
          this.importStatus.setText(ok ? t('settings.import_ok') : t('settings.import_failed'));
          this.importStatus.setColor(ok ? PALETTE.green.light : PALETTE.red.mid);
        });
      });
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private label(x: number, y: number, text: string, color: string = PALETTE.ui.text): void {
    this.track(uiText(this.host.scene, x, y, text, { color }).setDepth(DEPTH.panel + 1));
  }

  private title(x: number, y: number, text: string): void {
    this.track(
      uiText(this.host.scene, x, y, text, { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );
  }

  private toggleButton(x: number, y: number, width: number, onClick: () => void): TextButton {
    const btn = new TextButton(this.host.scene, x, y, '', { width, onClick });
    btn.setDepth(DEPTH.panel + 1);
    this.track(btn);
    return btn;
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
