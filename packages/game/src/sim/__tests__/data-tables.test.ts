/**
 * Item table & constants integrity tests (GDD §6.1 items / §4.3 shop / §2.1 time /
 * §5.1 thresholds / §1.4 tilled cap). Pure data — runs from day one.
 */
import { describe, expect, it } from 'vitest';

import { CROPS, M1_CROP_IDS, getCropDef } from '../data/crops.js';
import { ITEMS, ITEMS_BY_ID, cropItemId, getItemDef, seedItemId } from '../data/items.js';
import {
  DAILY_PICKUPS,
  ECONOMY,
  INVENTORY,
  M1_LEVEL_CAP,
  RELIEF,
  SHOP_CATALOG_M1,
  TILLED_CAP_BY_LEVEL,
  TIME,
  XP_CAP,
  XP_PLANT,
  XP_THRESHOLDS,
} from '../data/constants.js';

describe('item table (GDD §6.1, ruling A-14 prefix discipline)', () => {
  it('lists tools, 6 seeds, 6 crops and 3 materials (table enumerates 17 ids)', () => {
    expect(ITEMS).toHaveLength(17); // §6.1 heading says 16 — recorded as open question
    expect(ITEMS_BY_ID.size).toBe(17);
  });

  it.each(M1_CROP_IDS.map((id) => [id] as const))(
    '%s: seed_/crop_ ids exist, link back to the crop table and price from §3.6',
    (cropId) => {
      const crop = getCropDef(cropId);
      const seed = getItemDef(seedItemId(cropId));
      const product = getItemDef(cropItemId(cropId));
      expect(seed.category).toBe('seed');
      expect(seed.cropId).toBe(cropId);
      expect(seed.sellPrice).toBe(crop.seedPrice); // refund-only, 100% (ruling A-11)
      expect(product.category).toBe('crop');
      expect(product.cropId).toBe(cropId);
      expect(product.sellPrice).toBe(crop.sellPrice);
      expect(seed.stackMax).toBe(99);
      expect(product.stackMax).toBe(99);
    },
  );

  it('tools are unsellable (no sellPrice) and undiscardable, stackMax 1 (§4.2/§6.1)', () => {
    for (const id of ['hoe', 'watering_can'] as const) {
      const def = getItemDef(id);
      expect(def.category).toBe('tool');
      expect(def.sellPrice).toBeUndefined();
      expect(def.discardable).toBe(false);
      expect(def.stackMax).toBe(1);
    }
  });

  it('material prices: wood 5g / stone 3g / wildflower 8g (GDD §1.3/§6.1)', () => {
    expect(getItemDef('material_wood').sellPrice).toBe(5);
    expect(getItemDef('material_stone').sellPrice).toBe(3);
    expect(getItemDef('forage_wildflower').sellPrice).toBe(8);
  });
});

describe('M1 shop catalog (GDD §4.3 authoritative table)', () => {
  it('has exactly 10 entries: 6 seeds + 4 tool upgrades', () => {
    expect(SHOP_CATALOG_M1).toHaveLength(10);
    expect(SHOP_CATALOG_M1.filter((e) => e.kind === 'seed')).toHaveLength(6);
    expect(SHOP_CATALOG_M1.filter((e) => e.kind === 'tool_upgrade')).toHaveLength(4);
  });

  it('seed entryIds equal item ids and prices equal §3.6 seedPrice; unlock = crop unlockLevel', () => {
    for (const entry of SHOP_CATALOG_M1) {
      if (entry.kind !== 'seed') continue;
      expect(entry.cropId).toBeDefined();
      const crop = getCropDef(entry.cropId!);
      expect(entry.entryId).toBe(seedItemId(entry.cropId!));
      expect(entry.price).toBe(crop.seedPrice);
      expect(entry.unlockLevel).toBe(crop.unlockLevel);
      expect(entry.oneTime).toBe(false); // unlimited stock, anti-FOMO (§4.3)
    }
  });

  it('tool upgrades: copper 350g @Lv2, gold 2,650g @Lv4 requiring copper (§3.5/§4.3)', () => {
    const byId = new Map(SHOP_CATALOG_M1.map((e) => [e.entryId, e]));
    for (const tool of ['hoe', 'can'] as const) {
      const copper = byId.get(`tool_${tool}_copper`)!;
      const gold = byId.get(`tool_${tool}_gold`)!;
      expect(copper.price).toBe(ECONOMY.TOOL_UPGRADE_PRICE.copper);
      expect(copper.unlockLevel).toBe(2);
      expect(copper.oneTime).toBe(true);
      expect(gold.price).toBe(ECONOMY.TOOL_UPGRADE_PRICE.gold);
      expect(gold.unlockLevel).toBe(4);
      expect(gold.requires).toBe(copper.entryId);
    }
  });
});

