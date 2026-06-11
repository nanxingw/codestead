/**
 * palette.ts — CODE-28 UI color tokens (GDD §11.2).
 *
 * This module is the ONLY place in the UI layer where bare hex values are allowed
 * ("UI 颜色一律引用 token（game/src/ui/palette.ts），禁裸 hex"). Session five-state
 * colors stay in @codestead/shared theme.ts (single source per §7.3) — do not copy
 * them here.
 */

export const PALETTE = {
  /** Global 1px hard outline color. */
  ink: '#14100d',
  soil: { dark: '#3d2c23', mid: '#5a4030', light: '#7a563a' },
  wood: { mid: '#a97a50', light: '#d2a36b' },
  green: { dark: '#2c5230', mid: '#3f7a3c', light: '#62a64f', pale: '#8ed06f' },
  water: { deep: '#1f3a5f', mid: '#2e6f9e', light: '#4fa4e8', pale: '#9ad1f5' },
  gold: { deep: '#b97e2c', mid: '#f0b541', light: '#f8d878' },
  /** Warning / clock-amber (not an error color). */
  amber: '#e8a33d',
  red: { dark: '#a93b3b', mid: '#d96a6a' },
  berry: '#c0455e',
  purple: { mid: '#6b4a8a', light: '#9a7bd0' },
  /** Paper / parchment (letter & board reading panels). */
  sand: '#ecd3a5',
  ui: {
    panel: '#2b211b',
    panelLight: '#4a3a30',
    text: '#f4e3c2',
    textDim: '#9aa0a6',
  },
  /** M2 session-HUD panel chrome (hud-sessions §3.2 / GDD §7.4 verbatim values). */
  hud: {
    panelBg: '#14141c',
    panelBorder: '#3a3a52',
    /** Row highlight flash overlay color (white @ 12%, §3.2). */
    highlight: '#ffffff',
    /** Disconnect bar gray (§4.5 — same value as the unknown state token). */
    disconnected: '#8a8198',
  },
} as const;

/** `#rrggbb` → Phaser numeric color. */
export function hexToNum(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
