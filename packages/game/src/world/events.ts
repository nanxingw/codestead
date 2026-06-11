/**
 * events.ts — the scene-bridge contract between WorldScene and the UI/audio/storage
 * layers. Fixed interactables (door / shop / bin / bulletin / letter / well / signs)
 * are routed by the scene layer via their object-layer `kind` and emitted as UI events;
 * they never enter the farming sim (GDD §1.7).
 *
 * All events are emitted on `game.events` (cross-scene emitter). Shared mutable
 * handles (SimApi / MapMeta / TimeDriver) are published on the game registry under
 * REGISTRY_KEYS so UIScene and the storage layer can reach them without importing
 * WorldScene.
 */
import type { DaySummary, MapMeta, TilePos } from '../sim/types';
import type { SimApi } from '../sim/sim';
import type { TimeDriver } from './time-driver';

/** Game-registry keys published by WorldScene at create() time. */
export const REGISTRY_KEYS = {
  /** SimApi facade — may be pre-seeded by the storage/boot layer before World starts. */
  sim: 'sim',
  /** MapMeta consumed by createSim/newGameSim (storage layer may pre-seed it too). */
  mapMeta: 'mapMeta',
  /** TimeDriver — UI stack contributes 'menu'/'dialog'/'day_summary' pause sources here. */
  timeDriver: 'timeDriver',
  /**
   * One-shot flag set by MainMenuScene right before scene.start('World'): the menu
   * click IS the §2.4「回到农场」gesture, so WorldScene releases the boot_gate pause
   * source on the next tick instead of waiting for a first in-world input.
   */
  menuEntry: 'menuEntry',
} as const;

export const WORLD_EVENTS = {
  /**
   * A fixed interactable was activated. `id` is the .tmj object name (house_door /
   * shipping_bin / well / shop_stall / bulletin_board / signpost_junction / gate_sign /
   * intro_letter — GDD §1.5); `kind` is the object's `kind` property (canonical
   * vocabulary: door / shipping_bin / well / shop / bulletin_board / sign / letter).
   * UI routes on `kind`; kind 'door' should present the sleep confirm (ruling A-20)
   * and then emit `sleepConfirmed`.
   */
  interactable: 'world:interactable',
  /** UI → world: the sleep confirm was accepted; world runs the §2.5 night flow. */
  sleepConfirmed: 'world:sleep_confirmed',
  /** World → UI: night settlement done, fade-out finished — show the day summary. */
  daySummary: 'world:day_summary',
  /** UI → world: summary dismissed (any key after the 400ms grace); world fades in. */
  daySummaryDismissed: 'world:day_summary_dismissed',
  /** Esc pressed during play — UI opens the pause menu (GDD §6.8). */
  openMenu: 'world:open_menu',
  /** Tab / I pressed during play — UI opens the inventory (GDD §6.8). */
  openInventory: 'world:open_inventory',
  /** Driver pause-state changes (audio suspends on pause; GDD §2.4). */
  paused: 'world:paused',
  resumed: 'world:resumed',
} as const;

export interface InteractablePayload {
  id: string;
  kind: string;
  tile: TilePos;
}

export interface DaySummaryPayload {
  summary: DaySummary;
}

/** Typed views over the registry (registry get() is untyped in Phaser). */
export interface WorldRegistry {
  sim: SimApi | null;
  mapMeta: MapMeta;
  timeDriver: TimeDriver;
}
