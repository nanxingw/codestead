/**
 * codex-model.ts — pure pagination model for the 图鉴 panel (M3, GDD §4.8/§5.8;
 * PRD 04 US49/US50). Phaser-free, tested in test/codex-model.test.ts.
 *
 * Data source is sim/codex.buildCodexView (collectionLog recorded since M1); this
 * module only groups the rows into category pages for the Esc-menu tab. Sold rows
 * show icon + first-sold day; unsold rows render as silhouettes (panel side).
 */
import { buildCodexView, type CodexEntry } from '../../sim/codex';
import type { ItemCategory } from '../../sim/data/items';
import type { WorldState } from '../../sim/types';

/** Page order: the §6.1 category order restricted to codex-eligible categories. */
export const CODEX_PAGE_CATEGORIES: readonly ItemCategory[] = ['crop', 'artisan_good', 'material'];

export interface CodexPage {
  category: ItemCategory;
  entries: readonly CodexEntry[];
  collected: number;
}

export interface CodexPagesView {
  pages: readonly CodexPage[];
  collected: number;
  total: number;
}

export function codexPages(state: Readonly<WorldState>): CodexPagesView {
  const view = buildCodexView(state.economy.collectionLog);
  const pages = CODEX_PAGE_CATEGORIES.map((category) => {
    const entries = view.entries.filter((e) => e.category === category);
    return {
      category,
      entries,
      collected: entries.filter((e) => e.firstSoldDay !== null).length,
    };
  }).filter((page) => page.entries.length > 0);
  return { pages, collected: view.collected, total: view.total };
}

/** Clamp helper for the page cursor (wraps left/right like the hotbar wheel). */
export function cyclePage(current: number, delta: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return (current + delta + pageCount) % pageCount;
}
