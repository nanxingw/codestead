import { describe, expect, it } from 'vitest';

import { ACTION_TIMING } from '../../src/sim/data/constants';
import { ActionBuffer, HoldRepeater } from '../../src/world/action-timing';

describe('HoldRepeater (GDD §1.6 / ruling A-16)', () => {
  it('press fires one immediate attempt', () => {
    const r = new HoldRepeater();
    expect(r.press(0)).toBe(true);
  });

  it('no repeats before the 400ms hold threshold', () => {
    const r = new HoldRepeater();
    r.press(0);
    expect(r.update(ACTION_TIMING.HOLD_THRESHOLD_MS - 1)).toBe(0);
  });

  it('repeats every 280ms once held past the threshold', () => {
    const r = new HoldRepeater();
    r.press(0);
    expect(r.update(ACTION_TIMING.HOLD_THRESHOLD_MS)).toBe(1);
    expect(r.update(ACTION_TIMING.HOLD_THRESHOLD_MS + ACTION_TIMING.HOLD_REPEAT_MS - 1)).toBe(0);
    expect(r.update(ACTION_TIMING.HOLD_THRESHOLD_MS + ACTION_TIMING.HOLD_REPEAT_MS)).toBe(1);
  });

  it('release stops the beat', () => {
    const r = new HoldRepeater();
    r.press(0);
    r.release();
    expect(r.update(10_000)).toBe(0);
    expect(r.isHeld).toBe(false);
  });
});

describe('ActionBuffer (GDD §1.6: queue exactly one within the 150ms window)', () => {
  it('buffers a press inside the last 150ms of the lock', () => {
    const b = new ActionBuffer();
    b.offer(900, 1000); // 100ms before lock end
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false); // consumed
  });

  it('ignores presses earlier than the buffer window', () => {
    const b = new ActionBuffer();
    b.offer(700, 1000); // 300ms before lock end — outside 150ms window
    expect(b.take()).toBe(false);
  });

  it('never queues more than one', () => {
    const b = new ActionBuffer();
    b.offer(900, 1000);
    b.offer(950, 1000);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});
