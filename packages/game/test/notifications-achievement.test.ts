/**
 * Achievement-toast channel tests (M1.5, GDD §5.8 / PRD 02 US2/US10): bottom-right
 * 2.5s hold, at most ONE on screen, FIFO behind the shared cap-8 pending queue with
 * overflow merging, and modal suspension. Pure model — no Phaser.
 */
import { describe, expect, it } from 'vitest';

import {
  ACHIEVEMENT_FADE_MS,
  ACHIEVEMENT_HOLD_MS,
  NotificationsModel,
} from '../src/ui/notifications';

describe('NotificationsModel achievement channel', () => {
  it('holds an achievement toast for 2.5s then fades it out', () => {
    const m = new NotificationsModel();
    m.achievement('🏆 成就解锁 · 破土', 0);

    expect(m.update(0).achievement).toEqual({ text: '🏆 成就解锁 · 破土', alpha: 1 });
    expect(m.update(ACHIEVEMENT_HOLD_MS - 1).achievement?.alpha).toBe(1);

    const fading = m.update(ACHIEVEMENT_HOLD_MS + ACHIEVEMENT_FADE_MS / 2).achievement;
    expect(fading).not.toBeNull();
    expect(fading?.alpha).toBeLessThan(1);

    expect(m.update(ACHIEVEMENT_HOLD_MS + ACHIEVEMENT_FADE_MS + 1).achievement).toBeNull();
  });

  it('shows at most one at a time; the next pops only after the first expires (FIFO)', () => {
    const m = new NotificationsModel();
    m.achievement('a', 0);
    m.achievement('b', 0);

    expect(m.update(0).achievement?.text).toBe('a');
    expect(m.update(ACHIEVEMENT_HOLD_MS / 2).achievement?.text).toBe('a');

    const after = m.update(ACHIEVEMENT_HOLD_MS + ACHIEVEMENT_FADE_MS + 1).achievement;
    expect(after?.text).toBe('b');
  });

  it('suspends popping while a modal is open and resumes after (§5.8 队列纪律)', () => {
    const m = new NotificationsModel();
    m.setModalOpen(true);
    m.achievement('a', 0);
    expect(m.update(100).achievement).toBeNull(); // queued, not dropped
    m.setModalOpen(false);
    expect(m.update(200).achievement?.text).toBe('a');
  });

  it('shares the cap-8 pending queue; overflow merges into the summary toast', () => {
    const m = new NotificationsModel();
    m.setModalOpen(true); // hold everything in the pending queue
    for (let i = 0; i < 8; i += 1) m.achievement(`a${i}`, 0);
    m.achievement('a8', 0); // 9th pending item → overflow counter
    m.setModalOpen(false);

    const seen: string[] = [];
    let achievementsSeen = 0;
    for (let now = 0; now < 40_000; now += 200) {
      const out = m.update(now);
      if (out.achievement && !seen.includes(out.achievement.text)) {
        seen.push(out.achievement.text);
        achievementsSeen += 1;
      }
      for (const toast of out.toasts) {
        if (!seen.includes(toast.text)) seen.push(toast.text);
      }
    }
    expect(achievementsSeen).toBe(8); // a0..a7 played through, one at a time
    expect(seen).not.toContain('a8'); // the overflow item itself never shows…
    expect(seen).toContain('还有 1 项新进展，详见日结算'); // …it is merged (§5.8)
  });
});
