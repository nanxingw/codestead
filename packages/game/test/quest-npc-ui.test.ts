/**
 * quest-npc-ui.test.ts (PRD 05 §B/§I) — pure projections owned by the NPC/UI
 * sub-task: topic→NPC routing, the §6.4 settings-row builder, and the §6.2
 * dialogue per-screen view. Render details (Phaser) carry no tests (sim discipline);
 * only the pure data the shell consumes is asserted.
 */
import { describe, expect, it } from 'vitest';

import type { Quest } from '@codestead/shared';

import {
  FALLBACK_NPC_ID,
  NPCS,
  pickChatter,
  routeTopicToNpc,
  type ChatterFarmView,
  type QuestTopicTag,
} from '../src/quest/npc-data.js';
import {
  buildQuestSettingRows,
  cycleQuestSetting,
  nextFrequency,
  type QuestSettingsViewModel,
} from '../src/quest/quest-settings-rows.js';
import { viewForScreen, type QuestDialogueHandle } from '../src/ui/panels/quest-dialogue-panel.js';
import type { QuestScreen, QuestUiEvent } from '../src/quest/quest-store.js';

// ---- topic routing (§1.1) ----

describe('routeTopicToNpc (§1.1)', () => {
  const cases: [QuestTopicTag, string][] = [
    ['architecture', 'npc_carpenter'],
    ['refactoring', 'npc_carpenter'],
    ['boundaries', 'npc_carpenter'],
    ['naming', 'npc_grocer'],
    ['api-design', 'npc_grocer'],
    ['interfaces', 'npc_grocer'],
    ['testing', 'npc_keeper'],
    ['edge-cases', 'npc_keeper'],
    ['reliability', 'npc_keeper'],
    ['debugging', 'npc_keeper'],
  ];
  it.each(cases)('routes %s → %s', (tag, npc) => {
    expect(routeTopicToNpc(tag)).toBe(npc);
  });

  it('falls back to 渠叔 for an unroutable / null topic', () => {
    expect(routeTopicToNpc(null)).toBe(FALLBACK_NPC_ID);
    expect(FALLBACK_NPC_ID).toBe('npc_keeper');
  });

  describe('pickChatter (§1.4) — local, zero-AI ambience lines', () => {
    const dry: ChatterFarmView = { rainedLastNight: false, anyCropMature: false, highLevel: false };
    const rainy: ChatterFarmView = { ...dry, rainedLastNight: true };

    it('returns a line from the villager for a real npcId', () => {
      const line = pickChatter('npc_keeper', dry, 0);
      expect(typeof line).toBe('string');
      expect(NPCS.find((n) => n.id === 'npc_keeper')?.chatter.some((c) => c.text === line)).toBe(
        true,
      );
    });

    it('gates rain-only lines: 渠叔 rain line is eligible only after rain', () => {
      const rainLine = '昨夜下了雨，今天渠水满的，你的地也不用浇了吧。';
      // After rain, rand≈0 hits the first eligible line, which is the rain line.
      expect(pickChatter('npc_keeper', rainy, 0)).toBe(rainLine);
      // On a dry day, no rain-gated line can be returned.
      const dryLines = new Set<string>();
      for (let r = 0; r < 1; r += 0.05) dryLines.add(pickChatter('npc_keeper', dry, r) ?? '');
      expect(dryLines.has(rainLine)).toBe(false);
    });

    it('rand≈1 clamps to the last eligible line (never out of bounds)', () => {
      expect(pickChatter('npc_carpenter', dry, 1)).not.toBeNull();
    });
  });

  it('every villager carries 8–10 local chatter lines (§1.4)', () => {
    for (const npc of NPCS) {
      expect(npc.chatter.length).toBeGreaterThanOrEqual(8);
      expect(npc.chatter.length).toBeLessThanOrEqual(10);
    }
  });
});

// ---- settings rows (§6.4) ----

function settingsVm(overrides: Partial<QuestSettingsViewModel> = {}): QuestSettingsViewModel {
  return {
    prefs: { enabled: true, frequency: 'low' },
    aiGeneration: false,
    dailyBudgetUsd: 1,
    arrivalSound: true,
    aiPathAvailable: true,
    aiUnavailableReason: null,
    showAiHint: false,
    notesLocation: '~/.codestead/notes/',
    ...overrides,
  };
}

