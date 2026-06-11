/**
 * Red line 1 calibration — onboarding copy existence assertions
 * (PRD 02 Implementation Decision 12: when the human playtest fails, ONLY guidance
 * and copy may be adjusted; this file pins the copy that must exist for the playtest
 * to be runnable at all, and the GDD-verbatim lines that may NOT drift without a GDD
 * revision first — the 事实源 discipline).
 *
 * Covered: the §1.9 新手引导 pieces that ship in M1-core — the porch intro letter
 * (GDD-verbatim) and the bulletin board stage hints — plus the 明日之诺 settlement
 * strings the §1.9 day table leans on. The backlog A-3 signpost strings
 * (gate_sign / signpost_junction) belong to the polish implementer and are asserted
 * only once they land (see the soft probe note at the bottom).
 */
import { describe, expect, it } from 'vitest';

import { t } from '../src/ui/strings';

/** A key "exists" when t() does not echo it back (strings.ts contract). */
function exists(key: string): boolean {
  return t(key) !== key;
}

describe('intro letter (GDD §1.9 verbatim — copy is load-bearing for red line 1)', () => {
  it('title and body exist and match the GDD word for word', () => {
    expect(t('letter.title')).toBe('前任农场主的信');
    expect(t('letter.body')).toBe(
      '兜里有 100g。沿路往东，集市的杂货摊上有种子，投币自取。田就在门前。',
    );
  });

  it('the body carries all three guidance facts: starting gold, seed source, field', () => {
    const body = t('letter.body');
    expect(body).toContain('100g'); // budget anchor
    expect(body).toContain('种子'); // where the loop starts
    expect(body).toContain('田'); // where to come back to
  });
});

describe('bulletin board stage hints (GDD §1.9 三件套 #2)', () => {
  it('the three pure-query stage hints exist and match the GDD', () => {
    expect(t('board.hint_buy_seeds')).toBe('去集市买种子');
    expect(t('board.hint_plant')).toBe('锄地播种');
    expect(t('board.hint_water')).toBe('每天清晨浇水');
  });

  it('the board has a title (the panel is reachable and labeled)', () => {
    expect(exists('board.title')).toBe(true);
  });
});

describe('明日之诺 settlement strings (GDD §1.9 day-table column / §2.5 #10)', () => {
  it('crop-readiness promises exist and interpolate', () => {
    expect(t('summary.tomorrow_crop_ready', { crop: '小萝卜' })).toContain('小萝卜');
    const inDays = t('summary.tomorrow_crop_in', { crop: '小萝卜', days: 1 });
    expect(inDays).toContain('小萝卜');
    expect(inDays).toContain('1');
  });

  it('the promise list fallback exists (never-empty contract, GDD §2.5)', () => {
    expect(exists('summary.tomorrow_fallback')).toBe(true);
    expect(exists('summary.tomorrow')).toBe(true);
  });

  it('the ETA strings exist (progress block: 距 LvN 还差 X XP)', () => {
    const eta = t('summary.eta', { level: 3, xp: 68, days: 2 });
    expect(eta).toContain('68');
    expect(eta).toContain('3');
    expect(exists('summary.eta_keep_going')).toBe(true);
  });
});

describe('t() lookup contract (playtest safety: copy failures are visible, never fatal)', () => {
  it('unknown keys echo back instead of throwing', () => {
    expect(t('definitely.not.a.key')).toBe('definitely.not.a.key');
  });

  it('missing params are left as readable placeholders, not crashes', () => {
    expect(() => t('summary.eta')).not.toThrow();
  });
});

// Soft probe — backlog A-3 (gate_sign / signpost_junction) is owned by the polish
// implementer. Once those keys land in strings.ts this test starts enforcing them;
// until then it documents the expectation without failing another agent's in-flight work.
describe('signpost strings (backlog A-3, enforced once landed)', () => {
  it('gate_sign / signpost_junction are non-empty when present', () => {
    for (const key of ['sign.gate_sign', 'sign.signpost_junction']) {
      if (exists(key)) expect(t(key).trim().length).toBeGreaterThan(0);
    }
  });
});
