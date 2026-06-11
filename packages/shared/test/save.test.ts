/**
 * SaveDoc v1 schema tests — roundtrip equivalence and the reject table
 * (GDD §10.2 field table / §10.3 schema notes / §10.9 boundary rules;
 * rulings A-13 profession enum, A-15 bounds).
 */
import { describe, expect, it } from 'vitest';

import {
  FARM_TILE_KEY_REGEX,
  SAVE_SCHEMA_VERSION,
  SaveDocSchema,
  type SaveDoc,
} from '../src/index.js';

/** A representative mid-game SaveDoc exercising every block (§10.2). */
function validDoc(): SaveDoc {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    meta: {
      saveId: '6f1f3e7a-2b4c-4d5e-9f0a-1b2c3d4e5f6a',
      appVersion: '0.1.0',
      createdAtReal: 1_780_000_000_000,
      savedAtReal: 1_780_000_500_000,
      saveCount: 12,
      playTimeRealSeconds: 1234.5,
    },
    time: {
      day: 11,
      season: 'spring',
      minuteOfDay: 470,
      weatherToday: 'sunny',
      weatherTomorrow: 'rain', // forecast pre-rolled at settlement (§2.2)
      rngState: '0123456789abcdef0123456789abcdef',
    },
    player: { tileX: 27, tileY: 11, facing: 'down', gold: 184, selectedSlot: 2 },
    tools: { hoe: 2, wateringCan: 1 },
    inventory: {
      capacity: 12,
      slots: [
        { itemId: 'hoe', count: 1 },
        { itemId: 'watering_can', count: 1 },
        { itemId: 'seed_radish_quick', count: 8 },
        null,
        { itemId: 'crop_turnip', count: 14 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    },
    world: {
      farmTiles: {
        '22,14': { tilled: true, wateredToday: true, crop: null },
        '23,14': {
          tilled: true,
          wateredToday: false,
          crop: {
            cropId: 'bean_vine',
            daysGrown: 8,
            mature: false,
            regrowDaysLeft: 2,
            harvestsLeft: 7,
            withered: false,
          },
        },
      },
      shippingBin: [{ itemId: 'crop_radish_quick', count: 10 }], // HOLDING may be saved (§4.8)
    },
    progress: {
      xp: 425,
      profession: null,
      counters: { tillCount: 12, plantCount: 30, 'soldCrops:radish_quick': 28 },
      achievements: [],
      xpHistory: [60, 30, 48],
      collectionLog: { crop_radish_quick: { firstSoldDay: 3 } },
      stats: {
        totalGoldEarned: 660,
        totalHarvests: 30,
        harvestsByCrop: { radish_quick: 28, potato: 2 },
      },
    },
    quests: { grantedQuestIds: [], completedCount: 0, noteRefs: [] }, // M4 container (§10.2)
  };
}

/** JSON wire roundtrip + safeParse, mirroring the import path (§10.6). */
function parseWire(doc: unknown) {
  const wire: unknown = JSON.parse(JSON.stringify(doc));
  return SaveDocSchema.safeParse(wire);
}

describe('SaveDoc v1 roundtrip (GDD §10.6 — export → import equivalence)', () => {
  it('accepts a representative document through JSON encode/decode unchanged', () => {
    const doc = validDoc();
    const result = parseWire(doc);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(doc);
  });

  it('accepts the §10.2 new-game initial values', () => {
    const doc = validDoc();
    doc.time = {
      day: 1,
      season: 'spring',
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'rain',
      rngState: 'deadbeefdeadbeefdeadbeefdeadbeef',
    };
    doc.player = { tileX: 27, tileY: 11, facing: 'down', gold: 100, selectedSlot: 0 };
    doc.world = { farmTiles: {}, shippingBin: [] };
    doc.progress.xp = 0;
    expect(parseWire(doc).success).toBe(true);
  });

  it('accepts a 24-slot inventory when capacity is 24 (M3 upgrade shape)', () => {
    const doc = validDoc();
    doc.inventory = { capacity: 24, slots: Array.from({ length: 24 }, () => null) };
    expect(parseWire(doc).success).toBe(true);
  });

  it('accepts boundary keys of the sparse farm table (0,0 and 63,47)', () => {
    const doc = validDoc();
    doc.world.farmTiles['0,0'] = { tilled: true, wateredToday: false, crop: null };
    doc.world.farmTiles['63,47'] = { tilled: true, wateredToday: false, crop: null };
    expect(parseWire(doc).success).toBe(true);
  });
});

describe('SaveDoc v1 reject table (write-path self-check & import gate, §10.3/§10.9)', () => {
  const cases: [string, (doc: SaveDoc) => unknown][] = [
    ['wrong schemaVersion', (d) => ({ ...d, schemaVersion: 2 })],
    ['missing block (time)', (d) => ({ ...d, time: undefined })],
    ['unknown root key (strict)', (d) => ({ ...d, hacked: true })],
    [
      'farmTiles key out of bounds x (64,0)',
      (d) => {
        d.world.farmTiles['64,0'] = { tilled: true, wateredToday: false, crop: null };
        return d;
      },
    ],
    [
      'farmTiles key out of bounds y (0,48)',
      (d) => {
        d.world.farmTiles['0,48'] = { tilled: true, wateredToday: false, crop: null };
        return d;
      },
    ],
    [
      'farmTiles key with leading zero (07,3)',
      (d) => {
        d.world.farmTiles['07,3'] = { tilled: true, wateredToday: false, crop: null };
        return d;
      },
    ],
    [
      'untilled tile stored (tilled:false)',
      (d) => ({
        ...d,
        world: {
          ...d.world,
          farmTiles: {
            ...d.world.farmTiles,
            '22,14': { tilled: false, wateredToday: false, crop: null },
          },
        },
      }),
    ],
    [
      'crop missing the withered flag',
      (d) => ({
        ...d,
        world: {
          ...d.world,
          farmTiles: {
            ...d.world.farmTiles,
            '23,14': {
              tilled: true,
              wateredToday: false,
              crop: {
                cropId: 'turnip',
                daysGrown: 1,
                mature: false,
                regrowDaysLeft: null,
                harvestsLeft: null,
              },
            },
          },
        },
      }),
    ],
    [
      'stack count 0',
      (d) => {
        d.world.shippingBin = [{ itemId: 'crop_turnip', count: 0 }];
        return d;
      },
    ],
    [
      'stack count above the 99 cap',
      (d) => {
        d.inventory.slots[2] = { itemId: 'seed_turnip', count: 100 };
        return d;
      },
    ],
    [
      'slots length ≠ capacity',
      (d) => {
        d.inventory.slots = d.inventory.slots.slice(0, 11);
        return d;
      },
    ],
    [
      'minuteOfDay before 6:00',
      (d) => {
        d.time.minuteOfDay = 359;
        return d;
      },
    ],
    [
      'minuteOfDay after 22:00',
      (d) => {
        d.time.minuteOfDay = 1321;
        return d;
      },
    ],
    [
      'non-integer day',
      (d) => {
        d.time.day = 1.5;
        return d;
      },
    ],
    [
      'rngState not 32 lowercase hex',
      (d) => {
        d.time.rngState = '0123456789ABCDEF0123456789ABCDEF';
        return d;
      },
    ],
    ['unknown weather enum value', (d) => ({ ...d, time: { ...d.time, weatherToday: 'snow' } })],
    [
      'player off the 64×48 map (tileY 48, A-15)',
      (d) => {
        d.player.tileY = 48;
        return d;
      },
    ],
    [
      'selectedSlot outside the hotbar (9, A-15)',
      (d) => {
        d.player.selectedSlot = 9;
        return d;
      },
    ],
    [
      'negative gold',
      (d) => {
        d.player.gold = -1;
        return d;
      },
    ],
    [
      'gold above GOLD_CAP',
      (d) => {
        d.player.gold = 10_000_000;
        return d;
      },
    ],
    ['tool tier out of range', (d) => ({ ...d, tools: { ...d.tools, hoe: 4 } })],
    [
      'xp above the 15,000 hard cap',
      (d) => {
        d.progress.xp = 15_001;
        return d;
      },
    ],
    [
      'xpHistory longer than 3 days',
      (d) => {
        d.progress.xpHistory = [1, 2, 3, 4];
        return d;
      },
    ],
    [
      'unknown profession (A-13 enum)',
      (d) => ({ ...d, progress: { ...d.progress, profession: 'farmer' } }),
    ],
    [
      'meta saveId not a uuid',
      (d) => {
        d.meta.saveId = 'not-a-uuid';
        return d;
      },
    ],
    ['quests container missing', (d) => ({ ...d, quests: undefined })],
  ];

  it.each(cases)('rejects: %s', (_name, mutate) => {
    const result = parseWire(mutate(validDoc()));
    expect(result.success).toBe(false);
  });
});

describe('FARM_TILE_KEY_REGEX (GDD §10.9 — bounds baked into the key)', () => {
  it.each([['0,0'], ['12,3'], ['63,47'], ['9,40']])('accepts %s', (key) => {
    expect(FARM_TILE_KEY_REGEX.test(key)).toBe(true);
  });

  it.each([['64,0'], ['0,48'], ['-1,2'], ['007,1'], ['1,2,3'], ['a,b'], [' 1,2'], ['1, 2'], ['']])(
    'rejects %s',
    (key) => {
      expect(FARM_TILE_KEY_REGEX.test(key)).toBe(false);
    },
  );
});
