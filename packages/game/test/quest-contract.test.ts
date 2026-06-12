/**
 * Game-side quest CONTRACT test (PRD 05) — pins the load-bearing data the
 * implementation sub-tasks must not drift: the three NPC personas/topics, their
 * map-anchor ids (which MUST exist in farm-map-meta `npcAnchors`, §13), the
 * frequency→interval mapping and default prefs (factory 'low'=30min, §6.4 /
 * 附录 A-23), and the four-屏 screen vocabulary (§6.2). Behaviour (the reducer
 * bodies) is skeleton until its sub-task — only contracts are asserted here.
 */
import { describe, expect, it } from 'vitest';

import farmMapMeta from '../src/sim/data/farm-map-meta.json';
import {
  DEFAULT_QUEST_PREFS,
  FALLBACK_NPC_ID,
  NPCS,
  NPCS_BY_ID,
  frequencyToInterval,
} from '../src/quest/index.js';

describe('NPC roster (ai-quests §1.1)', () => {
  it('ships exactly the three M4 villagers with the documented topics', () => {
    expect(NPCS.map((n) => n.id)).toEqual(['npc_carpenter', 'npc_grocer', 'npc_keeper']);
    expect(NPCS_BY_ID.get('npc_carpenter')?.topics).toEqual(
      expect.arrayContaining(['architecture', 'refactoring', 'boundaries']),
    );
    expect(NPCS_BY_ID.get('npc_grocer')?.topics).toEqual(
      expect.arrayContaining(['naming', 'api-design', 'interfaces']),
    );
    expect(NPCS_BY_ID.get('npc_keeper')?.topics).toEqual(
      expect.arrayContaining(['testing', 'edge-cases', 'reliability', 'debugging']),
    );
  });

  it('routes unclassifiable topics to 渠叔 (fallback, §1.1)', () => {
    expect(FALLBACK_NPC_ID).toBe('npc_keeper');
  });

  it('every NPC anchorId exists in the map npcAnchors (no hardcoded mismatch, §13)', () => {
    const anchorIds = new Set(
      (farmMapMeta as { npcAnchors: { id: string }[] }).npcAnchors.map((a) => a.id),
    );
    for (const npc of NPCS) {
      expect(anchorIds.has(npc.anchorId)).toBe(true);
    }
    // The three personas land on the §1.1 站位 anchors.
    expect(NPCS_BY_ID.get('npc_carpenter')?.anchorId).toBe('carpenter_bench');
    expect(NPCS_BY_ID.get('npc_grocer')?.anchorId).toBe('market_stall');
    expect(NPCS_BY_ID.get('npc_keeper')?.anchorId).toBe('pond_sluice');
  });

  it('each villager carries at least one local chatter line (zero-AI ambience, §1.4)', () => {
    for (const npc of NPCS) expect(npc.chatter.length).toBeGreaterThanOrEqual(1);
  });
});

describe('quest prefs / frequency档 (ai-quests §6.4 / 附录 A-23)', () => {
  it('defaults to enabled + low档 (factory ≥30 min, double the constitutional floor)', () => {
    expect(DEFAULT_QUEST_PREFS).toEqual({ enabled: true, frequency: 'low' });
  });

  it('maps the two档 to the only legal wire intervals (no higher frequency)', () => {
    expect(frequencyToInterval('low')).toBe(30);
    expect(frequencyToInterval('normal')).toBe(15);
  });
});
