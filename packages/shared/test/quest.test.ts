/**
 * Quest schema + quest protocol contract tests (PRD 05 testing seam b).
 *
 * Pins the ai-quests §4.6 / §4.7 contracts: QuestGen/Quest accept/reject the
 * documented shapes, reward bounds hold (gold ≤120, xp ≤QUEST_XP_MAX), the
 * decision/reflection invariant is enforced, the seven new WS frames survive a
 * JSON roundtrip and slot into the existing discriminated unions, and the
 * `z.toJSONSchema(QuestGenSchema)` output (fed to `--json-schema`) is snapshot-
 * pinned against drift.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  ClientMessageSchema,
  NPC_IDS,
  PROTOCOL_VERSION,
  QUEST_GOLD_MAX,
  QUEST_REWARD_TABLE,
  QUEST_XP_MAX,
  QuestGenSchema,
  QuestSchema,
  ServerMessageSchema,
  rewardFor,
  type ClientMessage,
  type Quest,
  type ServerMessage,
} from '../src/index.js';

const roundtrip = (m: unknown): unknown => JSON.parse(JSON.stringify(m));

const validDecisionGen = {
  npcId: 'npc_keeper' as const,
  kind: 'decision' as const,
  title: '登录失败往哪引',
  opener: '你那边在改登录的重试逻辑吧。补漏之前，先想清楚水从哪儿来。',
  body: '登录失败之后，水往哪儿引？是退避重试、立即熔断，还是降级到只读？',
  options: [
    {
      id: 'a' as const,
      label: '指数退避重试，封顶 5 次',
      tradeoff: '瞬时故障友好，但雪崩时仍打死下游',
    },
    { id: 'b' as const, label: '立即熔断，亮灯等人', tradeoff: '保护下游，但夜里没人值班就是全停' },
  ],
  closer: '嗯，留口子，好习惯。渠也是这么修的。',
  contextEcho: '正在为登录服务设计失败重试策略，纠结重试与熔断的边界',
};

const validReflectionGen = {
  npcId: 'npc_carpenter' as const,
  kind: 'reflection' as const,
  title: '承重墙是哪堵',
  opener: '拆这堵墙，房子靠什么站着？',
  body: '当前的方案里，最让你不安的那个假设是什么？把它讲清楚。',
  closer: '想明白了再动手，地基才稳。',
  contextEcho: '正在重构一个模块的依赖方向',
};

const fullQuest: Quest = {
  ...validDecisionGen,
  questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
  source: 'ai',
  relatedSessionId: '53b273d5-9f1c-467b-aa8f-46f816bf61ef',
  relatedCwd: 'payments',
  reward: { gold: 120, xp: 60 },
  createdAt: '2026-06-10T09:12:31Z',
};

describe('QuestGenSchema (model-produced shape, ai-quests §4.6)', () => {
  it('accepts a valid decision quest', () => {
    expect(QuestGenSchema.safeParse(validDecisionGen).success).toBe(true);
  });

  it('accepts a valid reflection quest (no options)', () => {
    expect(QuestGenSchema.safeParse(validReflectionGen).success).toBe(true);
  });

  it('rejects a decision quest with fewer than 2 options', () => {
    const bad = { ...validDecisionGen, options: [validDecisionGen.options[0]] };
    expect(QuestGenSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a decision quest with more than 4 options', () => {
    const opt = validDecisionGen.options[0];
    const bad = { ...validDecisionGen, options: [opt, opt, opt, opt, opt] };
    expect(QuestGenSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a reflection quest that carries options', () => {
    const bad = { ...validReflectionGen, options: validDecisionGen.options };
    expect(QuestGenSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown npcId', () => {
    expect(QuestGenSchema.safeParse({ ...validDecisionGen, npcId: 'npc_mayor' }).success).toBe(
      false,
    );
  });

  it('rejects over-length text fields (boundary hardening, §6.2/§11-E8)', () => {
    expect(QuestGenSchema.safeParse({ ...validReflectionGen, title: 'x'.repeat(25) }).success).toBe(
      false,
    );
    expect(QuestGenSchema.safeParse({ ...validReflectionGen, body: 'x'.repeat(401) }).success).toBe(
      false,
    );
    expect(
      QuestGenSchema.safeParse({ ...validReflectionGen, contextEcho: 'x'.repeat(121) }).success,
    ).toBe(false);
  });

  it('rejects an option label/tradeoff beyond bounds', () => {
    const bad = {
      ...validDecisionGen,
      options: [
        { id: 'a', label: 'x'.repeat(61), tradeoff: 'ok cost' },
        validDecisionGen.options[1],
      ],
    };
    expect(QuestGenSchema.safeParse(bad).success).toBe(false);
  });
});

describe('QuestSchema (daemon-completed shape, ai-quests §4.6)', () => {
  it('accepts a full quest through a JSON roundtrip', () => {
    const parsed = QuestSchema.safeParse(roundtrip(fullQuest));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(fullQuest);
  });

  it('accepts a local/scripted quest with null session linkage', () => {
    const local: Quest = {
      ...validReflectionGen,
      questId: '00000000-0000-4000-8000-000000000001',
      source: 'local',
      relatedSessionId: null,
      relatedCwd: null,
      reward: { gold: 40, xp: 20 },
      createdAt: '2026-06-10T09:12:31Z',
    };
    expect(QuestSchema.safeParse(local).success).toBe(true);
  });

  it('rejects a reward over the gold bound (model has no authority — last-line defence)', () => {
    const bad = { ...fullQuest, reward: { gold: 99999, xp: 60 } };
    expect(QuestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a reward over the xp bound (QUEST_XP_MAX)', () => {
    const bad = { ...fullQuest, reward: { gold: 120, xp: QUEST_XP_MAX + 1 } };
    expect(QuestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-uuid questId and a non-ISO createdAt', () => {
    expect(QuestSchema.safeParse({ ...fullQuest, questId: 'not-a-uuid' }).success).toBe(false);
    expect(QuestSchema.safeParse({ ...fullQuest, createdAt: 'yesterday' }).success).toBe(false);
  });
});

describe('reward table (ai-quests §8.1)', () => {
  it('pins the documented bounds and values', () => {
    expect(QUEST_XP_MAX).toBe(60);
    expect(QUEST_GOLD_MAX).toBe(120);
    expect(rewardFor('ai', 'decision')).toEqual({ gold: 120, xp: 60 });
    expect(rewardFor('ai', 'reflection')).toEqual({ gold: 80, xp: 40 });
    expect(rewardFor('local', 'reflection')).toEqual({ gold: 40, xp: 20 });
    expect(rewardFor('scripted', 'reflection')).toEqual({ gold: 50, xp: 20 });
  });

  it('every table reward stays within the schema bounds', () => {
    const sources = ['ai', 'local', 'scripted'] as const;
    const kinds = ['decision', 'reflection'] as const;
    for (const source of sources) {
      for (const kind of kinds) {
        const r = rewardFor(source, kind);
        expect(r.gold).toBeLessThanOrEqual(QUEST_GOLD_MAX);
        expect(r.xp).toBeLessThanOrEqual(QUEST_XP_MAX);
      }
    }
    // QUEST_REWARD_TABLE is the same source rewardFor reads (keep both referenced).
    expect(QUEST_REWARD_TABLE.ai.decision).toEqual({ gold: 120, xp: 60 });
  });

  it('rewardFor returns a fresh object (no shared mutable reference)', () => {
    const a = rewardFor('ai', 'decision');
    a.gold = 0;
    expect(rewardFor('ai', 'decision').gold).toBe(120);
  });

  it('exposes the three NPC ids', () => {
    expect(NPC_IDS).toEqual(['npc_carpenter', 'npc_grocer', 'npc_keeper']);
  });
});

describe('quest WS frames roundtrip (ai-quests §4.7, additive — no version bump)', () => {
  it.each<[string, ServerMessage]>([
    ['questSnapshot (0 pending)', { v: 1, type: 'questSnapshot', payload: { quests: [] } }],
    [
      'questSnapshot (1 pending)',
      { v: 1, type: 'questSnapshot', payload: { quests: [fullQuest] } },
    ],
    ['questOffer', { v: 1, type: 'questOffer', payload: { quest: fullQuest } }],
    ['questRevoked', { v: 1, type: 'questRevoked', payload: { questId: fullQuest.questId } }],
    [
      'questReward',
      {
        v: 1,
        type: 'questReward',
        payload: { questId: fullQuest.questId, reward: { gold: 120, xp: 60 } },
      },
    ],
  ])('%s (daemon→game)', (_label, message) => {
    const parsed = ServerMessageSchema.safeParse(roundtrip(message));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(message);
  });

  it.each<[string, ClientMessage]>([
    [
      'questAnswer (decision)',
      {
        v: 1,
        type: 'questAnswer',
        payload: { questId: fullQuest.questId, optionId: 'a', note: '留口子' },
      },
    ],
    [
      'questAnswer (reflection, no option)',
      { v: 1, type: 'questAnswer', payload: { questId: fullQuest.questId, note: '想清楚再动手' } },
    ],
    ['questDismiss', { v: 1, type: 'questDismiss', payload: { questId: fullQuest.questId } }],
    [
      'clientPrefs (low档 30min)',
      {
        v: 1,
        type: 'clientPrefs',
        payload: { quests: { enabled: true, minIntervalRealMinutes: 30 } },
      },
    ],
    [
      'clientPrefs (normal档 15min)',
      {
        v: 1,
        type: 'clientPrefs',
        payload: { quests: { enabled: true, minIntervalRealMinutes: 15 } },
      },
    ],
  ])('%s (game→daemon)', (_label, message) => {
    const parsed = ClientMessageSchema.safeParse(roundtrip(message));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(message);
  });

  it('rejects clientPrefs with an out-of-range interval (only 15/30 are legal)', () => {
    const bad = roundtrip({
      v: 1,
      type: 'clientPrefs',
      payload: { quests: { enabled: true, minIntervalRealMinutes: 5 } },
    });
    expect(ClientMessageSchema.safeParse(bad).success).toBe(false);
  });

  it('does not bump PROTOCOL_VERSION for the additive quest frames', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('z.toJSONSchema(QuestGenSchema) is stable (fed to --json-schema)', () => {
  it('matches the pinned snapshot so schema drift is loud', () => {
    expect(z.toJSONSchema(QuestGenSchema)).toMatchSnapshot();
  });
});
