/**
 * SaveDoc v1 — zod schema, single source of truth for the M1 save document.
 *
 * Source of truth: docs/design/game-design.md §10.2 (field table) / §10.3 (schema notes),
 * with rulings A-13 (profession enum), A-15 (tileY ≤47, count ≤99, selectedSlot 0~8,
 * tile coords + facing) baked in.
 *
 * Contract rules (GDD §10.6):
 * - ANY field add/remove/change (incl. enum widening) bumps `schemaVersion` — no gray area.
 *   Migration chain (pure fn array v→v+1) is deferred until M3 introduces v2.
 * - Import path: JSON.parse → safeParse; failure = reject, existing save untouched (M1).
 * - Write path: safeParse self-check before persisting; failure = programming bug, do not write.
 * - `meta` is display-only and MUST NOT feed game logic; sim restore takes `RestorableSaveDoc`
 *   (SaveDoc minus meta/schemaVersion) so wall-clock data cannot reach the sim by type (§10.2).
 */
import { z } from 'zod';

export const SAVE_SCHEMA_VERSION = 1;

// ---- shared enums (GDD §2.2 / §1.6) ----

export const SeasonSchema = z.enum(['spring', 'summer', 'fall', 'winter']);
export type Season = z.infer<typeof SeasonSchema>;

export const WeatherSchema = z.enum(['sunny', 'rain']);
export type Weather = z.infer<typeof WeatherSchema>;

export const FacingSchema = z.enum(['up', 'down', 'left', 'right']);
export type Facing = z.infer<typeof FacingSchema>;

export const ProfessionSchema = z.enum(['horticulturist', 'artisan']); // ruling A-13
export type Profession = z.infer<typeof ProfessionSchema>;

// ---- farm tile state (GDD §3.1 / §10.3, save-aligned shapes) ----

export const CropStateSchema = z.strictObject({
  /** Must exist in the crop table (sim-side guard; schema keeps string for forward tolerance). */
  cropId: z.string(),
  daysGrown: z.number().int().min(0),
  mature: z.boolean(),
  /** Non-null only while a regrow crop is regrowing; 0 = back to mature at next night. */
  regrowDaysLeft: z.number().int().min(0).nullable(),
  /** Remaining regrow harvests (bean_vine 8 / berry 6); null for single-harvest crops (§3.1). */
  harvestsLeft: z.number().int().min(0).nullable(),
  /** Set by the M3 season-change event only; unreachable in M1 (sim implements with tests). */
  withered: z.boolean(),
});
export type CropState = z.infer<typeof CropStateSchema>;

export const TileStateSchema = z.strictObject({
  /** Untilled tiles are never stored (sparse table) — hence the literal. */
  tilled: z.literal(true),
  wateredToday: z.boolean(),
  crop: CropStateSchema.nullable(),
});
export type TileState = z.infer<typeof TileStateSchema>;

export const ItemStackSchema = z.strictObject({
  itemId: z.string(),
  count: z.number().int().min(1).max(99), // global stack cap 99 (ruling A-15)
});
export type ItemStack = z.infer<typeof ItemStackSchema>;

/**
 * Sparse farm-tile key `"x,y"` with map bounds 64×48 baked into the regex
 * (x 0..63, y 0..47, no leading zeros) — out-of-bounds keys are rejected at
 * the schema layer and routed into recovery (GDD §10.9).
 */
export const FARM_TILE_KEY_REGEX = /^(6[0-3]|[1-5]?\d),(4[0-7]|[1-3]?\d)$/;

// ---- SaveDoc v1 blocks (GDD §10.2 field table, M1 milestone rows) ----

/** Display-only. Never read by game logic (GDD §10.2 "真实时间不入 sim"). */
export const SaveMetaSchema = z.strictObject({
  saveId: z.uuid(),
  appVersion: z.string(),
  /** Real-clock timestamps, epoch milliseconds. Display only. */
  createdAtReal: z.number().int().min(0),
  savedAtReal: z.number().int().min(0),
  saveCount: z.number().int().min(0),
  playTimeRealSeconds: z.number().min(0),
});
export type SaveMeta = z.infer<typeof SaveMetaSchema>;

export const SaveTimeSchema = z.strictObject({
  /** Absolute day, 1-based, never wraps (GDD §2.2). */
  day: z.number().int().min(1),
  /** M1 is locked to 'spring' (GDD §10.2; see also §2.6 derived-view note). */
  season: SeasonSchema,
  /** 360..1320 = 6:00..22:00 (GDD §2.1). */
  minuteOfDay: z.number().int().min(360).max(1320),
  weatherToday: WeatherSchema,
  /** Pre-rolled at night settlement; the forecast is 100% accurate (GDD §2.2). */
  weatherTomorrow: WeatherSchema,
  /** Serialized sfc32 PRNG state, 32 hex chars (GDD §10.2). */
  rngState: z.string().regex(/^[0-9a-f]{32}$/),
});
export type SaveTime = z.infer<typeof SaveTimeSchema>;