describe('buildQuestSettingRows (§6.4)', () => {
  it('emits the §6.4 rows in order (no aiHint by default)', () => {
    const ids = buildQuestSettingRows(settingsVm()).map((r) => r.id);
    expect(ids).toEqual([
      'villagerTasks',
      'aiGeneration',
      'frequency',
      'dailyBudget',
      'arrivalSound',
      'notesLocation',
    ]);
  });

  it('greys the AI row with a reason when claude CLI is unavailable (§9)', () => {
    const rows = buildQuestSettingRows(
      settingsVm({ aiPathAvailable: false, aiUnavailableReason: '未检测到 claude CLI' }),
    );
    const ai = rows.find((r) => r.id === 'aiGeneration');
    expect(ai?.disabled).toBe(true);
    expect(ai?.disabledReason).toBe('未检测到 claude CLI');
  });

  it('AI row is enabled (toggleable) when the path is available', () => {
    const ai = buildQuestSettingRows(settingsVm()).find((r) => r.id === 'aiGeneration');
    expect(ai?.disabled).toBe(false);
    expect(ai?.disabledReason).toBeNull();
  });

  it('includes the §2.3 aiHint row ONLY when showAiHint is true', () => {
    expect(buildQuestSettingRows(settingsVm()).some((r) => r.id === 'aiHint')).toBe(false);
    const withHint = buildQuestSettingRows(settingsVm({ showAiHint: true }));
    expect(withHint[withHint.length - 1].id).toBe('aiHint');
  });

  it('frequency row shows the chosen档 text (two档 only, §6.4)', () => {
    expect(buildQuestSettingRows(settingsVm()).find((r) => r.id === 'frequency')?.value).toContain(
      '30',
    );
    expect(
      buildQuestSettingRows(settingsVm({ prefs: { enabled: true, frequency: 'normal' } })).find(
        (r) => r.id === 'frequency',
      )?.value,
    ).toContain('15');
  });

  it('villagerTasks / arrivalSound render 开/关; budget renders X.XX 美元', () => {
    const rows = buildQuestSettingRows(settingsVm({ arrivalSound: false, dailyBudgetUsd: 2.5 }));
    expect(rows.find((r) => r.id === 'villagerTasks')?.value).toBe('开');
    expect(rows.find((r) => r.id === 'arrivalSound')?.value).toBe('关');
    expect(rows.find((r) => r.id === 'dailyBudget')?.value).toBe('2.50 美元');
  });

  it('notesLocation is display-only and shows the本机 path', () => {
    const row = buildQuestSettingRows(settingsVm()).find((r) => r.id === 'notesLocation');
    expect(row?.disabled).toBe(true);
    expect(row?.value).toBe('~/.codestead/notes/');
  });
});

// ---- settings-page row cycling (§6.4, Story 33: toggles round-trip) ----

describe('cycleQuestSetting (§6.4 — game-scope rows round-trip)', () => {
  it('villagerTasks flips prefs.enabled and the row value follows', () => {
    const vm = settingsVm({ prefs: { enabled: true, frequency: 'low' } });
    const change = cycleQuestSetting('villagerTasks', vm);
    expect(change?.prefsPatch).toEqual({ enabled: false });
    // Apply the patch → the rebuilt row reflects 关.
    const next = settingsVm({ prefs: { ...vm.prefs, ...change?.prefsPatch } });
    expect(buildQuestSettingRows(next).find((r) => r.id === 'villagerTasks')?.value).toBe('关');
  });

  it('frequency cycles low ↔ normal (two档 only)', () => {
    expect(nextFrequency('low')).toBe('normal');
    expect(nextFrequency('normal')).toBe('low');
    const change = cycleQuestSetting('frequency', settingsVm());
    expect(change?.prefsPatch).toEqual({ frequency: 'normal' });
  });

  it('arrivalSound flips the arrival-sound preference', () => {
    expect(
      cycleQuestSetting('arrivalSound', settingsVm({ arrivalSound: true }))?.arrivalSound,
    ).toBe(false);
    expect(
      cycleQuestSetting('arrivalSound', settingsVm({ arrivalSound: false }))?.arrivalSound,
    ).toBe(true);
  });

  it('daemon-scope / display rows are NOT game-cycled (null change)', () => {
    for (const id of ['aiGeneration', 'dailyBudget', 'notesLocation', 'aiHint'] as const) {
      expect(cycleQuestSetting(id, settingsVm())).toBeNull();
    }
  });
});

