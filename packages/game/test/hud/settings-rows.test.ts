/**
 * 设置 → 会话面板 row models + connection block (hud-sessions §9, US27/29/30/
 * 31/32/39/40; src/hud/settings-rows.ts). Pure — no Phaser, no DOM.
 */
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@codestead/shared';

import { HUD_SETTINGS_DEFAULTS, HudSettingsSchema } from '../../src/hud/settings';
import type { HudSettings } from '../../src/hud/settings';
import {
  INSTALL_HINT,
  SESSION_SETTING_ROWS,
  connectionStatusLine,
  connectionSummary,
  installHintVisible,
  versionLine,
} from '../../src/hud/settings-rows';
import { createInitialHudState } from '../../src/hud/store';
import type { HudState } from '../../src/hud/types';

const defaults = (): HudSettings => ({ ...HUD_SETTINGS_DEFAULTS });

function state(conn: Partial<HudState['conn']> = {}): HudState {
  const base = createInitialHudState(defaults(), false);
  return { ...base, conn: { ...base.conn, ...conn } };
}

describe('SESSION_SETTING_ROWS — §9 table, all 10 keys', () => {
  it('covers exactly the 10 §9 keys in table order', () => {
    expect(SESSION_SETTING_ROWS.map((r) => r.key)).toEqual([
      'displayMode',
      'maxRows',
      'showIdle',
      'showUnknown',
      'opacity',
      'autoFade',
      'sound',
      'soundInBackground',
      'tabBadge',
      'streamerMode',
    ]);
  });

  it('cycling every row only ever produces schema-valid settings and returns to the default', () => {
    for (const row of SESSION_SETTING_ROWS) {
      let settings = defaults();
      const seen = new Set<unknown>([settings[row.key]]);
      // Walk the full cycle: every step parses, and we come back to the start.
      for (let step = 0; step < 8; step += 1) {
        settings = HudSettingsSchema.parse({ ...settings, ...row.next(settings) });
        if (settings[row.key] === HUD_SETTINGS_DEFAULTS[row.key]) break;
        expect(seen.has(settings[row.key]), `${row.key} revisited a non-default value`).toBe(false);
        seen.add(settings[row.key]);
      }
      expect(settings[row.key]).toEqual(HUD_SETTINGS_DEFAULTS[row.key]);
      expect(row.value(settings)).not.toBe(''); // every value renders a label
    }
  });

  it('§9 cycles match the design table values', () => {
    const byKey = new Map(SESSION_SETTING_ROWS.map((r) => [r.key, r]));
    const maxRows = byKey.get('maxRows')!;
    expect(maxRows.next({ ...defaults(), maxRows: 9 })).toEqual({ maxRows: 3 }); // 3/5/7/9 wraps
    const opacity = byKey.get('opacity')!;
    expect(opacity.next({ ...defaults(), opacity: 1 })).toEqual({ opacity: 0.6 }); // 0.6/0.8/1.0
    const sound = byKey.get('sound')!;
    expect(sound.next(defaults())).toEqual({ sound: 'blocked' }); // off → blocked → blocked+done
  });

  it('soundInBackground is only editable while sound ≠ off (§9)', () => {
    const row = SESSION_SETTING_ROWS.find((r) => r.key === 'soundInBackground')!;
    expect(row.enabled?.(defaults())).toBe(false); // default sound: off
    expect(row.enabled?.({ ...defaults(), sound: 'blocked' })).toBe(true);
  });
});

describe('connection block — US39/US40 (§8.1 settings column, §8.2 gate exemption)', () => {
  it('status line maps every phase to calm copy', () => {
    expect(connectionStatusLine(state({ phase: 'live' }))).toBe('连接状态：已连接');
    expect(connectionStatusLine(state({ phase: 'backoff' }))).toBe('连接状态：已断开 · 重试中');
    expect(connectionSummary(state({ phase: 'connecting' }))).toBe('连接中…');
  });

  it('version line always shows the game protocol; daemon version once known', () => {
    expect(versionLine(state())).toBe(`游戏协议 v${String(PROTOCOL_VERSION)}`);
    expect(versionLine(state({ daemonVersion: '0.2.0' }))).toBe(
      `游戏协议 v${String(PROTOCOL_VERSION)} ／ daemon 0.2.0`,
    );
  });

  it('INCOMPATIBLE shows BOTH protocol numbers (US39/§11-6)', () => {
    const line = versionLine(
      state({ phase: 'incompatible', daemonVersion: '9.9.9', daemonProtocol: 2 }),
    );
    expect(line).toContain(`v${String(PROTOCOL_VERSION)}`);
    expect(line).toContain('9.9.9');
    expect(line).toContain('v2');
  });

  it('install guidance shows whenever the daemon is not serving (US40)', () => {
    expect(INSTALL_HINT).toBe('运行 npx codestead 以启用会话面板'); // §8.2 exact copy
    expect(installHintVisible(state({ phase: 'live' }))).toBe(false);
    expect(installHintVisible(state({ phase: 'stale' }))).toBe(false);
    for (const phase of ['connecting', 'handshaking', 'backoff', 'incompatible'] as const) {
      expect(installHintVisible(state({ phase }))).toBe(true);
    }
  });
});
