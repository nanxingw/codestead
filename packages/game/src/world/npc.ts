/**
 * npc.ts — world-layer rendering of the three M4 villagers (ai-quests §1.1/§1.3/
 * §6.1). A thin Phaser view like PickupsView/StructuresView: it reads the pure
 * NPC data table (quest/npc-data.ts) + map anchors and draws standing sprites with
 * a 2-frame idle (§1.3 — NO walk/swing/寻路/日程, those are explicitly Out), plus a
 * quiet 8×8 💬 bubble floated over a villager who has a pending quest (§6.1).
 *
 * Zero-disturbance discipline (§3.5 / A4): the bubble is the ONLY in-world signal —
 * silent, no camera move, no pause. Whether a villager carries a bubble is driven
 * entirely by `setPendingNpc(npcId | null)` fed from the QuestStore's `pending`
 * field; nothing here pauses time or pushes UI.
 *
 * Fallback-safe (textures.ts discipline): until the Kenney CC0 atlas frames land
 * (§1.3), each villager gets a distinct synthesized 16×16 placeholder so the world
 * still boots and the three are visually tellable apart.
 */
import Phaser from 'phaser';

import { NPC_ACTORS, QUEST_BUBBLE_FRAME, TEXTURES, actorFrame } from '../AssetKeys';
import { FALLBACK_NPC_ID, NPCS, type NpcDef } from '../quest/npc-data';
import type { NpcId } from '@codestead/shared';
import type { MapMeta } from '../sim/types';
import { PALETTE } from './palette';
import { hasFrame } from './textures';

const TILE = 16;

/** Distinct placeholder body colours so the three villagers read apart sans art. */
const NPC_PLACEHOLDER_COLOR: Readonly<Record<NpcId, number>> = {
  npc_carpenter: PALETTE.soilDark, // 木匠 — earthy brown
  npc_grocer: PALETTE.greenMid, // 杂货 — fresh green
  npc_keeper: PALETTE.waterLight, // 水渠 — water blue
};

interface NpcSprite {
  readonly def: NpcDef;
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly bubble: Phaser.GameObjects.Image;
  readonly hasArt: boolean;
  bubbleTween: Phaser.Tweens.Tween | null;
}

export class NpcView {
  private readonly npcs: NpcSprite[] = [];
  /** anchorId → world foot position, for interaction range checks. */
  private readonly footByNpc = new Map<
    NpcId,
    { x: number; y: number; tile: { x: number; y: number } }
  >();

  constructor(
    private readonly scene: Phaser.Scene,
    mapMeta: MapMeta,
  ) {
    this.ensurePlaceholderTextures();
    const anchorById = new Map(mapMeta.npcAnchors.map((a) => [a.id, a.tile]));
    for (const def of NPCS) {
      const tile = anchorById.get(def.anchorId);
      if (!tile) continue; // map without this anchor — skip (tolerant, §13)
      this.spawn(def, tile);
    }
  }

  /**
   * Float the 💬 bubble over exactly the villager who owns the pending quest
   * (`null` = no pending → all bubbles hidden). Driven by QuestStore.pending; the
   * routing of which villager owns the quest is `quest.npcId` (already resolved by
   * the daemon via routeTopicToNpc). Quiet by contract — no sound, no camera move.
   */
  setPendingNpc(npcId: NpcId | null): void {
    for (const npc of this.npcs) {
      const on = npc.def.id === npcId;
      this.setBubbleVisible(npc, on);
    }
  }

  /**
   * The villager whose foot tile is the player's current facing target, if any
   * (interaction priority sits in WorldScene; this is the lookup it calls). Returns
   * the NpcId so the caller can open chatter (no pending) or the quest dialogue.
   */
  npcAtTile(tile: { x: number; y: number }): NpcId | null {
    for (const [id, foot] of this.footByNpc) {
      if (foot.tile.x === tile.x && foot.tile.y === tile.y) return id;
    }
    return null;
  }

  /** The fallback villager (渠叔) — used when chatter has no specific target. */
  get fallbackNpc(): NpcId {
    return FALLBACK_NPC_ID;
  }

  destroy(): void {
    for (const npc of this.npcs) {
      npc.bubbleTween?.remove();
      npc.bubble.destroy();
      npc.sprite.destroy();
    }
    this.npcs.length = 0;
    this.footByNpc.clear();
  }

  // ---- internals ----

