/**
 * Codex registration idempotency over REAL multi-night runs (GDD §4.8/§5.7;
 * PRD 04 US49/50). codex.test.ts pins the selector; this file pins the LEDGER:
 * firstSoldDay is written exactly once per item, survives repeat sales, reloads and
 * the v1→v2 migration unchanged — the codex can never "re-discover" an item.
 */
import { migrateSaveDoc } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { buildCodexView } from '../codex.js';
import { settleShipping } from '../economy.js';
import { createSim } from '../sim.js';
import { composeSaveDoc, createFreshMeta } from '../../storage/save-codec.js';
import { makeSave, makeWorldState, TEST_MAP } from './fixtures.js';

/** Buy radish seeds, plant nothing — just shove crops in the bin via a stocked save. */
function simWithBinnedCrop(day: number, count: number) {
  return createSim(
    makeSave({
      time: {
        day,
        season: 'spring',
        minuteOfDay: 360,
        weatherToday: 'sunny',
        weatherTomorrow: 'sunny',
        rngState: '0123456789abcdef0123456789abcdef',
      },
      world: { farmTiles: {}, shippingBin: [{ itemId: 'crop_radish_quick', count }] },
    }),
    TEST_MAP,
  );
}

describe('first-sale ledger is write-once (registration idempotency)', () => {
  it('selling the same item on a later night never moves firstSoldDay', () => {
    const day1 = makeWorldState();
    day1.economy.shippingBin = [{ itemId: 'crop_radish_quick', count: 2 }];
    const first = settleShipping(day1); // night 1 — first sale recorded
    expect(first.state.economy.collectionLog.crop_radish_quick).toEqual({ firstSoldDay: 1 });

    // restock the bin and sell the SAME item again two days later
    const day3 = structuredClone(first.state);
    day3.time.day = 3;
    day3.economy.shippingBin = [{ itemId: 'crop_radish_quick', count: 1 }];
    const second = settleShipping(day3);
    expect(second.state.economy.collectionLog.crop_radish_quick).toEqual({ firstSoldDay: 1 });

    const view = buildCodexView(second.state.economy.collectionLog);
    expect(view.entries.find((e) => e.itemId === 'crop_radish_quick')?.firstSoldDay).toBe(1);
    expect(view.collected).toBe(1);
  });

  it('the ledger survives serialize → restore byte-identically', () => {
    const sim = simWithBinnedCrop(4, 5);
    sim.sleep();
    const log = structuredClone(sim.state.economy.collectionLog);
    const restored = createSim(sim.serialize(), TEST_MAP);
    expect(restored.state.economy.collectionLog).toEqual(log);
    expect(buildCodexView(restored.state.economy.collectionLog).collected).toBe(
      buildCodexView(log).collected,
    );
  });

  it('the ledger crosses the v1→v2 migration untouched and still feeds the codex', () => {
    const sim = simWithBinnedCrop(7, 4);
    sim.sleep();
    const v1 = composeSaveDoc(
      sim.serialize(),
      createFreshMeta({
        appVersion: '0.1.0',
        now: 1_780_000_000_000,
        saveId: '00000000-0000-4000-8000-00000000c0de',
      }),
    );
    const result = migrateSaveDoc(v1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.progress.collectionLog).toEqual({ crop_radish_quick: { firstSoldDay: 7 } });
    const view = buildCodexView(result.doc.progress.collectionLog);
    expect(view.entries.find((e) => e.itemId === 'crop_radish_quick')?.firstSoldDay).toBe(7);
  });
});
