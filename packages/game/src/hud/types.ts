/**
 * HUD store types — pure data, ZERO Phaser and ZERO sim imports (enforced by
 * ESLint no-restricted-imports; hud-sessions §13-5, PRD 03 US61). The render
 * shell lives in the UIScene side and only READS this store.
 *
 * Two machines live here:
 * 1. the connection state machine (hud-sessions §8.1 — pure reducer,
 *    table-driven testable);
 * 2. the session display table (server-authoritative: the HUD performs NO
 *    semantic state transitions — §8.3; display-layer jitter merging only).
 */
import type { SessionInfo } from '@codestead/shared';

import type { HudSettings } from './settings.js';

// ---- Connection state machine (hud-sessions §8.1) ----

export type ConnectionPhase =
  | 'connecting'
  | 'handshaking'
  | 'live'
  | 'stale'
  | 'backoff'
  | 'incompatible';

/**
 * Input alphabet — exactly the edges of the §8.1 diagram.
 * All timer events are produced by the WS client (injected timers); the
 * reducer itself never reads a clock.
 */
export type ConnectionEvent =
  | { readonly kind: 'wsOpen' } // CONNECTING → HANDSHAKING (client sends auth)
  | { readonly kind: 'wsClose' } // any → BACKOFF
  | { readonly kind: 'wsError' } // any → BACKOFF
  | { readonly kind: 'connectTimeout' } // 10s without open → BACKOFF
  | { readonly kind: 'helloOk'; readonly daemonVersion: string } // protocol matched
  | { readonly kind: 'protoMismatch'; readonly daemonProtocol: number } // → INCOMPATIBLE (5min slow retry)
  | { readonly kind: 'snapshotReceived' } // HELLO_OK + SNAPSHOT completes → LIVE
  | { readonly kind: 'anyMessage'; readonly at: number } // refreshes liveness; STALE → LIVE
  | { readonly kind: 'heartbeatTimeout' } // 75s without any message → STALE
  | { readonly kind: 'retryTimer' }; // BACKOFF/INCOMPATIBLE timer fired → CONNECTING

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /** Consecutive failures — drives the backoff ladder (reset on LIVE). */
  readonly attempt: number;
  /** True once `hello` with a matching protocol arrived in this connection. */
  readonly gotHello: boolean;
  /** Shown in the settings page (§8.1 INCOMPATIBLE row, US39). */
  readonly daemonVersion: string | null;
  /**
   * Daemon-side protocol number from a mismatched `hello` (additive field):
   * the settings page shows both version numbers in INCOMPATIBLE (US39, §11-6).
   */
  readonly daemonProtocol: number | null;
  /** Epoch ms of the last received message; null before first. */
  readonly lastMessageAt: number | null;
}

// ---- Whole-HUD state ----

/** Per-session restraint cooldowns — KEPT across reconnects so a daemon restart never triggers a highlight storm (§8.1). */
export interface SessionCooldown {
  /** Last 600ms row-highlight, epoch ms (8s per-session cooldown, §6.1). */
  readonly lastHighlightAt: number | null;
  /** Last sound trigger, epoch ms (global 20s cooldown also applies, §3.4). */
  readonly lastSoundAt: number | null;
}

export interface HudState {
  readonly conn: ConnectionState;
  /** §8.2 gate: false ⇒ render NOTHING anywhere but the settings page. */
  readonly everConnected: boolean;
  /** Server-authoritative table; replaced wholesale by each snapshot. */
  readonly sessions: ReadonlyMap<string, SessionInfo>;
  /** Upserts/removes BEFORE the first snapshot of a connection are dropped (§8.1). */
  readonly hasSnapshot: boolean;
  readonly cooldowns: ReadonlyMap<string, SessionCooldown>;
  readonly settings: HudSettings;
}

// ---- Derived/display types ----

/** Sort tuple (§5.1): stateRank asc → since asc → sessionId asc. */
export const STATE_RANK = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
} as const;

/** Day-end “会话一行” feed (§4.6): counts by state; renderer belongs to day-cycle. */
export type SessionStateCounts = Readonly<Record<keyof typeof STATE_RANK, number>>;

/** Overflow plan (§5.2): rows to show + `+N 个会话` row; blocked is NEVER folded (hard cap 9 rows). */
export interface OverflowPlan {
  readonly visible: readonly SessionInfo[];
  readonly overflowCount: number;
  /** Tooltip list for the overflow row, capped at 12 entries (§11-12). */
  readonly overflowPreview: readonly SessionInfo[];
}
