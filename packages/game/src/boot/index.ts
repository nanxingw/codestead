/**
 * boot/ — startup orchestration: §10.4 load state machine, new-game onboarding
 * and the visibility → pause/autosave event lines.
 *
 * Integration sketch (BootScene / WorldScene wiring, owned by the scene layer):
 *
 *   const storage = new IdbSaveStorage();
 *   const outcome = await runBootLoad({
 *     storage,
 *     appVersion: detectAppVersion(),
 *     createNewGame: () => newGameSim(generateSeed(), mapMeta).serialize(),
 *   });
 *   // running  → sim = createSim(toRestorable(outcome.doc), mapMeta);
 *   //            driver adds 'boot_gate' until the first click (audio unlock);
 *   //            new game ⇒ introLetterFor(outcome.doc).unread drives the porch letter
 *   // recovery → two options: parseImportedSave + applyImportedSave | new farm
 *   // too_new  → read-only screen, downloadSaveDoc(...) only
 *   const saves = new SaveManager({ storage, snapshot: () => sim.serialize(),
 *                                   meta: outcome.doc.meta, appVersion: detectAppVersion() });
 *   bindVisibilityPause({ addPauseSource, removePauseSource,
 *     requestAutosave: (m) => m === 'immediate' ? void saves.flushImmediate()
 *                                               : saves.requestDebouncedSave() });
 *   // NightUpdate #11: after DayEnded → void saves.saveNow('night');
 *   // pause menu "save" → void saves.saveNow('manual').
 */
export { requestPersistentStorage, runBootLoad, startNewGame } from './boot-machine';
export type { BootDeps, BootOutcome, RecoveryReason } from './boot-machine';
export {
  detectAppVersion,
  generateSeed,
  INTRO_LETTER_INTERACTABLE_ID,
  INTRO_LETTER_READ_COUNTER,
  INTRO_LETTER_TEXT_KEY,
  introLetterFor,
} from './new-game';
export type { IntroLetterDelivery } from './new-game';
export { bindVisibilityPause } from './visibility';
export type {
  VisibilityDocumentLike,
  VisibilityPauseHooks,
  VisibilityPauseSource,
  VisibilityWindowLike,
} from './visibility';
