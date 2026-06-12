/**
 * SaveDoc v2 — zod schema, single source of truth for the M3 save document.
 *
 * Sources of truth: docs/design/game-design.md §10.2 (v2 row: structures / quality /
 * sprinkler layout), §8.4 (BlueprintDef / PlacedStructure data contract), §8.2 (facility
 * numbers: chest 24 slots, drying rack 2 slots, workshop 6 slots, coop ≤4 hens),
 * §4.5 (quality enum normal/silver/gold), §5.3 (profession — already in v1);
 * PRD 04 §M (migration chain paradigm) — see save-migrations.ts.
 *
 * v1 (save.ts) is FROZEN from this commit on: it exists only as the migration source
 * shape and must never change again (GDD §10.6 "任何字段增删改必升版本").
 *
 * v2 delta over v1 (every addition cited):
 * - `world.structures`        PlacedStructure[] (GDD §8.4; BuildModeState NEVER saved)
 * - `world.sprinklers`        flat sprinkler layout (GDD §10.2 v2 row / §3.8 reserve;
 *                             tier 1 = 4-neighbour @Lv6, tier 2 = 3×3 @Lv8, §5.3)
 * - `world.farmhouse`         farmhouse upgrade chain state (stage 0/1/2 + in-progress
 *                             order). NOT in the §10.2 v2 enumeration but structurally
 *                             required by §8.2 升级链 persistence — recorded as an open
 *                             question for GDD §10.2 backfill.
 * - `world.unlockedZones`     backlog B-2 resolution: v2 is the sanctioned migration
 *                             window, so the field enters the save here (never v1).
 * - `world.clearedResourceNodes`  ids of map trees/boulders permanently cleared by
 *                             axe/pickaxe (GDD §8.1 initial stock ≈200 wood + 90 stone;
 *                             without persistence a reload would respawn them). Also
 *                             beyond the §10.2 enumeration — recorded for backfill.
 * - `ItemStack.quality`       optional 'silver' | 'gold' on item stacks (inventory,
 *                             shipping bin, chest slots). Absent = normal — which makes
 *                             every v1 stack a valid v2 stack with zero data loss.
 *   Quality GENERATION mechanics are owner-pending (PRD 04 待裁决 1); the schema only
 *   carries the value, per §4.5 (multipliers are settled: silver 1.25 / gold 1.5).
 *
 * NOT added (deliberately):
 * - daily pickup spot state — backlog B-7 is an owner-adjudicated item this milestone
 *   was not authorised to settle; behaviour stays "reload may re-pickup ≤66g/day".
 * - season unlock / T4 crops — PRD 04 Out of Scope (B-11 pending).
 * - settings/audio volumes — never enter the SaveDoc (ruling A-10).
 */
import { z } from 'zod';

import {
  FacingSchema,
  FARM_TILE_KEY_REGEX,
  ProfessionSchema,
  SaveMetaSchema,
  SeasonSchema,
  TileStateSchema,
  WeatherSchema,
} from './save.js';

export const SAVE_SCHEMA_VERSION_V2 = 2;

// ---- quality (GDD §4.5; generation mechanics pending, multipliers settled) ----

export const QualitySchema = z.enum(['normal', 'silver', 'gold']);
export type Quality = z.infer<typeof QualitySchema>;

/**
 * v2 item stack: v1 shape + optional quality. `quality` absent ⇒ 'normal' (so v1
 * stacks migrate untouched). Sim-side discipline: only `crop` category items may
 * carry silver/gold (PRD 04 conservative reading of §4.5 — processing outputs and
 * materials are always normal); the schema stays permissive for forward tolerance.
 */
export const ItemStackV2Schema = z.strictObject({
  itemId: z.string(),
  count: z.number().int().min(1).max(99), // global stack cap 99 (ruling A-15)
  quality: QualitySchema.exclude(['normal']).optional(),
});
export type ItemStackV2 = z.infer<typeof ItemStackV2Schema>;

// ---- placed structures (GDD §8.4 data contract, zod-ified) ----

