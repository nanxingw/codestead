/**
 * Migration chain tests — the v1 → v2 fixture migration plus the CI guard the GDD
 * mandates for every future schema bump (GDD §10.6; PRD 04 §M / testing seam b):
 *   - a migration step exists for EVERY version 1..CURRENT-1 (delete one ⇒ red);
 *   - v1 fixture → migrate → terminal v2 validation passes, zero data loss;
 *   - v2 roundtrip covers every PlacedStructure data kind + quality + sprinklers;
 *   - the driver never mutates its input (copy-on-migrate, §10.6).
 */
import { describe, expect, it } from 'vitest';

import {
  CURRENT_SAVE_SCHEMA_VERSION,
  migrateSaveDoc,
  migrateV1toV2,
  SAVE_MIGRATIONS,
  SAVE_SCHEMA_VERSION,
  SaveDocV2Schema,
  type SaveDoc,
  type SaveDocV2,
} from '../src/index.js';

/** Mid-game v1 fixture (mirrors save.test.ts; xp 425 ⇒ Lv3 ⇒ field_a + field_b). */
function v1Doc(): SaveDoc {
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
      weatherTomorrow: 'rain',
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
        ...Array.from({ length: 9 }, () => null),
      ],
    },
    world: {
      farmTiles: {
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
      shippingBin: [{ itemId: 'crop_radish_quick', count: 10 }],
    },
    progress: {
      xp: 425,
      profession: null,
      counters: { tillCount: 12 },
      achievements: [],
      xpHistory: [60, 30, 48],
      collectionLog: { crop_radish_quick: { firstSoldDay: 3 } },
      stats: { totalGoldEarned: 660, totalHarvests: 24, harvestsByCrop: { radish_quick: 24 } },
    },
    quests: { grantedQuestIds: [], completedCount: 0, noteRefs: [] },
  };
}

describe('migration chain guard (GDD §10.6 — CI must go red if a link is deleted)', () => {
  it('has one step per version 1..CURRENT-1, ascending and gap-free', () => {
    expect(CURRENT_SAVE_SCHEMA_VERSION).toBe(2);
    expect(SAVE_MIGRATIONS).toHaveLength(CURRENT_SAVE_SCHEMA_VERSION - 1);
    SAVE_MIGRATIONS.forEach((step, i) => expect(step.from).toBe(i + 1));
  });
});

describe('migrateV1toV2 (PRD 04 §M: first real migration, zero loss)', () => {
  it('produces a valid v2 doc; v1 blocks survive verbatim; new blocks start empty', () => {
    const v1 = v1Doc();
    const v2 = migrateV1toV2(v1);
    expect(SaveDocV2Schema.safeParse(v2).success).toBe(true);
    expect(v2.schemaVersion).toBe(2);
    // zero-loss: untouched blocks are deep-equal
    expect(v2.meta).toEqual(v1.meta);
    expect(v2.time).toEqual(v1.time);
    expect(v2.player).toEqual(v1.player);
    expect(v2.tools).toEqual(v1.tools);
    expect(v2.inventory).toEqual(v1.inventory);
    expect(v2.progress).toEqual(v1.progress);
    expect(v2.quests).toEqual(v1.quests);
    expect(v2.world.farmTiles).toEqual(v1.world.farmTiles);
    expect(v2.world.shippingBin).toEqual(v1.world.shippingBin);
    // new v2 blocks at "nothing happened yet"
    expect(v2.world.structures).toEqual([]);
    expect(v2.world.sprinklers).toEqual([]);
    expect(v2.world.farmhouse).toEqual({ stage: 0, construction: null });
    expect(v2.world.clearedResourceNodes).toEqual([]);
  });

  it('derives unlockedZones from xp (B-2): Lv3 ⇒ field_a + field_b; Lv5+ adds field_c', () => {
    expect(migrateV1toV2(v1Doc()).world.unlockedZones).toEqual(['field_a', 'field_b']);
    const fresh = v1Doc();
    fresh.progress.xp = 0;
    expect(migrateV1toV2(fresh).world.unlockedZones).toEqual(['field_a']);
    const graduate = v1Doc();
    graduate.progress.xp = 2_400; // §5.5 canonical retro example (Lv6)
    expect(migrateV1toV2(graduate).world.unlockedZones).toEqual(['field_a', 'field_b', 'field_c']);
  });
});

