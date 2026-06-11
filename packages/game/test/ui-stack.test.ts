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
