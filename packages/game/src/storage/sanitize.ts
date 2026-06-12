/**
 * sanitize.ts — tolerant load pass (GDD §10.9), run on a schema-VALID SaveDoc
 * before it reaches the sim restore path.
 *
 * The shared schema deliberately keeps cropId/itemId as plain strings (forward
 * tolerance); the data tables that decide what is "known" live game-side
 * (sim/data/**), so the downgrade pass lives here:
 * - unknown cropId on a farm tile  → tile degrades to tilled-with-no-crop + warn;
 * - unknown itemId in an inventory slot → slot removed (null) + warn;
 * - unknown itemId in the shipping bin  → entry dropped + warn.
 *
 * Out-of-bounds farmTiles keys never reach this pass — FARM_TILE_KEY_REGEX
 * rejects them at the schema layer and routes the doc into recovery (§10.9).
 * Structural slot repairs (length/count clamping) are also schema-rejected in
 * M1 rather than repaired — recorded as an open question against §6.9.
 *
 * Pure: the input document is never mutated; warnings are returned for the
 * caller to surface (console.warn + gentle UI, never a scary modal).
 */
import type { SaveDocV2 } from '@codestead/shared';

import { CROPS_BY_ID, type CropId } from '../sim/data/crops';
import { ITEMS_BY_ID } from '../sim/data/items';

export interface SanitizeResult {
  doc: SaveDocV2;
  /** Human-readable downgrade notes; empty when the doc was fully known. */
  warnings: string[];
  changed: boolean;
}

/**
 * Apply the §10.9 unknown-id downgrades. Schema-valid input only (v2 since M3).
 * M3 structure LEGALITY (footprints/limits/unknown defIds) is deliberately NOT
 * handled here — that is the sim-side import sanitiser with its 100%-refund
 * reclaim channel (sim/building.ts sanitizeStructuresInPlace, GDD §8.5/US70),
 * which runs inside hydrate.
 */
export function sanitizeSaveDoc(input: SaveDocV2): SanitizeResult {
  const doc = structuredClone(input);
  const warnings: string[] = [];

  for (const [key, tile] of Object.entries(doc.world.farmTiles)) {
    if (tile.crop && !CROPS_BY_ID.has(tile.crop.cropId as CropId)) {
      warnings.push(`farmTiles[${key}]: unknown cropId '${tile.crop.cropId}' — crop removed`);
      tile.crop = null;
    }
  }

  doc.inventory.slots = doc.inventory.slots.map((slot, index) => {
    if (slot && !ITEMS_BY_ID.has(slot.itemId)) {
      warnings.push(`inventory.slots[${index}]: unknown itemId '${slot.itemId}' — slot cleared`);
      return null;
    }
    return slot;
  });

  doc.world.shippingBin = doc.world.shippingBin.filter((stack) => {
    if (!ITEMS_BY_ID.has(stack.itemId)) {
      warnings.push(`shippingBin: unknown itemId '${stack.itemId}' — entry dropped`);
      return false;
    }
    return true;
  });

  return { doc, warnings, changed: warnings.length > 0 };
}