describe('constants tables (GDD §2.1 / §5.1 / §1.4 / §4.7)', () => {
  it('time table: 187.5ms/min, 360..1320, 960 min/day, 28-day season (§2.1)', () => {
    expect(TIME.REAL_MS_PER_GAME_MINUTE).toBe(187.5);
    expect(TIME.DAY_END_MINUTE - TIME.DAY_START_MINUTE).toBe(TIME.GAME_MINUTES_PER_DAY);
    expect(TIME.DAYS_PER_YEAR).toBe(TIME.DAYS_PER_SEASON * 4);
    expect(TIME.RAIN_PROBABILITY.spring).toBe(0.2);
    expect(TIME.RAIN_FORCED_SUNNY_DAYS).toEqual([1]);
    expect(TIME.RAIN_MAX_CONSECUTIVE).toBe(2);
  });

  it('XP thresholds ascend strictly; cap 15,000; M1 level cap 5; plant XP 5 (§5.1/§5.2)', () => {
    expect(XP_THRESHOLDS).toHaveLength(10);
    expect(XP_THRESHOLDS[0]).toBe(0);
    for (let i = 1; i < XP_THRESHOLDS.length; i++) {
      expect(XP_THRESHOLDS[i]).toBeGreaterThan(XP_THRESHOLDS[i - 1]);
    }
    expect(XP_THRESHOLDS[1]).toBe(100); // red line 1 target (Lv2)
    expect(XP_THRESHOLDS[4]).toBe(1300); // Lv5, M1 graduation
    expect(XP_CAP).toBe(15_000);
    expect(M1_LEVEL_CAP).toBe(5);
    expect(XP_PLANT).toBe(5);
  });

  it('tilled cap brackets Lv1=12 / Lv3=18 / Lv5=24 / Lv7=32 / Lv9=42 (§1.4)', () => {
    expect(TILLED_CAP_BY_LEVEL).toEqual([
      { level: 1, cap: 12 },
      { level: 3, cap: 18 },
      { level: 5, cap: 24 },
      { level: 7, cap: 32 },
      { level: 9, cap: 42 },
    ]);
  });

  it('daily pickup faucet caps at 66g/day: 6×5 + 4×3 + 3×8 (§4.7)', () => {
    const value =
      DAILY_PICKUPS.wood * getItemDef('material_wood').sellPrice! +
      DAILY_PICKUPS.stone * getItemDef('material_stone').sellPrice! +
      DAILY_PICKUPS.wildflower * getItemDef('forage_wildflower').sellPrice!;
    expect(value).toBe(66);
  });

  it('relief grant: <10g threshold, 4 radish_quick seeds (§4.8)', () => {
    expect(RELIEF).toEqual({ GOLD_BELOW: 10, GRANT_SEEDS: 4, GRANT_CROP: 'radish_quick' });
  });

  it('economy: 100g start, 9,999,999 cap, inventory 12 slots / 9 hotbar (§4.1/§6.2)', () => {
    expect(ECONOMY.STARTING_GOLD).toBe(100);
    expect(ECONOMY.GOLD_CAP).toBe(9_999_999);
    expect(INVENTORY.M1_CAPACITY).toBe(12);
    expect(INVENTORY.HOTBAR_SIZE).toBe(9);
  });

  it('M1 crop unlock ladder covers Lv1~5 (§5.3)', () => {
    const unlocks = M1_CROP_IDS.map((id) => getCropDef(id).unlockLevel);
    expect(unlocks).toEqual([1, 1, 2, 3, 4, 5]);
    // every M1 level has at least one new crop from Lv2 on
    expect(new Set(unlocks)).toEqual(new Set([1, 2, 3, 4, 5]));
    const m1 = new Set<string>(M1_CROP_IDS);
    expect(CROPS.filter((c) => m1.has(c.id)).length).toBe(6);
  });
});
