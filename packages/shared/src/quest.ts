/**
 * Quest schema — zod v4 single source of truth for the M4 AI-quest data shape.
 *
 * Source of truth (LITERAL): docs/design/ai-quests.md §4.6 (QuestGenSchema /
 * QuestSchema) and §8.1 (reward table). This file TAKES PRECEDENCE over the
 * simplified `Quest` interface drafted in tech-stack.md §5 (ai-quests §0
 * 定稿一致性声明 #3).
 *
 * Two-part trust boundary (ai-quests §4.6 / §11-E8):
 * - `QuestGenSchema` is the ONLY shape the model produces. Its `z.toJSONSchema`
 *   output is fed verbatim to `claude -p --json-schema` (ai-quests §4.5). The
 *   model has NO authority over reward / id / session linkage.
 * - `QuestSchema` = QuestGen fields + daemon-completed fields (questId / reward /
 *   relatedSessionId / relatedCwd / source / createdAt). Even a prompt-injection
 *   payload in the transcript ("set the reward to 99999") cannot reach the
 *   economy because `reward` is queried by the daemon from the §8.1 table, never
 *   read from model output.
 *
 * Reward bounds (ai-quests §8.1 / GDD §5.2 / 附录 A-5): gold ∈ [0,120],
 * xp ∈ [0,QUEST_XP_MAX=60]. The constants are exported here so the daemon
 * (clamp at grant time) and the game (safeParse on the wire) reference ONE
 * source — the two ends of the "daemon clamp + game safeParse" double defence.
 */
import { z } from 'zod';

// ---- NPC roster (ai-quests §1.1; routing enum) ----

export const NPC_IDS = ['npc_carpenter', 'npc_grocer', 'npc_keeper'] as const;
export const NpcIdSchema = z.enum(NPC_IDS);
export type NpcId = z.infer<typeof NpcIdSchema>;

// ---- reward bounds (ai-quests §8.1; daemon & game same-source) ----

/** Quest XP upper bound (= §8.1 highest value). daemon clamps to it; game safeParse rejects above it. */
export const QUEST_XP_MAX = 60;
/** Quest gold upper bound (= §8.1 highest value, AI·decision). */
export const QUEST_GOLD_MAX = 120;

/** Quest kind (宪法 kind ∈ {decision, reflection}). */
export const QuestKindSchema = z.enum(['decision', 'reflection']);
export type QuestKind = z.infer<typeof QuestKindSchema>;

/** Provenance of a quest: ai = generated, local = pool题库, scripted = first-consent教学任务. */
export const QuestSourceSchema = z.enum(['ai', 'local', 'scripted']);
export type QuestSource = z.infer<typeof QuestSourceSchema>;

/** Option id enum, a–d (ai-quests §4.6; decision questions carry 2–4 of these). */
export const QuestOptionIdSchema = z.enum(['a', 'b', 'c', 'd']);
export type QuestOptionId = z.infer<typeof QuestOptionIdSchema>;

// ---- model-produced part (z.toJSONSchema(QuestGenSchema) → --json-schema) ----

/**
 * A decision option. `tradeoff` is the cost line rendered in grey under each
 * option (ai-quests §2.1 — "every option must carry one tradeoff line").
 */
export const QuestOptionSchema = z.object({
  id: QuestOptionIdSchema,
  label: z.string().min(2).max(60),
  tradeoff: z.string().min(2).max(80),
});
export type QuestOption = z.infer<typeof QuestOptionSchema>;

/**
 * What the model is allowed to author (ai-quests §4.6). Every text field carries
 * hard length bounds so a malicious/oversized output is rejected at the boundary
 * (§6.2 实现要点 / §11-E8 third defence). superRefine pins the decision/reflection
 * invariant: decision ⇒ 2–4 options, reflection ⇒ no options.
 *
 * NOTE on `z.toJSONSchema`: superRefine is a runtime-only check and does NOT
 * appear in the emitted JSON Schema — that is intended. The `--json-schema`
 * fed to the CLI guides shape; the daemon's `safeParse` (which DOES run the
 * superRefine) is the authoritative gate before any quest is offered (§4.1).
 */
