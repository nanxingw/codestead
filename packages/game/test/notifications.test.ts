/**
 * Notifications model tests (GDD §6.7 toast rules / §5.8 queue discipline):
 * 1s same-text dedupe, max 2 visible, FIFO cap 8 with overflow merge, modal suspend.
 */
import { describe, expect, it } from 'vitest';

import {
  BANNER_HOLD_MS,
  NotificationsModel,
  TOAST_FADE_MS,
  TOAST_HOLD_MS,
} from '../src/ui/notifications';

describe('NotificationsModel', () => {
  it('dedupes the same toast text within 1s', () => {
    const m = new NotificationsModel();
    m.toast('背包已满', 0);
    m.toast('背包已满', 500); // dropped
    m.toast('背包已满', 1_100); // accepted again
    expect(m.update(1_200).toasts).toHaveLength(2);
  });

  it('shows at most 2 toasts and fades them out after 1.2s + 0.3s', () => {
    const m = new NotificationsModel();
    m.toast('a', 0);
    m.toast('b', 0);
    m.toast('c', 0);
    const visible = m.update(0);
    expect(visible.toasts.map((t) => t.text)).toEqual(['a', 'b']);
    expect(visible.toasts.every((t) => t.alpha === 1)).toBe(true);

    const fading = m.update(TOAST_HOLD_MS + TOAST_FADE_MS / 2);
    expect(fading.toasts.filter((t) => t.alpha < 1).length).toBeGreaterThan(0);

    // After a+b expire, queued c pops.
    const later = m.update(TOAST_HOLD_MS + TOAST_FADE_MS + 1);
    expect(later.toasts.map((t) => t.text)).toEqual(['c']);
  });

  it('caps the pending queue at 8 and merges overflow into a summary toast', () => {
    const m = new NotificationsModel();
    m.setModalOpen(true); // queue without popping
    for (let i = 0; i < 10; i += 1) m.toast(`t${i}`, i * 1_100);
    m.setModalOpen(false);
    const texts: string[] = [];
    for (let now = 12_000; now < 30_000; now += 400) {
      for (const toast of m.update(now).toasts) {
        if (!texts.includes(toast.text)) texts.push(toast.text);
      }
    }
    expect(texts).toContain('还有 2 项新进展，详见日结算');
    expect(texts.filter((t) => t.startsWith('t'))).toHaveLength(8);
  });

  it('suspends popping while a modal is open and resumes after', () => {
    const m = new NotificationsModel();
    m.setModalOpen(true);
    m.banner('⬆ 农场等级 2！', 0);
    expect(m.update(100).banner).toBeNull();
    m.setModalOpen(false);
    expect(m.update(200).banner?.text).toBe('⬆ 农场等级 2！');
    expect(m.update(200 + BANNER_HOLD_MS + 1).banner).toBeNull();
  });
});
