/**
 * structures-view.ts — placed-structure rendering + collision truth extension
 * (M3, GDD §8.2/§8.3/§1.5; PRD 04 §B/§N73 "渲染层只订阅事件做表现").
 *
 * Pure render shell over `state.structures` / `state.sprinklers`: WorldScene calls
 * sync() after build events and at day start; nothing here mutates the sim.
 *
 * Art: real exteriors use the `structure_{defId}` / `structure_{defId}_site` frame
 * contract (AssetKeys §11.4). Until that atlas lands, every structure renders as a
 * generated placeholder (palette fill + 1px ink outline + name label) — the same
 * parallel-workstream safety net as world/textures.ts.
 *
 * Walkability (§8.2): stone paths and benches are walkable; everything else placed
 * is solid across its footprint (canPlace rule ⑤ guarantees nobody is inside when
 * it lands). WorldScene chains isSolid() into the player's collision callback.
 * Lamp posts auto-light 18:00~22:00 (§8.2) — a static warm glow, no flicker (§10.8).
 */
import type { PlacedStructure } from '@codestead/shared';
import Phaser from 'phaser';

import { BLUEPRINTS_BY_ID, type BlueprintDef } from '../sim/data/buildings';
import type { TilePos, WorldState } from '../sim/types';
import { t } from '../ui/strings';
import { PALETTE } from './palette';
import { PARTICLE_TEXTURE } from './textures';

const TILE = 16;
/** 18:00 / 22:00 in minutes-of-day (GDD §8.2 lamp post window). */
const LAMP_ON_MINUTE = 18 * 60;
const LAMP_OFF_MINUTE = 22 * 60;

/** Decorations the player may walk over (§8.2: 石径移速 +10%; 长椅可坐). */
const WALKABLE_DEF_IDS = new Set(['stone_path', 'bench']);

interface StructureSprite {
  container: Phaser.GameObjects.Container;
  glow: Phaser.GameObjects.Graphics | null; // lamp posts only
  signature: string; // defId|origin|state|daysLeft — rebuild only on change
}

