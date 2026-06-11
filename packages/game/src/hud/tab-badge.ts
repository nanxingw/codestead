/**
 * tabBadge — the ONE passive out-of-game cue (hud-sessions §6.1): while a
 * blocked session exists AND the tab is hidden, the browser tab title gets a
 * plain-text `● ` prefix. Deliberately NO Notification API (anti-pattern 3),
 * one-key off (§9 `tabBadge`). Pure string math here; the render shell
 * applies the result to document.title.
 */

export const TAB_BADGE_PREFIX = '● ';

/** Strip any existing badge so repeated applications stay idempotent. */
export function stripTabBadge(title: string): string {
  return title.startsWith(TAB_BADGE_PREFIX) ? title.slice(TAB_BADGE_PREFIX.length) : title;
}

/**
 * Compute the tab title: prefix only when the setting is on, a blocked
 * session exists, and the document is hidden (§6.1 trigger row). Idempotent.
 */
export function computeTabTitle(
  currentTitle: string,
  opts: { hasBlocked: boolean; tabBadgeEnabled: boolean; documentHidden: boolean },
): string {
  const base = stripTabBadge(currentTitle);
  const badged = opts.tabBadgeEnabled && opts.hasBlocked && opts.documentHidden;
  return badged ? `${TAB_BADGE_PREFIX}${base}` : base;
}
