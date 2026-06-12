/**
 * Blueprint table integrity tests — line-by-line against game-design.md §8.2 (the 12
 * facilities), §8.3 (refund/demolish/move rules), §5.2/§5.3 (XP & unlock levels),
 * rulings A-6/A-7/A-12. Pure data, runs from the contract pass onward (PRD 04).
 */
import { describe, expect, it } from 'vitest';

import {
  BLUEPRINTS,
  BLUEPRINTS_BY_ID,
  CONSTRUCTION_XP,
  COOP,
  CORE_FACILITY_IDS,
  DAILY_MATERIAL_REGEN_M3,
  getBlueprint,
  INVENTORY_EXPANSION_PRICE,
  LARGE_BUILDING_IDS,
  MATERIAL_SHOP_BUY_PRICE,
  PROCESSING,
  RESOURCE_YIELD,
} from '../data/buildings.js';
import { getCropDef, M1_CROP_IDS } from '../data/crops.js';
import { getItemDef, jamItemId, driedItemId, cropItemId } from '../data/items.js';

/** Equivalent total price (§8.2 column): gold + materials at the 5g shop floor. */
function equivalentPrice(defId: string): number {
  const def = getBlueprint(defId);
  return (
    def.cost.gold +
    (def.cost.wood ?? 0) * MATERIAL_SHOP_BUY_PRICE.wood +
    (def.cost.stone ?? 0) * MATERIAL_SHOP_BUY_PRICE.stone
  );
}