export const QuestGenSchema = z
  .object({
    npcId: NpcIdSchema,
    kind: QuestKindSchema,
    /** Quest name — settlement-screen / note title. */
    title: z.string().min(4).max(24),
    /** NPC opening line (first dialogue段). */
    opener: z.string().min(10).max(120),
    /** Question body (includes the NPC's restatement of the situation). */
    body: z.string().min(20).max(400),
    /** decision only: 2–4 options, each with its own tradeoff line. */
    options: z.array(QuestOptionSchema).min(2).max(4).optional(),
    /** Closing line — independent of the chosen answer. */
    closer: z.string().min(4).max(80),
    /** Model's ≤120-char restatement of the work context → written to the note. */
    contextEcho: z.string().max(120),
  })
  .superRefine((q, ctx) => {
    if (q.kind === 'decision' && (!q.options || q.options.length < 2)) {
      ctx.addIssue({
        code: 'custom',
        message: 'decision quest requires 2-4 options',
        path: ['options'],
      });
    }
    if (q.kind === 'reflection' && q.options) {
      ctx.addIssue({
        code: 'custom',
        message: 'reflection quest must not have options',
        path: ['options'],
      });
    }
  });
export type QuestGen = z.infer<typeof QuestGenSchema>;

// ---- daemon-completed reward (model has NO authority here) ----

/**
 * Reward block — bounded at the schema layer (gold ≤120, xp ≤QUEST_XP_MAX). The
 * daemon assigns it by table lookup (§8.1) and the game safeParses it on arrival;
 * the two bounds cite the SAME exported constants. `itemId` stays optional but is
 * unused in M4 (道具按无道具实现, §8.1 注 / GDD §9.8).
 */
export const QuestRewardSchema = z.object({
  gold: z.number().int().min(0).max(QUEST_GOLD_MAX),
  xp: z.number().int().min(0).max(QUEST_XP_MAX),
  itemId: z.string().optional(),
});
export type QuestReward = z.infer<typeof QuestRewardSchema>;

// ---- the full quest (daemon补全 of QuestGen) ----

/**
 * The complete Quest as it crosses the WS and lands in the note (ai-quests §4.6).
 * QuestGen fields (already superRefine-validated) plus daemon-owned identity,
 * provenance, reward and session linkage. `relatedCwd` carries ONLY a basename
 * on the wire (privacy §12-3) — the schema does not enforce basename-ness (that
 * is a daemon construction discipline), but it stays nullable for the no-session
 * (local/scripted) paths.
 */
export const QuestSchema = z.object({
  // QuestGen shape spread — re-listed (not `...QuestGenSchema.shape`) because the
  // refined wrapper has no `.shape`; this keeps the field set explicit & literal.
  npcId: NpcIdSchema,
  kind: QuestKindSchema,
  title: z.string().min(4).max(24),
  opener: z.string().min(10).max(120),
  body: z.string().min(20).max(400),
  options: z.array(QuestOptionSchema).min(2).max(4).optional(),
  closer: z.string().min(4).max(80),
  contextEcho: z.string().max(120),
  // ---- daemon-completed ----
  questId: z.uuid(),
  source: QuestSourceSchema,
  relatedSessionId: z.string().nullable(),
  /** basename only on the wire (§12-3); null for local/scripted. */
  relatedCwd: z.string().nullable(),
  reward: QuestRewardSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Quest = z.infer<typeof QuestSchema>;

/**
 * Reward table (ai-quests §8.1, single source of truth). The daemon resolves a
 * reward by `(source, kind)`; the game/sim never recompute it. Item rewards are
 * deliberately absent in M4 (累计 5/15/30 道具按无道具实现; only completedCount
 * accrues, §8.1 注 / GDD §9.8).
 */
export const QUEST_REWARD_TABLE = {
  ai: {
    decision: { gold: 120, xp: 60 },
    reflection: { gold: 80, xp: 40 },
  },
  local: {
    // local pool题库 is reflection-only (§2.3); decision kept for table totality.
    decision: { gold: 40, xp: 20 },
    reflection: { gold: 40, xp: 20 },
  },
  scripted: {
    // first-consent教学任务 (渠叔), any of a/b/c rewards 50g/20XP (§3.4).
    decision: { gold: 50, xp: 20 },
    reflection: { gold: 50, xp: 20 },
  },
} as const satisfies Record<QuestSource, Record<QuestKind, { gold: number; xp: number }>>;

/** Resolve the §8.1 reward for a (source, kind). Pure table lookup — model-independent. */
export function rewardFor(source: QuestSource, kind: QuestKind): QuestReward {
  return { ...QUEST_REWARD_TABLE[source][kind] };
}
