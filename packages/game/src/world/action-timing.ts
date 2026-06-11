/**
 * action-timing.ts — press / hold-to-repeat / hold-to-charge attempt scheduling
 * (GDD §1.6, ruling A-16; pure / Phaser-free). All numbers come from ACTION_TIMING.
 *
 * Two hold semantics (A-16 语义分档):
 * - HoldRepeater — pressing fires one attempt immediately; holding ≥400ms enters the
 *   280ms repeat beat against the CURRENT target tile; invalid targets are skipped by
 *   the caller WITHOUT resetting the beat (the beat is purely time-based here). Used
 *   by the wood hoe, the watering can at ALL tiers, and every non-tool action.
 * - HoldCharge (M1.5) — copper/gold HOE only: pressing arms a charge and fires
 *   NOTHING; releasing before the 400ms threshold is a tap (single tile, §3.5 轻按
 *   永远 1 格), releasing at/after it is the batch over the previewed range. cancel()
 *   models the 22:00 / modal interruption: preview dropped, nothing executes, zero
 *   penalty (GDD §3.9 #4).
 *
 * The 250ms action lock / 120ms effect landing / 150ms input buffer live in the
 * player controller + scene (they need animation timing); these classes only decide
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

/** Outcome of releasing a charge: nothing armed / tap (<400ms) / batch (≥400ms). */
export type ChargeRelease = 'none' | 'tap' | 'batch';

/**
 * Copper/gold hoe hold-to-charge (ruling A-16; see header). The caller polls
 * isCharging() to drive the range preview and calls release() on the input edge;
 * cancel() drops the charge silently (22:00 sleep boundary, modal opening, hotbar
 * slot switch — §3.9 #4 防误锄: nothing fires unless the player deliberately releases).
 */
export class HoldCharge {
  private heldSince: number | null = null;

  /** Key/button went down. Arms the charge; nothing fires yet. */
  press(nowMs: number): void {
    this.heldSince = nowMs;
  }

  get isHeld(): boolean {
    return this.heldSince !== null;
  }

  /** Past the 400ms threshold → the range preview is showing (GDD §1.6/A-16). */
  isCharging(nowMs: number): boolean {
    return this.heldSince !== null && nowMs - this.heldSince >= ACTION_TIMING.HOLD_THRESHOLD_MS;
  }

  /** Input edge went up. Idempotent: a second release reports 'none'. */
  release(nowMs: number): ChargeRelease {
    if (this.heldSince === null) return 'none';
    const charged = this.isCharging(nowMs);
    this.heldSince = null;
    return charged ? 'batch' : 'tap';
  }

  /** Interrupted (22:00 / modal / slot switch): preview cancelled, nothing executes. */
  cancel(): void {
    this.heldSince = null;
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
