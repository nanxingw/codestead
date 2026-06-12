/**
 * quest-dialogue-panel.ts — the four-屏 villager dialogue (ai-quests §6.2).
 *
 * Bottom 640×96 panel: 48px NPC头像 left, typewriter body (30 字符/s, any-key
 * snaps complete), screen flow driven by the pure QuestStore reducer
 * (quest/quest-store.ts applyQuestUiEvent). decision = 4 屏 (opener → question+
 * options → optional compose → closer+reward); reflection = same minus the
 * options/compose split (第2屏 is question + textarea).
 *
 * Hard rules baked into the contract (§6.2 实现要点 / §11-E8 / §6.1 / GDD §4.3):
 *  - opening the dialogue PAUSES game time via the 'dialog' pause source (§6.1);
 *  - the compose / reflection textarea is a Phaser DOM overlay that CAPTURES all
 *    keyboard events while active — WASD/E never reach the world (§6.2);
 *  - ALL quest text renders as PLAIN TEXT (no markup parse); schema length caps
 *    are the overflow backstop (§6.2 / §11-E8 — anti-injection / anti-overflow);
 *  - Esc on屏1–3 = 先不聊 (dismiss, zero-cost), never closes destructively;
 *  - the reward line (第4屏) REUSES the shop金币 sfx + 飘字 (§6.2).
 *
 * SKELETON: the panel-facing handle + screen renderer signatures. The Phaser
 * build (text objects, head sprite, DOM textarea, typewriter tween, sfx) is the
 * dialogue-UI sub-task — rendering details carry no unit tests (sim discipline).
 */
import type { Quest, QuestReward } from '@codestead/shared';

import { NPCS_BY_ID } from '../../quest/npc-data.js';
import type { QuestScreen, QuestUiEvent } from '../../quest/quest-store.js';

/** Logical-resolution dialogue panel geometry (§6.2). */
export const QUEST_PANEL = {
  WIDTH: 640,
  HEIGHT: 96,
  HEAD_PX: 48,
  /** Typewriter speed (§6.2). */
  TYPEWRITER_CPS: 30,
} as const;

/**
 * What the dialogue panel needs from its host: the live quest, the current screen
 * + selection from the store, a way to emit a UI event back into the store, and
 * the reward to celebrate once it arrives. The host wires `emit` to
 * applyQuestUiEvent and, for submit/dismiss, to the outgoing WS frames.
 */
export interface QuestDialogueHandle {
  /** The OFFERED quest being answered (null ⇒ panel should close). */
  quest(): Quest | null;
  /** Active screen (drives which renderer runs). */
  screen(): QuestScreen;
  /** Selected option id during the question屏 (decision), or null. */
  selectedOption(): 'a' | 'b' | 'c' | 'd' | null;
  /** Reward for the closer屏, or null until questReward arrives. */
  reward(): QuestReward | null;
  /** Push a UI event into the pure store (and, for submit/dismiss, upstream WS). */
  emit(event: QuestUiEvent): void;
}

/**
 * Per-screen render contract. Each returns the text the panel should show; the
 * Phaser layer owns the actual drawing. SKELETON — bodies by the dialogue-UI
 * sub-task. Kept as a pure mapping so the screen→text choice is testable apart
 * from Phaser if desired.
 */
export interface QuestScreenView {
  /** NPC display name shown beside the head. */
  readonly npcName: string;
  /** Body text for the active screen (plain text, §6.2). */
  readonly body: string;
  /** Option rows for the question屏 (decision only): label + grey tradeoff line. */
  readonly options?: readonly { id: 'a' | 'b' | 'c' | 'd'; label: string; tradeoff: string }[];
  /** Whether a multiline textarea overlay is active on this screen (compose / reflection). */
  readonly textarea: boolean;
  /** Footer hint keys (e.g. 'E 继续 / Esc 先不聊') — resolved from ui/strings.ts. */
  readonly footerKeys: readonly string[];
}

