/**
 * CODE-28 palette (GDD §11.2) — the only colors self-drawn assets may use.
 * Keep hex values in sync with game-design.md §11.2 and game/src/ui/palette.ts.
 */

function hex(s) {
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
    255,
  ];
}

export const PAL = {
  ink: hex('#14100d'),
  soilDark: hex('#3d2c23'),
  soilMid: hex('#5a4030'),
  soilLight: hex('#7a563a'),
  woodMid: hex('#a97a50'),
  woodLight: hex('#d2a36b'),
  greenDark: hex('#2c5230'),
  greenMid: hex('#3f7a3c'),
  greenLight: hex('#62a64f'),
  greenPale: hex('#8ed06f'),
  waterDeep: hex('#1f3a5f'),
  waterMid: hex('#2e6f9e'),
  waterLight: hex('#4fa4e8'),
  waterPale: hex('#9ad1f5'),
  goldDeep: hex('#b97e2c'),
  goldMid: hex('#f0b541'),
  goldLight: hex('#f8d878'),
  amber: hex('#e8a33d'),
  redDark: hex('#a93b3b'),
  redMid: hex('#d96a6a'),
  berry: hex('#c0455e'),
  purpleMid: hex('#6b4a8a'),
  purpleLight: hex('#9a7bd0'),
  sand: hex('#ecd3a5'),
  uiPanel: hex('#2b211b'),
  uiPanelLight: hex('#4a3a30'),
  uiText: hex('#f4e3c2'),
  uiTextDim: hex('#9aa0a6'),
  // Session-HUD tokens beyond the CODE-28 list, sanctioned by GDD §7.3/§7.4 +
  // appendix A-8 and shared/src/theme.ts (hud-sessions §3.1/§3.2 verbatim).
  hudUnknown: hex('#8a8198'),
  hudPanelBg: hex('#14141c'),
  hudPanelBorder: hex('#3a3a52'),
};

export const TRANSPARENT = [0, 0, 0, 0];