/**
 * One in-flight processing job (drying rack / workshop slot).
 * `daysLeft` counts settlement nights; 0 = done, waiting for pickup (goods sit in the
 * slot forever — zero-loss red line, GDD §0.5 / PRD 04 零恶化).
 */
export const ProcessingJobSchema = z.strictObject({
  inputItemId: z.string(),
  outputItemId: z.string(),
  daysLeft: z.number().int().min(0),
});
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>;

/** Chest: 24 storage slots (GDD §8.2 storage_chest). Fixed length, null = empty. */
export const ChestDataSchema = z.strictObject({
  kind: z.literal('chest'),
  slots: z.array(ItemStackV2Schema.nullable()).length(24),
});

/** Drying rack: 2 slots (GDD §8.2 drying_rack). */
export const DryingRackDataSchema = z.strictObject({
  kind: z.literal('dryingRack'),
  jobs: z.array(ProcessingJobSchema.nullable()).length(2),
});

/**
 * Coop: ≤4 hens (2 granted at completion, buy 200g / sell 100g — ruling A-6);
 * `eggsReady` accumulates 1/hen/settlement-night with NO cap (PRD 04 test contract
 * "满 4 鸡快进 N 天断言产蛋累计 = 4N"; leaving never loses anything).
 */
export const CoopDataSchema = z.strictObject({
  kind: z.literal('coop'),
  hens: z.number().int().min(0).max(4),
  eggsReady: z.number().int().min(0),
});

/** Workshop: 6 processing slots (GDD §8.2 workshop). */
export const WorkshopDataSchema = z.strictObject({
  kind: z.literal('workshop'),
  jobs: z.array(ProcessingJobSchema.nullable()).length(6),
});

export const StructureDataSchema = z.discriminatedUnion('kind', [
  ChestDataSchema,
  DryingRackDataSchema,
  CoopDataSchema,
  WorkshopDataSchema,
]);
export type StructureData = z.infer<typeof StructureDataSchema>;

/**
 * A placed structure instance (GDD §8.4). `defId` references the blueprint table
 * (game/src/sim/data/buildings.ts); unknown defIds are schema-tolerated (string) and
 * handled by the sim import sanitiser (reclaim + 100% refund, never silent delete —
 * GDD §8.5 / PRD 04 US70).
 */
export const PlacedStructureSchema = z
  .strictObject({
    instanceId: z.string().min(1),
    defId: z.string().min(1),
    origin: z.strictObject({
      x: z.number().int().min(0).max(63),
      y: z.number().int().min(0).max(47),
    }),
    state: z.enum(['underConstruction', 'built']),
    /** Settlement nights to completion; present iff underConstruction (refined below). */
    daysLeft: z.number().int().min(1).optional(),
    data: StructureDataSchema.optional(),
  })
  .refine((s) => (s.state === 'underConstruction') === (s.daysLeft !== undefined), {
    message: 'daysLeft must be present iff state is underConstruction',
    path: ['daysLeft'],
  });
export type PlacedStructure = z.infer<typeof PlacedStructureSchema>;

/** Sprinkler layout entry (GDD §3.8/§5.3): tier 1 = 4-neighbour, tier 2 = 3×3. */
export const SprinklerSchema = z.strictObject({
  x: z.number().int().min(0).max(63),
  y: z.number().int().min(0).max(47),
  tier: z.union([z.literal(1), z.literal(2)]),
});
export type Sprinkler = z.infer<typeof SprinklerSchema>;

/**
 * Farmhouse upgrade chain (GDD §8.2 房屋升级链): stage 0 = base, 1 = renovated
 * (farmhouse_1, Lv6), 2 = expanded (farmhouse_2, Lv10, requires stage 1).
 * `construction` non-null while an upgrade order is in progress (2 settlement nights;
 * the farmhouse stays usable throughout, §8.2). Not placeable/demolishable (§8.3).
 */
export const FarmhouseStateSchema = z.strictObject({
  stage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  construction: z
    .strictObject({
      targetStage: z.union([z.literal(1), z.literal(2)]),
      nightsLeft: z.number().int().min(1).max(2),
    })
    .nullable(),
});
export type FarmhouseState = z.infer<typeof FarmhouseStateSchema>;

