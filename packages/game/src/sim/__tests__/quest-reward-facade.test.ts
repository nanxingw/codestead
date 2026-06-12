/**
 * SimApi quest-reward facade (PRD 05 §K integration; A9). The pure grant lives in
 * quest-reward.ts (tested in quest-reward.contract.test.ts); THIS verifies the
 * facade wiring the integrator added: applyQuestReward / recordQuestNote run through
 * the sim, credit the wallet, emit events to subscribers, run the achievement sweep
 * (#19/#20), and stay idempotent on questId / noteRef.
 *
 * The economy-unbreakable contract through the facade:
 *  - a daemon reward credits gold/XP ONCE per questId (reconnect replays no-op);
 *  - quest gold goes to the wallet (GoldChanged emitted), never the shipping bin;
 *  - the first completed quest lights #19 智者 via the sweep;
 *  - the 10th thinking note lights #20 思考的痕迹 (+30 XP).
 */
import { describe, expect, it } from 'vitest';

import type { QuestReward } from '@codestead/shared';

import { newGameSim, type SimApi } from '../sim.js';
import type { SimEvent } from '../types.js';
import { TEST_MAP } from './fixtures.js';

const AI_DECISION: QuestReward = { gold: 120, xp: 60 };

function freshSim(seed: string): SimApi {
  // Game entry point ⇒ achievements ON so #19/#20 can fire through the sweep.
  return newGameSim(seed, TEST_MAP, { achievements: true });
}

function capture(sim: SimApi): SimEvent[] {
  const events: SimEvent[] = [];
  sim.on((e) => events.push(e));
  return events;
}

describe('SimApi.applyQuestReward — facade wiring (A9)', () => {
  it('credits gold + XP, emits GoldChanged, and lights #19 on the first quest', () => {
    const sim = freshSim('quest-reward-1');
    const goldBefore = sim.state.economy.gold;
    const events = capture(sim);

    sim.applyQuestReward('q1', AI_DECISION);

    expect(sim.state.economy.gold).toBe(goldBefore + 120);
    expect(events.some((e) => e.type === 'GoldChanged')).toBe(true);
    expect(sim.state.progress.counters.questsCompleted).toBe(1);
    // #19 first_quest fires through the sweep (game-entry achievements ON).
    expect(events.some((e) => e.type === 'AchievementUnlocked' && e.id === 'first_quest')).toBe(
      true,
    );
  });

  it('is idempotent on questId: a replay credits nothing and emits no events', () => {
    const sim = freshSim('quest-reward-2');
    sim.applyQuestReward('q1', AI_DECISION);
    const goldAfterFirst = sim.state.economy.gold;
    const completedAfterFirst = sim.state.progress.counters.questsCompleted;

    const events = capture(sim);
    const replayed = sim.applyQuestReward('q1', AI_DECISION); // same questId

    expect(replayed).toEqual([]); // no events from the no-op
    expect(events).toEqual([]); // nothing reached subscribers
    expect(sim.state.economy.gold).toBe(goldAfterFirst);
    expect(sim.state.progress.counters.questsCompleted).toBe(completedAfterFirst);
  });

  it('quest gold does NOT bump the goldEarned sales counter (PRD 02 decision 4)', () => {
    const sim = freshSim('quest-reward-3');
    const earnedBefore = sim.state.progress.counters.goldEarned ?? 0;
    sim.applyQuestReward('q1', AI_DECISION);
    expect(sim.state.progress.counters.goldEarned ?? 0).toBe(earnedBefore);
  });
});

describe('SimApi.recordQuestNote — #20 思考的痕迹 (decoupled from reward)', () => {
  it('the 10th distinct note lights #20 with +30 XP via the sweep', () => {
    const sim = freshSim('quest-note-1');
    const events = capture(sim);

    for (let i = 1; i <= 10; i++) sim.recordQuestNote(`2026-06-12/n${String(i)}.md`);

    expect(sim.state.progress.counters.notesWritten).toBe(10);
    const unlock = events.find((e) => e.type === 'AchievementUnlocked' && e.id === 'notebook');
    expect(unlock).toMatchObject({ id: 'notebook', xp: 30 });
  });

  it('is idempotent on noteRef: re-recording the same ref does nothing', () => {
    const sim = freshSim('quest-note-2');
    sim.recordQuestNote('n1.md');
    const after = sim.state.progress.counters.notesWritten;
    const events = capture(sim);
    expect(sim.recordQuestNote('n1.md')).toEqual([]);
    expect(events).toEqual([]);
    expect(sim.state.progress.counters.notesWritten).toBe(after);
  });
});
