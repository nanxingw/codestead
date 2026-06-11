/**
 * host.ts — the narrow surface a panel sees of UIScene. Panels render from SimApi
 * snapshots (`host.state()`) and act only through SimCommands (`host.dispatch`) plus
 * UI-local concerns (toasts, closing, opening a nested panel). One-way flow, GDD §12.
 */
import type Phaser from 'phaser';

import type { SfxKey } from '../../AssetKeys';
import type { HudSettings } from '../../hud/settings';
import type { HudState } from '../../hud/types';
import type { SimCommand, SimEvent, WorldState } from '../../sim/types';
import type { UiContext } from '../context';
import type { SettingsStore } from '../settings-store';
import type { UiPanelId } from '../ui-stack';

/**
 * Narrow surface of the session HUD exposed to panels (hud-sessions §12-D6):
 * the settings page reads/writes HUD settings (persisted to codestead.hud.v1,
 * NEVER the farm save) and reads connection state; the day-summary panel reads
 * stateCounts for the §4.6 会话一行. Implemented by ui/hud/session-hud.ts.
 */
export interface SessionHudHandle {
  settings(): Readonly<HudSettings>;
  updateSettings(patch: Partial<HudSettings>): void;
  hudState(): Readonly<HudState>;
}

export interface UiHost {
  readonly scene: Phaser.Scene;
  readonly ctx: UiContext;
  readonly settings: SettingsStore;
  /** Absent only in the passive M0-compatible shell (and in panel tests). */
  readonly sessionHud?: SessionHudHandle;
  state(): Readonly<WorldState>;
  dispatch(command: SimCommand): SimEvent[];
  /** Blocked-reason toast (string key from strings.ts, GDD §6.7 toast discipline). */
  toast(key: string, params?: Record<string, string | number>): void;
  /** Pop the top panel off the UI stack. */
  closeTop(): void;
  /** Push a nested panel (pauseMenu → settings / keysHelp only, GDD §6.5). */
  openChild(id: UiPanelId): void;
  /** Clear the whole stack (回主菜单 path, §6.5). */
  closeAll(): void;
  reducedMotion(): boolean;
  playSfx(key: SfxKey): void;
}

/** Lifecycle every panel implements; panels are built on open, destroyed on close. */
export interface Panel {
  readonly id: UiPanelId;
  /** Re-render from the current sim snapshot (called after dispatches / sim events). */
  refresh(): void;
  /** Handle a key while this panel is top-of-stack; return true when consumed. */
  handleKey(event: KeyboardEvent): boolean;
  destroy(): void;
  /**
   * Hide/show while a child panel covers this one (pauseMenu → settings/keysHelp/
   * achievements, §6.5). All panels share the same DEPTH tokens, so a covered parent
   * must be hidden outright or its depth-(panel+1) widgets bleed through the child.
   */
  setCovered?(covered: boolean): void;
}