  private spawn(def: NpcDef, tile: { x: number; y: number }): void {
    const x = tile.x * TILE + TILE / 2;
    const y = tile.y * TILE + TILE; // origin (0.5, 1): foot on the anchor tile
    const idleFrame = actorFrame(NPC_ACTORS[def.id], 'idle', 'down', 0);
    const hasArt = hasFrame(this.scene, TEXTURES.characters, idleFrame);
    const sprite = this.scene.add.sprite(
      x,
      y,
      hasArt ? TEXTURES.characters : this.placeholderKey(def.id),
      hasArt ? idleFrame : undefined,
    );
    sprite.setOrigin(0.5, 1);
    sprite.setDepth(100 + y); // y-sort with other entities (GDD §1.5)
    if (hasArt) this.ensureIdleAnim(def.id);
    if (hasArt && this.scene.anims.exists(this.idleAnimKey(def.id))) {
      sprite.anims.play(this.idleAnimKey(def.id), true);
    }

    // 8×8 bubble, hidden until a quest is pending. Sits ~10px above the head.
    const bubble = this.scene.add.image(x, y - TILE - 6, this.bubbleTextureKey());
    bubble.setDepth(100 + y + 1);
    bubble.setVisible(false);

    this.npcs.push({ def, sprite, bubble, hasArt, bubbleTween: null });
    this.footByNpc.set(def.id, { x, y, tile });
  }

  /** Idle anim = 2-frame breathing loop (§1.3); idempotent create. */
  private ensureIdleAnim(id: NpcId): void {
    const key = this.idleAnimKey(id);
    if (this.scene.anims.exists(key)) return;
    const frames = [0, 1]
      .map((i) => actorFrame(NPC_ACTORS[id], 'idle', 'down', i))
      .filter((f) => hasFrame(this.scene, TEXTURES.characters, f))
      .map((f) => ({ key: TEXTURES.characters, frame: f }));
    if (frames.length >= 2) {
      this.scene.anims.create({ key, frames, frameRate: 2, repeat: -1 });
    }
  }

  private idleAnimKey(id: NpcId): string {
    return `npc_idle_${id}`;
  }

  private setBubbleVisible(npc: NpcSprite, on: boolean): void {
    if (npc.bubble.visible === on) return;
    npc.bubble.setVisible(on);
    if (on) {
      // 1s-period gentle float (§6.1) — pure cosmetic, respect reduced-motion by
      // simply not tweening (the bubble is still visible, just static).
      const baseY = npc.bubble.y;
      npc.bubbleTween = this.scene.tweens.add({
        targets: npc.bubble,
        y: baseY - 2,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.InOut',
      });
    } else {
      npc.bubbleTween?.remove();
      npc.bubbleTween = null;
    }
  }

  // ---- fallback textures (synthesized; idempotent) ----

  private placeholderKey(id: NpcId): string {
    return `gen_${id}`;
  }

  private bubbleTextureKey(): string {
    return this.bubbleHasArt() ? TEXTURES.ui : 'gen_quest_bubble';
  }

  private bubbleHasArt(): boolean {
    return hasFrame(this.scene, TEXTURES.ui, QUEST_BUBBLE_FRAME);
  }

  private ensurePlaceholderTextures(): void {
    for (const def of NPCS) {
      const key = this.placeholderKey(def.id);
      if (!this.scene.textures.exists(key)) {
        const canvas = this.scene.textures.createCanvas(key, 16, 16);
        if (canvas) {
          const ctx = canvas.context;
          ctx.fillStyle = this.css(NPC_PLACEHOLDER_COLOR[def.id]);
          ctx.fillRect(3, 2, 10, 12);
          ctx.strokeStyle = this.css(PALETTE.ink);
          ctx.strokeRect(3.5, 2.5, 9, 11);
          canvas.refresh();
        }
      }
    }
    if (!this.bubbleHasArt() && !this.scene.textures.exists('gen_quest_bubble')) {
      const canvas = this.scene.textures.createCanvas('gen_quest_bubble', 8, 8);
      if (canvas) {
        const ctx = canvas.context;
        ctx.fillStyle = this.css(PALETTE.uiPanelLight);
        ctx.fillRect(0, 1, 8, 5);
        ctx.fillRect(2, 6, 2, 2); // little tail
        ctx.fillStyle = this.css(PALETTE.ink);
        ctx.fillRect(2, 3, 1, 1); // the "💬" dots
        ctx.fillRect(4, 3, 1, 1);
        canvas.refresh();
      }
    }
  }

  private css(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
  }
}