export const SavePlayerSchema = z.strictObject({
  tileX: z.number().int().min(0).max(63),
  tileY: z.number().int().min(0).max(47), // map is 64×48 (ruling A-15)
  facing: FacingSchema,
  /** Non-negative integer gold; new game = 100; GOLD_CAP clamp lives in sim (GDD §4.1). */
  gold: z.number().int().min(0).max(9_999_999),
  /** Hotbar selection only (slots 0..8, ruling A-15). */
  selectedSlot: z.number().int().min(0).max(8),
});
export type SavePlayer = z.infer<typeof SavePlayerSchema>;

const ToolTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]); // 1 wood / 2 copper / 3 gold

export const SaveToolsSchema = z.strictObject({
  hoe: ToolTierSchema,
  wateringCan: ToolTierSchema,
});
export type SaveTools = z.infer<typeof SaveToolsSchema>;

export const SaveInventorySchema = z
  .strictObject({
    capacity: z.union([z.literal(12), z.literal(24)]),
    /** Fixed length === capacity (GDD §10.2). */
    slots: z.array(ItemStackSchema.nullable()),
  })
  .refine((inv) => inv.slots.length === inv.capacity, {
    message: 'inventory.slots length must equal capacity',
    path: ['slots'],
  });
export type SaveInventory = z.infer<typeof SaveInventorySchema>;

export const SaveWorldSchema = z.strictObject({
  /** Sparse record — only tilled tiles are stored, key "x,y" (GDD §10.2/§3.1). */
  farmTiles: z.record(z.string().regex(FARM_TILE_KEY_REGEX), TileStateSchema),
  /** Shipping bin contents; HOLDING state may be saved mid-day (GDD §4.8). */
  shippingBin: z.array(ItemStackSchema),
});
export type SaveWorld = z.infer<typeof SaveWorldSchema>;

export const SaveProgressSchema = z.strictObject({
  /** 0..15,000 (XP hard cap, GDD §5.1). farmLevel is NEVER stored — derived from xp. */
  xp: z.number().int().min(0).max(15_000),
  profession: ProfessionSchema.nullable(),
  /** Achievement counters, full instrumentation lands in M1-core (GDD §5.6 counter list). */
  counters: z.record(z.string(), z.number().int().min(0)),
  /** Append-only; unknown ids are preserved on import (forward compat, GDD §5.8). */
  achievements: z.array(z.string()),
  /** Daily XP of the last ≤3 days (settlement-screen ETA, GDD §5.5). */
  xpHistory: z.array(z.number().int().min(0)).max(3),
  /** First-sale day per itemId; recorded from M1, UI lands M3 (GDD §4.8). */
  collectionLog: z.record(z.string(), z.strictObject({ firstSoldDay: z.number().int().min(1) })),
  stats: z.strictObject({
    totalGoldEarned: z.number().int().min(0),
    totalHarvests: z.number().int().min(0),
    harvestsByCrop: z.record(z.string(), z.number().int().min(0)),
  }),
});
export type SaveProgress = z.infer<typeof SaveProgressSchema>;

/** M4 container, created empty in M1 (GDD §10.2; ruling A-15 field set). */
export const SaveQuestsSchema = z.strictObject({
  grantedQuestIds: z.array(z.string()), // reward idempotency
  completedCount: z.number().int().min(0),
  noteRefs: z.array(z.string()), // note CONTENT never enters the save
});
export type SaveQuests = z.infer<typeof SaveQuestsSchema>;

// ---- the document ----

export const SaveDocSchema = z.strictObject({
  schemaVersion: z.literal(SAVE_SCHEMA_VERSION),
  meta: SaveMetaSchema,
  time: SaveTimeSchema,
  player: SavePlayerSchema,
  tools: SaveToolsSchema,
  inventory: SaveInventorySchema,
  world: SaveWorldSchema,
  progress: SaveProgressSchema,
  quests: SaveQuestsSchema,
});
export type SaveDoc = z.infer<typeof SaveDocSchema>;

/**
 * The only shape the sim restore path may accept: meta (wall clock) and schemaVersion
 * are stripped at the type level, so "compute growth from real time" cannot compile
 * (GDD §10.2 discipline; PRD 01 US99).
 */
export type RestorableSaveDoc = Omit<SaveDoc, 'meta' | 'schemaVersion'>;
