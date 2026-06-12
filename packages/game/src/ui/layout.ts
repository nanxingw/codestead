/**
 * layout.ts — UI layout constants (GDD §6.6 HUD layout, §6.7 panel specs, §11.3 rules).
 *
 * All coordinates/sizes are multiples of 4 except where the GDD itself specifies
 * otherwise (hotbar slot gap 2px, top-right panel height 30 — both verbatim §6.6).
 * Logical resolution is 640×360 (scale.ts).
 */

/**
 * M2 session-HUD reserve, ruling A-9: rect (4,4)–(156,150). ZERO pixels may be drawn
 * inside this rect by the M1 UI (acceptance check in GDD §6.9). Modal scrims must be
 * composed around it — see widgets/scrim.ts.
 */
export const HUD_RESERVED = { x: 4, y: 4, width: 152, height: 146 } as const;

/** Top-right play panel: (540,4) 96×30 + 4px XP bar attached below (GDD §6.6). */
export const TOP_RIGHT_PANEL = { x: 540, y: 4, width: 96, height: 30 } as const;
export const XP_BAR = { x: 540, y: 36, width: 96, height: 4 } as const;

/** Hotbar: (222,336) 196×20 — 9 slots of 20×20 with 2px gaps (GDD §6.6). */
export const HOTBAR = { x: 222, y: 336, width: 196, height: 20 } as const;
export const SLOT_SIZE = 20;
export const SLOT_GAP = 2;

/** Toast line sits above the hotbar at y=312; max 2 on screen (GDD §6.6/§6.7). */
export const TOAST_Y = 312;

/** Achievement toast anchor (bottom-right, origin (1,1)); 2.5s non-modal (GDD §5.8). */
export const ACHIEVEMENT_TOAST = { x: 636, y: 356 } as const;

/** Level-up banner slides in at top-center (GDD §5.8); x-extent clears HUD_RESERVED. */
export const BANNER = { centerX: 320, y: 8, width: 296, height: 20 } as const;

/** Inventory panel: 232×156 centered at (204,102) (GDD §6.6). */
export const INVENTORY_PANEL = { x: 204, y: 102, width: 232, height: 156 } as const;

/** Shop panel — no verbatim GDD rect; chosen on the 4-grid, clear of HUD_RESERVED. */
export const SHOP_PANEL = { x: 180, y: 24, width: 280, height: 312 } as const;

/** Shipping-bin panel (mock in GDD §4.2); 4-grid, clear of HUD_RESERVED. */
export const BIN_PANEL = { x: 160, y: 60, width: 320, height: 240 } as const;

/** Day-summary modal panel; full-screen scrim + centered card clear of HUD_RESERVED. */
export const SUMMARY_PANEL = { x: 168, y: 24, width: 304, height: 312 } as const;

/** Pause menu / settings / dialogs — small centered cards (4-grid).
 *  Menu height fits 8 buttons since the M3 「建造」/「图鉴」 entries (PRD 04 US1/US49). */
export const MENU_PANEL = { x: 240, y: 60, width: 160, height: 240 } as const;
export const SETTINGS_PANEL = { x: 184, y: 36, width: 272, height: 288 } as const;
export const DIALOG_PANEL = { x: 220, y: 132, width: 200, height: 96 } as const;
export const READING_PANEL = { x: 184, y: 60, width: 272, height: 240 } as const;

/** Build catalog (M3, GDD §8.3 CATALOG) — same envelope family as the shop panel. */
export const BUILD_PANEL = { x: 168, y: 24, width: 304, height: 312 } as const;

/** Build/demolish confirm dialog (M3, §8.3 CONFIRM — taller than DIALOG_PANEL). */
export const BUILD_CONFIRM_PANEL = { x: 196, y: 104, width: 248, height: 152 } as const;

/** Facility interaction panels (coop / workshop / drying rack, M3 §8.2). */
export const FACILITY_PANEL = { x: 184, y: 48, width: 272, height: 264 } as const;

/** Profession certificate dialog (M3, GDD §5.3 职业证书桌). */
export const PROFESSION_PANEL = { x: 168, y: 84, width: 304, height: 192 } as const;

/** Codex (图鉴) page — same envelope as the settings/achievements tabs (M3, §5.8). */
export const CODEX_PANEL = { x: 184, y: 36, width: 272, height: 288 } as const;

/** Font sizes: only 12 / 24 px, line heights 16 / 28 (GDD §11.3). */
export const FONT_SIZE = { body: 12, title: 24 } as const;
export const LINE_HEIGHT = { body: 16, title: 28 } as const;

/** UI depths inside UIScene (above whatever WorldScene renders). */
export const DEPTH = {
  hud: 10,
  /** In-place success fx (flying icons / floaters, GDD §6.4): over the HUD, under toasts. */
  feedback: 14,
  toast: 20,
  banner: 22,
  scrim: 30,
  panel: 40,
  held: 50,
  tooltip: 60,
} as const;
