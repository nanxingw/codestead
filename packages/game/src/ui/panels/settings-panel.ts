/**
 * settings-panel.ts — Esc → 设置 (GDD §10.7; M1 subset per PRD 01 US96).
 *
 * Live rows: master volume (0..100, default 80), muted, language (zh-CN; en grayed
 * until M5), reducedMotion three-state. Grayed structure rows ship from day one so the
 * page never reflows: bgm/sfx/ui volumes (M3), 会话面板 (M2), 村民任务 (M4). Save
 * import/export entries route to the storage layer (GDD §10.6); the storage status
 * line shows 「存储：正常 ✓」 in M1. Every change applies immediately and persists.
 */
import type Phaser from 'phaser';

import { DEPTH, SETTINGS_PANEL } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export class SettingsPanel implements Panel {
  readonly id: UiPanelId = 'settings';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private masterBar!: Phaser.GameObjects.Graphics;
  private masterValue!: Phaser.GameObjects.Text;
  private mutedButton!: TextButton;
  private rmButton!: TextButton;
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

    // ---- audio ----
    this.label(x, y, t('settings.audio'), PALETTE.gold.light);
    y += 16;
    this.label(x, y, t('settings.master'));
    this.masterBar = scene.add.graphics().setDepth(DEPTH.panel + 1);
    this.track(this.masterBar);
    const barX = p.x + 108;
    const barW = 96;
    const barY = y + 4;
    const barZone = scene.add
      .zone(barX, barY - 4, barW, 14)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTH.panel + 2);
    this.track(barZone);
    const setFromPointer = (pointer: Phaser.Input.Pointer): void => {
      const ratio = Math.min(1, Math.max(0, (pointer.x - barX) / barW));
      this.host.settings.update({ audio: { master: Math.round(ratio * 100) } });
      this.applyAudio();
      this.refresh();
    };
    barZone.on('pointerdown', setFromPointer);
    barZone.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) setFromPointer(pointer);
    });
    this.masterValue = this.track(
      uiText(scene, valueX, y, '', { color: PALETTE.ui.text })
        .setOrigin(1, 0)
        .setDepth(DEPTH.panel + 1),
    );
    this.drawMasterBar(barX, barY, barW);
    y += 18;

    this.label(x, y, t('settings.muted'));
    this.mutedButton = this.toggleButton(valueX - 48, y - 2, 48, () => {
      this.host.settings.update({ audio: { muted: !this.host.settings.get().audio.muted } });
      this.applyAudio();
      this.refresh();
    });
    y += 20;

    // M3 channel rows — grayed structure (GDD §10.7: 设置页结构从第一天稳定).
    for (const key of ['settings.bgm', 'settings.sfx', 'settings.ui_volume'] as const) {
      this.label(x, y, t(key), PALETTE.ui.textDim);
      this.label(valueX - 60, y, t('settings.m3_badge'), PALETTE.ui.textDim);
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

    // ---- M2 / M4 reserves (grayed, PRD 01 US96/US112) ----
    this.label(x, y, t('settings.sessions_section'), PALETTE.ui.textDim);
    this.label(valueX - 60, y, t('settings.sessions_badge'), PALETTE.ui.textDim);
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
    this.masterValue.setText(String(s.audio.master));
    this.mutedButton.setLabel(s.audio.muted ? t('settings.on') : t('settings.off'));
    this.rmButton.setLabel(t(`settings.rm_${s.accessibility.reducedMotion}`));
    this.redrawMasterBar();
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
      this.applyAudio();
      this.refresh();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.fileInput?.remove();
    this.fileInput = null;
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  // ---- helpers ----

  private barGeom = { x: 0, y: 0, w: 0 };

  private drawMasterBar(x: number, y: number, w: number): void {
    this.barGeom = { x, y, w };
    this.redrawMasterBar();
  }

  private redrawMasterBar(): void {
    const { x, y, w } = this.barGeom;
    if (w === 0) return;
    const s = this.host.settings.get();
    const fill = s.audio.master / 100;
    this.masterBar.clear();
    this.masterBar.fillStyle(hexToNum(PALETTE.ui.panelLight), 1);
    this.masterBar.fillRect(x, y, w, 6);
    this.masterBar.fillStyle(hexToNum(s.audio.muted ? PALETTE.ui.textDim : PALETTE.water.light), 1);
    this.masterBar.fillRect(x, y, Math.round(w * fill), 6);
    this.masterBar.lineStyle(1, hexToNum(PALETTE.ink), 1);
    this.masterBar.strokeRect(x + 0.5, y + 0.5, w - 1, 5);
  }

  private applyAudio(): void {
    const s = this.host.settings.get();
    this.host.ctx.audio?.setMasterVolume(s.audio.master, s.audio.muted);
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
