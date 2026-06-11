import { describe, expect, it } from 'vitest';

import { ACTION_TIMING } from '../../src/sim/data/constants';
import { ActionBuffer, HoldCharge, HoldRepeater } from '../../src/world/action-timing';

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

describe('HoldCharge (ruling A-16: copper/gold hoe charge, M1.5)', () => {
  const T = ACTION_TIMING.HOLD_THRESHOLD_MS;

  it('press fires nothing; release before 400ms is a single-tile tap (§3.5 轻按)', () => {
    const c = new HoldCharge();
    c.press(0);
    expect(c.isHeld).toBe(true);
    expect(c.release(T - 1)).toBe('tap');
    expect(c.isHeld).toBe(false);
  });

  it('release at/after the 400ms threshold is the previewed batch', () => {
    const c = new HoldCharge();
    c.press(100);
    expect(c.release(100 + T)).toBe('batch');
  });

  it('isCharging turns true exactly at the threshold (drives the range preview)', () => {
    const c = new HoldCharge();
    c.press(0);
    expect(c.isCharging(T - 1)).toBe(false);
    expect(c.isCharging(T)).toBe(true);
  });

  it('cancel (22:00 / modal, GDD §3.9 #4) drops the charge — nothing fires', () => {
    const c = new HoldCharge();
    c.press(0);
    c.cancel();
    expect(c.isHeld).toBe(false);
    expect(c.isCharging(10_000)).toBe(false);
    expect(c.release(10_000)).toBe('none');
  });

  it('release is idempotent: a second release reports none', () => {
    const c = new HoldCharge();
    c.press(0);
    expect(c.release(T)).toBe('batch');
    expect(c.release(T + 1)).toBe('none');
  });

  it('re-press after release re-arms from the new press time', () => {
    const c = new HoldCharge();
    c.press(0);
    c.release(50);
    c.press(1_000);
    expect(c.isCharging(1_000 + T - 1)).toBe(false);
    expect(c.release(1_000 + T - 1)).toBe('tap');
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