export class StructuresView {
  private readonly sprites = new Map<string, StructureSprite>();
  private sprinklerG: Phaser.GameObjects.Graphics;
  private solid = new Set<string>();
  private lampLit = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly reducedMotion: () => boolean,
  ) {
    this.sprinklerG = scene.add.graphics().setDepth(12); // over farmland (10), under cursor
  }

  /** Is a tile blocked by a placed structure? Chained into the collision callback. */
  isSolid(tx: number, ty: number): boolean {
    return this.solid.has(`${tx},${ty}`);
  }

  /** Rebuild the diff against the snapshot (cheap: keyed by instance signature). */
  sync(state: Readonly<WorldState>): void {
    const structures = state.structures ?? [];
    const seen = new Set<string>();
    this.solid.clear();

    for (const s of structures) {
      const def = BLUEPRINTS_BY_ID.get(s.defId);
      if (!def) continue; // sanitiser reclaims unknown defIds (§8.5); never crash render
      seen.add(s.instanceId);
      this.markSolid(s, def);
      const signature = `${s.defId}|${s.origin.x},${s.origin.y}|${s.state}|${s.daysLeft ?? 0}`;
      const existing = this.sprites.get(s.instanceId);
      if (existing?.signature === signature) continue;
      existing?.container.destroy();
      existing?.glow?.destroy();
      this.sprites.set(s.instanceId, this.build(s, def, signature));
    }

    for (const [instanceId, sprite] of this.sprites) {
      if (!seen.has(instanceId)) {
        sprite.container.destroy();
        sprite.glow?.destroy();
        this.sprites.delete(instanceId);
      }
    }

    this.drawSprinklers(state);
    this.applyLamps(this.lampLit, true);
  }

  /** Per-frame clock hook (WorldScene.update): lamp posts auto-light 18:00~22:00. */
  updateClock(minuteOfDay: number): void {
    const lit = minuteOfDay >= LAMP_ON_MINUTE && minuteOfDay < LAMP_OFF_MINUTE;
    if (lit !== this.lampLit) this.applyLamps(lit, false);
  }

  /** Completion confetti (§8.3 竣工彩带粒子，无弹窗); skipped under reducedMotion. */
  confetti(origin: TilePos, defId: string): void {
    if (this.reducedMotion()) return;
    const def = BLUEPRINTS_BY_ID.get(defId);
    const w = (def?.size.w ?? 1) * TILE;
    const cx = origin.x * TILE + w / 2;
    const cy = origin.y * TILE + ((def?.size.h ?? 1) * TILE) / 2;
    const emitter = this.scene.add.particles(0, 0, PARTICLE_TEXTURE, {
      lifespan: 900,
      speed: { min: 20, max: 60 },
      gravityY: 60,
      alpha: { start: 1, end: 0 },
      tint: [PALETTE.goldLight, PALETTE.greenPale, PALETTE.waterPale, PALETTE.amber],
      emitting: false,
    });
    emitter.setDepth(1100); // fx layer (GDD §1.5)
    emitter.explode(36, cx, cy);
    this.scene.time.delayedCall(1200, () => emitter.destroy());
  }

  destroy(): void {
    for (const sprite of this.sprites.values()) {
      sprite.container.destroy();
      sprite.glow?.destroy();
    }
    this.sprites.clear();
    this.sprinklerG.destroy();
    this.solid.clear();
  }

  // ---- internals ----

  private markSolid(s: PlacedStructure, def: BlueprintDef): void {
    if (WALKABLE_DEF_IDS.has(def.id)) return;
    for (let y = s.origin.y; y < s.origin.y + def.size.h; y++) {
      for (let x = s.origin.x; x < s.origin.x + def.size.w; x++) {
        this.solid.add(`${x},${y}`);
      }
    }
  }

  private build(s: PlacedStructure, def: BlueprintDef, signature: string): StructureSprite {
    const px = s.origin.x * TILE;
    const py = s.origin.y * TILE;
    const w = def.size.w * TILE;
    const h = def.size.h * TILE;
    const site = s.state === 'underConstruction';

    const g = this.scene.add.graphics();
    if (def.id === 'stone_path') {
      g.fillStyle(PALETTE.uiTextDim, 1);
      g.fillRect(1, 1, w - 2, h - 2);
      g.lineStyle(1, PALETTE.ink, 0.5);
      g.strokeRect(0.5, 0.5, w - 1, h - 1);
    } else if (site) {
      // Construction site: sand base + diagonal hatching (§8.3 工地).
      g.fillStyle(PALETTE.soilLight, 1);
      g.fillRect(0, 0, w, h);
      g.lineStyle(1, PALETTE.ink, 0.6);
      for (let x = -h; x < w; x += 6) {
        g.lineBetween(x, h, x + h, 0);
      }
      g.strokeRect(0.5, 0.5, w - 1, h - 1);
    } else {
      const body = this.bodyColor(def);
      g.fillStyle(PALETTE.ink, 0.35); // 1px right-down shadow discipline (§11.3)
      g.fillRect(1, 1, w, h);
      g.fillStyle(body, 1);
      g.fillRect(0, 0, w, h);
      if (def.category === 'building') {
        g.fillStyle(PALETTE.soilDark, 1); // roof band
        g.fillRect(0, 0, w, Math.max(4, Math.floor(h / 3)));
        if (def.doorOffset) {
          g.fillStyle(PALETTE.ink, 1); // door
          g.fillRect(def.doorOffset.x * TILE + 4, def.doorOffset.y * TILE + 4, TILE - 8, TILE - 4);
        }
      }
      g.lineStyle(1, PALETTE.ink, 1);
      g.strokeRect(0.5, 0.5, w - 1, h - 1);
    }

    const children: Phaser.GameObjects.GameObject[] = [g];
    if (def.size.w > 1 || def.category === 'building' || def.category === 'station') {
      const label = site ? t('structure.site_label', { days: s.daysLeft ?? 0 }) : t(def.nameKey);
      const text = this.scene.add
        .text(w / 2, site ? h / 2 - 6 : 2, label, {
          fontFamily: 'monospace',
          fontSize: '10px',
          color: '#f4e3c2',
        })
        .setOrigin(0.5, 0)
        .setResolution(1);
      children.push(text);
    }

    const container = this.scene.add.container(px, py, children);
    // Walkable flats sit under farmland; everything else y-sorts with entities (§1.5).
    container.setDepth(WALKABLE_DEF_IDS.has(def.id) ? 6 : 100 + py + h);

    let glow: Phaser.GameObjects.Graphics | null = null;
    if (def.id === 'lamp_post' && !site) {
      glow = this.scene.add.graphics();
      glow.fillStyle(PALETTE.goldLight, 0.18);
      glow.fillCircle(px + w / 2, py + h / 2, TILE * 1.5);
      glow.setDepth(1001); // above layer (1000), under fx — a static pool of light
      glow.setVisible(this.lampLit);
    }
    return { container, glow, signature };
  }

  private bodyColor(def: BlueprintDef): number {
    switch (def.id) {
      case 'greenhouse':
        return PALETTE.waterPale;
      case 'coop':
        return PALETTE.amber;
      case 'workshop':
        return PALETTE.soilLight;
      case 'fence':
        return PALETTE.soilMid;
      case 'flower_bed':
        return PALETTE.greenPale;
      case 'bench':
        return PALETTE.soilLight;
      case 'lamp_post':
        return PALETTE.uiPanelLight;
      case 'sprinkler':
      case 'sprinkler_advanced':
        return PALETTE.waterLight;
      case 'memorial_statue':
        return PALETTE.goldMid;
      default:
        return PALETTE.uiPanelLight;
    }
  }

  private drawSprinklers(state: Readonly<WorldState>): void {
    const g = this.sprinklerG;
    g.clear();
    for (const sp of state.sprinklers ?? []) {
      const px = sp.x * TILE;
      const py = sp.y * TILE;
      g.fillStyle(PALETTE.waterLight, 1);
      g.fillRect(px + 5, py + 5, 6, 6);
      g.lineStyle(1, PALETTE.ink, 1);
      g.strokeRect(px + 4.5, py + 4.5, 7, 7);
      if (sp.tier === 2) {
        g.fillStyle(PALETTE.waterPale, 1);
        g.fillRect(px + 7, py + 2, 2, 3); // tier-2 antenna — shape-coded, not colour-only
      }
    }
  }

  private applyLamps(lit: boolean, force: boolean): void {
    if (!force && lit === this.lampLit) return;
    this.lampLit = lit;
    for (const sprite of this.sprites.values()) {
      sprite.glow?.setVisible(lit);
    }
  }
}
