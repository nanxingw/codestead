/**
 * new-game.ts — the new-farm onboarding flow (GDD §1.9, PRD 01 §H).
 *
 * Flow: runBootLoad → empty slot → NEW_GAME (sim builds §10.2 initial values,
 * player spawns at MapMeta.spawn — porch tile (27,11) facing down per §1.1) →
 * the scene fades in on the porch with the intro letter one tile away.
 *
 * Intro letter (`intro_letter`, GDD §1.3/§1.9): a one-shot interactable on the
 * porch — "the previous farmer's letter". Reading is an E-interaction, non-
 * modal, and it stops prompting once read. SaveDoc v1 has no dedicated field
 * for the read flag; this module reads/derives it from the forward-tolerant
 * `progress.counters` record under INTRO_LETTER_READ_COUNTER (recorded as an
 * open question — schema owner may bless or relocate it).
 */
import type { SaveDocV2 } from '@codestead/shared';

/** Map-object id of the porch letter (farm.tmj `interactables` layer, §1.5). */
export const INTRO_LETTER_INTERACTABLE_ID = 'intro_letter';

/** i18n key for the letter body (copy lives with the UI layer; text in GDD §1.9). */
export const INTRO_LETTER_TEXT_KEY = 'onboarding.intro_letter';

/**
 * Forward-tolerant counters key persisting "the letter was read". The schema
 * accepts arbitrary counter keys; the sim's CounterId union does not list it,
 * so writes go through the scene/sim integration (see boot/index.ts notes).
 */
export const INTRO_LETTER_READ_COUNTER = 'introLetterRead';

export interface IntroLetterDelivery {
  interactableId: typeof INTRO_LETTER_INTERACTABLE_ID;
  /** True ⇒ the scene shows the letter as interactable-with-prompt. */
  unread: boolean;
}

/** Decide whether the porch letter should still prompt for this save. */
export function introLetterFor(doc: SaveDocV2): IntroLetterDelivery {
  const count = doc.progress.counters[INTRO_LETTER_READ_COUNTER] ?? 0;
  return { interactableId: INTRO_LETTER_INTERACTABLE_ID, unread: count < 1 };
}

/**
 * Random seed for `newGameSim(seed, mapMeta)` — 128 bits, hex. Entropy comes
 * from crypto (allowed here: this is the boot layer, not sim/**; inside the
 * sim all randomness flows through the serialized sfc32 rngState, §2.2).
 */
export function generateSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Vite-injected app version with a safe fallback for non-Vite runs (tests). */
export function detectAppVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
}
