/**
 * notifications.ts — pure toast + banner queue model (GDD §6.7 toast rules, §5.8
 * banner/queue discipline). Phaser-free; time is injected as `nowMs` so the model is
 * deterministic and unit-testable.
 *
 * Rules implemented:
 * - toasts are ONLY for "why an action was blocked" (success feedback is in-place fx);
 * - at most 2 toasts on screen, 1.2s hold + 0.3s fade, 1s same-text dedupe;
 * - at most 1 banner at a time, 3s hold, queued FIFO; consecutive banners 0.5s apart;
 * - achievement toasts (M1.5, GDD §5.8): bottom-right, 2.5s hold, at most 1 on screen
 *   ("最多 1 横幅 + 1 成就 toast"), same FIFO/cap/modal discipline, no dedupe (ids are
 *   unique by construction);
 * - pending queue (banners + toasts + achievement toasts) hard cap 8; overflow merges
 *   into one "还有 N 项新进展，详见日结算" toast;
 * - while a modal is open, popping new items is suspended (queued, not dropped).
 */
import { t } from './strings';

export const TOAST_HOLD_MS = 1_200;
export const TOAST_FADE_MS = 300;
export const TOAST_DEDUPE_MS = 1_000;
export const TOAST_MAX_VISIBLE = 2;
export const BANNER_HOLD_MS = 3_000;
export const BANNER_GAP_MS = 500;
export const QUEUE_CAP = 8;
/** Achievement toast: 2.5s non-modal, bottom-right (GDD §5.8 / PRD 02 US2). */
export const ACHIEVEMENT_HOLD_MS = 2_500;
export const ACHIEVEMENT_FADE_MS = 300;

export interface VisibleToast {
  text: string;
  /** 1 during hold, 1→0 during the fade window. */
  alpha: number;
}

export interface VisibleBanner {
  text: string;
  /** 0→1 slide-in progress over the first 300ms (render maps it to y-offset). */
  slide: number;
}

interface ActiveToast {
  text: string;
  shownAt: number;
}

export class NotificationsModel {
  private toastQueue: string[] = [];
  private bannerQueue: string[] = [];
  private achievementQueue: string[] = [];
  private active: ActiveToast[] = [];
  private activeBanner: { text: string; shownAt: number } | null = null;
  private activeAchievement: ActiveToast | null = null;
  private lastToastText = '';
  private lastToastAt = -Infinity;
  private bannerClearedAt = -Infinity;
  private overflowCount = 0;
  private modalOpen = false;

  /** Modal panels suspend popping (GDD §5.8 "模态打开时暂停弹出"). */
  setModalOpen(open: boolean): void {
    this.modalOpen = open;
  }

  /** Enqueue a blocked-reason toast (dedupes same text within 1s). */
  toast(text: string, nowMs: number): void {
    if (text === this.lastToastText && nowMs - this.lastToastAt < TOAST_DEDUPE_MS) return;
    this.lastToastText = text;
    this.lastToastAt = nowMs;
    if (this.pendingCount() >= QUEUE_CAP) {
      this.overflowCount += 1;
      return;
    }
    this.toastQueue.push(text);
  }

  banner(text: string, _nowMs: number): void {
    if (this.pendingCount() >= QUEUE_CAP) {
      this.overflowCount += 1;
      return;
    }
    this.bannerQueue.push(text);
  }

  /** Enqueue an achievement-unlock toast (bottom-right, 2.5s, GDD §5.8; M1.5). */
  achievement(text: string, _nowMs: number): void {
    if (this.pendingCount() >= QUEUE_CAP) {
      this.overflowCount += 1;
      return;
    }
    this.achievementQueue.push(text);
  }

  /** Advance the model; call once per frame. Returns what should be on screen. */
  update(nowMs: number): {
    toasts: VisibleToast[];
    banner: VisibleBanner | null;
    achievement: VisibleToast | null;
  } {
    // Expire finished toasts/banner/achievement.
    this.active = this.active.filter((a) => nowMs - a.shownAt < TOAST_HOLD_MS + TOAST_FADE_MS);
    if (this.activeBanner && nowMs - this.activeBanner.shownAt >= BANNER_HOLD_MS) {
      this.activeBanner = null;
      this.bannerClearedAt = nowMs;
    }
    if (
      this.activeAchievement &&
      nowMs - this.activeAchievement.shownAt >= ACHIEVEMENT_HOLD_MS + ACHIEVEMENT_FADE_MS
    ) {
      this.activeAchievement = null;
    }

    if (!this.modalOpen) {
      // Merge overflow into a single summarizing toast (GDD §5.8).
      if (this.overflowCount > 0 && this.pendingCount() < QUEUE_CAP) {
        this.toastQueue.push(t('toast.overflow_summary', { n: this.overflowCount }));
        this.overflowCount = 0;
      }
      while (this.active.length < TOAST_MAX_VISIBLE && this.toastQueue.length > 0) {
        const text = this.toastQueue.shift();
        if (text !== undefined) this.active.push({ text, shownAt: nowMs });
      }
      if (
        this.activeBanner === null &&
        this.bannerQueue.length > 0 &&
        nowMs - this.bannerClearedAt >= BANNER_GAP_MS
      ) {
        const text = this.bannerQueue.shift();
        if (text !== undefined) this.activeBanner = { text, shownAt: nowMs };
      }
      // At most ONE achievement toast on screen (§5.8 "最多 1 横幅 + 1 toast").
      if (this.activeAchievement === null && this.achievementQueue.length > 0) {
        const text = this.achievementQueue.shift();
        if (text !== undefined) this.activeAchievement = { text, shownAt: nowMs };
      }
    }

    const toasts = this.active.map((a) => {
      const age = nowMs - a.shownAt;
      const alpha =
        age <= TOAST_HOLD_MS ? 1 : Math.max(0, 1 - (age - TOAST_HOLD_MS) / TOAST_FADE_MS);
      return { text: a.text, alpha };
    });
    const banner = this.activeBanner
      ? {
          text: this.activeBanner.text,
          slide: Math.min(1, (nowMs - this.activeBanner.shownAt) / 300),
        }
      : null;
    let achievement: VisibleToast | null = null;
    if (this.activeAchievement) {
      const age = nowMs - this.activeAchievement.shownAt;
      achievement = {
        text: this.activeAchievement.text,
        alpha:
          age <= ACHIEVEMENT_HOLD_MS
            ? 1
            : Math.max(0, 1 - (age - ACHIEVEMENT_HOLD_MS) / ACHIEVEMENT_FADE_MS),
      };
    }
    return { toasts, banner, achievement };
  }

  private pendingCount(): number {
    return this.toastQueue.length + this.bannerQueue.length + this.achievementQueue.length;
  }
}
