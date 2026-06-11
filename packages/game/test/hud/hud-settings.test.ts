import { describe, expect, it } from 'vitest';

import {
  HUD_EVER_CONNECTED_KEY,
  HUD_SETTINGS_DEFAULTS,
  HUD_SETTINGS_KEY,
  HudSettingsSchema,
  parseHudSettings,
} from '../../src/hud/settings.js';

/** The 4 M2-end additive keys at their §9 defaults (behavior fixed until exposed). */
const M2_END_DEFAULTS = {
  showIdle: true,
  showUnknown: true,
  autoFade: true,
  soundInBackground: false,
} as const;

describe('HUD settings (hud-sessions §9 — 6 first-version keys + 4 additive M2-end keys)', () => {
  it('pins the localStorage keys (never inside the farm save)', () => {
    expect(HUD_SETTINGS_KEY).toBe('codestead.hud.v1');
    expect(HUD_EVER_CONNECTED_KEY).toBe('codestead.hud.v1.everConnected');
  });

  it('defaults match the §9 table exactly', () => {
    expect(HUD_SETTINGS_DEFAULTS).toEqual({
      displayMode: 'expanded',
      maxRows: 5,
      opacity: 0.8,
      sound: 'off', // default OFF is design law (§3.4, anti-pattern 7)
      tabBadge: true,
      streamerMode: false,
      ...M2_END_DEFAULTS,
    });
  });

  it('round-trips a stored 6-key first-version object (additive keys fill §9 defaults)', () => {
    const stored = {
      displayMode: 'collapsed',
      maxRows: 9,
      opacity: 0.6,
      sound: 'blocked',
      tabBadge: false,
      streamerMode: true,
    };
    // JSON written by the 6-key first version keeps parsing unchanged — the
    // M2-end keys come back at their defaults (additive evolution contract).
    expect(parseHudSettings(JSON.parse(JSON.stringify(stored)))).toEqual({
      ...stored,
      ...M2_END_DEFAULTS,
    });
  });

  it('round-trips a full 10-key object', () => {
    const stored = {
      displayMode: 'expanded',
      maxRows: 7,
      opacity: 1,
      sound: 'blocked+done',
      tabBadge: true,
      streamerMode: false,
      showIdle: false,
      showUnknown: false,
      autoFade: false,
      soundInBackground: true,
    };
    expect(parseHudSettings(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('silently resets to defaults on any corruption (§11-22)', () => {
    expect(parseHudSettings(null)).toEqual(HUD_SETTINGS_DEFAULTS);
    expect(parseHudSettings('garbage')).toEqual(HUD_SETTINGS_DEFAULTS);
    expect(parseHudSettings({ maxRows: 4 })).toEqual(HUD_SETTINGS_DEFAULTS); // 4 is not in 3/5/7/9
    expect(parseHudSettings({ sound: 'loud' })).toEqual(HUD_SETTINGS_DEFAULTS);
  });

  it('fills missing keys with defaults (additive evolution: M2-end adds 4 keys safely)', () => {
    const result = HudSettingsSchema.safeParse({ displayMode: 'hidden' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayMode).toBe('hidden');
      expect(result.data.maxRows).toBe(5);
      expect(result.data.showIdle).toBe(true);
      expect(result.data.soundInBackground).toBe(false);
    }
  });
});
