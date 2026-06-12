/**
 * build-controller.ts — the PLACING state of the §8.3 build machine, world-side
 * (M3; PRD 04 US5~US12, US30/US31). Time keeps flowing here by design.
 *
 * Owned by WorldScene; UIScene panels reach it through build-bridge (registry handle)
 * and it talks back over game.events (BUILD_EVENTS). Per frame it resolves the ghost
 * anchor (mouse hover, or the tile in front of the player for keyboard-only flows —
 * US10 dual-channel equivalence), validates via sim/building.canPlace and renders the
 * ghost. Commit semantics (§8.3):
 *   - building → CONFIRM dialog (UIScene; 金额+工期+余额复验, US8);
 *   - station/decoration/sprinkler → instant commit, STAY in PLACING (刷一排栅栏,
 *     US7); materials exhausted → back to CATALOG with the yellow-line toast;
 *   - move → instant & free, all internal state preserved (US30);
 *   - Esc/right-click → back to CATALOG; 22:00/night → force exit, uncommitted = 未扣费.
 *
 * Parallel-workstream tolerance: while sim/building.canPlace is still the contract
 * stub, a local approximation (same six §8.3 rule names) validates the ghost, and
 * dispatch failures degrade to logged no-ops — the sim stays the commit authority.
 */
import type Phaser from 'phaser';

import { canPlace, type CanPlaceResult, type CanPlaceViolation } from '../sim/building';
import { getBlueprint, type BlueprintDef } from '../sim/data/buildings';
import type { SimApi } from '../sim/sim';
import type { Facing, MapMeta, TilePos, WorldState } from '../sim/types';
import {
  asSimCommand,
  canAfford,
  instancesOf,
  originForCursor,
  sprinklerCoverage,
  sprinklersOf,
  structuresOf,
  type BuildSimCommand,
} from '../ui/panels/build-model';
import { t } from '../ui/strings';
import {
  BUILD_CONTROLLER_REGISTRY_KEY,
  BUILD_EVENTS,
  type BuildControllerHandle,
  type CatalogReturnPayload,
  type ConfirmRequestPayload,
  type PlacingRequest,
} from './build-bridge';
import { BuildGhost } from './build-ghost';

export interface BuildControllerDeps {
  sim: () => SimApi | null;
  mapMeta: () => MapMeta;
  playerTile: () => TilePos;
  facing: () => Facing;
  /** Hovered tile (mouse aim) or null when off-map. */
  hoverTile: () => TilePos | null;
  aimMode: () => 'keyboard' | 'mouse';
  /** STATIC terrain collision only (water/walls); structures are checked separately. */
  isSolidTerrain: (tx: number, ty: number) => boolean;
  toast: (text: string) => void;
  playError: () => void;
  playCommit: () => void;
}