// ---- dialogue view (§6.2) ----

function dquest(overrides: Partial<Quest> = {}): Quest {
  return {
    npcId: 'npc_keeper',
    kind: 'decision',
    title: '水往哪儿引',
    opener: '你那边在改登录的重试逻辑吧。',
    body: '登录失败之后，水往哪儿引？',
    options: [
      { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
      { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
    ],
    closer: '留口子，好习惯。',
    contextEcho: 'echo',
    questId: '7f3c9e2a-4b1d-4e02-9c1f-2a8d5e6f7a90',
    source: 'ai',
    relatedSessionId: null,
    relatedCwd: null,
    reward: { gold: 120, xp: 60 },
    createdAt: '2026-06-10T09:12:31Z',
    ...overrides,
  };
}

function handle(
  quest: Quest | null,
  screen: QuestScreen,
  selected: 'a' | 'b' | 'c' | 'd' | null = null,
): QuestDialogueHandle {
  return {
    quest: () => quest,
    screen: () => screen,
    selectedOption: () => selected,
    reward: () => null,
    emit: (_e: QuestUiEvent) => {},
  };
}

describe('viewForScreen (§6.2)', () => {
  it('opener屏 renders the opener verbatim + NPC display name', () => {
    const v = viewForScreen(handle(dquest(), 'opener'));
    expect(v.npcName).toBe('渠叔');
    expect(v.body).toBe('你那边在改登录的重试逻辑吧。');
    expect(v.textarea).toBe(false);
    expect(v.options).toBeUndefined();
  });

  it('decision question屏 carries body + option rows with tradeoffs', () => {
    const v = viewForScreen(handle(dquest(), 'question'));
    expect(v.body).toBe('登录失败之后，水往哪儿引？');
    expect(v.options).toEqual([
      { id: 'a', label: '指数退避重试', tradeoff: '雪崩时仍在打死下游' },
      { id: 'b', label: '立即熔断', tradeoff: '夜里没人值班就是全停' },
    ]);
    expect(v.textarea).toBe(false);
  });

  it('reflection question屏 has a textarea and no options', () => {
    const v = viewForScreen(handle(dquest({ kind: 'reflection', options: undefined }), 'question'));
    expect(v.textarea).toBe(true);
    expect(v.options).toBeUndefined();
  });

  it('compose屏 echoes the chosen option label and flags the textarea', () => {
    const v = viewForScreen(handle(dquest(), 'compose', 'a'));
    expect(v.body).toContain('指数退避重试');
    expect(v.textarea).toBe(true);
  });

  it('closer屏 renders the closer verbatim', () => {
    const v = viewForScreen(handle(dquest(), 'closer'));
    expect(v.body).toBe('留口子，好习惯。');
    expect(v.textarea).toBe(false);
  });

  it('null quest yields an inert empty view (panel is closing)', () => {
    const v = viewForScreen(handle(null, 'opener'));
    expect(v).toEqual({ npcName: '', body: '', textarea: false, footerKeys: [] });
  });

  it('opener/question carry a 先不聊 footer; compose offers Tab跳过; closer has neither (§6.2)', () => {
    // 第1/2屏: Esc 先不聊 (zero-cost dismiss, §2.1).
    for (const screen of ['opener', 'question'] as const) {
      expect(viewForScreen(handle(dquest(), screen)).footerKeys).toContain('quest.footer.dismiss');
    }
    // 第3屏 (compose, decision 补充): the answer is already chosen — Tab 跳过 / Ctrl+Enter 提交.
    const compose = viewForScreen(handle(dquest(), 'compose', 'a')).footerKeys;
    expect(compose).toContain('quest.footer.skip');
    expect(compose).not.toContain('quest.footer.dismiss');
    // 第4屏 (closer): only E 回去干活.
    expect(viewForScreen(handle(dquest(), 'closer')).footerKeys).not.toContain(
      'quest.footer.dismiss',
    );
  });

  it('NPC display name falls back to the raw id for an unknown villager', () => {
    // Force an off-roster id through the structural type to exercise the fallback.
    const v = viewForScreen(handle(dquest({ npcId: 'npc_carpenter' }), 'opener'));
    expect(v.npcName).toBe('老榆');
  });
});
