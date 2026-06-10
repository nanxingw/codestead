/**
 * WebSocket protocol skeleton — envelope + non-quest message shapes.
 *
 * Source of truth: docs/design/tech-stack.md §5 (aligned with docs/design/hud-sessions.md §10.4).
 * Scope (M0, PRD 00): shapes only. Semantic validation and protocol evolution belong to
 * M2 (PRD 03). Quest messages (questOffer / questAnswer / …) belong to M4 (PRD 05) and
 * are intentionally absent here until then.
 *
 * Evolution rules (tech-stack §5):
 * - Additive, backward-compatible changes (new message types, new optional fields) do NOT
 *   bump the version — e.g. `heartbeat` was added this way.
 * - Breaking changes bump both the envelope `v` literal and PROTOCOL_VERSION.
 */
import { z } from 'zod';

import { SessionInfoSchema } from './session.js';

export const PROTOCOL_VERSION = 1;

/** Envelope shape: every frame is `{ v: 1, type, payload }` (JSON text frames). */
const versionLiteral = z.literal(PROTOCOL_VERSION);

// ---- game -> daemon ----

/** First message after connecting; token comes from `GET /handshake` (hud-sessions §10.3 P2). */
export const AuthMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('auth'),
  payload: z.object({ token: z.string() }),
});
export type AuthMessage = z.infer<typeof AuthMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [AuthMessageSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- daemon -> game ----

export const HelloMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('hello'),
  payload: z.object({
    protocol: versionLiteral,
    daemonVersion: z.string(),
  }),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** Full session list, sent once after successful auth. */
export const SnapshotMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('snapshot'),
  payload: z.object({ sessions: z.array(SessionInfoSchema) }),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;

/** Incremental upsert of a single session. */
export const SessionUpsertMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('sessionUpsert'),
  payload: z.object({ session: SessionInfoSchema }),
});
export type SessionUpsertMessage = z.infer<typeof SessionUpsertMessageSchema>;

export const SessionRemovedMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('sessionRemoved'),
  payload: z.object({ sessionId: z.string() }),
});
export type SessionRemovedMessage = z.infer<typeof SessionRemovedMessageSchema>;

/** Every 25s; client treats 75s of silence as stale data (hud-sessions §8.1). */
export const HeartbeatMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('heartbeat'),
  payload: z.object({ at: z.iso.datetime({ offset: true }) }),
});
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SnapshotMessageSchema,
  SessionUpsertMessageSchema,
  SessionRemovedMessageSchema,
  HeartbeatMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Any protocol message (either direction). Inbound data must go through `safeParse`. */
export const ProtocolMessageSchema = z.union([ClientMessageSchema, ServerMessageSchema]);
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
