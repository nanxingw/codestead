/**
 * pause-menu.ts — the Esc menu (GDD §6.5/§6.7): 继续 / 保存（「已保存 ✓」1s）/ 设置 /
 * 键位说明（M1 固定键位）/ 回主菜单（自动保存后清栈）. Opening contributes the 'menu'
 * pause source via the UI stack.
 */
import type Phaser from 'phaser';

import { DEPTH, MENU_PANEL } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import type { UiPanelId } from '../ui-stack';
import { TextButton } from '../widgets/button';
import { addPanel } from '../widgets/panel';
import { addScrim } from '../widgets/scrim';
import { uiText } from '../widgets/text';
import type { Panel, UiHost } from './host';

export class PauseMenuPanel implements Panel {
  readonly id: UiPanelId = 'pauseMenu';
  private objects: Phaser.GameObjects.GameObject[] = [];
  private saveButton!: TextButton;
  private savedTimer: Phaser.Time.TimerEvent | null = null;

  constructor(private host: UiHost) {
    const scene = host.scene;
    const p = MENU_PANEL;
    this.track(addScrim(scene).setDepth(DEPTH.scrim));
    this.track(addPanel(scene, p.x, p.y, p.width, p.height).setDepth(DEPTH.panel));
    this.track(
      uiText(scene, p.x + p.width / 2, p.y + 8, t('menu.title'), { color: PALETTE.gold.light })
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.panel + 1),
    );

    const bx = p.x + 16;
    const bw = p.width - 32;
    let by = p.y + 32;
    const addButton = (label: string, onClick: () => void, disabled = false): TextButton => {
      const btn = new TextButton(scene, bx, by, label, { width: bw, onClick, disabled });
      btn.setDepth(DEPTH.panel + 1);
      by += 24;
      this.track(btn);
      return btn;
    };

    addButton(t('menu.resume'), () => host.closeTop());
    this.saveButton = addButton(
      t('menu.save'),
      () => void this.manualSave(),
      host.ctx.saveTransfer === undefined,
    );
    addButton(t('menu.settings'), () => host.openChild('settings'));
    addButton(t('menu.keys'), () => host.openChild('keysHelp'));
    addButton(
      t('menu.main_menu'),
      () => {
        // Autosave first, then clear the stack (GDD §6.5 主菜单 path).
        void this.host.ctx.saveTransfer?.manualSave().finally(() => {
          this.host.closeAll();
          this.host.ctx.returnToMainMenu?.();
        });
      },
      host.ctx.returnToMainMenu === undefined,
    );
  }

  refresh(): void {
    // Static menu — nothing derived from sim state.
  }

  handleKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.host.closeTop();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.savedTimer?.remove();
    for (const obj of this.objects) obj.destroy();
    this.objects = [];
  }

  private async manualSave(): Promise<void> {
    const ok = await this.host.ctx.saveTransfer?.manualSave();
    if (ok) {
      this.saveButton.setLabel(t('menu.saved')); // 「已保存 ✓」 for 1s (GDD §6.7)
      this.savedTimer = this.host.scene.time.delayedCall(1_000, () =>
        this.saveButton.setLabel(t('menu.save')),
      );
    }
  }

  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }
}
