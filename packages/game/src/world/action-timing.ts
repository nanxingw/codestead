/**
 * action-timing.ts — press / hold-to-repeat attempt scheduling (GDD §1.6, ruling A-16;
 * pure / Phaser-free). All numbers come from ACTION_TIMING.
 *
 * Semantics (M1-core): pressing fires one attempt immediately; holding ≥400ms enters
 * the 280ms repeat beat against the CURRENT target tile; invalid targets are skipped
 * by the caller WITHOUT resetting the beat (the beat is purely time-based here).
 * M1-core scope ruling (PRD 01 Implementation Decision 4): wood-tier single-tile
 * semantics for ALL tiers — copper/gold range preview + batch is M1.5.
 *
 * The 250ms action lock / 120ms effect landing / 150ms input buffer live in the
 * player controller + scene (they need animation timing); this class only decides
 * WHEN an attempt is due.
 */
import { ACTION_TIMING } from '../sim/data/constants';

export class HoldRepeater {
  private heldSince: number | null = null;
  private nextBeatAt = Number.POSITIVE_INFINITY;

  /** Key/button went down. Returns true: one immediate attempt is due. */
  press(nowMs: number): boolean {
    this.heldSince = nowMs;
    this.nextBeatAt = nowMs + ACTION_TIMING.HOLD_THRESHOLD_MS;
    return true;
  }

  release(): void {
    this.heldSince = null;
    this.nextBeatAt = Number.POSITIVE_INFINITY;
  }

  get isHeld(): boolean {
    return this.heldSince !== null;
  }

  /**
   * Per-frame poll while the input is held. Returns the number of repeat attempts due
   * this frame (0 or 1 — repeats never batch up across a slow frame; the beat simply
   * continues from now).
   */
  update(nowMs: number): number {
    if (this.heldSince === null) return 0;
    if (nowMs < this.nextBeatAt) return 0;
    this.nextBeatAt = nowMs + ACTION_TIMING.HOLD_REPEAT_MS;
    return 1;
  }
}

/**
 * One-slot input buffer (GDD §1.6: actions pressed while Acting queue exactly one,
 * within the 150ms buffer window before the lock ends).
 */
export class ActionBuffer {
  private buffered = false;

  /** A press arrived while an action lock runs until `lockEndsAtMs`. */
  offer(nowMs: number, lockEndsAtMs: number): void {
    if (lockEndsAtMs - nowMs <= ACTION_TIMING.INPUT_BUFFER_MS) this.buffered = true;
  }

  /** Consume the buffered attempt (called when the lock ends). */
  take(): boolean {
    const had = this.buffered;
    this.buffered = false;
    return had;
  }

  clear(): void {
    this.buffered = false;
  }
}
