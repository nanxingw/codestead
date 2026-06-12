/**
 * quest-dialogue.ts — the four-屏 villager dialogue render shell (ai-quests §6.2),
 * a scene-level component like SessionHud (NOT a UI-stack Panel: it is driven by the
 * QuestStore, not the sim, and owns its own `dialog` pause source).
 *
 * Bottom 640×96 panel: 48px NPC head left, typewriter body (30 字符/s, any-key snaps
 * complete), screen flow driven by the pure reducer projection (quest-dialogue-panel.ts
 * viewForScreen). decision = 4 屏 (opener → question+options → optional 补充 → closer+
 * reward); reflection = same minus the options/compose split.
 *
 * Hard rules (§6.2 实现要点 / §11-E8 / §6.1 / GDD §4.3):
 *  - opening PAUSES game time via the injected `dialog` pause source (§6.1);
 *  - the note input captures ALL keyboard while active — WASD/E never reach the world
 *    (§6.2). Implemented as an in-Phaser captured text buffer (no DOM config needed);
 *  - ALL quest text renders as PLAIN TEXT (no markup parse); schema length caps are the
 *    overflow backstop (§6.2 / §11-E8);
 *  - Esc on屏1–3 = 先不聊 (dismiss, zero-cost), never closes destructively;
 *  - the reward line (第4屏) reuses the shop金币 sfx (§6.2 — injected `playRewardSfx`).
 *
 * The pure store transitions live in quest-store.ts; this file only renders the
 * projection and translates keys into QuestUiEvents fed back through `emit`.
 */
import Phaser from 'phaser';

import { NPC_ACTORS, TEXTURES, actorFrame } from '../../AssetKeys';
import type { QuestScreen, QuestState, QuestUiEvent } from '../../quest/quest-store';
import { hasFrame } from '../../world/textures';
import { DEPTH } from '../layout';
import { hexToNum, PALETTE } from '../palette';
import { viewForScreen, QUEST_PANEL } from '../panels/quest-dialogue-panel';
import { t } from '../strings';
import { addPanel } from '../widgets/panel';
import { uiText } from '../widgets/text';

const GAME_HEIGHT = 360;
const TYPEWRITER_MS_PER_CHAR = 1000 / QUEST_PANEL.TYPEWRITER_CPS;

export interface QuestDialogueDeps {
  /** Live store view (pending quest + screen + selection + pendingReward). */
  state: () => QuestState;
  /** Push a UI event into the store (and, for submit/dismiss, upstream WS). */
  emit: (event: QuestUiEvent) => void;
  /** Add/remove the `dialog` pause source so opening停 game time (§6.1 / GDD §4.3). */
  pause: (on: boolean) => void;
  reducedMotion: () => boolean;
  /** Shop金币 sfx for the reward line (§6.2). */
  playRewardSfx?: () => void;
}

/**
 * Renders the dialogue when the store screen is not 'none'; hides otherwise. UIScene
 * subscribes the store and calls `sync()` on every change; `handleKey` is routed only
 * while `isOpen()`.
 */
export class QuestDialogue {
  private root: Phaser.GameObjects.Container | null = null;
  private bodyText: Phaser.GameObjects.Text | null = null;
  private optionTexts: Phaser.GameObjects.Text[] = [];
  private footerText: Phaser.GameObjects.Text | null = null;
  private inputText: Phaser.GameObjects.Text | null = null;
  private head: Phaser.GameObjects.Sprite | null = null;
  private nameText: Phaser.GameObjects.Text | null = null;
  private tagText: Phaser.GameObjects.Text | null = null;

