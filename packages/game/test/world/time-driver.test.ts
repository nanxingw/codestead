import { describe, expect, it } from 'vitest';

import { TIME } from '../../src/sim/data/constants';
import { TimeDriver, type StepResult } from '../../src/world/time-driver';

function makeDriver(overrides?: {
  stepResult?: () => StepResult;
  isAtDayEnd?: () => boolean;
  shouldHoldDayEnd?: () => boolean;
}) {
  let steps = 0;
  const driver = new TimeDriver({
    step: () => {
      steps++;
      return overrides?.stepResult?.() ?? 'continue';
    },
    isAtDayEnd: overrides?.isAtDayEnd,
    shouldHoldDayEnd: overrides?.shouldHoldDayEnd,
  });
  return { driver, steps: () => steps };
}

describe('TimeDriver (GDD §2.8)', () => {
  it('steps once per whole game minute (187.5ms)', () => {
    const { driver, steps } = makeDriver();
    driver.update(TIME.REAL_MS_PER_GAME_MINUTE - 0.5);
    expect(steps()).toBe(0);
    driver.update(0.5);
    expect(steps()).toBe(1);
  });

  it('clamps a single frame delta to 250ms (sleep/throttle recovery)', () => {
    const { driver, steps } = makeDriver();
    driver.update(60_000); // a minute-long frame gap
    expect(steps()).toBe(1); // 250ms clamp ⇒ only one 187.5ms step fits
  });

  it('does not step while any pause source is active, with no catch-up after', () => {
    const { driver, steps } = makeDriver();
    driver.add('menu');
    driver.update(10_000);
    expect(steps()).toBe(0);
    driver.remove('menu');
    driver.update(0);
    expect(steps()).toBe(0); // paused frames never accumulate
  });

  it('AFK after 90s without input; any input clears it (GDD §2.4)', () => {
    const { driver } = makeDriver();
    driver.update(TIME.AFK_PAUSE_AFTER_MS);
    expect(driver.has('afk')).toBe(true);
    driver.noteInput();
    expect(driver.has('afk')).toBe(false);
  });

  it('a halt step (DayEnded) discards the accumulator remainder', () => {
    const { driver, steps } = makeDriver({ stepResult: () => 'halt' });
    driver.update(200); // enough for 1 step + remainder
    expect(steps()).toBe(1);
    driver.update(180); // remainder must have been discarded
    expect(steps()).toBe(1);
  });

  it('holds the 22:00 crossing while the player is acting (GDD §1.10 #7)', () => {
    let acting = true;
    const { driver, steps } = makeDriver({
      isAtDayEnd: () => true,
      shouldHoldDayEnd: () => acting,
    });
    driver.update(200);
    expect(steps()).toBe(0); // crossing deferred
    acting = false;
    driver.update(0);
    expect(steps()).toBe(1); // action finished → the minute lands
  });

  it('pause/resume callbacks fire on the empty↔non-empty edges only', () => {
    let paused = 0;
    let resumed = 0;
    const driver = new TimeDriver({
      step: () => 'continue',
      onPause: () => paused++,
      onResume: () => resumed++,
    });
    driver.add('menu');
    driver.add('dialog');
    expect(paused).toBe(1);
    driver.remove('menu');
    expect(resumed).toBe(0);
    driver.remove('dialog');
    expect(resumed).toBe(1);
  });
});
