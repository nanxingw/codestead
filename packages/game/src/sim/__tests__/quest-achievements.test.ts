/**
 * Quest achievements #19/#20 light-up (PRD 05 §K US75; GDD §5.6).
 *
 * M4 "merely flips the milestone flag": the data rows for #19 first_quest
 * (questsCompleted ≥1, 0 XP — quest reward already paid) and #20 notebook
 * (notesWritten ≥10, +30 XP) already exist (PRD 02 data); M4 widens
 * UNLOCKABLE_MILESTONES to include 'M4' so the EXISTING engine lights them.
 *
 * These tests assert the END-TO-END light-up through the real sweep:
 *   grantQuestReward → questsCompleted++ → checkAchievements → #19 unlocked;
 *   recordNoteWritten ×10 → notesWritten=10 → checkAchievements → #20 unlocked (+30 XP).
 * No quest-specific engine code — just the §5.6 counter→predicate→sweep path.
 */
import { describe, expect, it } from 'vitest';

import type { QuestReward, SaveQuests } from '@codestead/shared';

import { checkAchievements, isUnlocked, UNLOCKABLE_MILESTONES } from '../achievements.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { grantQuestReward, recordNoteWritten } from '../quest-reward.js';
import { makeWorldState } from './fixtures.js';

const FRESH: SaveQuests = { grantedQuestIds: [], completedCount: 0, noteRefs: [] };
const AI_DECISION: QuestReward = { gold: 120, xp: 60 };

describe('milestone gate includes M4 (so #19/#20 may fire, US75)', () => {
  it('UNLOCKABLE_MILESTONES contains M4', () => {
    expect(UNLOCKABLE_MILESTONES.has('M4')).toBe(true);
  });

  it('the #19/#20 data rows exist and stay XP-correct (#19 = 0 XP, #20 = +30)', () => {
    const first = ACHIEVEMENTS.find((a) => a.id === 'first_quest');
    const notebook = ACHIEVEMENTS.find((a) => a.id === 'notebook');
    expect(first?.milestone).toBe('M4');
    expect(first?.reward).toEqual({ xp: 0, gold: 0 }); // quest reward already paid
    expect(notebook?.milestone).toBe('M4');
    expect(notebook?.reward).toEqual({ xp: 30, gold: 0 });
  });
});

describe('#19 first_quest — lights up on the first completed quest', () => {
  it('completing one quest bumps questsCompleted and unlocks #19 via the sweep', () => {
    const world = makeWorldState();
    const granted = grantQuestReward(world, FRESH, 'q1', AI_DECISION);
    expect(granted.state.progress.counters.questsCompleted).toBe(1);

    const swept = checkAchievements(granted.state);
    expect(isUnlocked(swept.state, 'first_quest')).toBe(true);
    // #19 grants 0 XP (the quest reward already paid the XP); the sweep emits the
    // unlock event but adds no extra XP/gold beyond it.
    const unlock = swept.events.find(
      (e) => e.type === 'AchievementUnlocked' && e.id === 'first_quest',
    );
    expect(unlock).toMatchObject({ xp: 0, gold: 0 });
  });

  it('does not unlock #19 before any quest is completed', () => {
    const swept = checkAchievements(makeWorldState());
    expect(isUnlocked(swept.state, 'first_quest')).toBe(false);
  });
});

describe('#20 notebook — lights up at the 10th thinking note (+30 XP)', () => {
  it('the 10th note crosses the threshold and unlocks #20 with +30 XP', () => {
    let world = makeWorldState();
    let quests = FRESH;
    for (let i = 1; i <= 9; i++) {
      const r = recordNoteWritten(world, quests, `2026-06-12/n${String(i)}.md`);
      world = r.state;
      quests = r.quests;
    }
    // 9 notes: not yet.
    expect(world.progress.counters.notesWritten).toBe(9);
    expect(isUnlocked(checkAchievements(world).state, 'notebook')).toBe(false);

    // 10th note crosses the threshold.
    const tenth = recordNoteWritten(world, quests, '2026-06-12/n10.md');
    expect(tenth.state.progress.counters.notesWritten).toBe(10);
    const swept = checkAchievements(tenth.state);
    expect(isUnlocked(swept.state, 'notebook')).toBe(true);
    const unlock = swept.events.find(
      (e) => e.type === 'AchievementUnlocked' && e.id === 'notebook',
    );
    expect(unlock).toMatchObject({ id: 'notebook', xp: 30 });
  });
});
