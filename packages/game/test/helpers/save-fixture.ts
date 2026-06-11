/**
 * Test fixtures: a minimal schema-valid SaveDoc v1 matching the GDD §10.2
 * new-save values (gold 100, day 1, 6:00, spring, sunny, hoe/can in slots 0/1).
 */
import type { RestorableSaveDoc, SaveDoc, SaveMeta } from '@codestead/shared';

export function makeRestorable(overrides: Partial<RestorableSaveDoc> = {}): RestorableSaveDoc {
  const slots: RestorableSaveDoc['inventory']['slots'] = [
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
    world: { farmTiles: {}, shippingBin: [] },
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
  overrides: Partial<SaveDoc> = {},
  restorable: RestorableSaveDoc = makeRestorable(),
): SaveDoc {
  return { schemaVersion: 1, meta: makeMeta(), ...restorable, ...overrides };
}
