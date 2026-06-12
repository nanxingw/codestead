/**
 * M1+M3 item table — transcribed from game-design.md §6.1 (prefix naming, ruling A-14).
 *
 * Authority: GDD §6.1 (categories, stack caps, sellability) + §3.6 (prices via crop
 * table) + §8.1/§8.2 (M3 materials, egg, processed goods — PRD 04 US75: every new item
 * goes through this table, prefix-style ids, pricing via unitSalePrice only).
 * itemId discipline: seeds = `seed_<cropId>`, crops = `crop_<cropId>` — identical to shop
 * entryIds (§4.3) and texture frame keys (§11.4). bean_vine's product is `crop_bean_vine`
 * (display name "豆荚" via nameKey); there is NO separate bean_pod id (ruling A-14).
 *
 * M3 id coinage (PRD 04 待裁决 5 — settled by this contract pass, recorded openQuestions):
 *   `animal_egg`               40g  — category 'material' (no `animal_good` category
 *     exists in §6.1 and adding one needs a GDD revision; precedent: forage_wildflower
 *     is also semantically-prefixed but category material. Keeps eggs OUT of the
 *     horticulturist crop ×1.10 multiplier, which §4.5 scopes to category 'crop').
 *   `artisan_mayonnaise`       95g  — artisan_good (workshop, 1 night).
 *   `artisan_jam_<cropId>`          — artisan_good, floor(2×crop sellPrice+25) (§8.2).
 *   `artisan_dried_<cropId>`        — artisan_good, floor(1.4×crop sellPrice) (A-12).
 *   `axe` / `pickaxe`               — tools (§8.1); tierless, no ToolTiers slot.
 * Processed goods carry NO quality (conservative reading: quality is harvest-only,
 * §4.5; processing any-quality input yields a normal-quality product).
 *
 * NOTE: the GDD §6.1 heading says "16 个 id" but the table enumerates 17; the sickle
 * (needed by §3.2/§3.3 clear actions) is absent from the table — both recorded as
 * open questions for the owner. This file transcribes exactly what the table lists.
 */
import { PROCESSING } from './buildings.js';
import { CROPS, M1_CROP_IDS, type CropId } from './crops.js';

export type ItemCategory = 'tool' | 'seed' | 'crop' | 'material' | 'artisan_good' | 'quest';

export interface ItemDef {
  readonly id: string;
  /** i18n key. Convention: `item.<id>`. */
  readonly nameKey: string;
  readonly category: ItemCategory;
  readonly stackMax: 1 | 99;
  /**
   * Base unit sale price (GDD §4.5: the ONLY input to unitSalePrice).
   * Seeds: equals seedPrice but is refund-only (100% instant refund, ruling A-11) —
   * they never go through the shipping bin. Absent = not sellable (tool/quest).
   */
  readonly sellPrice?: number;
  readonly discardable: boolean;
  /** Texture frame key (see AssetKeys.ts; §11.4 contract). */
  readonly iconFrame: string;
  /** Present on seed_* and crop_* items; links back to the crop table. */
  readonly cropId?: CropId;
}

const seedItems: ItemDef[] = M1_CROP_IDS.map((cropId) => {
  const crop = CROPS.find((c) => c.id === cropId);
  if (!crop) throw new Error(`crop table missing ${cropId}`);
  return {
    id: `seed_${cropId}`,
    nameKey: `item.seed_${cropId}`,
    category: 'seed',
    stackMax: 99,
    sellPrice: crop.seedPrice, // refund-only (ruling A-11)
    discardable: true,
    iconFrame: `seed_${cropId}`,
    cropId,
  } as const;
});

const cropItems: ItemDef[] = M1_CROP_IDS.map((cropId) => {
  const crop = CROPS.find((c) => c.id === cropId);
  if (!crop) throw new Error(`crop table missing ${cropId}`);
  return {
    id: `crop_${cropId}`,
    nameKey: `item.crop_${cropId}`,
    category: 'crop',
    stackMax: 99,
    sellPrice: crop.sellPrice, // overnight consignment via shipping bin (ruling A-1)
    discardable: true,
    iconFrame: `item_${cropId}`,
    cropId,
  } as const;
});

// ---- M3 additions (GDD §8.1/§8.2; PRD 04 US75 — see header for id coinage) ----

const jamItems: ItemDef[] = M1_CROP_IDS.map((cropId) => {
  const crop = CROPS.find((c) => c.id === cropId);
  if (!crop) throw new Error(`crop table missing ${cropId}`);
  return {
    id: `artisan_jam_${cropId}`,
    nameKey: `item.artisan_jam_${cropId}`,
    category: 'artisan_good',
    stackMax: 99,
    sellPrice: PROCESSING.JAM.price(crop.sellPrice), // floor(2×sell+25), §8.2
    discardable: true,
    iconFrame: `item_jam_${cropId}`,
    cropId,
  } as const;
});

