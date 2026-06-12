/**
 * UI stack invariant tests (GDD §6.5): `depth() > 0 ⇔ sources() non-empty`, mutual
 * panel exclusion, and the pauseMenu → settings nesting path. Pure model — no Phaser.
 */
import { describe, expect, it } from 'vitest';

import { PANEL_PAUSE_SOURCE, UiStackModel, type UiPanelId } from '../src/ui/ui-stack';

const ALL_PANELS = Object.keys(PANEL_PAUSE_SOURCE) as UiPanelId[];

describe('UiStackModel', () => {
  it('holds the pause invariant: depth > 0 ⇔ sources non-empty', () => {
    const stack = new UiStackModel();
    expect(stack.depth()).toBe(0);
    expect(stack.sources().size).toBe(0);
    for (const id of ALL_PANELS) {
      stack.push(id);
      expect(stack.depth()).toBeGreaterThan(0);
      expect(stack.sources().size).toBeGreaterThan(0);
      stack.clear();
      expect(stack.sources().size).toBe(0);
    }
  });

  it('rejects opening a second unrelated panel (one panel at a time)', () => {
    const stack = new UiStackModel();
    expect(stack.push('shop')).toBe(true);
    expect(stack.push('inventory')).toBe(false);
    expect(stack.push('shippingBin')).toBe(false);
    expect(stack.top()).toBe('shop');
  });

  it('allows settings / keysHelp nested on the pause menu only', () => {
    const stack = new UiStackModel();
    expect(stack.push('pauseMenu')).toBe(true);
    expect(stack.push('settings')).toBe(true);
    expect(stack.top()).toBe('settings');
    expect(stack.pop()).toBe('settings');
    expect(stack.push('keysHelp')).toBe(true);
    stack.clear();
    expect(stack.push('inventory')).toBe(true);
    expect(stack.push('settings')).toBe(false);
  });

  it('nests 会话面板 and 村民与 AI 任务 sub-pages on settings (and nothing else)', () => {
    const stack = new UiStackModel();
    stack.push('pauseMenu');
    stack.push('settings');
    // 设置 → 村民与 AI 任务 (M4, ai-quests §6.4) nests on settings.
    expect(stack.push('questSettings')).toBe(true);
    expect(stack.top()).toBe('questSettings');
    expect([...stack.sources()]).toEqual(['menu']); // sub-page is still a 'menu' source
    expect(stack.pop()).toBe('questSettings');
    // 会话面板 (M2) likewise nests on settings.
    expect(stack.push('sessionSettings')).toBe(true);
    expect(stack.pop()).toBe('sessionSettings');
    // questSettings does NOT open from an empty stack's non-settings parent.
    stack.clear();
    stack.push('inventory');
    expect(stack.push('questSettings')).toBe(false);
  });

  it('maps panels onto the §2.4 pause-source vocabulary', () => {
    const stack = new UiStackModel();
    stack.push('pauseMenu');
    expect([...stack.sources()]).toEqual(['menu']);
    stack.push('settings');
    expect([...stack.sources()]).toEqual(['menu']);
    stack.clear();
    stack.push('daySummary');
    expect([...stack.sources()]).toEqual(['day_summary']);
    stack.clear();
    stack.push('shop');
    expect([...stack.sources()]).toEqual(['dialog']);
  });
});