const FACING_DELTA: Record<Facing, TilePos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export class BuildController implements BuildControllerHandle {
  private readonly ghost: BuildGhost;
  private placing: PlacingRequest | null = null;
  private lastOrigin: TilePos | null = null;
  private lastResult: CanPlaceResult | null = null;
  private canPlaceBroken = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: BuildControllerDeps,
  ) {
    this.ghost = new BuildGhost(scene);
    scene.registry.set(BUILD_CONTROLLER_REGISTRY_KEY, this);
  }

  destroy(): void {
    if (this.scene.registry.get(BUILD_CONTROLLER_REGISTRY_KEY) === this) {
      this.scene.registry.remove(BUILD_CONTROLLER_REGISTRY_KEY);
    }
    this.ghost.destroy();
    this.placing = null;
  }

  // ---- BuildControllerHandle (driven by the UI panels via build-bridge) ----

  isActive(): boolean {
    return this.placing !== null;
  }

  startPlacing(request: PlacingRequest): void {
    const sim = this.deps.sim();
    if (!sim) {
      console.warn('[build] no sim — placing unavailable');
      return;
    }
    this.placing = request;
    this.lastOrigin = null;
    this.lastResult = null;
  }

  cancelToCatalog(): void {
    if (!this.placing) return;
    const tab = this.placing.movingInstanceId !== null ? 'move' : 'blueprints';
    this.exit();
    this.emitCatalogReturn({ tab });
  }

  forceExit(): void {
    // 22:00 / night flow / teardown: uncommitted = 未扣费, silent (§8.3 零损失).
    this.exit();
  }

  confirmCommitted(): void {
    // A building order was charged — buildings end their placing session (§8.3).
    this.exit();
  }

  confirmCancelled(): void {
    // CONFIRM backed out: PLACING stays alive; nothing to do (ghost keeps tracking).
  }

  // ---- per-frame (called from WorldScene.update) ----

  update(): void {
    if (!this.placing) {
      this.ghost.hide();
      return;
    }
    const sim = this.deps.sim();
    if (!sim) {
      this.exit();
      return;
    }
    const def = this.safeBlueprint(this.placing.defId);
    if (!def) {
      this.exit();
      return;
    }
    const cursor = this.cursorTile();
    const origin = originForCursor(def, cursor);
    const result = this.validate(sim.state, def, origin);
    this.lastOrigin = origin;
    this.lastResult = result;
    const coverage =
      def.id === 'sprinkler' || def.id === 'sprinkler_advanced'
        ? sprinklerCoverage(def.id, origin)
        : [];
    this.ghost.show(def, origin, result, coverage);
  }

  /** E / left-click while placing (routed here by WorldScene before tryAttempt). */
  commit(): void {
    if (!this.placing || !this.lastOrigin || !this.lastResult) return;
    const sim = this.deps.sim();
    const def = this.safeBlueprint(this.placing.defId);
    if (!sim || !def) return;

    if (!this.lastResult.ok) {
      const violation = this.firstViolation(this.lastResult);
      this.deps.toast(t(`build.violation.${violation ?? 'not_buildable'}`));
      this.deps.playError();
      return;
    }
    const origin = this.lastOrigin;

    // ---- relocation (free, instant, state preserved — §8.3 搬迁) ----
    if (this.placing.movingInstanceId !== null) {
      const instanceId = this.placing.movingInstanceId;
      this.dispatch(sim, { type: 'moveStructure', instanceId, origin });
      const moved = structuresOf(sim.state).some(
        (s) => s.instanceId === instanceId && s.origin.x === origin.x && s.origin.y === origin.y,
      );
      if (moved) {
        this.deps.playCommit();
        this.deps.toast(t('toast.build_moved'));
        this.exit();
      } else {
        this.deps.playError();
      }
      return;
    }

    // ---- buildings: COMMIT happens in the CONFIRM dialog (§8.3, US8) ----
    if (def.category === 'building') {
      const payload: ConfirmRequestPayload = {
        request: { kind: 'placeBuilding', defId: def.id, origin },
      };
      this.scene.game.events.emit(BUILD_EVENTS.confirmRequest, payload);
      return;
    }

    // ---- stations/decorations/sprinklers: instant, stay in PLACING (US7) ----
    const isSprinkler = def.id === 'sprinkler' || def.id === 'sprinkler_advanced';
    const before = isSprinkler ? sprinklersOf(sim.state).length : structuresOf(sim.state).length;
    this.dispatch(
      sim,
      isSprinkler
        ? { type: 'placeSprinkler', defId: def.id, tile: origin }
        : { type: 'placeStructure', defId: def.id, origin },
    );
    const after = isSprinkler ? sprinklersOf(sim.state).length : structuresOf(sim.state).length;
    if (after <= before) {
      this.deps.playError(); // sim refused at commit time (funds/limit — authority)
      return;
    }
    this.deps.playCommit();
    if (def.limit !== undefined && !isSprinkler && instancesOf(sim.state, def.id) >= def.limit) {
      this.exit();
      this.emitCatalogReturn({ tab: 'blueprints' });
      return;
    }
    if (!canAfford(sim.state, def)) {
      // 连续放置耗尽材料 → 成交后退回目录并黄字提示 (§8.3/§8.5).
      this.exit();
      this.emitCatalogReturn({ tab: 'blueprints', toastKey: 'toast.build_materials_exhausted' });
    }
  }

  // ---- internals ----

  private exit(): void {
    this.placing = null;
    this.lastOrigin = null;
    this.lastResult = null;
    this.ghost.hide();
  }

  private emitCatalogReturn(payload: CatalogReturnPayload): void {
    this.scene.game.events.emit(BUILD_EVENTS.catalogReturn, payload);
  }

  private firstViolation(result: CanPlaceResult): CanPlaceViolation | null {
    for (const report of result.tiles) {
      if (report.violations.length > 0) return report.violations[0];
    }
    return null;
  }

  private safeBlueprint(defId: string): BlueprintDef | null {
    try {
      return getBlueprint(defId);
    } catch {
      return null;
    }
  }

  private cursorTile(): TilePos {
    const map = this.deps.mapMeta();
    const player = this.deps.playerTile();
    const hover = this.deps.aimMode() === 'mouse' ? this.deps.hoverTile() : null;
    const tile = hover ?? {
      x: player.x + FACING_DELTA[this.deps.facing()].x,
      y: player.y + FACING_DELTA[this.deps.facing()].y,
    };
    return {
      x: Math.max(0, Math.min(map.width - 1, tile.x)),
      y: Math.max(0, Math.min(map.height - 1, tile.y)),
    };
  }

  private validate(
    state: Readonly<WorldState>,
    def: BlueprintDef,
    origin: TilePos,
  ): CanPlaceResult {
    if (!this.canPlaceBroken) {
      try {
        return canPlace(state, def, origin, {
          movingInstanceId: this.placing?.movingInstanceId ?? undefined,
          henTiles: [], // hens live in the coop interior; none roam the farm (M3)
        });
      } catch (err) {
        this.canPlaceBroken = true; // sim contract stub not merged yet — local approx
        console.warn('[build] sim canPlace unavailable — using local approximation:', err);
      }
    }
    return this.fallbackValidate(state, def, origin);
  }

  /**
   * Local approximation of the §8.3 six rules (same violation vocabulary) so the
   * ghost stays truthful while the sim implementation is in flight. The sim re-runs
   * the authoritative check at commit time.
   */
  private fallbackValidate(
    state: Readonly<WorldState>,
    def: BlueprintDef,
    origin: TilePos,
  ): CanPlaceResult {
    const map = this.deps.mapMeta();
    const player = this.deps.playerTile();
    const occupied = this.occupiedTiles(state);
    const isPath = def.id === 'stone_path';

    const checkTile = (tile: TilePos, forDoor: boolean): CanPlaceViolation[] => {
      const violations: CanPlaceViolation[] = [];
      if (tile.x < 0 || tile.y < 0 || tile.x >= map.width || tile.y >= map.height) {
        violations.push(forDoor ? 'door_unreachable' : 'out_of_bounds');
        return violations;
      }
      if (this.deps.isSolidTerrain(tile.x, tile.y)) {
        violations.push(forDoor ? 'door_unreachable' : 'not_buildable');
      }
      if (state.farm.tiles[`${tile.x},${tile.y}`] !== undefined && (!forDoor || isPath)) {
        violations.push('farmland_conflict'); // 石径同样不可压耕地 (§8.3 ③)
      }
      if (!forDoor && occupied.has(`${tile.x},${tile.y}`)) violations.push('overlap');
      if (forDoor && occupied.has(`${tile.x},${tile.y}`)) violations.push('door_unreachable');
      if (!forDoor && player.x === tile.x && player.y === tile.y) {
        violations.push('occupant_inside'); // 不自动推开 (§8.5, US31)
      }
      return violations;
    };

    const tiles: CanPlaceResult['tiles'] = [];
    for (let y = origin.y; y < origin.y + def.size.h; y++) {
      for (let x = origin.x; x < origin.x + def.size.w; x++) {
        tiles.push({ tile: { x, y }, violations: checkTile({ x, y }, false) });
      }
    }
    if (def.category === 'building' && def.doorOffset) {
      const front = { x: origin.x + def.doorOffset.x, y: origin.y + def.doorOffset.y + 1 };
      tiles.push({ tile: front, violations: checkTile(front, true) });
    }
    return { ok: tiles.every((r) => r.violations.length === 0), tiles };
  }

  /** Tiles already occupied by placed structures/sprinklers (move exempts itself). */
  private occupiedTiles(state: Readonly<WorldState>): Set<string> {
    const occupied = new Set<string>();
    for (const s of structuresOf(state)) {
      if (s.instanceId === this.placing?.movingInstanceId) continue; // rule ④ exemption
      const def = this.safeBlueprint(s.defId);
      if (!def) continue;
      for (let y = s.origin.y; y < s.origin.y + def.size.h; y++) {
        for (let x = s.origin.x; x < s.origin.x + def.size.w; x++) {
          occupied.add(`${x},${y}`);
        }
      }
    }
    for (const sp of sprinklersOf(state)) occupied.add(`${sp.x},${sp.y}`);
    return occupied;
  }

  private dispatch(sim: SimApi, command: BuildSimCommand): void {
    try {
      sim.dispatch(asSimCommand(command));
    } catch (err) {
      console.warn('[build] sim.dispatch failed (M3 commands not merged yet?):', command, err);
    }
  }
}
