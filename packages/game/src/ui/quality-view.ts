/**
 * quality-view.ts — render-side quality helpers (M3, GDD §4.5; PRD 04 US43~45).
 *
 * Pure & Phaser-free. Runtime stacks are still the v1 `ItemStack` shape; SaveDoc v2
 * adds an OPTIONAL `quality` field ('silver' | 'gold', absent = normal — shared
 * ItemStackV2Schema). Until the sim implementer flips the runtime carrier to the v2
 * stack, every stack simply reads as 'normal' here — forward-ready, zero coupling.
 *
 * Badge discipline (PRD 04 light-sensitivity note / §10.8): quality must be DOUBLE
 * encoded — colour AND shape — so the marks below pair a distinct glyph with each
 * palette token and stay readable in grayscale. Text rows (shop sell tab / shipping
 * bin) use the textual mark; 20×20 slots draw the corner badge in slot-view.ts.
 */
import type { Quality } from '@codestead/shared';

import { unitSalePrice } from '../sim/economy';
import { getItemDef } from '../sim/data/items';
import type { ItemStack, WorldState } from '../sim/types';

import { safe } from './safe';

/** Tolerant accessor: v1 stacks have no quality field; absent ⇒ 'normal'. */
export function qualityOf(stack: ItemStack | null): Quality {
  if (!stack) return 'normal';
  const q = (stack as { quality?: unknown }).quality;
  return q === 'silver' || q === 'gold' ? q : 'normal';
}

/**
 * Textual quality mark for list rows — shape + word double encoding (◆银 / ★金;
 * normal is unmarked). Prepend a space when appending to a name.
 */
export function qualityMark(quality: Quality): string {
  switch (quality) {
    case 'silver':
      return '◆银';
    case 'gold':
      return '★金';
    default:
      return '';
  }
}

/** Display name suffix helper: `芜菁 ◆银` (normal: bare name). */
export function withQualityMark(name: string, quality: Quality): string {
  const mark = qualityMark(quality);
  return mark === '' ? name : `${name} ${mark}`;
}

/**
 * Unit sale price of a stack honouring quality + profession via the single §4.5
 * pricing entry (unitSalePrice). Falls back to the base sellPrice (or 0) when the
 * item is not sellable — display-only, the sim settles authoritatively at night.
 */
export function stackUnitSalePrice(state: Readonly<WorldState>, stack: ItemStack): number {
  const def = getItemDef(stack.itemId);
  return safe(
    'quality-view.unitSalePrice',
    () => unitSalePrice(def, qualityOf(stack), { profession: state.progress.profession }),
    def.sellPrice ?? 0,
  );
}
