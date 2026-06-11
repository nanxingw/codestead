/**
 * save-transfer.ts — the SaveTransfer implementation handed to the UI layer
 * (ui/context.ts contract; consumed by the pause menu & settings panel).
 *
 * Export: live snapshot + current meta → SaveDoc → pretty-printed download
 * (storage/export-import.ts). Import: parse/validate/sanitize purely; on success
 * the slot is replaced and the page reloads so the §10.4 boot machine restores
 * the imported world (M1 has no hot-swap path). Any failure leaves the existing
 * save byte-identical (GDD §10.6 / PRD 01 US93).
 */
import type { RestorableSaveDoc } from '@codestead/shared';

import { applyImportedSave, downloadSaveDoc, parseImportedSave } from '../storage/export-import';
import { composeSaveDoc, validateSaveDoc } from '../storage/save-codec';
import type { SaveManager } from '../storage/save-manager';
import type { SaveStorage } from '../storage/save-storage';
import type { SaveTransfer } from '../ui/context';
import { t } from '../ui/strings';

/** Long enough for the settings panel to show 「导入完成」 before the reload. */
const IMPORT_RELOAD_DELAY_MS = 600;

export function makeSaveTransfer(deps: {
  storage: SaveStorage;
  saves: SaveManager;
  /** Live snapshot provider — WorldScene's player-synced SimApi.serialize. */
  snapshot: () => RestorableSaveDoc;
}): SaveTransfer {
  return {
    exportSave(): Promise<void> {
      const validated = validateSaveDoc(composeSaveDoc(deps.snapshot(), deps.saves.meta));
      if (!validated.ok) {
        // Self-check failure is a programming bug (§10.4); never export garbage.
        console.warn('[save] export self-check failed:', validated.issues);
        return Promise.resolve();
      }
      downloadSaveDoc(validated.doc);
      return Promise.resolve();
    },

    async importSave(file: File): Promise<{ ok: boolean }> {
      const parsed = parseImportedSave(await file.text());
      if (!parsed.ok) {
        console.warn(`[save] import rejected at ${parsed.stage}:`, parsed.issues);
        return { ok: false };
      }
      try {
        await applyImportedSave(deps.storage, parsed.doc);
      } catch (error) {
        console.warn('[save] import write failed; existing save untouched:', error);
        return { ok: false };
      }
      // Stop further autosaves from clobbering the imported slot, then reboot into it.
      deps.saves.dispose();
      window.setTimeout(() => window.location.reload(), IMPORT_RELOAD_DELAY_MS);
      return { ok: true };
    },

    manualSave(): Promise<boolean> {
      return deps.saves.saveNow('manual');
    },

    storageStatusText(): string {
      return t('settings.storage_ok'); // M1: IDB path only (受限/内存模式 are M5)
    },
  };
}
