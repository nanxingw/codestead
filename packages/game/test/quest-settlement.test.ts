/**
 * quest-settlement.test.ts (PRD 05 §I / ai-quests §6.3, Story 25) — the day-summary
 * 「明日预告」 villager-quest line. PURE: the panel renders the string this builder
 * returns. Asserts the line appears IFF a quest is pending, carries the villager
 * displayName + standing-place描述, and is absent (null) when none is pending —
 * append-only, NEVER a popup (§3.5).
 */
import { describe, expect, it } from 'vitest';

import type { Quest } from '@codestead/shared';

import { questSettlementLine } from '../src/quest/quest-settlement.js';
import { t } from '../src/ui/strings.js';

function quest(npcId: Quest['npcId']): Quest {
  return {
    npcId,
    kind: 'reflection',
    title: '村民的问题',
    opener: '渠叔放下斗笠。',
    body: '今天写的代码里，哪一处你其实没想清楚就先写了？',
    closer: '想好了再答。',
    contextEcho: '',
    questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
    source: 'local',
    relatedSessionId: null,
    relatedCwd: null,
    reward: { gold: 40, xp: 20 },
    createdAt: '2026-06-11T09:12:31Z',
  };
}

describe('questSettlementLine (§6.3 / Story 25)', () => {
  it('returns null when no quest is pending (line absent)', () => {
    expect(questSettlementLine(null, t)).toBeNull();
  });

  it('renders 🌾 {npc}在{place}，想听听你的想法 for a pending 渠叔 quest', () => {
    const line = questSettlementLine(quest('npc_keeper'), t);
    expect(line).toBe('🌾 渠叔在水渠边，想听听你的想法');
  });

  it('uses each villager displayName + standing-place描述', () => {
    expect(questSettlementLine(quest('npc_carpenter'), t)).toBe(
      '🌾 老榆在木工台旁，想听听你的想法',
    );
    expect(questSettlementLine(quest('npc_grocer'), t)).toBe('🌾 阿穗在杂货摊，想听听你的想法');
  });

  it('the template references the real string key (not a stray fallback)', () => {
    // If the key were missing, t() would echo the key — assert it resolved.
    expect(t('quest.settlement.pending')).not.toBe('quest.settlement.pending');
  });
});
