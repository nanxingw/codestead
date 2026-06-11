/**
 * HUD persistence seams (PRD 03 testing decision 4): the localStorage plumbing
 * and the HudStore subscription wrapper, against INJECTED storage only — tests
 * never touch real localStorage (mirrors the daemon hard rule for ~/.claude).
 * Settings live under `codestead.hud.v1`, the §8.2 gate under
 * `codestead.hud.v1.everConnected`; neither ever enters the farm save
 * (appendix A-21).
 */
import type { ServerMessage, SessionInfo } from '@codestead/shared';
import { describe, expect, it } from 'vitest';

import { HudStore } from '../../src/hud/hud-store.js';
import {
  HUD_EVER_CONNECTED_KEY,
  HUD_SETTINGS_DEFAULTS,
  HUD_SETTINGS_KEY,
  loadEverConnected,
  loadHudSettings,
  saveEverConnected,
  saveHudSettings,
  type HudSettings,
  type HudStorage,
} from '../../src/hud/settings.js';
import type { HudState } from '../../src/hud/types.js';

function fakeStorage(initial: Record<string, string> = {}): HudStorage & {
  data: Map<string, string>;
  setCalls: string[];
} {
  const data = new Map(Object.entries(initial));
  const setCalls: string[] = [];
  return {
    data,
    setCalls,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      setCalls.push(key);
      data.set(key, value);
    },
  };
}

const throwingStorage: HudStorage = {
  getItem: () => {
    throw new Error('storage unavailable (private mode)');
  },
  setItem: () => {
    throw new Error('storage unavailable (private mode)');
  },
};

/** Every key away from its default — exercises the full §9 value space. */
const ALL_KEYS_NON_DEFAULT: HudSettings = {
  displayMode: 'collapsed',
  maxRows: 9,
  opacity: 0.6,
  sound: 'blocked+done',
  tabBadge: false,
  streamerMode: true,
  showIdle: false,
  showUnknown: false,
  autoFade: false,
  soundInBackground: true,
};

const HELLO: ServerMessage = {
  v: 1,
  type: 'hello',
  payload: { protocol: 1, daemonVersion: '0.2.0' },
};

function snapshotMsg(sessions: SessionInfo[]): ServerMessage {
  return { v: 1, type: 'snapshot', payload: { sessions } };
}

describe('settings storage plumbing — injected storage (hud-sessions §9/§11-22)', () => {
  it('loadHudSettings: empty storage and null storage both yield defaults', () => {
    expect(loadHudSettings(fakeStorage())).toEqual(HUD_SETTINGS_DEFAULTS);
    expect(loadHudSettings(null)).toEqual(HUD_SETTINGS_DEFAULTS);
  });

  it('save → load round-trips through storage under HUD_SETTINGS_KEY', () => {
    const storage = fakeStorage();
    saveHudSettings(storage, ALL_KEYS_NON_DEFAULT);
    expect(JSON.parse(storage.data.get(HUD_SETTINGS_KEY) ?? '')).toEqual(ALL_KEYS_NON_DEFAULT);
    expect(loadHudSettings(storage)).toEqual(ALL_KEYS_NON_DEFAULT);
  });

  it('unparseable JSON and schema-invalid JSON silently reset to defaults (§11-22)', () => {
    expect(loadHudSettings(fakeStorage({ [HUD_SETTINGS_KEY]: 'not json {' }))).toEqual(
      HUD_SETTINGS_DEFAULTS,
    );
    expect(
      loadHudSettings(fakeStorage({ [HUD_SETTINGS_KEY]: JSON.stringify({ maxRows: 4 }) })),
    ).toEqual(HUD_SETTINGS_DEFAULTS);
  });

  it('throwing storage (private mode) is silent: load yields defaults, save does not throw', () => {
    expect(loadHudSettings(throwingStorage)).toEqual(HUD_SETTINGS_DEFAULTS);
    expect(() => {
      saveHudSettings(throwingStorage, { ...HUD_SETTINGS_DEFAULTS });
    }).not.toThrow();
  });

  it("everConnected gate: only the literal string 'true' opens it; save writes 'true'", () => {
    expect(loadEverConnected(fakeStorage({ [HUD_EVER_CONNECTED_KEY]: 'true' }))).toBe(true);
    expect(loadEverConnected(fakeStorage({ [HUD_EVER_CONNECTED_KEY]: 'false' }))).toBe(false);
    expect(loadEverConnected(fakeStorage({ [HUD_EVER_CONNECTED_KEY]: '1' }))).toBe(false);
    expect(loadEverConnected(fakeStorage())).toBe(false);
    expect(loadEverConnected(null)).toBe(false);
    expect(loadEverConnected(throwingStorage)).toBe(false);

    const storage = fakeStorage();
    saveEverConnected(storage);
    expect(storage.data.get(HUD_EVER_CONNECTED_KEY)).toBe('true');
    expect(() => {
      saveEverConnected(throwingStorage);
    }).not.toThrow();
  });
});

