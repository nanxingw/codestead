/**
 * Test fixtures: a minimal schema-valid SaveDoc matching the GDD §10.2
 * new-save values (gold 100, day 1, 6:00, spring, sunny, hoe/can in slots 0/1).
 *
 * M3: the CURRENT persisted document is SaveDoc v2 (GDD §10.6) — makeRestorable/
 * makeSaveDoc emit the v2 shape (empty M3 world blocks). makeSaveDocV1 builds the
 * frozen v1 document for migration-path tests.
 */
import type {
  RestorableSaveDoc,
  RestorableSaveDocV2,
  SaveDoc,
  SaveDocV2,
  SaveMeta,
} from '@codestead/shared';

export function makeRestorable(overrides: Partial<RestorableSaveDocV2> = {}): RestorableSaveDocV2 {
  const slots: RestorableSaveDocV2['inventory']['slots'] = [
    { itemId: 'hoe', count: 1 },
    { itemId: 'watering_can', count: 1 },
    ...Array.from({ length: 10 }, () => null),
  ];
  return {
    time: {
      day: 1,
      season: 'spring',
      minuteOfDay: 360,
      weatherToday: 'sunny',
      weatherTomorrow: 'sunny',
      rngState: '0123456789abcdef0123456789abcdef',
    },
    player: { tileX: 27, tileY: 11, facing: 'down', gold: 100, selectedSlot: 0 },
    tools: { hoe: 1, wateringCan: 1 },
    inventory: { capacity: 12, slots },
    world: {
      farmTiles: {},
      shippingBin: [],
      structures: [],
      sprinklers: [],
      farmhouse: { stage: 0, construction: null },
      unlockedZones: ['field_a'],
      clearedResourceNodes: [],
    },
    progress: {
      xp: 0,
      profession: null,
      counters: {},
      achievements: [],
      xpHistory: [],
      collectionLog: {},
      stats: { totalGoldEarned: 0, totalHarvests: 0, harvestsByCrop: {} },
    },
    quests: { grantedQuestIds: [], completedCount: 0, noteRefs: [] },
    ...overrides,
  };
}

/** The frozen v1 restorable shape (migration-source tests only). */
export function makeRestorableV1(overrides: Partial<RestorableSaveDoc> = {}): RestorableSaveDoc {
  const { world, ...rest } = makeRestorable();
  return {
    ...rest,
    world: { farmTiles: world.farmTiles, shippingBin: world.shippingBin },
    ...overrides,
  };
}

export function makeMeta(overrides: Partial<SaveMeta> = {}): SaveMeta {
  return {
    saveId: '11111111-2222-4333-8444-555555555555',
    appVersion: '0.1.0',
    createdAtReal: 1_700_000_000_000,
    savedAtReal: 1_700_000_000_000,
    saveCount: 1,
    playTimeRealSeconds: 0,
    ...overrides,
  };
}

export function makeSaveDoc(
  overrides: Partial<SaveDocV2> = {},
  restorable: RestorableSaveDocV2 = makeRestorable(),
): SaveDocV2 {
  return { schemaVersion: 2, meta: makeMeta(), ...restorable, ...overrides };
}

/** A frozen SaveDoc v1 (the migration chain's input shape, GDD §10.6). */
export function makeSaveDocV1(
  overrides: Partial<SaveDoc> = {},
  restorable: RestorableSaveDoc = makeRestorableV1(),
): SaveDoc {
  return { schemaVersion: 1, meta: makeMeta(), ...restorable, ...overrides };
}
