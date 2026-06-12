/**
 * build-bridge.ts — the narrow seam between the build UI (UIScene panels) and the
 * world-side placing controller (M3, GDD §8.3; PRD 04 §A).
 *
 * The §8.3 machine spans two scenes: CATALOG/CONFIRM are UIScene panels (menu/dialog
 * pause sources), PLACING lives in WorldScene (time flows). This module carries the
 * handshake without import cycles:
 *   - WorldScene registers its BuildController under BUILD_CONTROLLER_REGISTRY_KEY
 *     (same game-registry pattern as REGISTRY_KEYS.sim/timeDriver in world/events.ts);
 *   - panels reach it via getBuildController()/requestPlacing();
 *   - the controller talks back over game.events with BUILD_EVENTS payloads.
 */
import type Phaser from 'phaser';

import type { TilePos } from '../sim/types';
import type { BuildConfirmRequest } from '../ui/panels/build-model';

export const BUILD_CONTROLLER_REGISTRY_KEY = 'codestead:buildController';

export const BUILD_EVENTS = {
  /** world → UI: a building order needs the CONFIRM dialog (§8.3, tick stops). */
  confirmRequest: 'build:confirm_request',
  /** world → UI: placing backed out to the catalog (Esc/right-click), optionally
   *  with a toast reason key (materials exhausted, §8.3/§8.5). */
  catalogReturn: 'build:catalog_return',
  /** world → UI: E on a built structure (coop/workshop/rack/bench/... routing). */
  structureInteract: 'build:structure_interact',
} as const;

export interface PlacingRequest {
  defId: string;
  /** Relocation target — §8.3 move (free, instant, state preserved); null = new. */
  movingInstanceId: string | null;
}

export interface ConfirmRequestPayload {
  request: BuildConfirmRequest;
}

export interface CatalogReturnPayload {
  toastKey?: string;
  /** Which catalog tab to land on (defaults to 图纸). */
  tab?: 'blueprints' | 'move' | 'demolish';
}

export interface StructureInteractPayload {
  instanceId: string;
  defId: string;
  tile: TilePos;
}

/** WorldScene-side controller surface the UI may drive (implemented in build-controller.ts). */
export interface BuildControllerHandle {
  isActive(): boolean;
  startPlacing(request: PlacingRequest): void;
  /** Esc / right-click: drop the ghost and return to the catalog (uncommitted = free). */
  cancelToCatalog(): void;
  /** 22:00 / night flow / scene teardown: silent exit, no catalog reopen (§8.3). */
  forceExit(): void;
  /** CONFIRM accepted & charged: buildings end their placing session (§8.3). */
  confirmCommitted(): void;
  /** CONFIRM cancelled: keep PLACING alive so the player can re-aim. */
  confirmCancelled(): void;
}

export function getBuildController(scene: Phaser.Scene): BuildControllerHandle | null {
  const handle = scene.registry.get(BUILD_CONTROLLER_REGISTRY_KEY) as
    | BuildControllerHandle
    | undefined;
  return handle ?? null;
}

/** Panel-side entry into PLACING; logged no-op while the world controller is absent. */
export function requestPlacing(scene: Phaser.Scene, request: PlacingRequest): void {
  const controller = getBuildController(scene);
  if (!controller) {
    console.warn('[build] no build controller registered — placing request dropped', request);
    return;
  }
  controller.startPlacing(request);
}