describe('HudStore — subscription wrapper over the pure reducers', () => {
  it('boots from injected storage: stored settings + everConnected, phase connecting', () => {
    const storage = fakeStorage({
      [HUD_SETTINGS_KEY]: JSON.stringify(ALL_KEYS_NON_DEFAULT),
      [HUD_EVER_CONNECTED_KEY]: 'true',
    });
    const store = new HudStore(storage);
    expect(store.getState().settings).toEqual(ALL_KEYS_NON_DEFAULT);
    expect(store.getState().everConnected).toBe(true);
    expect(store.getState().conn.phase).toBe('connecting');
    expect(store.getState().sessions.size).toBe(0);
  });

  it('boots to defaults on fresh, null, and throwing storage', () => {
    for (const storage of [fakeStorage(), null, throwingStorage]) {
      const store = new HudStore(storage);
      expect(store.getState().settings).toEqual(HUD_SETTINGS_DEFAULTS);
      expect(store.getState().everConnected).toBe(false);
    }
  });

  it('updateSettings merges the patch, persists immediately, notifies synchronously', () => {
    const storage = fakeStorage();
    const store = new HudStore(storage);
    const seen: HudState[] = [];
    store.subscribe((state) => seen.push(state));

    store.updateSettings({ streamerMode: true, maxRows: 7 });

    expect(seen).toHaveLength(1); // synchronous, exactly once
    expect(seen[0].settings).toEqual({ ...HUD_SETTINGS_DEFAULTS, streamerMode: true, maxRows: 7 });
    expect(JSON.parse(storage.data.get(HUD_SETTINGS_KEY) ?? '')).toEqual(seen[0].settings);
    expect(store.getState()).toBe(seen[0]);
  });

  it('cycleDisplayMode: expanded → collapsed → hidden → expanded, each step persisted (H key, §9)', () => {
    const storage = fakeStorage();
    const store = new HudStore(storage);
    const stored = (): unknown =>
      (JSON.parse(storage.data.get(HUD_SETTINGS_KEY) ?? '{}') as HudSettings).displayMode;

    expect(store.cycleDisplayMode()).toBe('collapsed');
    expect(stored()).toBe('collapsed');
    expect(store.cycleDisplayMode()).toBe('hidden');
    expect(stored()).toBe('hidden');
    expect(store.cycleDisplayMode()).toBe('expanded');
    expect(stored()).toBe('expanded');
  });

  it('first hello flips everConnected and writes the gate key exactly once (§8.2)', () => {
    const storage = fakeStorage();
    const store = new HudStore(storage);
    store.dispatchConnection({ kind: 'wsOpen' });

    store.applyMessage(HELLO, 1_000);
    expect(store.getState().everConnected).toBe(true);
    expect(storage.data.get(HUD_EVER_CONNECTED_KEY)).toBe('true');

    store.applyMessage(HELLO, 2_000); // a reconnect hello must not rewrite the gate
    const gateWrites = storage.setCalls.filter((k) => k === HUD_EVER_CONNECTED_KEY);
    expect(gateWrites).toHaveLength(1);
  });

  it('hello + snapshot reach LIVE and populate the session table (wiring smoke)', () => {
    const store = new HudStore(fakeStorage());
    const session: SessionInfo = {
      sessionId: 's-wired',
      title: null,
      subtitle: null,
      cwd: '/work/p',
      state: 'working',
      since: '2026-06-11T08:00:00.000Z',
      lastSignalAt: '2026-06-11T08:00:00.000Z',
      source: 'hooks',
    };
    store.dispatchConnection({ kind: 'wsOpen' });
    store.applyMessage(HELLO, 1_000);
    store.applyMessage(snapshotMsg([session]), 2_000);
    expect(store.getState().conn.phase).toBe('live');
    expect(store.getState().sessions.get('s-wired')).toEqual(session);
  });

  it('no-op events do not notify subscribers (commit skips identical states)', () => {
    const store = new HudStore(fakeStorage());
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    // heartbeatTimeout is a LIVE-only edge; while CONNECTING the reducer
    // returns the same state — no commit, no notification.
    store.dispatchConnection({ kind: 'heartbeatTimeout' });
    expect(calls).toBe(0);
  });

  it('unsubscribe stops notifications', () => {
    const store = new HudStore(fakeStorage());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.updateSettings({ tabBadge: false });
    expect(calls).toBe(1);
    unsubscribe();
    store.updateSettings({ tabBadge: true });
    expect(calls).toBe(1);
  });

  it('throwing storage never breaks the store: updates still apply in memory', () => {
    const store = new HudStore(throwingStorage);
    expect(() => {
      store.updateSettings({ streamerMode: true });
    }).not.toThrow();
    expect(store.getState().settings.streamerMode).toBe(true);
    expect(() => {
      store.applyMessage(HELLO, 1_000);
    }).not.toThrow();
    expect(store.getState().everConnected).toBe(true); // in-memory gate holds for the session
  });

  it('HUD persistence writes only the two HUD keys — the farm save is untouchable', () => {
    const storage = fakeStorage();
    const store = new HudStore(storage);
    store.updateSettings({ maxRows: 3 });
    store.applyMessage(HELLO, 1_000);
    expect([...storage.data.keys()].sort()).toEqual(
      [HUD_EVER_CONNECTED_KEY, HUD_SETTINGS_KEY].sort(),
    );
  });
});
