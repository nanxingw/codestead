/**
 * settings-store.ts — localStorage-backed settings (GDD §10.7, key
 * `codestead.settings.v1`). Separate from the save (deleting the farm keeps
 * preferences); corrupted values silently fall back to defaults and are rewritten.
 *
 * M1 subset per PRD 01 US96: audio.master (80) / audio.muted / general.language
 * (zh-CN only) / accessibility.reducedMotion ('system'|'on'|'off').
 * M3 (PRD 04 US56, ruling A-10): bgm/sfx/ui channel volumes go live — defaults
 * 35/70/50, bgm deliberately low (§10.7) — still localStorage-only, never SaveDoc.
 *
 * Phaser-free. Changes apply immediately and persist on every set (§6.5 设置 rule);
 * subscribers (audio system, reduced-motion consumers) get notified synchronously.
 */
import { DEFAULT_AUDIO_SETTINGS } from '../audio/audio-director';

export const SETTINGS_STORAGE_KEY = 'codestead.settings.v1';

export type ReducedMotion = 'system' | 'on' | 'off';

/** The four-channel audio block (GDD §10.7; audio-director DEFAULT_AUDIO_SETTINGS). */
export interface AudioSettings {
  master: number;
  muted: boolean;
  bgm: number;
  sfx: number;
  ui: number;
}

export interface GameSettings {
  audio: AudioSettings;
  general: { language: 'zh-CN' | 'en' };
  accessibility: { reducedMotion: ReducedMotion };
}

export const DEFAULT_SETTINGS: GameSettings = {
  audio: { ...DEFAULT_AUDIO_SETTINGS },
  general: { language: 'zh-CN' },
  accessibility: { reducedMotion: 'system' },
};

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : fallback;
}

function sanitize(raw: unknown): GameSettings {
  const d = DEFAULT_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return structuredClone(d);
  const o = raw as Record<string, unknown>;
  const audio = (o.audio ?? {}) as Record<string, unknown>;
  const general = (o.general ?? {}) as Record<string, unknown>;
  const accessibility = (o.accessibility ?? {}) as Record<string, unknown>;
  const master = clampVolume(audio.master, d.audio.master);
  const muted = typeof audio.muted === 'boolean' ? audio.muted : d.audio.muted;
  const bgm = clampVolume(audio.bgm, d.audio.bgm);
  const sfx = clampVolume(audio.sfx, d.audio.sfx);
  const ui = clampVolume(audio.ui, d.audio.ui);
  const language = general.language === 'en' ? 'en' : 'zh-CN';
  const rm = accessibility.reducedMotion;
  const reducedMotion: ReducedMotion =
    rm === 'on' || rm === 'off' || rm === 'system' ? rm : 'system';
  return {
    audio: { master, muted, bgm, sfx, ui },
    general: { language },
    accessibility: { reducedMotion },
  };
}

export class SettingsStore {
  private settings: GameSettings;
  private listeners = new Set<(s: GameSettings) => void>();

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
  ) {
    this.settings = this.load();
  }

  get(): Readonly<GameSettings> {
    return this.settings;
  }

  /** Apply a partial update; persists and notifies immediately. */
  update(patch: {
    audio?: Partial<GameSettings['audio']>;
    general?: Partial<GameSettings['general']>;
    accessibility?: Partial<GameSettings['accessibility']>;
  }): void {
    this.settings = sanitize({
      audio: { ...this.settings.audio, ...patch.audio },
      general: { ...this.settings.general, ...patch.general },
      accessibility: { ...this.settings.accessibility, ...patch.accessibility },
    });
    this.persist();
    for (const fn of this.listeners) fn(this.settings);
  }

  onChange(fn: (s: GameSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolved reduced-motion flag ('system' consults prefers-reduced-motion). */
  reducedMotionActive(): boolean {
    const mode = this.settings.accessibility.reducedMotion;
    if (mode !== 'system') return mode === 'on';
    try {
      return (
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch {
      return false;
    }
  }

  private load(): GameSettings {
    try {
      const raw = this.storage?.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      const parsed: unknown = JSON.parse(raw);
      const clean = sanitize(parsed);
      // Rewrite so a partially-corrupt blob heals itself (GDD §10.7).
      if (JSON.stringify(parsed) !== JSON.stringify(clean)) this.persistValue(clean);
      return clean;
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private persist(): void {
    this.persistValue(this.settings);
  }

  private persistValue(value: GameSettings): void {
    try {
      this.storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Storage unavailable (private mode etc.) — settings live for the session only.
    }
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