  /** Screen currently rendered, so we only rebuild on a真正的 transition. */
  private renderedScreen: QuestScreen = 'none';
  private renderedQuestId: string | null = null;
  /** Typewriter progress (chars revealed) + the full body being typed. */
  private fullBody = '';
  private typed = 0;
  private typeAccumMs = 0;
  /** In-Phaser note buffer (补充 / reflection 正文); never persisted as draft (§11-E5). */
  private noteBuffer = '';
  private pauseActive = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly deps: QuestDialogueDeps,
  ) {}

  /** True while a dialogue screen is active (UIScene routes keys here then). */
  isOpen(): boolean {
    return this.deps.state().screen !== 'none';
  }

  /** Whether the active screen has a text input (compose / reflection question). */
  private hasInput(): boolean {
    const s = this.deps.state();
    if (s.pending === null) return false;
    if (s.screen === 'compose') return true;
    return s.screen === 'question' && s.pending.kind === 'reflection';
  }

  /** Per-frame: drive the typewriter (no-op when fully revealed or closed). */
  update(deltaMs: number): void {
    if (this.root === null || this.typed >= this.fullBody.length) return;
    if (this.deps.reducedMotion()) {
      this.typed = this.fullBody.length;
    } else {
      this.typeAccumMs += deltaMs;
      while (this.typeAccumMs >= TYPEWRITER_MS_PER_CHAR && this.typed < this.fullBody.length) {
        this.typeAccumMs -= TYPEWRITER_MS_PER_CHAR;
        this.typed += 1;
      }
    }
    this.bodyText?.setText(this.fullBody.slice(0, this.typed));
  }

  /** Reconcile the rendered panel with the current store screen (called on change). */
  sync(): void {
    const s = this.deps.state();
    if (s.screen === 'none' || s.pending === null) {
      this.teardown();
      return;
    }
    this.setPause(true);
    const questId = s.pending.questId;
    if (
      this.root === null ||
      this.renderedScreen !== s.screen ||
      this.renderedQuestId !== questId
    ) {
      // Entering a new screen (or a new quest): reset the note buffer when leaving the
      // input screens, rebuild the panel for the new projection.
      if (s.screen !== 'compose' && s.screen !== 'question') this.noteBuffer = '';
      if (this.renderedQuestId !== questId) this.noteBuffer = '';
      this.renderedScreen = s.screen;
      this.renderedQuestId = questId;
      this.build();
    } else {
      // Same screen, e.g. a selectOption highlight changed — refresh option rows only.
      this.refreshOptions();
    }
  }

  /** Route a keyboard event while the dialogue is top (returns true when consumed). */
  handleKey(event: KeyboardEvent): boolean {
    const s = this.deps.state();
    if (s.screen === 'none' || s.pending === null) return false;

    // Esc = 先不聊 on屏1–3 (never the closer). Zero-cost (§6.2).
    if (event.key === 'Escape') {
      if (s.screen !== 'closer') this.deps.emit({ kind: 'dismiss' });
      return true;
    }

    // Typewriter still running: any key first snaps it complete (§6.2), no advance.
    if (this.typed < this.fullBody.length && !this.hasInput()) {
      this.typed = this.fullBody.length;
      this.bodyText?.setText(this.fullBody);
      return true;
    }

    switch (s.screen) {
      case 'opener':
        // E / any advance key → question屏.
        if (event.key === 'Enter' || event.key === 'e' || event.key === 'E' || event.key === ' ') {
          this.deps.emit({ kind: 'advance' });
        }
        return true;

      case 'question':
        if (s.pending.kind === 'decision') return this.handleDecisionQuestionKey(event, s);
        return this.handleInputKey(event, /* allowSkip */ false);

      case 'compose':
        return this.handleInputKey(event, /* allowSkip */ true);

      case 'closer':
        if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
          this.deps.emit({ kind: 'closeDialogue' });
        }
        return true;

      default:
        return true;
    }
  }

  destroy(): void {
    this.teardown();
  }

  // ---- key handling per screen ----

  private handleDecisionQuestionKey(event: KeyboardEvent, s: QuestState): boolean {
    const options = s.pending?.options ?? [];
    const ids = options.map((o) => o.id);
    const current = s.selectedOption;
    const digit = Number.parseInt(event.key, 10);
    if (digit >= 1 && digit <= ids.length) {
      this.deps.emit({ kind: 'selectOption', optionId: ids[digit - 1] });
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      const idx = current === null ? 0 : ids.indexOf(current);
      const next = (idx + dir + ids.length) % ids.length;
      this.deps.emit({ kind: 'selectOption', optionId: ids[next] });
      return true;
    }
    if (event.key === 'Enter' || event.key === 'e' || event.key === 'E') {
      // Confirm the highlighted option → compose屏 (the reducer no-ops without one).
      this.deps.emit({ kind: 'confirmOption' });
      return true;
    }
    return true;
  }

  /** Text-input screens (compose 补充 / reflection 正文). Ctrl+Enter submits; Tab skips
   *  (compose only). The note flows IN via the submitAnswer event (§12-3). */
  private handleInputKey(event: KeyboardEvent, allowSkip: boolean): boolean {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      const note = this.noteBuffer.trim();
      this.deps.emit({ kind: 'submitAnswer', ...(note.length > 0 ? { note } : {}) });
      return true;
    }
    if (event.key === 'Tab') {
      // Compose 补充 is optional: Tab submits with no note (§6.2 第3屏 [Tab → 跳过]).
      // Reflection requires a non-empty note, so Tab does nothing there.
      if (allowSkip) this.deps.emit({ kind: 'submitAnswer' });
      return true;
    }
    if (event.key === 'Backspace') {
      this.noteBuffer = this.noteBuffer.slice(0, -1);
      this.refreshInput();
      return true;
    }
    if (event.key === 'Enter') {
      this.noteBuffer += '\n';
      this.refreshInput();
      return true;
    }
    // Printable single chars only (ignore arrows/modifiers/function keys).
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (this.noteBuffer.length < 400) this.noteBuffer += event.key; // schema body cap (§4.6)
      this.refreshInput();
      return true;
    }
    return true;
  }

  // ---- rendering ----

  private build(): void {
    this.teardownObjects();
    const s = this.deps.state();
    if (s.pending === null) return;
    const view = viewForScreen({
      quest: () => s.pending,
      screen: () => s.screen,
      selectedOption: () => s.selectedOption,
      reward: () => s.pendingReward,
      emit: () => undefined,
    });

    const panelY = GAME_HEIGHT - QUEST_PANEL.HEIGHT;
    const root = this.scene.add.container(0, 0).setDepth(DEPTH.panel);
    this.root = root;
    root.add(addPanel(this.scene, 0, panelY, QUEST_PANEL.WIDTH, QUEST_PANEL.HEIGHT));

    // 48px NPC head (sprite ×3 if art landed, else a flat plate — §1.3 fallback-safe).
    this.head = this.buildHead(s, panelY);
    if (this.head) {
      root.add(this.head);
    } else {
      // Plate fallback: a flat 48×48 panel-light rect so the head slot is never empty.
      root.add(
        this.scene.add
          .rectangle(8, panelY + 8, 48, 48, hexToNum(PALETTE.ui.panelLight))
          .setOrigin(0, 0),
      );
    }

    const textX = QUEST_PANEL.HEAD_PX + 16;
    this.nameText = uiText(this.scene, textX, panelY + 8, view.npcName, {
      color: PALETTE.ui.text,
    });
    root.add(this.nameText);

    // [任务 · 决策] / [任务 · 反思] tag, top-right.
    const tag = s.pending.kind === 'decision' ? t('quest.tag.decision') : t('quest.tag.reflection');
    this.tagText = uiText(this.scene, QUEST_PANEL.WIDTH - 12, panelY + 8, tag, {
      color: PALETTE.gold.light,
      align: 'right',
    }).setOrigin(1, 0);
    root.add(this.tagText);

    // Body (typewriter target). Reward closer屏 appends the reward line below.
    this.fullBody = view.body;
    this.typed = this.deps.reducedMotion() ? view.body.length : 0;
    this.typeAccumMs = 0;
    this.bodyText = uiText(this.scene, textX, panelY + 26, this.fullBody.slice(0, this.typed), {
      color: PALETTE.ui.text,
      wrapWidth: QUEST_PANEL.WIDTH - textX - 12,
    });
    root.add(this.bodyText);

    if (s.screen === 'question' && s.pending.kind === 'decision') {
      this.buildOptions(s, textX, panelY + 44, root);
    }
    if (this.hasInput()) {
      this.buildInput(textX, panelY + 44, root);
    }
    if (s.screen === 'closer' && s.pendingReward !== null) {
      this.buildRewardLine(textX, panelY + 50, root);
    }

    this.footerText = uiText(
      this.scene,
      QUEST_PANEL.WIDTH / 2,
      panelY + QUEST_PANEL.HEIGHT - 14,
      view.footerKeys.map((k) => t(k)).join('   '),
      { color: PALETTE.ui.textDim, align: 'center' },
    ).setOrigin(0.5, 0);
    root.add(this.footerText);
  }

  private buildHead(s: QuestState, panelY: number): Phaser.GameObjects.Sprite | null {
    const npcId = s.pending?.npcId;
    if (npcId === undefined) return null;
    const frame = actorFrame(NPC_ACTORS[npcId], 'idle', 'down', 0);
    if (hasFrame(this.scene, TEXTURES.characters, frame)) {
      const head = this.scene.add.sprite(8, panelY + 8, TEXTURES.characters, frame);
      head.setOrigin(0, 0).setScale(3); // 16×16 ×3 = 48px (§1.3 / 宪法 §4.2 整数倍)
      return head;
    }
    // Art not loaded yet (§1.3): a flat 48px plate keeps the head slot from being
    // empty without drawing a broken-texture sprite (which would warn). The plate
    // lives on the container as a Rectangle, not a Sprite, so return null here.
    return null;
  }

  private buildOptions(
    s: QuestState,
    x: number,
    y: number,
    root: Phaser.GameObjects.Container,
  ): void {
    this.optionTexts = [];
    const options = s.pending?.options ?? [];
    let row = 0;
    options.forEach((opt, i) => {
      const selected = s.selectedOption === opt.id;
      const prefix = `${selected ? '▶' : ' '} ${String(i + 1)}. `;
      const line = uiText(this.scene, x, y + row * 24, `${prefix}${opt.label}`, {
        color: selected ? PALETTE.gold.light : PALETTE.ui.text,
        wrapWidth: QUEST_PANEL.WIDTH - x - 12,
      });
      root.add(line);
      this.optionTexts.push(line);
      row += 1;
      const tradeoff = uiText(this.scene, x + 16, y + row * 24, `└ 代价：${opt.tradeoff}`, {
        color: PALETTE.ui.textDim,
        wrapWidth: QUEST_PANEL.WIDTH - x - 28,
      });
      root.add(tradeoff);
      this.optionTexts.push(tradeoff);
      row += 1;
    });
  }

  private buildInput(x: number, y: number, root: Phaser.GameObjects.Container): void {
    this.inputText = uiText(this.scene, x, y, this.inputDisplay(), {
      color: PALETTE.ui.text,
      wrapWidth: QUEST_PANEL.WIDTH - x - 12,
    });
    root.add(this.inputText);
  }

  private buildRewardLine(x: number, y: number, root: Phaser.GameObjects.Container): void {
    const reward = this.deps.state().pendingReward;
    if (reward === null) return;
    const text = `${t('quest.reward.noteSaved')}    +${String(reward.gold)}g   +${String(reward.xp)} XP`;
    const line = uiText(this.scene, x, y, text, { color: PALETTE.gold.light });
    root.add(line);
    this.deps.playRewardSfx?.();
  }

  private refreshOptions(): void {
    const s = this.deps.state();
    if (s.screen !== 'question' || s.pending?.kind !== 'decision' || this.root === null) return;
    // Cheapest correct path: rebuild option rows for the new highlight.
    for (const obj of this.optionTexts) obj.destroy();
    this.optionTexts = [];
    const textX = QUEST_PANEL.HEAD_PX + 16;
    this.buildOptions(s, textX, GAME_HEIGHT - QUEST_PANEL.HEIGHT + 44, this.root);
  }

  private refreshInput(): void {
    this.inputText?.setText(this.inputDisplay());
  }

  private inputDisplay(): string {
    return `${this.noteBuffer}▌`;
  }

  private setPause(on: boolean): void {
    if (on === this.pauseActive) return;
    this.pauseActive = on;
    this.deps.pause(on);
  }

  private teardownObjects(): void {
    this.root?.destroy(true);
    this.root = null;
    this.bodyText = null;
    this.optionTexts = [];
    this.footerText = null;
    this.inputText = null;
    this.head = null;
    this.nameText = null;
    this.tagText = null;
  }

  private teardown(): void {
    this.teardownObjects();
    this.renderedScreen = 'none';
    this.renderedQuestId = null;
    this.fullBody = '';
    this.typed = 0;
    this.noteBuffer = '';
    this.setPause(false);
  }
}