describe('migrateSaveDoc driver (GDD §10.4 MIGRATING / §10.6 copy-on-migrate)', () => {
  it('migrates a v1 doc and never mutates the input', () => {
    const v1 = v1Doc();
    const snapshot = structuredClone(v1);
    const result = migrateSaveDoc(v1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromVersion).toBe(1);
      expect(result.doc.schemaVersion).toBe(2);
    }
    expect(v1).toEqual(snapshot); // input untouched
  });

  it('passes a current-version doc straight through terminal validation', () => {
    const v2 = migrateV1toV2(v1Doc());
    const result = migrateSaveDoc(v2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc).toEqual(v2);
  });

  it('rejects newer-than-current versions as too_new (read-only path, §10.4)', () => {
    const doc = { ...migrateV1toV2(v1Doc()), schemaVersion: 99 };
    expect(migrateSaveDoc(doc)).toEqual({ ok: false, reason: 'too_new', foundVersion: 99 });
  });

  it('rejects garbage and invalid v1 inputs without throwing', () => {
    expect(migrateSaveDoc(null).ok).toBe(false);
    expect(migrateSaveDoc('nope').ok).toBe(false);
    expect(migrateSaveDoc({ schemaVersion: 1, junk: true }).ok).toBe(false);
  });
});

describe('SaveDoc v2 roundtrip (every structure kind + quality + sprinklers)', () => {
  function v2DocFull(): SaveDocV2 {
    const base = migrateV1toV2(v1Doc());
    return {
      ...base,
      inventory: {
        capacity: 24,
        slots: [
          { itemId: 'crop_turnip', count: 3, quality: 'gold' },
          { itemId: 'crop_cabbage', count: 2, quality: 'silver' },
          { itemId: 'animal_egg', count: 5 },
          ...Array.from({ length: 21 }, () => null),
        ],
      },
      world: {
        ...base.world,
        shippingBin: [{ itemId: 'crop_turnip', count: 1, quality: 'gold' }],
        structures: [
          {
            instanceId: 's-coop-1',
            defId: 'coop',
            origin: { x: 42, y: 32 },
            state: 'built',
            data: { kind: 'coop', hens: 4, eggsReady: 7 },
          },
          {
            instanceId: 's-site-1',
            defId: 'greenhouse',
            origin: { x: 44, y: 37 },
            state: 'underConstruction',
            daysLeft: 2,
          },
          {
            instanceId: 's-chest-1',
            defId: 'storage_chest',
            origin: { x: 33, y: 12 },
            state: 'built',
            data: {
              kind: 'chest',
              slots: [
                { itemId: 'material_wood', count: 99 },
                ...Array.from({ length: 23 }, () => null),
              ],
            },
          },
          {
            instanceId: 's-rack-1',
            defId: 'drying_rack',
            origin: { x: 35, y: 12 },
            state: 'built',
            data: {
              kind: 'dryingRack',
              jobs: [
                { inputItemId: 'crop_cabbage', outputItemId: 'artisan_dried_cabbage', daysLeft: 0 },
                null,
              ],
            },
          },
          {
            instanceId: 's-shop-1',
            defId: 'workshop',
            origin: { x: 50, y: 32 },
            state: 'built',
            data: {
              kind: 'workshop',
              jobs: [
                { inputItemId: 'animal_egg', outputItemId: 'artisan_mayonnaise', daysLeft: 1 },
                ...Array.from({ length: 5 }, () => null),
              ],
            },
          },
        ],
        sprinklers: [
          { x: 23, y: 15, tier: 1 },
          { x: 12, y: 16, tier: 2 },
        ],
        farmhouse: { stage: 1, construction: { targetStage: 2, nightsLeft: 2 } },
        unlockedZones: ['field_a', 'field_b', 'field_c'],
        clearedResourceNodes: ['tree_03', 'boulder_07'],
      },
    };
  }

  it('roundtrips byte-equal through parse', () => {
    const doc = v2DocFull();
    const parsed = SaveDocV2Schema.safeParse(structuredClone(doc));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(doc);
  });

  it('rejects daysLeft on built structures and missing daysLeft on construction sites', () => {
    const doc = v2DocFull();
    (doc.world.structures[0] as { daysLeft?: number }).daysLeft = 1; // built + daysLeft
    expect(SaveDocV2Schema.safeParse(doc).success).toBe(false);
    const doc2 = v2DocFull();
    delete (doc2.world.structures[1] as { daysLeft?: number }).daysLeft;
    expect(SaveDocV2Schema.safeParse(doc2).success).toBe(false);
  });

  it("rejects quality: 'normal' written explicitly (absent = normal, single spelling)", () => {
    const doc: unknown = v2DocFull();
    const slots = (doc as { inventory: { slots: Record<string, unknown>[] } }).inventory.slots;
    slots[2] = { ...slots[2], quality: 'normal' };
    expect(SaveDocV2Schema.safeParse(doc).success).toBe(false);
  });
});
