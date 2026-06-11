/**
 * data/achievements.ts — the 22-achievement authority table (GDD §5.6, ids verbatim).
 *
 * Data-driven by contract (PRD 02 §F37): the FULL table ships in M1.5; entries whose
 * `milestone` is not yet live are inert data — their counters never move in this build
 * and the engine (sim/achievements.ts) additionally gates unlocking by milestone, so
 * M3/M4 light up #15~#22 by widening that gate, zero engine changes.
 *
 * Rewards are the §5.6 table values. Invariants guarded by unit tests (§5.6):
 *   - level/XP-dependent achievements (#21 farm_master / #22 mastery) have xp === 0;
 *   - Σ xp over the M1.5 set (#1~#14) === 305;
 *   - Σ gold over the M1.5 set === 340 (paid instantly to the wallet, GDD §4.7).
 *
 * Display names/conditions are render-side (ui/strings.ts `achv.<id>.*`) — this table
 * carries rules only, per the "display strings never live in sim" discipline.
 */
import type { CounterId, Profession, ToolTiers } from '../types.js';

import { XP_CAP, XP_THRESHOLDS } from './constants.js';
import { M1_CROP_IDS } from './crops.js';

/** §5.6 table ids, verbatim (#1 first_till … #22 mastery). */
export type AchievementId =
  | 'first_till'
  | 'first_seed'
  | 'first_harvest'
  | 'first_sale'
  | 'rain_blessing'
  | 'first_sunrise'
  | 'nest_egg'
  | 'moneybags'
  | 'hundred_harvests'
  | 'steady_hands'
  | 'tooled_up'
  | 'gilded'
  | 'six_crops'
  | 'regrow_expert'
  | 'homestead'
  | 'tycoon'
  | 'automation_dream'
  | 'signed_papers'
  | 'first_quest'
  | 'notebook'
  | 'farm_master'
  | 'mastery';

/** §5.6 "实装" column. */
export type AchievementMilestone = 'M1.5' | 'M3' | 'M4';

/** Read-only view the predicates run against (counters + tool tiers + xp, PRD 02 §3). */
export interface ProgressView {
  readonly counters: Readonly<Partial<Record<CounterId, number>>>;
  readonly tools: Readonly<ToolTiers>;
  readonly xp: number;
  readonly profession: Profession | null;
}

/** Live progress for the achievements page ("37/100", GDD §5.8). */
export interface AchievementProgress {
  current: number;
  target: number;
}

export interface AchievementDef {
  readonly id: AchievementId;
  /** §5.6 table row number (1..22) — display & deterministic unlock-sweep order. */
  readonly num: number;
  readonly milestone: AchievementMilestone;
  readonly predicate: (view: ProgressView) => boolean;
  readonly progress: (view: ProgressView) => AchievementProgress;
  /** §5.6 reward column. Gold is paid instantly to the wallet (no shipping bin). */
  readonly reward: { readonly xp: number; readonly gold: number };
}

/** Most rows are a single counter threshold (§5.6 "多数 = 单计数器阈值"). */
function counterAtLeast(
  id: CounterId,
  target: number,
): Pick<AchievementDef, 'predicate' | 'progress'> {
  return {
    predicate: (view) => (view.counters[id] ?? 0) >= target,
    progress: (view) => ({ current: Math.min(view.counters[id] ?? 0, target), target }),
  };
}

/** #13 six_crops: how many of the six M1 starter crops have been sold at least once. */
function soldCropKinds(view: ProgressView): number {
  return M1_CROP_IDS.filter((cropId) => (view.counters[`soldCrops:${cropId}`] ?? 0) >= 1).length;
}

/** #12 gilded: how many of the two tools sit at the gold tier (tier 3, GDD §3.5). */
function goldTierTools(view: ProgressView): number {
  return (view.tools.hoe === 3 ? 1 : 0) + (view.tools.wateringCan === 3 ? 1 : 0);
}

