import { describe, expect, it } from 'vitest';

import { sanitizeSaveDoc } from '../src/storage/sanitize';
import { makeRestorable, makeSaveDoc } from './helpers/save-fixture';

describe('sanitizeSaveDoc (tolerant load, GDD §10.9)', () => {
  it('leaves a fully-known document untouched', () => {
    const doc = makeSaveDoc();
    const result = sanitizeSaveDoc(doc);
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.doc).toEqual(doc);
  });

  it('degrades a tile with an unknown cropId to tilled-with-no-crop', () => {
    const restorable = makeRestorable();
    restorable.world.farmTiles['12,7'] = {
      tilled: true,
      wateredToday: true,
      crop: {
        cropId: 'crop_from_the_future',
        daysGrown: 2,
        mature: false,
        regrowDaysLeft: null,
        harvestsLeft: null,
        withered: false,
      },
    };
    const result = sanitizeSaveDoc(makeSaveDoc({}, restorable));
    expect(result.changed).toBe(true);
    expect(result.doc.world.farmTiles['12,7']).toEqual({
      tilled: true,
      wateredToday: true,
      crop: null,
    });
    expect(result.warnings.some((w) => w.includes('crop_from_the_future'))).toBe(true);
  });

  it('clears inventory slots and drops bin entries with unknown itemIds', () => {
    const restorable = makeRestorable();
    restorable.inventory.slots[2] = { itemId: 'mystery_widget', count: 3 };
    restorable.world.shippingBin = [
      { itemId: 'crop_turnip', count: 5 },
      { itemId: 'mystery_widget', count: 1 },
    ];
    const result = sanitizeSaveDoc(makeSaveDoc({}, restorable));
    expect(result.doc.inventory.slots[2]).toBeNull();
    expect(result.doc.inventory.slots).toHaveLength(12); // length is never disturbed
    expect(result.doc.world.shippingBin).toEqual([{ itemId: 'crop_turnip', count: 5 }]);
    expect(result.warnings).toHaveLength(2);
  });

  it('never mutates its input document', () => {
    const restorable = makeRestorable();
    restorable.inventory.slots[2] = { itemId: 'mystery_widget', count: 3 };
    const doc = makeSaveDoc({}, restorable);
    const before = structuredClone(doc);
    sanitizeSaveDoc(doc);
    expect(doc).toEqual(before);
  });
});