// ---- v2 blocks (unchanged v1 blocks are reused from save.ts by reference) ----

export const SaveTimeV2Schema = z.strictObject({
  day: z.number().int().min(1),
  season: SeasonSchema,
  minuteOfDay: z.number().int().min(360).max(1320),
  weatherToday: WeatherSchema,
  weatherTomorrow: WeatherSchema,
  rngState: z.string().regex(/^[0-9a-f]{32}$/),
});

export const SavePlayerV2Schema = z.strictObject({
  tileX: z.number().int().min(0).max(63),
  tileY: z.number().int().min(0).max(47),
  facing: FacingSchema,
  gold: z.number().int().min(0).max(9_999_999),
  selectedSlot: z.number().int().min(0).max(8),
});

const ToolTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * v2 keeps the v1 tool-tier block shape: axe/pickaxe (GDD §8.1, M3) are tierless and
 * exist purely as inventory items, so they need no tier slot here.
 */
export const SaveToolsV2Schema = z.strictObject({
  hoe: ToolTierSchema,
  wateringCan: ToolTierSchema,
});

export const SaveInventoryV2Schema = z
  .strictObject({
    capacity: z.union([z.literal(12), z.literal(24)]),
    slots: z.array(ItemStackV2Schema.nullable()),
  })
  .refine((inv) => inv.slots.length === inv.capacity, {
    message: 'inventory.slots length must equal capacity',
    path: ['slots'],
  });

export const SaveWorldV2Schema = z.strictObject({
  farmTiles: z.record(z.string().regex(FARM_TILE_KEY_REGEX), TileStateSchema),
  shippingBin: z.array(ItemStackV2Schema),
  /** GDD §8.4: PlacedStructure[] enters the save; BuildModeState (UI) never does. */
  structures: z.array(PlacedStructureSchema),
  /** GDD §10.2 v2 row "洒水器布置". */
  sprinklers: z.array(SprinklerSchema),
  /** GDD §8.2 farmhouse upgrade chain (see header note re §10.2 backfill). */
  farmhouse: FarmhouseStateSchema,
  /**
   * Unlocked field zone ids (backlog B-2, settled via the v2 window): subset of
   * {'field_a','field_b','field_c'}; field_a is always present on a healthy save.
   */
  unlockedZones: z.array(z.string()),
  /** Map resource nodes (trees/boulders) permanently cleared by axe/pickaxe (§8.1). */
  clearedResourceNodes: z.array(z.string()),
});

export const SaveProgressV2Schema = z.strictObject({
  xp: z.number().int().min(0).max(15_000),
  profession: ProfessionSchema.nullable(),
  counters: z.record(z.string(), z.number().int().min(0)),
  achievements: z.array(z.string()),
  xpHistory: z.array(z.number().int().min(0)).max(3),
  collectionLog: z.record(z.string(), z.strictObject({ firstSoldDay: z.number().int().min(1) })),
  stats: z.strictObject({
    totalGoldEarned: z.number().int().min(0),
    totalHarvests: z.number().int().min(0),
    harvestsByCrop: z.record(z.string(), z.number().int().min(0)),
  }),
});

export const SaveQuestsV2Schema = z.strictObject({
  grantedQuestIds: z.array(z.string()),
  completedCount: z.number().int().min(0),
  noteRefs: z.array(z.string()),
});

// ---- the v2 document ----

export const SaveDocV2Schema = z.strictObject({
  schemaVersion: z.literal(SAVE_SCHEMA_VERSION_V2),
  meta: SaveMetaSchema,
  time: SaveTimeV2Schema,
  player: SavePlayerV2Schema,
  tools: SaveToolsV2Schema,
  inventory: SaveInventoryV2Schema,
  world: SaveWorldV2Schema,
  progress: SaveProgressV2Schema,
  quests: SaveQuestsV2Schema,
});
export type SaveDocV2 = z.infer<typeof SaveDocV2Schema>;

/** Same "wall clock never reaches the sim" discipline as v1 (GDD §10.2). */
export type RestorableSaveDocV2 = Omit<SaveDocV2, 'meta' | 'schemaVersion'>;
