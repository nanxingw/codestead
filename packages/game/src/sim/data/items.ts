/**
 * M1 item table — transcribed from game-design.md §6.1 (prefix naming, ruling A-14).
 *
 * Authority: GDD §6.1 (categories, stack caps, sellability) + §3.6 (prices via crop table).
 * itemId discipline: seeds = `seed_<cropId>`, crops = `crop_<cropId>` — identical to shop
 * entryIds (§4.3) and texture frame keys (§11.4). bean_vine's product is `crop_bean_vine`
 * (display name "豆荚" via nameKey); there is NO separate bean_pod id (ruling A-14).
 *
 * NOTE: the GDD §6.1 heading says "16 个 id" but the table enumerates 17; the sickle
 * (needed by §3.2/§3.3 clear actions) is absent from the table — both recorded as
 * open questions for the owner. This file transcribes exactly what the table lists.
 */
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

/** The M1 item list (GDD §6.1 table; tools first — new-save loadout is slot0/slot1). */
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
];

/** Narrow id union for M1 items (template-literal members come from the 6 M1 crops). */
export type ItemId =
  | 'hoe'
  | 'watering_can'
  | `seed_${(typeof M1_CROP_IDS)[number]}`
  | `crop_${(typeof M1_CROP_IDS)[number]}`
  | 'material_wood'
  | 'material_stone'
  | 'forage_wildflower';

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
