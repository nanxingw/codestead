/**
 * Settings → 会话面板 page model (hud-sessions §9; PRD 03 US27/29/30/31/32 +
 * M2-end US12/19 settings tier, D6). PURE — zero Phaser, zero sim (ESLint-
 * enforced like the rest of src/hud); the panel shell renders these rows and
 * calls `next()` through HudStore.updateSettings (persisted immediately, §9).
 *
 * All 10 keys ship here (M2-end exposes the 4 deferred ones); order and copy
 * follow the §9 table verbatim. Values cycle through the §9 取值 column.
 */
import { PROTOCOL_VERSION } from '@codestead/shared';

import type { HudSettings } from './settings.js';
import type { HudState } from './types.js';

export interface SessionSettingRow {
  readonly key: keyof HudSettings;
  /** UI 文案 — §9 设置名 column, verbatim. */
  readonly label: string;
  /** Current value as button text. */
  readonly value: (settings: Readonly<HudSettings>) => string;
  /** Patch advancing to the next value in the §9 cycle. */
  readonly next: (settings: Readonly<HudSettings>) => Partial<HudSettings>;
  /** Row interactivity gate (§9: soundInBackground 仅 sound≠off 可改). */
  readonly enabled?: (settings: Readonly<HudSettings>) => boolean;
}

const ON_OFF = (v: boolean): string => (v ? '开' : '关');

function cycle<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}

/** §9 table, in table order. */
export const SESSION_SETTING_ROWS: readonly SessionSettingRow[] = [
  {
    key: 'displayMode',
    label: '显示模式',
    value: (s) =>
      s.displayMode === 'expanded' ? '展开' : s.displayMode === 'collapsed' ? '折叠' : '隐藏',
    next: (s) => ({
      displayMode: cycle(['expanded', 'collapsed', 'hidden'] as const, s.displayMode),
    }),
  },
  {
    key: 'maxRows',
    label: '最多显示行数',
    value: (s) => String(s.maxRows),
    next: (s) => ({ maxRows: cycle([3, 5, 7, 9] as const, s.maxRows) }),
  },
  {
    key: 'showIdle',
    label: '显示空闲会话',
    value: (s) => ON_OFF(s.showIdle),
    next: (s) => ({ showIdle: !s.showIdle }),
  },
  {
    key: 'showUnknown',
    label: '显示未接入 hooks 的会话',
    value: (s) => ON_OFF(s.showUnknown),
    next: (s) => ({ showUnknown: !s.showUnknown }),
  },
  {
    key: 'opacity',
    label: '面板不透明度',
    value: (s) => String(s.opacity),
    next: (s) => ({ opacity: cycle([0.6, 0.8, 1] as const, s.opacity) }),
  },
  {
    key: 'autoFade',
    label: '角色经过时自动淡出',
    value: (s) => ON_OFF(s.autoFade),
    next: (s) => ({ autoFade: !s.autoFade }),
  },
  {
    key: 'sound',
    label: '状态提示音',
    value: (s) => (s.sound === 'off' ? '关' : s.sound === 'blocked' ? '等待输入' : '等待+完成'),
    next: (s) => ({ sound: cycle(['off', 'blocked', 'blocked+done'] as const, s.sound) }),
  },
  {
    key: 'soundInBackground',
    label: '切到其他标签页时也提示音',
    value: (s) => ON_OFF(s.soundInBackground),
    next: (s) => ({ soundInBackground: !s.soundInBackground }),
    enabled: (s) => s.sound !== 'off', // §9: 仅 sound≠off 可改
  },
  {
    key: 'tabBadge',
    label: '有会话等待输入时标签页加 ●',
    value: (s) => ON_OFF(s.tabBadge),
    next: (s) => ({ tabBadge: !s.tabBadge }),
  },
  {
    key: 'streamerMode',
    label: '隐私模式（隐藏路径与最近输入）',
    value: (s) => ON_OFF(s.streamerMode),
    next: (s) => ({ streamerMode: !s.streamerMode }),
  },
];

// ---- Connection block (US39/US40; §8.1 settings-page column, §8.2 gate exemption) ----

/** §8.2 install guidance — exact copy, settings page only (never in-world). */
export const INSTALL_HINT = '运行 npx codestead 以启用会话面板';

const PHASE_LABEL: Readonly<Record<HudState['conn']['phase'], string>> = {
  connecting: '连接中…',
  handshaking: '连接中…',
  live: '已连接',
  stale: '已连接 · 数据可能过期',
  backoff: '已断开 · 重试中',
  incompatible: '版本不匹配 · 守护进程需要更新',
};

/** Settings-page connection status line (NOT gated by everConnected). */
export function connectionStatusLine(state: HudState): string {
  return `连接状态：${PHASE_LABEL[state.conn.phase]}`;
}

/** Compact phase summary for the settings main page's 会话面板 entry row. */
export function connectionSummary(state: HudState): string {
  return PHASE_LABEL[state.conn.phase];
}

/**
 * Both version numbers (US39): the game's protocol always; the daemon's
 * version once known. In INCOMPATIBLE the daemon-side protocol from the
 * mismatched hello is shown against ours (§11-6).
 */
export function versionLine(state: HudState): string {
  const game = `游戏协议 v${String(PROTOCOL_VERSION)}`;
  const daemonVersion = state.conn.daemonVersion;
  const daemonProtocol = state.conn.daemonProtocol;
  if (state.conn.phase === 'incompatible' && daemonProtocol !== null) {
    const name = daemonVersion === null ? '' : ` ${daemonVersion}`;
    return `${game} ／ daemon${name} 协议 v${String(daemonProtocol)}`;
  }
  if (daemonVersion === null) return game;
  return `${game} ／ daemon ${daemonVersion}`;
}

/** Install guidance shows whenever the daemon is not currently serving data (US40). */
export function installHintVisible(state: HudState): boolean {
  return state.conn.phase !== 'live' && state.conn.phase !== 'stale';
}
