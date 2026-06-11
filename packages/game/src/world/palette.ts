/**
 * palette.ts — CODE-28 tokens consumed by the WORLD layer (cursor, lighting, fx,
 * runtime farmland tiles, loading bar). Transcribed from game-design.md §11.2;
 * "UI colors always reference a token, bare hex is forbidden" — this module IS the
 * token table for world-side rendering. The UI subsystem keeps its own token module
 * (game/src/ui/palette.ts per §11.2); when that lands the two should be merged by
 * the integrator (recorded as api drift).
 *
 * Values are numeric (0xrrggbb) because Phaser tint/fill APIs take numbers.
 */

export const PALETTE = {
  /** Global 1px outline color (§11.2 `ink`). */
  ink: 0x14100d,
  /** Wet tilled soil / dry tilled soil / highlight (§11.2 `soil.dark/mid/light`). */
  soilDark: 0x3d2c23,
  soilMid: 0x5a4030,
  soilLight: 0x7a563a,
  /** Leaf system (§11.2 `green.*`). */
  greenMid: 0x3f7a3c,
  greenLight: 0x62a64f,
  greenPale: 0x8ed06f,
  /** Water system (§11.2 `water.*`). */
  waterDeep: 0x1f3a5f,
  waterLight: 0x4fa4e8,
  waterPale: 0x9ad1f5,
  /** Gold / XP / selection outline (§11.2 `gold.*`). */
  goldMid: 0xf0b541,
  goldLight: 0xf8d878,
  /** Warning-not-error amber (§11.2 `amber`) — also the dawn warm-orange tint. */
  amber: 0xe8a33d,
  /** Eggplant purple (§11.2 `purple.mid`) — also the dusk blue-purple tint (§2.7). */
  purpleMid: 0x6b4a8a,
  /** Panel / text tokens (§11.2 `ui.*`). */
  uiPanel: 0x2b211b,
  uiPanelLight: 0x4a3a30,
  uiText: 0xf4e3c2,
  uiTextDim: 0x9aa0a6,
} as const;

/**
 * Day-night tint table (GDD §2.7 — presentation only, stepped every 10 game minutes):
 * dawn = warm orange 25%→0, day = none, golden = warm gold →15%, dusk = blue-purple →45%.
 * Rain adds a 10% cold-grey overlay all day. The §2.7 table names colors, not hex —
 * tokens chosen from CODE-28: amber (warm orange), gold.mid (warm gold),
 * purple.mid (blue-purple), ui.textDim (cold grey).
 */
export const LIGHT_COLORS = {
  dawn: PALETTE.amber,
  golden: PALETTE.goldMid,
  dusk: PALETTE.purpleMid,
  rainGrey: PALETTE.uiTextDim,
} as const;

/** Tile cursor colors (GDD §1.7: valid = white frame + 12% white fill; invalid = grey). */
export const CURSOR_COLORS = {
  valid: 0xffffff,
  invalid: PALETTE.uiTextDim,
} as const;
