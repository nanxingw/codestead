/**
 * ui-stack.ts — pure UI stack state machine (GDD §6.5).
 *
 * Invariant (load-bearing, unit-tested): `depth() > 0 ⇔ sources() non-empty` — the
 * driver pauses the sim whenever the stack contributes at least one pause source
 * ("uiStack.length > 0 ⇔ sim 暂停"). Panels map onto the §2.4 PauseSource vocabulary:
 *   - pauseMenu / settings / sessionSettings / keysHelp → 'menu'
 *   - inventory / shop / shippingBin / letter / board / sleepConfirm → 'dialog'
 *   - daySummary → 'day_summary' (the ONLY auto-opened modal)
 *
 * Stack rules (§6.5): only one panel chain at a time; settings/keysHelp/achievements
 * may stack on the pause menu; everything else opens only from an empty stack.
 * Phaser-free.
 */
import type { PauseSource } from '../sim/types';

export type UiPanelId =
  | 'inventory'
  | 'shop'
  | 'shippingBin'
  | 'pauseMenu'
  | 'settings'
  | 'sessionSettings' // 设置 → 会话面板 sub-page (M2, hud-sessions §9/§12-D6)
  | 'questSettings' // 设置 → 村民与 AI 任务 sub-page (M4, ai-quests §6.4)
  | 'keysHelp'
  | 'achievements'
  | 'daySummary'
  | 'sleepConfirm'
  | 'letter'
  | 'board'
  | 'sign' // readable signposts (US5 / backlog A-3, M1.5)
  // ---- M3 (GDD §8.3 build machine / §5.3 / §5.8; PRD 04) ----
  | 'buildCatalog' // CATALOG (= menu, tick stops; B key or Esc 菜单 → 建造)
  | 'buildConfirm' // CONFIRM (= dialog; cost + build days + balance recheck §8.3)
  | 'coop' // coop interior interaction (hens/eggs, rulings A-6/A-7)
  | 'processing' // workshop 6 slots / drying rack 2 slots (§8.2)
  | 'profession' // Lv5 certificate desk two-way choice (§5.3, A-13)
  | 'codex'; // 图鉴 Esc-menu tab (§4.8/§5.8)

export const PANEL_PAUSE_SOURCE: Readonly<Record<UiPanelId, PauseSource>> = {
  pauseMenu: 'menu',
  settings: 'menu',
  sessionSettings: 'menu', // 设置 → 会话面板 (M2)
  questSettings: 'menu', // 设置 → 村民与 AI 任务 (M4)
  keysHelp: 'menu',
  achievements: 'menu', // Esc-menu 「成就」 tab (M1.5, PRD 02 US12)
  inventory: 'dialog',
  shop: 'dialog',
  shippingBin: 'dialog',
  letter: 'dialog',
  board: 'dialog',
  sign: 'dialog',
  sleepConfirm: 'dialog',
  daySummary: 'day_summary',
  // M3 (§8.3: 目录 = 菜单态; 确认框 = 对话态; facility/profession panels = dialogs)
  buildCatalog: 'menu',
  buildConfirm: 'dialog',
  coop: 'dialog',
  processing: 'dialog',
  profession: 'dialog',
  codex: 'menu',
};

/** Panels allowed to be pushed on top of an existing panel (parent → children). */
const NESTABLE: Readonly<Partial<Record<UiPanelId, readonly UiPanelId[]>>> = {
  pauseMenu: ['settings', 'keysHelp', 'achievements', 'codex', 'buildCatalog'],
  // 设置 → 会话面板 (M2) / 村民与 AI 任务 (M4) sub-pages (GDD §6.5; hud-sessions §9 / ai-quests §6.4).
  settings: ['sessionSettings', 'questSettings'],
  // 拆除/搬迁确认 nests on the catalog (§8.3 demolish table confirmations).
  buildCatalog: ['buildConfirm'],
};

export class UiStackModel {
  private stack: UiPanelId[] = [];

  depth(): number {
    return this.stack.length;
  }

  top(): UiPanelId | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  entries(): readonly UiPanelId[] {
    return this.stack;
  }

  /**
   * Try to open a panel. From an empty stack any panel may open; on a non-empty stack
   * only NESTABLE children of the current top may push (mutual-exclusion contract:
   * "同时只开一个面板"). Returns false when rejected.
   */
  push(id: UiPanelId): boolean {
    const top = this.top();
    if (top === null) {
      this.stack.push(id);
      return true;
    }
    if (this.stack.includes(id)) return false;
    const allowed = NESTABLE[top];
    if (allowed?.includes(id)) {
      this.stack.push(id);
      return true;
    }
    return false;
  }

  /** Pop the top panel; returns it (or null on an empty stack). */
  pop(): UiPanelId | null {
    return this.stack.pop() ?? null;
  }

  /** Clear the whole stack (e.g. "回主菜单" path after autosave, §6.5). */
  clear(): UiPanelId[] {
    const removed = this.stack;
    this.stack = [];
    return removed;
  }

  /**
   * Pause sources currently contributed by the stack. Non-empty ⇔ depth() > 0 by
   * construction — the driver-side `Set<PauseSource>` mirrors this via diffing.
   */
  sources(): ReadonlySet<PauseSource> {
    return new Set(this.stack.map((id) => PANEL_PAUSE_SOURCE[id]));
  }
}