const driedItems: ItemDef[] = M1_CROP_IDS.map((cropId) => {
  const crop = CROPS.find((c) => c.id === cropId);
  if (!crop) throw new Error(`crop table missing ${cropId}`);
  return {
    id: `artisan_dried_${cropId}`,
    nameKey: `item.artisan_dried_${cropId}`,
    category: 'artisan_good',
    stackMax: 99,
    sellPrice: PROCESSING.DRIED.price(crop.sellPrice), // floor(1.4×sell), ruling A-12
    discardable: true,
    iconFrame: `item_dried_${cropId}`,
    cropId,
  } as const;
});

const m3Items: ItemDef[] = [
  {
    id: 'axe', // clears trees, 5 wood each (§8.1); tierless in M3
    nameKey: 'item.axe',
    category: 'tool',
    stackMax: 1,
    discardable: false,
    iconFrame: 'tool_axe_t1',
  },
  {
    id: 'pickaxe', // clears boulders, 3 stone each (§8.1); tierless in M3
    nameKey: 'item.pickaxe',
    category: 'tool',
    stackMax: 1,
    discardable: false,
    iconFrame: 'tool_pickaxe_t1',
  },
  {
    id: 'animal_egg', // 1/hen/night from the coop (§8.2); 40g
    nameKey: 'item.animal_egg',
    category: 'material', // see header — deliberate, keeps §4.5 multipliers clean
    stackMax: 99,
    sellPrice: 40,
    discardable: true,
    iconFrame: 'item_egg',
  },
  {
    id: 'artisan_mayonnaise', // 1 egg → 1 night → 95g (§8.2)
    nameKey: 'item.artisan_mayonnaise',
    category: 'artisan_good',
    stackMax: 99,
    sellPrice: PROCESSING.MAYONNAISE.price,
    discardable: true,
    iconFrame: 'item_mayonnaise',
  },
  ...jamItems,
  ...driedItems,
];

/** The item list (GDD §6.1 M1 table + M3 additions; tools first — new-save loadout). */
export const ITEMS: readonly ItemDef[] = [
  {
    id: 'hoe',
    nameKey: 'item.hoe',
    category: 'tool',
    stackMax: 1,
    discardable: false,
    iconFrame: 'tool_hoe_t1', // render layer swaps t{1..3} from ToolTiers
  },
  {
    id: 'watering_can',
    nameKey: 'item.watering_can',
    category: 'tool',
    stackMax: 1,
    discardable: false,
    iconFrame: 'tool_can_t1',
  },
  ...seedItems,
  ...cropItems,
  {
    id: 'material_wood',
    nameKey: 'item.material_wood',
    category: 'material',
    stackMax: 99,
    sellPrice: 5, // GDD §6.1/§1.3; sale via shipping bin only in M1
    discardable: true,
    iconFrame: 'item_wood',
  },
  {
    id: 'material_stone',
    nameKey: 'item.material_stone',
    category: 'material',
    stackMax: 99,
    sellPrice: 3,
    discardable: true,
    iconFrame: 'item_stone',
  },
  {
    id: 'forage_wildflower',
    nameKey: 'item.forage_wildflower',
    category: 'material',
    stackMax: 99,
    sellPrice: 8,
    discardable: true,
    iconFrame: 'item_wildflower',
  },
  ...m3Items,
];

/** Narrow id union (M1 set + M3 additions; template members from the 6 M1 crops). */
export type ItemId =
  | 'hoe'
  | 'watering_can'
  | `seed_${(typeof M1_CROP_IDS)[number]}`
  | `crop_${(typeof M1_CROP_IDS)[number]}`
  | 'material_wood'
  | 'material_stone'
  | 'forage_wildflower'
  // M3 (GDD §8.1/§8.2; PRD 04 US75)
  | 'axe'
  | 'pickaxe'
  | 'animal_egg'
  | 'artisan_mayonnaise'
  | `artisan_jam_${(typeof M1_CROP_IDS)[number]}`
  | `artisan_dried_${(typeof M1_CROP_IDS)[number]}`;

export const ITEMS_BY_ID: ReadonlyMap<string, ItemDef> = new Map(ITEMS.map((i) => [i.id, i]));

export function getItemDef(itemId: string): ItemDef {
  const def = ITEMS_BY_ID.get(itemId);
  if (!def) throw new Error(`Unknown itemId: ${itemId}`);
  return def;
}

/** seed_<cropId> / crop_<cropId> helpers — keep the prefix discipline in one place. */
export function seedItemId(cropId: CropId): ItemId {
  return `seed_${cropId}` as ItemId;
}
export function cropItemId(cropId: CropId): ItemId {
  return `crop_${cropId}` as ItemId;
}
/** M3 processed-good helpers (same prefix discipline; PRD 04 US75 / 待裁决 5). */
export function jamItemId(cropId: CropId): ItemId {
  return `artisan_jam_${cropId}` as ItemId;
}
export function driedItemId(cropId: CropId): ItemId {
  return `artisan_dried_${cropId}` as ItemId;
}
