/**
 * Local pool DRAW behaviour (ai-quests §2.3, questbank-rewards lane). The §2.3
 * contract test (quest-contract.test.ts) pins the 30/10-10-10 DATA; this file
 * pins the no-repeat draw + exhaustion-without-reset behaviour of
 * `drawLocalQuestion`, the "运行时随机不重复抽取 / 耗尽后回纯闲聊" rule.
 *
 * The draw is PURE over an injected `rand`, so it is fully deterministic here.
 */
import { describe, expect, it } from 'vitest';

import { LOCAL_POOL, LOCAL_POOL_SIZE, drawLocalQuestion } from '../src/quest/local-pool.js';
import type { RandomFn } from '../src/quest/local-pool.js';

/** A deterministic rand that always picks the first available entry (rand → 0). */
const PICK_FIRST: RandomFn = () => 0;

describe('drawLocalQuestion (no-repeat draw, ai-quests §2.3)', () => {
  it('never returns an id already in usedIds', () => {
    const used = LOCAL_POOL.slice(0, 5).map((e) => e.id);
    // rand → 0 ⇒ first AVAILABLE entry; the first 5 are used, so it must skip them.
    const drawn = drawLocalQuestion(used, PICK_FIRST);
    expect(drawn).not.toBeNull();
    expect(used).not.toContain(drawn!.id);
    expect(drawn!.id).toBe(LOCAL_POOL[5].id);
  });

  it('walks the whole pool without repeats, then returns null (NO reset, §2.3)', () => {
    const used: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < LOCAL_POOL_SIZE; i++) {
      const drawn = drawLocalQuestion(used, PICK_FIRST);
      expect(drawn).not.toBeNull();
      expect(seen.has(drawn!.id)).toBe(false); // never repeats
      seen.add(drawn!.id);
      used.push(drawn!.id);
    }
    expect(seen.size).toBe(LOCAL_POOL_SIZE); // every question drawn exactly once
    // Pool exhausted: villager returns to pure chatter, the pool is NOT reset.
    expect(drawLocalQuestion(used, PICK_FIRST)).toBeNull();
  });

  it('respects the injected randomness (rand → ~1 selects the last available)', () => {
    const nearOne: RandomFn = () => 0.999999;
    const drawn = drawLocalQuestion([], nearOne);
    expect(drawn!.id).toBe(LOCAL_POOL[LOCAL_POOL_SIZE - 1].id);
  });

  it('clamps a degenerate rand === 1 to the last entry (no out-of-bounds read)', () => {
    const exactlyOne: RandomFn = () => 1;
    const drawn = drawLocalQuestion([], exactlyOne);
    expect(drawn).not.toBeNull();
    expect(drawn!.id).toBe(LOCAL_POOL[LOCAL_POOL_SIZE - 1].id);
  });
});
