/**
 * feedback-view.ts — in-place success feedback for harvest / pickup / gold deltas
 * (PRD 01 US80/US68/US103; GDD §6.4 timeline, §5.8 floaters, §10.8 reducedMotion).
 *
 * Driven by UIScene.onSimEvent (one-way flow, GDD §12): CropHarvested / ItemPicked /
 * GoldChanged are buffered and flushed once per frame so same-frame batches merge
 * (US68). On flush: the item icon pops off the source tile and flies a quadratic
 * bezier arc into the hotbar slot that received it (§6.4: 0ms 上弹 → 60ms 起飞 →
 * 300ms 落槽), then the slot bounces, the §6.4 入包音 plays, and "+1 芜菁" / "+{xp} xp"
 * floaters rise side by side above the tile. Toasts stay reserved for blocked reasons
 * (GDD §6.7) — success feedback is exactly this in-place layer.
 *
 * reducedMotion (§10.8, wired from day one): no flight — the icon fades in place over
 * 200ms, floaters appear at their terminal position and fade after a short hold, the
 * slot bounce is skipped. Sounds still play (muted/RM never loses information, §10.8).
 *
 * Ruling A-9: spawn points are clamped out of the (4,4)–(156,150) session-HUD reserve
 * (clampOutsideHudReserve keeps the whole bezier hull clear of it).
 */
import type Phaser from 'phaser';

import { SFX, TEXTURES, type SfxKey } from '../../AssetKeys';
import { INVENTORY } from '../../sim/data/constants';
import { cropItemId, getItemDef, type ItemId } from '../../sim/data/items';
import type { SimEvent, WorldState } from '../../sim/types';
import { formatGold } from '../format';
import { DEPTH, TOP_RIGHT_PANEL, XP_BAR } from '../layout';
import { PALETTE } from '../palette';
import { t } from '../strings';
import { hasFrame } from '../widgets/panel';
import { glyphFor } from '../widgets/slot-view';
import { uiText } from '../widgets/text';
import {
  clampOutsideHudReserve,
  FLOAT_FADE_MS,
  FLOAT_MS,
  FLOAT_RISE_PX,
  FLY_DELAY_MS,
  FLY_MS,
  flightControlPoint,
  hotbarSlotCenter,
  mergeHarvests,
  mergePickups,
  POP_PX,
  quadBezier,
  REDUCED_FADE_MS,
  REDUCED_FLOAT_HOLD_MS,
  type Point,
} from './feedback-model';

const TILE = 16;
/** Gold delta floater anchor: just under the top-right panel's gold row (GDD §6.6). */
const GOLD_FLOAT_ANCHOR: Point = {
  x: TOP_RIGHT_PANEL.x + TOP_RIGHT_PANEL.width / 2,
  y: XP_BAR.y + 24,
};

export interface FeedbackDeps {
  state(): Readonly<WorldState>;
  /** WorldScene main camera for world→screen mapping; null in the degraded shell. */
  worldCamera(): Phaser.Cameras.Scene2D.Camera | null;
  reducedMotion(): boolean;
  playSfx(key: SfxKey): void;
  bounceSlot(slot: number): void;
}

interface FloaterLine {
  text: string;
  color: string;
}

type FxObject = Phaser.GameObjects.Image | Phaser.GameObjects.Text;

export class FeedbackView {
  private pendingHarvests: Extract<SimEvent, { type: 'CropHarvested' }>[] = [];
  private pendingPickups: Extract<SimEvent, { type: 'ItemPicked' }>[] = [];
  private pendingGold = 0;
  private goldDirty = false;

