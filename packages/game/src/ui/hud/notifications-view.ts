/**
 * notifications-view.ts — renders the NotificationsModel: toasts above the hotbar at
 * y=312 (GDD §6.6/§6.7), the non-modal top-center banner (GDD §5.8) and the M1.5
 * bottom-right achievement toast (2.5s, §5.8). The banner's x-extent (172..468) stays
 * clear of the (4,4)–(156,150) session-HUD reserve; the achievement anchor sits in the
 * opposite corner, far from the reserve by construction.
 */
import type Phaser from 'phaser';

import { ACHIEVEMENT_TOAST, BANNER, DEPTH, TOAST_Y } from '../layout';
import { PALETTE } from '../palette';
import type { NotificationsModel } from '../notifications';
import { uiText } from '../widgets/text';

export class NotificationsView {
  private toastTexts: Phaser.GameObjects.Text[] = [];
  private bannerText: Phaser.GameObjects.Text;
  private achievementText: Phaser.GameObjects.Text;

  constructor(
    scene: Phaser.Scene,
    private model: NotificationsModel,
    private reducedMotion: () => boolean,
  ) {
    for (let i = 0; i < 2; i += 1) {
      this.toastTexts.push(
        uiText(scene, 320, TOAST_Y - i * 16, '', { color: PALETTE.amber, align: 'center' })
          .setOrigin(0.5, 0)
          .setDepth(DEPTH.toast)
          .setVisible(false),
      );
    }
    this.bannerText = uiText(scene, BANNER.centerX, BANNER.y, '', {
      color: PALETTE.gold.light,
      align: 'center',
    })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH.banner)
      .setVisible(false);
    this.achievementText = uiText(scene, ACHIEVEMENT_TOAST.x, ACHIEVEMENT_TOAST.y, '', {
      color: PALETTE.gold.light,
      align: 'right',
    })
      .setOrigin(1, 1)
      .setDepth(DEPTH.toast)
      .setVisible(false);
  }

  update(nowMs: number): void {
    const { toasts, banner, achievement } = this.model.update(nowMs);
    for (let i = 0; i < this.toastTexts.length; i += 1) {
      const view = this.toastTexts[i];
      const toast = toasts[i];
      if (toast) {
        view.setText(toast.text).setAlpha(toast.alpha).setVisible(true);
      } else {
        view.setVisible(false);
      }
    }
    if (banner) {
      const slide = this.reducedMotion() ? 1 : banner.slide;
      this.bannerText
        .setText(banner.text)
        .setY(BANNER.y - Math.round((1 - slide) * 12))
        .setAlpha(slide)
        .setVisible(true);
    } else {
      this.bannerText.setVisible(false);
    }
    if (achievement) {
      this.achievementText.setText(achievement.text).setAlpha(achievement.alpha).setVisible(true);
    } else {
      this.achievementText.setVisible(false);
    }
  }
}