/** Cumulative XP that means "reached Lv10" (#21; level is always derived, §5.1). */
const LV10_XP = XP_THRESHOLDS[9];

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // ---- M1.5 (#1~#14) — unlockable in the M1 release ----
  {
    id: 'first_till',
    num: 1,
    milestone: 'M1.5',
    ...counterAtLeast('tillCount', 1),
    reward: { xp: 5, gold: 0 },
  },
  {
    id: 'first_seed',
    num: 2,
    milestone: 'M1.5',
    ...counterAtLeast('plantCount', 1),
    reward: { xp: 5, gold: 0 },
  },
  {
    id: 'first_harvest',
    num: 3,
    milestone: 'M1.5',
    ...counterAtLeast('harvestCount', 1),
    reward: { xp: 10, gold: 20 },
  },
  {
    id: 'first_sale',
    num: 4,
    milestone: 'M1.5',
    ...counterAtLeast('sellCount', 1),
    reward: { xp: 10, gold: 20 },
  },
  {
    id: 'rain_blessing',
    num: 5,
    milestone: 'M1.5',
    ...counterAtLeast('rainDaysSeen', 1),
    reward: { xp: 10, gold: 0 },
  },
  {
    id: 'first_sunrise',
    num: 6,
    milestone: 'M1.5',
    ...counterAtLeast('sleepCount', 1),
    reward: { xp: 5, gold: 0 },
  },
  {
    id: 'nest_egg',
    num: 7,
    milestone: 'M1.5',
    ...counterAtLeast('goldEarned', 1_000),
    reward: { xp: 25, gold: 0 },
  },
  {
    id: 'moneybags',
    num: 8,
    milestone: 'M1.5',
    ...counterAtLeast('goldEarned', 10_000),
    reward: { xp: 50, gold: 200 },
  },
  {
    id: 'hundred_harvests',
    num: 9,
    milestone: 'M1.5',
    ...counterAtLeast('harvestCount', 100),
    reward: { xp: 30, gold: 0 },
  },
  {
    id: 'steady_hands',
    num: 10,
    milestone: 'M1.5',
    ...counterAtLeast('waterCount', 200),
    reward: { xp: 20, gold: 0 },
  },
  {
    id: 'tooled_up',
    num: 11,
    milestone: 'M1.5',
    ...counterAtLeast('toolUpgrades', 1),
    reward: { xp: 20, gold: 0 },
  },
  {
    id: 'gilded',
    num: 12,
    milestone: 'M1.5',
    predicate: (view) => goldTierTools(view) === 2,
    progress: (view) => ({ current: goldTierTools(view), target: 2 }),
    reward: { xp: 40, gold: 0 },
  },
  {
    id: 'six_crops',
    num: 13,
    milestone: 'M1.5',
    predicate: (view) => soldCropKinds(view) >= M1_CROP_IDS.length,
    progress: (view) => ({ current: soldCropKinds(view), target: M1_CROP_IDS.length }),
    reward: { xp: 50, gold: 100 },
  },
  {
    id: 'regrow_expert',
    num: 14,
    milestone: 'M1.5',
    ...counterAtLeast('regrowChainMax', 4),
    reward: { xp: 25, gold: 0 },
  },

  // ---- M3 (#15~#18, #21, #22) — data in place; counters/gate open in M3 ----
  {
    id: 'homestead',
    num: 15,
    milestone: 'M3',
    ...counterAtLeast('buildingsBuilt', 1),
    reward: { xp: 50, gold: 0 },
  },
  {
    id: 'tycoon',
    num: 16,
    milestone: 'M3',
    // 三种建筑齐 — canonical building ids from GDD §8.2 (coop / workshop / greenhouse).
    predicate: (view) =>
      (['coop', 'workshop', 'greenhouse'] as const).every(
        (b) => (view.counters[`built:${b}`] ?? 0) >= 1,
      ),
    progress: (view) => ({
      current: (['coop', 'workshop', 'greenhouse'] as const).filter(
        (b) => (view.counters[`built:${b}`] ?? 0) >= 1,
      ).length,
      target: 3,
    }),
    reward: { xp: 100, gold: 500 },
  },
  {
    id: 'automation_dream',
    num: 17,
    milestone: 'M3',
    ...counterAtLeast('sprinklersPlaced', 1),
    reward: { xp: 30, gold: 0 },
  },
  {
    id: 'signed_papers',
    num: 18,
    milestone: 'M3',
    predicate: (view) => view.profession !== null,
    progress: (view) => ({ current: view.profession !== null ? 1 : 0, target: 1 }),
    reward: { xp: 0, gold: 0 }, // 纪念性（0 XP）
  },

  // ---- M4 (#19, #20) ----
  {
    id: 'first_quest',
    num: 19,
    milestone: 'M4',
    ...counterAtLeast('questsCompleted', 1),
    reward: { xp: 0, gold: 0 },
  }, // quest reward 已发
  {
    id: 'notebook',
    num: 20,
    milestone: 'M4',
    ...counterAtLeast('notesWritten', 10),
    reward: { xp: 30, gold: 0 },
  },

  // ---- M3 long-line (#21, #22) — xp MUST stay 0 (anti feedback loop, §5.6 invariant) ----
  {
    id: 'farm_master',
    num: 21,
    milestone: 'M3',
    predicate: (view) => view.xp >= LV10_XP,
    progress: (view) => ({ current: Math.min(view.xp, LV10_XP), target: LV10_XP }),
    reward: { xp: 0, gold: 1_000 }, // + 纪念雕像 (item form deferred to M3, PRD 02 §7)
  },
  {
    id: 'mastery',
    num: 22,
    milestone: 'M3',
    predicate: (view) => view.xp >= XP_CAP,
    progress: (view) => ({ current: Math.min(view.xp, XP_CAP), target: XP_CAP }),
    reward: { xp: 0, gold: 0 }, // + 金色牌匾 (item form deferred to M3, PRD 02 §7)
  },
];

export const ACHIEVEMENTS_BY_ID: ReadonlyMap<AchievementId, AchievementDef> = new Map(
  ACHIEVEMENTS.map((def) => [def.id, def]),
);

/** The #1~#14 slice shown by the M1 achievements page (#15~#22 stay invisible, §5.3 折叠纪律). */
export const M1_5_ACHIEVEMENTS: readonly AchievementDef[] = ACHIEVEMENTS.filter(
  (def) => def.milestone === 'M1.5',
);
