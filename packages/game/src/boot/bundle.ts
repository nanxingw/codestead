/**
 * bundle.ts — the boot → world handoff record (integration seam).
 *
 * PreloadScene runs the §10.4 boot machine and, on a `running` outcome, publishes
 * this bundle on the game registry next to the pre-seeded SimApi/MapMeta
 * (world/events.ts REGISTRY_KEYS). WorldScene picks it up to construct the
 * SaveManager (night/blur/hidden/manual triggers) and the SaveTransfer surface
 * for the UI (export / import / manual save, GDD §10.6).
 */
import type { SaveMeta } from '@codestead/shared';

import type { SaveStorage } from '../storage/save-storage';

export const BOOT_BUNDLE_REGISTRY_KEY = 'codestead:bootBundle';

export interface BootBundle {
  storage: SaveStorage;
  /** Meta as of the boot-time doc (SaveManager advances it on every write). */
  meta: SaveMeta;
  isNewGame: boolean;
  /** False when the new-game first write failed (§10.1: gentle export hint, keep playing). */
  persisted: boolean;
}