describe('the 12 facilities (GDD §8.2; appendix B-6 counts buildings as exactly 3)', () => {
  it('roster is exactly the §8.2 twelve, all present in the table', () => {
    expect(CORE_FACILITY_IDS).toHaveLength(12);
    for (const id of CORE_FACILITY_IDS) expect(BLUEPRINTS_BY_ID.has(id)).toBe(true);
    expect(LARGE_BUILDING_IDS).toEqual(['coop', 'workshop', 'greenhouse']);
  });

  it('coop: 4×3, 2,000g + wood×150 (equiv 2,750g), Lv6 (A-7), limit 1, 2 nights', () => {
    const coop = getBlueprint('coop');
    expect(coop.size).toEqual({ w: 4, h: 3 });
    expect(coop.cost).toEqual({ gold: 2_000, wood: 150 });
    expect(equivalentPrice('coop')).toBe(2_750);
    expect(coop.unlock.farmLevel).toBe(6);
    expect(coop.limit).toBe(1);
    expect(coop.buildDays).toBe(2);
    expect(coop.refundRate).toBe(0.5);
    expect(coop.interiorMapId).toBe('coop_interior');
    expect(coop.doorOffset).toBeDefined(); // canPlace rule ⑥ needs it
  });

  it('workshop: 5×3, 6,000g + wood×200 stone×100 (equiv 7,500g — A-12 note), Lv7', () => {
    const w = getBlueprint('workshop');
    expect(w.size).toEqual({ w: 5, h: 3 });
    expect(w.cost).toEqual({ gold: 6_000, wood: 200, stone: 100 });
    expect(equivalentPrice('workshop')).toBe(7_500);
    expect(w.unlock.farmLevel).toBe(7);
    expect(w.limit).toBe(1);
  });

  it('greenhouse: 6×5, 15,000g + wood×300 stone×300 (equiv 18,000g), Lv9', () => {
    const g = getBlueprint('greenhouse');
    expect(g.size).toEqual({ w: 6, h: 5 });
    expect(g.cost).toEqual({ gold: 15_000, wood: 300, stone: 300 });
    expect(equivalentPrice('greenhouse')).toBe(18_000);
    expect(g.unlock.farmLevel).toBe(9);
  });

  it(
    'farmhouse chain: 4,000g+wood×200 @Lv6; 20,000g+stone×300 wood×100 @Lv10 after I;' +
      ' never demolishable (§8.3)',
    () => {
      const f1 = getBlueprint('farmhouse_1');
      const f2 = getBlueprint('farmhouse_2');
      expect(f1.cost).toEqual({ gold: 4_000, wood: 200 });
      expect(f1.unlock.farmLevel).toBe(6);
      expect(f2.cost).toEqual({ gold: 20_000, stone: 300, wood: 100 });
      expect(f2.unlock).toEqual({ farmLevel: 10, requires: ['farmhouse_1'] });
      for (const f of [f1, f2]) {
        expect(f.demolishable).toBe(false);
        expect(f.movable).toBe(false);
        expect(f.buildDays).toBe(2);
        expect(f.placement).toBe('farmhouse');
      }
    },
  );

  it('stations: chest 1×1 200g+wood×30 @Lv3 ≤4; rack 2×1 500g+wood×40 @Lv4 ≤4', () => {
    const chest = getBlueprint('storage_chest');
    expect(chest.size).toEqual({ w: 1, h: 1 });
    expect(chest.cost).toEqual({ gold: 200, wood: 30 });
    expect(chest.unlock.farmLevel).toBe(3);
    expect(chest.limit).toBe(4);
    const rack = getBlueprint('drying_rack');
    expect(rack.size).toEqual({ w: 2, h: 1 });
    expect(rack.cost).toEqual({ gold: 500, wood: 40 });
    expect(rack.unlock.farmLevel).toBe(4);
    expect(rack.limit).toBe(4);
  });

  it(
    'decorations: fence wood×1 / path stone×1 / flower bed 150g+wood×10 / ' +
      'bench 250g+wood×20 / lamp 300g+wood×10 — all instant & 100% refund',
    () => {
      expect(getBlueprint('fence').cost).toEqual({ gold: 0, wood: 1 });
      expect(getBlueprint('stone_path').cost).toEqual({ gold: 0, stone: 1 });
      expect(getBlueprint('flower_bed').cost).toEqual({ gold: 150, wood: 10 });
      expect(getBlueprint('bench').cost).toEqual({ gold: 250, wood: 20 });
      expect(getBlueprint('lamp_post').cost).toEqual({ gold: 300, wood: 10 });
    },
  );

  it('category invariants (§8.2/§8.3): build nights, refund rates, limits', () => {
    for (const def of BLUEPRINTS) {
      if (def.category === 'building') {
        expect(def.buildDays).toBe(2); // buildings & upgrades take 2 nights
      } else {
        expect(def.buildDays).toBe(0); // stations/decorations are instant
        expect(def.refundRate).toBe(1.0); // §8.3: deco/station refund 100%
        expect(def.demolishable).toBe(true);
        expect(def.movable).toBe(true);
      }
      if (def.demolishable && def.category === 'building') expect(def.refundRate).toBe(0.5);
    }
    for (const id of LARGE_BUILDING_IDS) expect(getBlueprint(id).limit).toBe(1);
  });

  it('sprinklers are OUTSIDE the 12, Lv6/Lv8, flagged provisional (PRD 04 待裁决 2)', () => {
    const s1 = getBlueprint('sprinkler');
    const s2 = getBlueprint('sprinkler_advanced');
    expect(CORE_FACILITY_IDS).not.toContain('sprinkler');
    expect(CORE_FACILITY_IDS).not.toContain('sprinkler_advanced');
    expect(s1.unlock.farmLevel).toBe(6); // §5.3
    expect(s2.unlock.farmLevel).toBe(8); // §5.3
    expect(s1.provisional).toBe(true); // cost awaits GDD §8.2 backfill
    expect(s2.provisional).toBe(true);
  });
});

