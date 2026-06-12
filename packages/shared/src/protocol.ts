/**
 * WebSocket protocol skeleton — envelope + non-quest message shapes.
 *
 * Source of truth: docs/design/tech-stack.md §5 (aligned with docs/design/hud-sessions.md §10.4).
 * Quest messages (M4, PRD 05): the seven frames of ai-quests §4.7 are added below
 * WITHOUT bumping PROTOCOL_VERSION (additive evolution rule). Their data shape lives
 * in quest.ts (single source of truth, ai-quests §4.6).
 *
 * Evolution rules (tech-stack §5):
 * - Additive, backward-compatible changes (new message types, new optional fields) do NOT
 *   bump the version — e.g. `heartbeat` was added this way, and the M4 quest frames too.
 * - Breaking changes bump both the envelope `v` literal and PROTOCOL_VERSION.
 */
import { z } from 'zod';

import { QuestRewardSchema, QuestSchema, QuestOptionIdSchema } from './quest.js';
import { SessionInfoSchema } from './session.js';

export const PROTOCOL_VERSION = 1;

/**
 * Heartbeat cadence (hud-sessions §10.3 P1, §8.1): daemon sends `heartbeat`
 * every 25s; the client treats 75s (3 missed periods) without ANY message as
 * stale data (HUD enters STALE — keep data, dim, append “数据可能过期”).
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_STALE_MS = 75_000;

/*
 * NOTE — there is deliberately NO error frame in this protocol.
 * hud-sessions §10.1 defines the complete M2 message set (5 + 1 below).
 * Rejections are expressed out-of-band:
 * - bad/missing auth token, disallowed Origin → daemon closes the connection;
 * - protocol mismatch → client compares `hello.payload.protocol` and enters
 *   INCOMPATIBLE (hud-sessions §8.1);
 * - hook POSTs always get an EMPTY 2xx, never a decision field (tech-stack §4.1-1).
 */

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

/**
 * game → daemon: answer to an offered quest (ai-quests §4.7). `optionId` present
 * for decision answers, absent for reflection; `note` is the player's optional
 * free text (decision 补充 / reflection 正文). The note flows IN (player → daemon
 * → local note file) — it is never sent OUT; this is the only inward content path
 * (§12-3). The daemon accepts exactly one OFFERED→ANSWERED transition (§11-E7).
 */
export const QuestAnswerMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questAnswer'),
  payload: z.object({
    questId: z.string(),
    optionId: QuestOptionIdSchema.optional(),
    note: z.string().optional(),
  }),
});
export type QuestAnswerMessage = z.infer<typeof QuestAnswerMessageSchema>;

/** game → daemon: "先不聊" (ai-quests §4.7). Zero-cost dismiss; never a penalty (§5). */
export const QuestDismissMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questDismiss'),
  payload: z.object({ questId: z.string() }),
});
export type QuestDismissMessage = z.infer<typeof QuestDismissMessageSchema>;

/**
 * game → daemon: client quest preferences (ai-quests §4.7). Sent after connect
 * and on every settings change; the daemon takes the STRICTER of this and its own
 * config (出题间隔 only two档 → minIntervalRealMinutes ∈ {15,30}, no higher
 * frequency). When the daemon does not understand this frame, the game falls back
 * to dropping `questOffer` locally by its own `enabled` switch (§4.7 / GDD §10.7).
 */
export const ClientPrefsMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('clientPrefs'),
  payload: z.object({
    quests: z.object({
      enabled: z.boolean(),
      minIntervalRealMinutes: z.union([z.literal(15), z.literal(30)]),
    }),
  }),
});
export type ClientPrefsMessage = z.infer<typeof ClientPrefsMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  AuthMessageSchema,
  QuestAnswerMessageSchema,
  QuestDismissMessageSchema,
  ClientPrefsMessageSchema,
]);
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

/**
 * daemon → game: full quest snapshot on connect/reconnect (ai-quests §4.7). The
 * array holds 0 or 1 quest (global pending ≤1, T2); restart recovery re-pushes an
 * OFFERED quest here (§5 / §11-E3). Two tabs both receive it (broadcast, §11-E7).
 */
export const QuestSnapshotMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questSnapshot'),
  payload: z.object({ quests: z.array(QuestSchema) }),
});
export type QuestSnapshotMessage = z.infer<typeof QuestSnapshotMessageSchema>;

/** daemon → game: a new quest arrived (ai-quests §4.7). Game shows ONLY a 💬 bubble. */
export const QuestOfferMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questOffer'),
  payload: z.object({ quest: QuestSchema }),
});
export type QuestOfferMessage = z.infer<typeof QuestOfferMessageSchema>;

/**
 * daemon → game: a quest was revoked (ai-quests §4.7 / §3.5). ONLY two sources:
 * player dismiss, or 总开关关闭 clearing the field. NEVER time-based (零焦虑).
 */
export const QuestRevokedMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questRevoked'),
  payload: z.object({ questId: z.string() }),
});
export type QuestRevokedMessage = z.infer<typeof QuestRevokedMessageSchema>;

/**
 * daemon → game: reward to credit for an answered quest (ai-quests §4.7). The game
 * grants idempotently keyed on questId (grantedQuestIds, §5 / §11-E4) so reconnect
 * replays and save imports never double-credit.
 */
export const QuestRewardMessageSchema = z.object({
  v: versionLiteral,
  type: z.literal('questReward'),
  payload: z.object({ questId: z.string(), reward: QuestRewardSchema }),
});
export type QuestRewardMessage = z.infer<typeof QuestRewardMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SnapshotMessageSchema,
  SessionUpsertMessageSchema,
  SessionRemovedMessageSchema,
  HeartbeatMessageSchema,
  QuestSnapshotMessageSchema,
  QuestOfferMessageSchema,
  QuestRevokedMessageSchema,
  QuestRewardMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Any protocol message (either direction). Inbound data must go through `safeParse`. */
export const ProtocolMessageSchema = z.union([ClientMessageSchema, ServerMessageSchema]);
export type ProtocolMessage = z.infer<typeof ProtocolMessageSchema>;
