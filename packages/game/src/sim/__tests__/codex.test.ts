/**
 * codex.ts behavior tests (GDD §4.8/§5.7; PRD 04 §H49~50).
 *
 * The codex is a PASSIVE read model over economy.collectionLog (first-sale records
 * kept since M1 by settleShipping) — these tests pin the eligible-row rule
 * (sellable ∧ not a seed, ruling A-11), silhouette/lit rendering data, forward
 * tolerance for unknown ids, settlement-driven lighting (US50: no manual
 * registration anywhere), and the suspended 5/15/30 reward placeholders.
 */
import { describe, expect, it } from 'vitest';

import { buildCodexView, CODEX_PENDING_REWARD_ITEM_IDS, codexEligibleItems } from '../codex.js';
import { ITEMS, ITEMS_BY_ID } from '../data/items.js';
import { settleShipping } from '../economy.js';
import { makeWorldState } from './fixtures.js';

describe('codexEligibleItems — sellable ∧ not seed (§4.2/§4.8; ruling A-11)', () => {
  it('includes crops, materials (incl. eggs) and artisan goods; excludes seeds/tools', () => {
    const ids = codexEligibleItems().map((d) => d.id);
    for (const id of [
      'crop_turnip',
      'crop_berry',
      'material_wood',
      'forage_wildflower',
      'animal_egg',
      'artisan_mayonnaise',
      'artisan_jam_turnip',
      'artisan_dried_radish_quick',
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids.some((id) => id.startsWith('seed_'))).toBe(false); // refund-only (A-11)
    expect(ids).not.toContain('hoe');
    expect(ids).not.toContain('axe'); // tools have no sellPrice at category level
  });

  it('every row is actually priceable (a codex row can always light up via the bin)', () => {
    for (const def of codexEligibleItems()) {
      expect(def.sellPrice, def.id).toBeDefined();
      expect(def.category, def.id).not.toBe('seed');
    }
  });

  it('M3 roster pin: 23 rows = 6 crops + 4 materials + 13 artisan goods (items.ts)', () => {
    // 6 crops · wood/stone/wildflower/egg · mayonnaise + 6 jams + 6 dried (A-14 ids).
    expect(codexEligibleItems()).toHaveLength(23);
  });
});

describe('buildCodexView — pure selector, table order, silhouettes (US49)', () => {
  it('an empty log renders every row as a silhouette (firstSoldDay null)', () => {
    const view = buildCodexView({});
    expect(view.total).toBe(codexEligibleItems().length);
    expect(view.collected).toBe(0);
    expect(view.entries.every((e) => e.firstSoldDay === null)).toBe(true);
  });

  it('sold rows light up with icon frame + first-sold day; counts move', () => {
    const view = buildCodexView({
      crop_turnip: { firstSoldDay: 3 },
      artisan_mayonnaise: { firstSoldDay: 40 },
    });
    expect(view.collected).toBe(2);
    const turnip = view.entries.find((e) => e.itemId === 'crop_turnip');
    expect(turnip).toMatchObject({
      firstSoldDay: 3,
      iconFrame: ITEMS_BY_ID.get('crop_turnip')?.iconFrame,
      category: 'crop',
    });
    expect(view.entries.find((e) => e.itemId === 'artisan_mayonnaise')?.firstSoldDay).toBe(40);
  });

  it('entry order is the item-table order (stable page layout, §11.3)', () => {
    const tableOrder = ITEMS.filter((d) => d.sellPrice !== undefined && d.category !== 'seed').map(
      (d) => d.id,
    );
    expect(buildCodexView({}).entries.map((e) => e.itemId)).toEqual(tableOrder);
  });

  it('unknown itemIds in the log are ignored, never crash, never add rows (§5.8 tolerance)', () => {
    const view = buildCodexView({ item_from_v9: { firstSoldDay: 1 } });
    expect(view.total).toBe(codexEligibleItems().length);
    expect(view.collected).toBe(0);
    expect(view.entries.some((e) => e.itemId === 'item_from_v9')).toBe(false);
  });

  it('lights up via the settlement event chain only — settleShipping writes the log (US50)', () => {
    const state = makeWorldState({
      economy: {
        gold: 0,
        shippingBin: [{ itemId: 'crop_radish_quick', count: 2 }],
        collectionLog: {},
        newEntriesSeenDay: {},
      },
    });
    expect(buildCodexView(state.economy.collectionLog).collected).toBe(0);
    const settled = settleShipping(state);
    const view = buildCodexView(settled.state.economy.collectionLog);
    expect(view.collected).toBe(1);
    expect(view.entries.find((e) => e.itemId === 'crop_radish_quick')?.firstSoldDay).toBe(
      state.time.day,
    );
  });
});

describe('suspended 5/15/30 reward placeholders (待图鉴定稿 — GDD §9 milestone table)', () => {
  it('the reserved ids are NOT items and NOT codex rows in the M3 build', () => {
    for (const id of CODEX_PENDING_REWARD_ITEM_IDS) {
      expect(ITEMS_BY_ID.has(id), id).toBe(false);
      expect(
        buildCodexView({}).entries.some((e) => e.itemId === id),
        id,
      ).toBe(false);
    }
  });
});
