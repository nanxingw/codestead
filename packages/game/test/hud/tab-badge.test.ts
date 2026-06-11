/**
 * tabBadge pure math (hud-sessions §6.1): the ONE passive out-of-game cue —
 * a plain-text `● ` title prefix while a blocked session exists AND the tab
 * is hidden AND the setting is on. No Notification API (anti-pattern 3).
 */
import { describe, expect, it } from 'vitest';

import { computeTabTitle, stripTabBadge, TAB_BADGE_PREFIX } from '../../src/hud/tab-badge.js';

const ON = { hasBlocked: true, tabBadgeEnabled: true, documentHidden: true };

describe('computeTabTitle (hud-sessions §6.1)', () => {
  it('pins the plain-text prefix', () => {
    expect(TAB_BADGE_PREFIX).toBe('● ');
  });

  it('badges only when ALL THREE hold: setting on, blocked exists, tab hidden', () => {
    expect(computeTabTitle('Codestead', ON)).toBe('● Codestead');
    expect(computeTabTitle('Codestead', { ...ON, hasBlocked: false })).toBe('Codestead');
    expect(computeTabTitle('Codestead', { ...ON, tabBadgeEnabled: false })).toBe('Codestead');
    expect(computeTabTitle('Codestead', { ...ON, documentHidden: false })).toBe('Codestead');
  });

  it('is idempotent: re-applying never stacks prefixes', () => {
    const once = computeTabTitle('Codestead', ON);
    expect(computeTabTitle(once, ON)).toBe('● Codestead');
  });

  it('removes an existing badge when any condition drops (blocked resolved / tab visible / setting off)', () => {
    expect(computeTabTitle('● Codestead', { ...ON, hasBlocked: false })).toBe('Codestead');
    expect(computeTabTitle('● Codestead', { ...ON, documentHidden: false })).toBe('Codestead');
    expect(computeTabTitle('● Codestead', { ...ON, tabBadgeEnabled: false })).toBe('Codestead');
  });

  it('stripTabBadge leaves unbadged titles untouched (including ● without the space)', () => {
    expect(stripTabBadge('Codestead')).toBe('Codestead');
    expect(stripTabBadge('●Codestead')).toBe('●Codestead');
    expect(stripTabBadge('● Codestead')).toBe('Codestead');
    expect(stripTabBadge('')).toBe('');
  });
});
