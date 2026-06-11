/**
 * player.ts — player movement, collision and action lock (GDD §1.6).
 *
 * Free pixel movement with a 12×8 foot-aligned AABB (MOVEMENT.COLLIDER), four
 * directions, walk 72 / run 120 px/s, ≤3px corner forgiveness. Collision is resolved
 * manually against the boolean grid built from the invisible `collision` tile layer —
 * the ONLY collision truth (GDD §1.5). Farming interactions are tile-based; the
 * current tile is `floor(bodyCenter / 16)`.
 *
 * The Acting state (GDD §1.6 player state machine) locks movement for the action
 * duration (250ms tool / 200ms bare-hand harvest) while direction keys stay stacked.
 */
import Phaser from 'phaser';

import { ACTION_TIMING, MOVEMENT } from '../sim/data/constants';
import type { ActionVerb, Facing, TilePos } from '../sim/types';
import { actorFrame, PLAYER_ACTOR, TEXTURES } from '../AssetKeys';
import type { Dir } from './input-stack';
import { FALLBACK_PLAYER_TEXTURE, hasFrame } from './textures';

const TILE = 16;
const SPRITE_W = 16;
const SPRITE_H = 16;

/** Solid-cell lookup built by WorldScene from the `collision` layer. */
export type CollisionGrid = (tileX: number, tileY: number) => boolean;

export class PlayerController {
  readonly sprite: Phaser.GameObjects.Sprite;
  facing: Facing = 'down';

  /** Foot-center position (sprite origin (0.5, 1)). */
  private x: number;
  private y: number;
  private actingUntil = 0;
  private actingVerb: ActionVerb | null = null;
  private readonly hasArt: boolean;

  constructor(
    private readonly scene: Phaser.Scene,
    spawnTile: TilePos,
    facing: Facing,
    private readonly isSolid: CollisionGrid,
    private readonly mapWidthPx: number,
    private readonly mapHeightPx: number,
  ) {
    this.x = spawnTile.x * TILE + TILE / 2;
    this.y = spawnTile.y * TILE + 12; // body center lands on the spawn tile
    this.facing = facing;
    this.hasArt = hasFrame(scene, TEXTURES.characters, actorFrame(PLAYER_ACTOR, 'walk', 'down', 0));
    this.sprite = scene.add.sprite(
      this.x,
      this.y,
      this.hasArt ? TEXTURES.characters : FALLBACK_PLAYER_TEXTURE,
      this.hasArt ? actorFrame(PLAYER_ACTOR, 'walk', 'down', 0) : undefined,
    );
    this.sprite.setOrigin(0.5, 1);
    if (this.hasArt) PlayerController.ensureAnims(scene);
    this.syncSprite();
  }

  /** Walk 4 frames @8fps; swing overlay 3 frames @12fps (GDD §11.4). Idempotent. */
  static ensureAnims(scene: Phaser.Scene): void {
    const dirs: Facing[] = ['up', 'down', 'left', 'right'];
    for (const dir of dirs) {
      const walkKey = `player_walk_${dir}`;
      if (!scene.anims.exists(walkKey)) {
        const frames = [0, 1, 2, 3]
          .map((i) => actorFrame(PLAYER_ACTOR, 'walk', dir, i))
          .filter((f) => hasFrame(scene, TEXTURES.characters, f))
          .map((f) => ({ key: TEXTURES.characters, frame: f }));
        if (frames.length > 0) {
          scene.anims.create({ key: walkKey, frames, frameRate: 8, repeat: -1 });
        }
      }
      const swingKey = `player_swing_${dir}`;
      if (!scene.anims.exists(swingKey)) {
        const frames = [0, 1, 2]
          .map((i) => actorFrame(PLAYER_ACTOR, 'swing', dir, i))
          .filter((f) => hasFrame(scene, TEXTURES.characters, f))
          .map((f) => ({ key: TEXTURES.characters, frame: f }));
        if (frames.length > 0) {
          scene.anims.create({ key: swingKey, frames, frameRate: 12, repeat: 0 });
        }
      }
    }
  }

  /** Current tile = floor(body center / 16) (GDD §1.6). */
  get currentTile(): TilePos {
    return { x: Math.floor(this.x / TILE), y: Math.floor((this.y - 4) / TILE) };
  }

  get isActing(): boolean {
    return this.scene.time.now < this.actingUntil;
  }

  get actingEndsAt(): number {
    return this.actingUntil;
  }