describe('coop & material constants (§8.2/§8.1; rulings A-6/A-7)', () => {
  it('hens: 2 free at completion, ≤4, buy 200g / sell 100g, 1 egg/hen/night', () => {
    expect(COOP.STARTING_HENS).toBe(2);
    expect(COOP.MAX_HENS).toBe(4);
    expect(COOP.HEN_BUY_PRICE).toBe(200);
    expect(COOP.HEN_SELL_PRICE).toBe(100);
    expect(COOP.EGGS_PER_HEN_PER_NIGHT).toBe(1);
  });

  it('materials: shop floor 5g/each; tree 5 wood / boulder 3 stone; regen 10木+6石', () => {
    expect(MATERIAL_SHOP_BUY_PRICE).toEqual({ wood: 5, stone: 5 });
    expect(RESOURCE_YIELD).toEqual({ treeWood: 5, boulderStone: 3 });
    expect(DAILY_MATERIAL_REGEN_M3).toEqual({ wood: 10, stone: 6 });
    expect(INVENTORY_EXPANSION_PRICE).toBe(1_000); // §6.2
  });

  it('construction XP: coop 150 / workshop 300 / greenhouse 500, one-time (§5.2)', () => {
    expect(CONSTRUCTION_XP).toEqual({ coop: 150, workshop: 300, greenhouse: 500 });
  });
});

describe('processing economics (§8.2; ruling A-12 single floor; PRD 04 US22)', () => {
  it('recipes: jam floor(2×sell+25)/2 nights; mayo 95g/1 night; dried floor(1.4×sell)', () => {
    expect(PROCESSING.JAM.days).toBe(2);
    expect(PROCESSING.MAYONNAISE).toEqual({ days: 1, price: 95 });
    expect(PROCESSING.DRIED.days).toBe(1);
    // §8.2 cabbage check figures: 178g → jam 381 (+101.5/slot-night), dried 249 (+71)
    expect(PROCESSING.JAM.price(178)).toBe(381);
    expect(PROCESSING.DRIED.price(178)).toBe(249);
  });

  it.each(M1_CROP_IDS.map((id) => [id] as const))(
    '%s: item prices match recipe formulas and value increases monotonically ' +
      '(jam > dried > direct — §8.2 校验, US22)',
    (cropId) => {
      const sell = getCropDef(cropId).sellPrice;
      const jam = getItemDef(jamItemId(cropId));
      const dried = getItemDef(driedItemId(cropId));
      const direct = getItemDef(cropItemId(cropId));
      expect(jam.sellPrice).toBe(PROCESSING.JAM.price(sell));
      expect(dried.sellPrice).toBe(PROCESSING.DRIED.price(sell));
      expect(jam.category).toBe('artisan_good');
      expect(dried.category).toBe('artisan_good');
      // unit-value monotonicity: processing never loses money (US22)
      expect(jam.sellPrice!).toBeGreaterThan(dried.sellPrice!);
      expect(dried.sellPrice!).toBeGreaterThan(direct.sellPrice!);
      // per-slot-night added value monotonicity (§8.2 check formula)
      const jamPerNight = (jam.sellPrice! - sell) / PROCESSING.JAM.days;
      const driedPerNight = (dried.sellPrice! - sell) / PROCESSING.DRIED.days;
      expect(jamPerNight).toBeGreaterThan(driedPerNight);
    },
  );

  it('egg 40g (material — keeps §4.5 multipliers clean); mayonnaise 95g artisan_good', () => {
    const egg = getItemDef('animal_egg');
    expect(egg.sellPrice).toBe(40);
    expect(egg.category).toBe('material');
    const mayo = getItemDef('artisan_mayonnaise');
    expect(mayo.sellPrice).toBe(95);
    expect(mayo.category).toBe('artisan_good');
  });

  it('axe & pickaxe exist as tierless tools (§8.1): stack 1, unsellable, undiscardable', () => {
    for (const id of ['axe', 'pickaxe'] as const) {
      const def = getItemDef(id);
      expect(def.category).toBe('tool');
      expect(def.stackMax).toBe(1);
      expect(def.sellPrice).toBeUndefined();
      expect(def.discardable).toBe(false);
    }
  });
});
