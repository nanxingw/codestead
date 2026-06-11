/**
 * time-driver.ts — the render-side fixed-step driver (GDD §2.8, pure / Phaser-free).
 *
 * The sim has NO notion of real time: this driver consumes frame deltas, clamps them
 * (ACCUMULATOR_CLAMP_MS), and calls `step()` once per whole game minute
 * (REAL_MS_PER_GAME_MINUTE). Pause is driver-side: while the Set<PauseSource> is
 * non-empty the sim is simply not ticked — no partial time scale, no fast-forward
 * (GDD §2.4). Wall-clock use here (AFK timing via frame deltas) is on the §2.4
 * real-time whitelist.
 *
 * 22:00 boundary contract: the driver always advances minute-by-minute so the day end
 * can never be stepped over; when the NEXT minute would cross DAY_END and the player
 * is mid-action, stepping holds until the action completes (≤250ms, GDD §1.10 #7).
 * A step returning 'halt' (DayEnded fired) discards the accumulator remainder.
 */
import { TIME } from '../sim/data/constants';
import type { PauseSource } from '../sim/types';

export type StepResult = 'continue' | 'halt';

export interface TimeDriverOptions {
  /** Advance the sim by exactly 1 game minute; return 'halt' on DayEnded. */
  step: () => StepResult;
  /** True when the next minute would cross 22:00 (facade-side state check). */
  isAtDayEnd?: () => boolean;
  /** True while the player is mid-action (Acting) — defers the 22:00 crossing. */
  shouldHoldDayEnd?: () => boolean;
  onPause?: (sources: ReadonlySet<PauseSource>) => void;
  onResume?: () => void;
}

export class TimeDriver {
  private accumulatorMs = 0;
  private idleMs = 0;
  private readonly sources = new Set<PauseSource>();

  constructor(private readonly opts: TimeDriverOptions) {}

  /** Any user input: clears the AFK timer and the 'afk' source (GDD §2.4). */
  noteInput(): void {
    this.idleMs = 0;
    this.remove('afk');
  }

  add(source: PauseSource): void {
    const wasPaused = this.paused;
    this.sources.add(source);
    if (!wasPaused && this.paused) this.opts.onPause?.(this.sources);
  }

  remove(source: PauseSource): void {
    const wasPaused = this.paused;
    this.sources.delete(source);
    if (wasPaused && !this.paused) this.opts.onResume?.();
  }

  has(source: PauseSource): boolean {
    return this.sources.has(source);
  }

  get paused(): boolean {
    return this.sources.size > 0;
  }

  get pauseSources(): ReadonlySet<PauseSource> {
    return this.sources;
  }

  /** Dropped on NIGHT_TRANSITION (GDD §2.8) and on restore. */
  discardAccumulator(): void {
    this.accumulatorMs = 0;
  }

  /** Per-frame tick. `deltaMs` is the raw frame delta (clamped here, GDD §2.1). */
  update(deltaMs: number): void {
    if (!this.paused) {
      this.idleMs += deltaMs;
      if (this.idleMs >= TIME.AFK_PAUSE_AFTER_MS) this.add('afk');
    }
    if (this.paused) return;

    this.accumulatorMs += Math.min(deltaMs, TIME.ACCUMULATOR_CLAMP_MS);
    while (this.accumulatorMs >= TIME.REAL_MS_PER_GAME_MINUTE) {
      if (this.opts.isAtDayEnd?.() === true && this.opts.shouldHoldDayEnd?.() === true) {
        // Hold the crossing; cap stored time so the wait doesn't fast-forward later.
        this.accumulatorMs = Math.min(this.accumulatorMs, TIME.ACCUMULATOR_CLAMP_MS);
        return;
      }
      this.accumulatorMs -= TIME.REAL_MS_PER_GAME_MINUTE;
      if (this.opts.step() === 'halt') {
        this.accumulatorMs = 0;
        return;
      }
      if (this.paused) return; // a step handler may have pushed a pause source
    }
  }
}