  /** Snap to a tile center (save restore / new-day wake-up, GDD §1.6). */
  setTilePosition(tile: TilePos, facing: Facing): void {
    this.x = tile.x * TILE + TILE / 2;
    this.y = tile.y * TILE + 12;
    this.facing = facing;
    this.syncSprite();
    this.playIdle();
  }

  /**
   * Enter Acting: lock movement for the verb's duration (250ms tool / 200ms harvest,
   * ruling A-16) and play the swing animation toward `facing`.
   */
  beginActing(verb: ActionVerb, facing: Facing): void {
    this.facing = facing;
    const lock = verb === 'harvest' ? ACTION_TIMING.HARVEST_LOCK_MS : ACTION_TIMING.TOOL_LOCK_MS;
    this.actingUntil = this.scene.time.now + lock;
    this.actingVerb = verb;
    if (this.hasArt && this.scene.anims.exists(`player_swing_${this.facing}`)) {
      this.sprite.anims.play(`player_swing_${this.facing}`, true);
    }
  }

  /** Per-frame movement (call only while world input is not modal-blocked). */
  update(deltaMs: number, dir: Dir | null, run: boolean): void {
    if (this.isActing) {
      this.syncSprite();
      return;
    }
    if (this.actingVerb !== null) {
      this.actingVerb = null;
      this.playIdle();
    }
    if (dir === null) {
      this.playIdle();
      this.syncSprite();
      return;
    }
    this.facing = dir;
    const speed = run ? MOVEMENT.RUN_SPEED_PX_PER_S : MOVEMENT.WALK_SPEED_PX_PER_S;
    const dist = (speed * deltaMs) / 1000;
    if (dir === 'left') this.moveAxis(-dist, 0);
    else if (dir === 'right') this.moveAxis(dist, 0);
    else if (dir === 'up') this.moveAxis(0, -dist);
    else this.moveAxis(0, dist);

    if (this.hasArt && this.scene.anims.exists(`player_walk_${dir}`)) {
      this.sprite.anims.play(`player_walk_${dir}`, true);
    }
    this.syncSprite();
  }

  private playIdle(): void {
    if (!this.hasArt) return;
    this.sprite.anims.stop();
    const idle = actorFrame(PLAYER_ACTOR, 'idle', this.facing, 0);
    const walk0 = actorFrame(PLAYER_ACTOR, 'walk', this.facing, 0);
    if (hasFrame(this.scene, TEXTURES.characters, idle)) {
      this.sprite.setFrame(idle);
    } else if (hasFrame(this.scene, TEXTURES.characters, walk0)) {
      this.sprite.setFrame(walk0);
    }
  }

  private syncSprite(): void {
    this.sprite.setPosition(this.x, this.y);
    // entities depth = 100 + foot worldY (y-sort, GDD §1.5)
    this.sprite.setDepth(100 + this.y);
  }

  // ---- manual AABB collision (collision layer is the only truth, GDD §1.5) ----

  private bodyCollides(x: number, y: number): boolean {
    const { width, height, offsetX, offsetY } = MOVEMENT.COLLIDER;
    const left = x - SPRITE_W / 2 + offsetX;
    const top = y - SPRITE_H + offsetY;
    const right = left + width;
    const bottom = top + height;
    if (left < 0 || top < 0 || right > this.mapWidthPx || bottom > this.mapHeightPx) return true;
    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((right - 0.001) / TILE);
    const y0 = Math.floor(top / TILE);
    const y1 = Math.floor((bottom - 0.001) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.isSolid(tx, ty)) return true;
      }
    }
    return false;
  }

  private moveAxis(dx: number, dy: number): void {
    const nx = this.x + dx;
    const ny = this.y + dy;
    if (!this.bodyCollides(nx, ny)) {
      this.x = nx;
      this.y = ny;
      return;
    }
    // Corner forgiveness (GDD §1.6): when the blocking overlap on the perpendicular
    // axis is ≤3px, slide 1px per frame toward the clear side.
    const f = MOVEMENT.CORNER_FORGIVENESS_PX;
    if (dx !== 0) {
      for (let nudge = 1; nudge <= f; nudge++) {
        if (!this.bodyCollides(nx, this.y - nudge)) {
          this.y -= 1;
          return;
        }
        if (!this.bodyCollides(nx, this.y + nudge)) {
          this.y += 1;
          return;
        }
      }
    } else if (dy !== 0) {
      for (let nudge = 1; nudge <= f; nudge++) {
        if (!this.bodyCollides(this.x - nudge, ny)) {
          this.x -= 1;
          return;
        }
        if (!this.bodyCollides(this.x + nudge, ny)) {
          this.x += 1;
          return;
        }
      }
    }
  }
}
