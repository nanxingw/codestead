/**
 * codex.ts — collection log ("图鉴") read model (M3, GDD §4.8/§5.7; PRD 04 §H49~50).
 *
 * The codex is a PASSIVE collection view, never a task list: its single data source is
 * `economy.collectionLog` (recorded since M1 by settleShipping's first-sale bookkeeping
 * — §4.2); entries light up event-driven at settlement, no manual registration.
 *
 * Pure selector over the item table: every sellable, bin-eligible item is a codex row
 * (crops, materials, eggs, artisan goods — seeds are refund-only and excluded, ruling
 * A-11; tools/quest items have no sellPrice). Unsold rows render as silhouettes; sold
 * rows show the icon + first-sold day (PRD 04 US49). UI form factor: an Esc-menu tab
 * following the achievements-page conventions (§5.8) under the §11.3 pixel rules —
 * visual detail is the implementer's, this module is the data contract.
 */
import { ITEMS, type ItemDef } from './data/items.js';

export interface CodexEntry {
  readonly itemId: string;
  readonly nameKey: string;
  readonly iconFrame: string;
  readonly category: ItemDef['category'];
  /** Game day of the first sale; null = not yet sold (silhouette row). */
  readonly firstSoldDay: number | null;
}

export interface CodexView {
  readonly entries: readonly CodexEntry[];
  readonly collected: number;
  readonly total: number;
}

/** Items that count as codex rows: sellable through the shipping bin (see header). */
export function codexEligibleItems(): readonly ItemDef[] {
  return ITEMS.filter((def) => def.sellPrice !== undefined && def.category !== 'seed');
}

/**
 * ⚠ SUSPENDED (待图鉴定稿 — GDD §9 quest-milestone table): the cumulative
 * 5 / 15 / 30 quest-completion rewards name three item forms — seed packs
 * (`seed_pack_t{1..3}`), the "沉思的稻草人" decoration and the "村民的信"
 * collectible — whose ItemDef AND codex form are explicitly deferred until the
 * codex/decoration subsystems settle ("道具与图鉴形态待 M3 图鉴/装饰子系统定稿后
 * 确认，在此之前 M4 按无道具实现"). M3 ships the codex as a pure first-sale
 * collection view and deliberately does NOT register these ids as items or codex
 * rows; this constant is the named placeholder so M4 (and the owner ruling) have
 * a single anchor to replace. Guarded by codex.test.ts: the suspension holds.
 */
export const CODEX_PENDING_REWARD_ITEM_IDS = [
  'seed_pack_t1',
  'seed_pack_t2',
  'seed_pack_t3',
  'deco_thinking_scarecrow',
  'collectible_villagers_letter',
] as const;

/**
 * Build the codex view from the persistent collection log (pure; table order).
 * Unknown itemIds in the log (future versions) are ignored — forward tolerance
 * mirrors §5.8's unknown-achievement-id rule.
 */
export function buildCodexView(
  collectionLog: Readonly<Record<string, { firstSoldDay: number }>>,
): CodexView {
  const entries = codexEligibleItems().map((def) => ({
    itemId: def.id,
    nameKey: def.nameKey,
    iconFrame: def.iconFrame,
    category: def.category,
    firstSoldDay: collectionLog[def.id]?.firstSoldDay ?? null,
  }));
  return {
    entries,
    collected: entries.filter((e) => e.firstSoldDay !== null).length,
    total: entries.length,
  };
}
