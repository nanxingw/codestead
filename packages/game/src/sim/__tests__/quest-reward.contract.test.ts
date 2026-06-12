/**
 * quest-reward contract test (PRD 05 §K, seam a) — the load-bearing pure helper
 * `clampQuestReward` (the second leg of the §4.6 double defence), and the
 * idempotent grant / note-record commands (A9 economy-unbreakable). Asserts the
 * external behaviour only: wallet/xp/counter deltas, idempotency on questId /
 * noteRef, and that quest gold rides the `credit` faucet (not the goldEarned
 * sales counter, not the shipping bin).
 */
import { QUEST_GOLD_MAX, QUEST_XP_MAX, type QuestReward, type SaveQuests } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { clampQuestReward, grantQuestReward, recordNoteWritten } from '../quest-reward.js';
import { makeWorldState } from './fixtures.js';

const FRESH_QUESTS: SaveQuests = { grantedQuestIds: [], completedCount: 0, noteRefs: [] };
const AI_DECISION: QuestReward = { gold: 120, xp: 60 };

describe('clampQuestReward (defence-in-depth, ai-quests §4.6 / GDD §5.2)', () => {
  it('passes through an in-bounds reward unchanged', () => {
    expect(clampQuestReward({ gold: 120, xp: 60 })).toEqual({ gold: 120, xp: 60 });
    expect(clampQuestReward({ gold: 0, xp: 0 })).toEqual({ gold: 0, xp: 0 });
    expect(clampQuestReward({ gold: 80, xp: 40 })).toEqual({ gold: 80, xp: 40 });
  });

  it('clamps an over-bound gold/xp to the shared ceilings (cannot mint out-of-band)', () => {
    expect(clampQuestReward({ gold: 99999, xp: 9999 })).toEqual({
      gold: QUEST_GOLD_MAX,
      xp: QUEST_XP_MAX,
    });
  });

  it('floors negatives at 0 and truncates fractions', () => {
    expect(clampQuestReward({ gold: -5, xp: -1 })).toEqual({ gold: 0, xp: 0 });
    expect(clampQuestReward({ gold: 40.9, xp: 20.9 })).toEqual({ gold: 40, xp: 20 });
  });

  it('pins the shared bounds it defends', () => {
    expect(QUEST_GOLD_MAX).toBe(120);
    expect(QUEST_XP_MAX).toBe(60);
  });
});

describe('grantQuestReward (idempotent faucet, §K / A9)', () => {
  it('credits gold to the wallet and xp through the level pipeline on a fresh grant', () => {
    const state = makeWorldState({
      economy: { gold: 100, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    const r = grantQuestReward(state, FRESH_QUESTS, 'q1', AI_DECISION);

    expect(r.granted).toBe(true);
    expect(r.state.economy.gold).toBe(220); // 100 + 120, instant wallet credit
    expect(r.state.progress.xp).toBe(60); // through grantXpInPlace
    expect(r.quests.grantedQuestIds).toEqual(['q1']);
    expect(r.quests.completedCount).toBe(1);
    expect(r.state.progress.counters.questsCompleted).toBe(1);
    // gold faucet: emits GoldChanged, never touches the shipping bin or goldEarned.
    expect(r.events).toContainEqual({ type: 'GoldChanged', gold: 220, delta: 120 });
    expect(r.state.economy.shippingBin).toEqual([]);
    expect(r.state.progress.counters.goldEarned ?? 0).toBe(0);
  });

  it('is a byte-identical no-op on a replayed questId (reconnect / import / roll-back)', () => {
    const state = makeWorldState();
    const first = grantQuestReward(state, FRESH_QUESTS, 'q1', AI_DECISION);
    const replay = grantQuestReward(first.state, first.quests, 'q1', AI_DECISION);

    expect(replay.granted).toBe(false);
    expect(replay.events).toEqual([]);
    // SAME references — no clone, no double-credit (A9).
    expect(replay.state).toBe(first.state);
    expect(replay.quests).toBe(first.quests);
    expect(replay.state.economy.gold).toBe(first.state.economy.gold);
    expect(replay.quests.completedCount).toBe(1);
    expect(replay.state.progress.counters.questsCompleted).toBe(1);
  });

  it('clamps an out-of-band reward before crediting (second defence leg)', () => {
    const state = makeWorldState({
      economy: { gold: 0, shippingBin: [], collectionLog: {}, newEntriesSeenDay: {} },
    });
    const r = grantQuestReward(state, FRESH_QUESTS, 'evil', { gold: 99999, xp: 9999 });
    expect(r.state.economy.gold).toBe(QUEST_GOLD_MAX);
    expect(r.state.progress.xp).toBe(QUEST_XP_MAX);
  });

  it('a zero reward still completes the quest (counter rises, no gold/xp events)', () => {
    const state = makeWorldState();
    const r = grantQuestReward(state, FRESH_QUESTS, 'q0', { gold: 0, xp: 0 });
    expect(r.granted).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.quests.completedCount).toBe(1);
    expect(r.state.progress.counters.questsCompleted).toBe(1);
  });
});

describe('recordNoteWritten (notesWritten faucet, §K / #20 / E11)', () => {
  it('records a fresh noteRef and bumps notesWritten', () => {
    const state = makeWorldState();
    const r = recordNoteWritten(state, FRESH_QUESTS, '2026-06-12/q1.md');
    expect(r.recorded).toBe(true);
    expect(r.quests.noteRefs).toEqual(['2026-06-12/q1.md']);
    expect(r.state.progress.counters.notesWritten).toBe(1);
  });

  it('is idempotent on the ref (a re-sync of the same note cannot inflate #20)', () => {
    const state = makeWorldState();
    const first = recordNoteWritten(state, FRESH_QUESTS, '2026-06-12/q1.md');
    const replay = recordNoteWritten(first.state, first.quests, '2026-06-12/q1.md');
    expect(replay.recorded).toBe(false);
    expect(replay.state).toBe(first.state);
    expect(replay.quests).toBe(first.quests);
    expect(replay.state.progress.counters.notesWritten).toBe(1);
  });

  it('is decoupled from reward granting (a note write moves #20 even with no reward)', () => {
    // §11-E11: note exists on disk, reward withheld — notesWritten still rises,
    // questsCompleted does NOT (no grant happened).
    const state = makeWorldState();
    const r = recordNoteWritten(state, FRESH_QUESTS, 'note-only.md');
    expect(r.state.progress.counters.notesWritten).toBe(1);
    expect(r.state.progress.counters.questsCompleted ?? 0).toBe(0);
  });
});