/** Footer hint keys (resolved from ui/strings.ts by the panel). */
const FOOTER = {
  /** opener屏: E 继续 / Esc 先不聊. */
  OPENER: ['quest.footer.advance', 'quest.footer.dismiss'] as const,
  /** decision question屏: ↑↓/1~4 选择 · E 确认 / Esc 先不聊. */
  QUESTION_DECISION: ['quest.footer.choose', 'quest.footer.dismiss'] as const,
  /** reflection question屏: 文本框 · Ctrl+Enter 提交 / Esc 先不聊. */
  QUESTION_REFLECTION: ['quest.footer.submit', 'quest.footer.dismiss'] as const,
  /** compose屏: Ctrl+Enter 提交 / Tab 跳过. */
  COMPOSE: ['quest.footer.submit', 'quest.footer.skip'] as const,
  /** closer屏: E 回去干活. */
  CLOSER: ['quest.footer.done'] as const,
} as const;

/** Display name beside the head; falls back to the raw npcId if unknown. */
function npcDisplayName(quest: Quest): string {
  return NPCS_BY_ID.get(quest.npcId)?.displayName ?? quest.npcId;
}

/**
 * Project the store into the view for the active screen (§6.2). PURE over the
 * handle's snapshot. Renders the opener/body/closer verbatim from the quest (plain
 * text — no markup parse, §6.2 / §11-E8), builds option rows from quest.options,
 * and flags the textarea for compose (decision) / question (reflection).
 *
 * The screen vocabulary maps to the four屏: opener → question (+options for
 * decision / +textarea for reflection) → compose (decision only, textarea) →
 * closer (closing line + reward). 'none' should never reach here (the panel is
 * only mounted while a dialogue screen is active) — it degrades to the opener
 * projection rather than throwing.
 */
export function viewForScreen(handle: QuestDialogueHandle): QuestScreenView {
  const quest = handle.quest();
  if (quest === null) {
    // No quest ⇒ the panel should be closing; render an empty, inert view.
    return { npcName: '', body: '', textarea: false, footerKeys: [] };
  }
  const npcName = npcDisplayName(quest);
  const isDecision = quest.kind === 'decision';
  const screen = handle.screen();

  switch (screen) {
    case 'opener':
    case 'none':
      return {
        npcName,
        body: quest.opener,
        textarea: false,
        footerKeys: [...FOOTER.OPENER],
      };

    case 'question':
      if (isDecision) {
        return {
          npcName,
          body: quest.body,
          options: (quest.options ?? []).map((o) => ({
            id: o.id,
            label: o.label,
            tradeoff: o.tradeoff,
          })),
          textarea: false,
          footerKeys: [...FOOTER.QUESTION_DECISION],
        };
      }
      // reflection: question + multiline textarea on the same屏 (§6.2).
      return {
        npcName,
        body: quest.body,
        textarea: true,
        footerKeys: [...FOOTER.QUESTION_REFLECTION],
      };

    case 'compose':
      // decision only: optional 补充 textarea after a选项 is chosen (§6.2 第3屏).
      return {
        npcName,
        body: composePrompt(quest, handle.selectedOption()),
        textarea: true,
        footerKeys: [...FOOTER.COMPOSE],
      };

    case 'closer':
      return {
        npcName,
        body: quest.closer,
        textarea: false,
        footerKeys: [...FOOTER.CLOSER],
      };

    default:
      return { npcName, body: quest.opener, textarea: false, footerKeys: [...FOOTER.OPENER] };
  }
}

/**
 * Compose屏 prompt (§6.2 第3屏): "选了「<label>」。想补充一句为什么吗？（可跳过）".
 * The chosen option's label is rendered as PLAIN TEXT inside the prompt (schema
 * length caps are the overflow backstop, §6.2 / §11-E8).
 */
function composePrompt(quest: Quest, selected: 'a' | 'b' | 'c' | 'd' | null): string {
  const label = quest.options?.find((o) => o.id === selected)?.label ?? '';
  return label
    ? `选了「${label}」。想补充一句为什么吗？（可跳过）`
    : '想补充一句为什么吗？（可跳过）';
}
