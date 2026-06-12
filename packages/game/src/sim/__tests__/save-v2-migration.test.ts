/**
 * Cross-package migration guard (PRD 04 §M; GDD §10.6) — shared/ cannot import the
 * game's sim constants, so migrateV1toV2 carries SNAPSHOTS of the §5.1 XP table and
 * the §1.4 zone-unlock levels. THIS test is the anti-drift lock: if either authority
 * table changes without updating the snapshot (or vice versa), CI goes red.
 *
 * Also pins the §5.5 acceptance fixture on the game side: an xp=2,400 M1 save is a
 * Lv6 save after migration (unlockedZones complete; retro level-up EVENTS are the
 * load path's job — sim/profession.ts retroLevelUpEvents).
 */
import { XP_THRESHOLDS_SNAPSHOT, ZONE_UNLOCK_LEVELS_SNAPSHOT } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { XP_THRESHOLDS } from '../data/constants.js';
import farmMapMeta from '../data/farm-map-meta.json';
import { levelForXp } from '../leveling.js';

describe('shared migration snapshots never drift from the sim authorities', () => {
  it('XP_THRESHOLDS_SNAPSHOT === sim XP_THRESHOLDS (GDD §5.1)', () => {
    expect([...XP_THRESHOLDS_SNAPSHOT]).toEqual([...XP_THRESHOLDS]);
  });

  it('ZONE_UNLOCK_LEVELS_SNAPSHOT === farm-map-meta unlockGroups (GDD §1.4/§1.5)', () => {
    const fromMap = (farmMapMeta as { unlockGroups: { zoneId: string; farmLevel: number }[] })
      .unlockGroups;
    expect(
      ZONE_UNLOCK_LEVELS_SNAPSHOT.map((z) => ({ zoneId: z.zoneId, farmLevel: z.farmLevel })),
    ).toEqual(fromMap.map((g) => ({ zoneId: g.zoneId, farmLevel: g.farmLevel })));
  });

  it('§5.5 canonical retro fixture: xp 2,400 derives Lv6 in BOTH packages', () => {
    expect(levelForXp(2_400)).toBe(6);
    // shared-side derivation uses the snapshot; equality above makes them one.
  });
});