  private readonly live = new Set<FxObject>();
  private readonly tweens = new Set<Phaser.Tweens.Tween>();
  private readonly timers = new Set<Phaser.Time.TimerEvent>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: FeedbackDeps,
  ) {}

  /** Buffer; rendering happens in update() so same-frame batches merge (US68). */
  onEvent(event: SimEvent): void {
    switch (event.type) {
      case 'CropHarvested':
        this.pendingHarvests.push(event);
        break;
      case 'ItemPicked':
        this.pendingPickups.push(event);
        break;
      case 'GoldChanged':
        this.pendingGold += event.delta;
        this.goldDirty = true;
        break;
      default:
        break;
    }
  }

  /** Call once per frame from UIScene.update. */
  update(): void {
    if (this.pendingHarvests.length > 0) this.flushHarvests();
    if (this.pendingPickups.length > 0) this.flushPickups();
    if (this.goldDirty) this.flushGold();
  }

  /** Kill everything in flight (night transition / scene shutdown). */
  clear(): void {
    for (const tween of this.tweens) tween.remove();
    this.tweens.clear();
    for (const timer of this.timers) timer.remove(false);
    this.timers.clear();
    for (const obj of this.live) obj.destroy();
    this.live.clear();
    this.pendingHarvests = [];
    this.pendingPickups = [];
    this.pendingGold = 0;
    this.goldDirty = false;
  }

  // ---- flushes ----

  private flushHarvests(): void {
    const { groups, totalXp } = mergeHarvests(this.pendingHarvests);
    this.pendingHarvests = [];
    let xpShown = false;
    for (const group of groups) {
      const itemId = cropItemId(group.cropId);
      const from = this.tileTopScreen(group.tile);
      if (!from) continue; // no world camera (degraded shell) — skip the visuals
      const def = getItemDef(itemId);
      const lines: FloaterLine[] = [
        {
          text: t('fx.gain_item', { n: group.count, name: t(def.nameKey) }),
          color: PALETTE.ui.text,
        },
      ];
      // US68/§5.8: ONE merged xp line per frame, side by side with the first item line.
      if (!xpShown && totalXp > 0) {
        lines.push({ text: t('fx.gain_xp', { xp: totalXp }), color: PALETTE.green.light });
        xpShown = true;
      }
      // §6.4 入包音 plays on landing (harvest_pop already played at 0ms by attachWorldSfx).
      this.spawnFlight(itemId, from, { landSfx: SFX.itemGet, floaters: lines });
    }
  }

  private flushPickups(): void {
    const merged = mergePickups(this.pendingPickups);
    this.pendingPickups = [];
    const from = this.playerHeadScreen();
    if (!from) return;
    for (const entry of merged) {
      const def = getItemDef(entry.itemId);
      // item_get already played at event time (attachWorldSfx) — no landing sfx here.
      this.spawnFlight(entry.itemId, from, {
        floaters: [
          {
            text: t('fx.gain_item', { n: entry.count, name: t(def.nameKey) }),
            color: PALETTE.ui.text,
          },
        ],
      });
    }
  }

  private flushGold(): void {
    const delta = this.pendingGold;
    this.pendingGold = 0;
    this.goldDirty = false;
    if (delta === 0) return;
    const line: FloaterLine =
      delta > 0
        ? { text: t('fx.gold_gain', { gold: formatGold(delta) }), color: PALETTE.gold.light }
        : { text: t('fx.gold_spend', { gold: formatGold(-delta) }), color: PALETTE.red.mid };
    this.spawnFloaters(GOLD_FLOAT_ANCHOR, [line], this.deps.reducedMotion());
  }

  // ---- flight ----

  private spawnFlight(
    itemId: ItemId,
    from: Point,
    opts: { landSfx?: SfxKey; floaters: FloaterLine[] },
  ): void {
    const reduced = this.deps.reducedMotion();
    const slot = this.findHotbarSlot(itemId);
    const icon = this.makeIcon(itemId, from);

    if (reduced) {
      // §10.8: 收割抛物线 → 200ms 淡出 — no flight; terminal effects land immediately.
      this.track(
        this.scene.tweens.add({
          targets: icon,
          alpha: 0,
          duration: REDUCED_FADE_MS,
          onComplete: () => this.destroyFx(icon),
        }),
      );
      this.land(slot, from, opts, true);
      return;
    }

    // 0ms 作物上弹 (§6.4): the icon pops up during the 60ms pre-flight beat.
    this.track(
      this.scene.tweens.add({
        targets: icon,
        y: from.y - POP_PX,
        duration: FLY_DELAY_MS,
        ease: 'Quad.easeOut',
      }),
    );
    const start: Point = { x: from.x, y: from.y - POP_PX };
    const to = hotbarSlotCenter(slot);
    const control = flightControlPoint(start, to);
    const progress = { t: 0 };
    this.track(
      this.scene.tweens.add({
        targets: progress,
        t: 1,
        delay: FLY_DELAY_MS,
        duration: FLY_MS,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          const p = quadBezier(start, control, to, progress.t);
          icon.setPosition(Math.round(p.x), Math.round(p.y));
        },
        onComplete: () => {
          this.destroyFx(icon);
          this.land(slot, from, opts, false);
        },
      }),
    );
  }

  /** §6.4 300ms mark: slot bounce + 入包音 + floaters above the source point. */
  private land(
    slot: number | null,
    from: Point,
    opts: { landSfx?: SfxKey; floaters: FloaterLine[] },
    reduced: boolean,
  ): void {
    if (slot !== null && !reduced) this.deps.bounceSlot(slot); // §10.8: bounce is motion
    if (opts.landSfx) this.deps.playSfx(opts.landSfx);
    if (opts.floaters.length > 0) this.spawnFloaters(from, opts.floaters, reduced);
  }

  // ---- floaters (同帧并排上飘淡出, §6.4/§5.8) ----

  private spawnFloaters(at: Point, lines: FloaterLine[], reduced: boolean): void {
    const texts = lines.map((line) =>
      uiText(this.scene, 0, 0, line.text, { color: line.color })
        .setOrigin(0, 1)
        .setDepth(DEPTH.feedback),
    );
    const gap = 6;
    const total =
      texts.reduce((sum, text) => sum + text.width, 0) + gap * Math.max(0, texts.length - 1);
    let x = at.x - total / 2;
    for (const text of texts) {
      text.setPosition(Math.round(x), Math.round(at.y - 2));
      x += text.width + gap;
      this.live.add(text);
    }
    if (reduced) {
      // §10.8 直接终值: no rise; hold for readability, then a 200ms fade.
      const timer = this.scene.time.delayedCall(REDUCED_FLOAT_HOLD_MS, () => {
        this.timers.delete(timer);
        this.track(
          this.scene.tweens.add({
            targets: texts,
            alpha: 0,
            duration: REDUCED_FADE_MS,
            onComplete: () => texts.forEach((text) => this.destroyFx(text)),
          }),
        );
      });
      this.timers.add(timer);
      return;
    }
    this.track(
      this.scene.tweens.add({
        targets: texts,
        y: `-=${FLOAT_RISE_PX}`,
        duration: FLOAT_MS,
        ease: 'Quad.easeOut',
      }),
    );
    this.track(
      this.scene.tweens.add({
        targets: texts,
        alpha: 0,
        delay: FLOAT_MS - FLOAT_FADE_MS,
        duration: FLOAT_FADE_MS,
        onComplete: () => texts.forEach((text) => this.destroyFx(text)),
      }),
    );
  }

  // ---- helpers ----

  /** First hotbar slot holding the item (fill order: first same-id stack, GDD §6.2). */
  private findHotbarSlot(itemId: ItemId): number | null {
    const slots = this.deps.state().inventory.slots;
    const n = Math.min(INVENTORY.HOTBAR_SIZE, slots.length);
    for (let i = 0; i < n; i += 1) {
      if (slots[i]?.itemId === itemId) return i;
    }
    return null;
  }

  /** Screen point above a world tile ("tile 上方"), clear of the HUD reserve (A-9). */
  private tileTopScreen(tile: { x: number; y: number }): Point | null {
    return this.worldToScreen(tile.x * TILE + TILE / 2, tile.y * TILE);
  }

  /** Screen point above the player's head (§5.8 头顶飘字 — ItemPicked has no tile). */
  private playerHeadScreen(): Point | null {
    const player = this.deps.state().player;
    return this.worldToScreen(player.tileX * TILE + TILE / 2, player.tileY * TILE - 4);
  }

  private worldToScreen(wx: number, wy: number): Point | null {
    const cam = this.deps.worldCamera();
    if (!cam) return null;
    const point = clampOutsideHudReserve({
      x: (wx - cam.worldView.x) * cam.zoom,
      y: (wy - cam.worldView.y) * cam.zoom,
    });
    // Keep spawn points on screen (640×360 logical, scale.ts).
    return {
      x: Math.min(628, Math.max(12, point.x)),
      y: Math.min(348, Math.max(12, point.y)),
    };
  }

  private makeIcon(itemId: ItemId, at: Point): FxObject {
    const def = getItemDef(itemId);
    let icon: FxObject;
    if (hasFrame(this.scene, TEXTURES.items, def.iconFrame)) {
      icon = this.scene.add
        .image(at.x, at.y, TEXTURES.items, def.iconFrame)
        .setOrigin(0.5)
        .setDepth(DEPTH.feedback);
    } else {
      // Same glyph fallback as slot-view while the items atlas is not loaded yet.
      icon = uiText(this.scene, at.x, at.y, glyphFor(def.category), { color: PALETTE.sand })
        .setOrigin(0.5)
        .setDepth(DEPTH.feedback);
    }
    this.live.add(icon);
    return icon;
  }

  private destroyFx(obj: FxObject): void {
    this.live.delete(obj);
    obj.destroy();
  }

  private track(tween: Phaser.Tweens.Tween): void {
    this.tweens.add(tween);
    tween.once('complete', () => this.tweens.delete(tween));
  }
}
