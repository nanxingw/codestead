/**
 * HUD settings — localStorage `codestead.hud.v1` (hud-sessions §9).
 *
 * Machine/browser preference, NOT game progress: never enters the farm save
 * schema or the JSON export (appendix A-21). Corrupted storage silently
 * resets to defaults (§11-22). zod-validated as mandated by PRD 03.
 *
 * M2 FIRST VERSION exposes exactly 6 keys in the settings UI. The 4 deferred
 * keys (`showIdle` / `showUnknown` / `autoFade` / `soundInBackground`) are the
 * M2-END tier — added below as ADDITIVE fields with §9 defaults, so JSON
 * stored by the 6-key first version keeps parsing unchanged (the additive
 * evolution promised by the contract).
 */
import { z } from 'zod';

/** localStorage key for the settings object. */
export const HUD_SETTINGS_KEY = 'codestead.hud.v1';

/**
 * everConnected gate (hud-sessions §8.2): separate localStorage boolean, set
 * true on first HELLO_OK and never inside the settings object. Before it is
 * set, connection failures are fully silent — a player without the daemon
 * must find NO trace of the HUD.
 */
export const HUD_EVER_CONNECTED_KEY = 'codestead.hud.v1.everConnected';

export const HudSettingsSchema = z.object({
  /** H key cycles expanded → collapsed → hidden (game-design §6.8). */
  displayMode: z.enum(['expanded', 'collapsed', 'hidden']).default('expanded'),
  maxRows: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]).default(5),
  opacity: z.union([z.literal(0.6), z.literal(0.8), z.literal(1)]).default(0.8),
  /** Default OFF is design law (§3.4 / anti-pattern 7); 'blocked+done' is the max. */
  sound: z.enum(['off', 'blocked', 'blocked+done']).default('off'),
  /** Tab-title `● ` prefix while a blocked session exists — plain text, no Notification API (§6.1). */
  tabBadge: z.boolean().default(true),
  /** Privacy: hides cwd & last-prompt in tooltips (streaming / screen share, §2.2). */
  streamerMode: z.boolean().default(false),
  // ---- M2-end tier (§9 实施分期) — additive keys with §9 defaults ----
  /** false ⇒ idle sessions neither render nor count toward overflow (§5.2). */
  showIdle: z.boolean().default(true),
  /** false ⇒ unknown (ps-only) sessions neither render nor count toward overflow (§5.2). */
  showUnknown: z.boolean().default(true),
  /** Panel fades to alpha 0.25 while the player sprite is behind it (§3.2). */
  autoFade: z.boolean().default(true),
  /** Sound also plays while the tab is hidden (opt-in; only meaningful when sound ≠ off, §3.4). */
  soundInBackground: z.boolean().default(false),
});
export type HudSettings = z.infer<typeof HudSettingsSchema>;

export const HUD_SETTINGS_DEFAULTS: Readonly<HudSettings> = Object.freeze(
  HudSettingsSchema.parse({}),
);

/** Tolerant load: any corruption → full silent reset to defaults (§11-22). */
export function parseHudSettings(raw: unknown): HudSettings {
  const result = HudSettingsSchema.safeParse(raw);
  return result.success ? result.data : { ...HUD_SETTINGS_DEFAULTS };
}

// ---- localStorage plumbing (injected storage — tests never touch real localStorage) ----

/** Minimal storage surface (localStorage satisfies it; tests fake it). */
export type HudStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Load settings from storage; missing/corrupted/unavailable → defaults, silently (§11-22). */
export function loadHudSettings(storage: HudStorage | null): HudSettings {
  try {
    const raw = storage?.getItem(HUD_SETTINGS_KEY);
    if (raw === null || raw === undefined) return { ...HUD_SETTINGS_DEFAULTS };
    return parseHudSettings(JSON.parse(raw));
  } catch {
    return { ...HUD_SETTINGS_DEFAULTS };
  }
}

/** Persist settings; storage failures (private mode etc.) are silent — session-only settings. */
export function saveHudSettings(storage: HudStorage | null, settings: HudSettings): void {
  try {
    storage?.setItem(HUD_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable — settings live for the session only.
  }
}

/** §8.2 gate read: anything but the literal string 'true' is false. */
export function loadEverConnected(storage: HudStorage | null): boolean {
  try {
    return storage?.getItem(HUD_EVER_CONNECTED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Set the §8.2 gate (called on first HELLO_OK; never unset by the game). */
export function saveEverConnected(storage: HudStorage | null): void {
  try {
    storage?.setItem(HUD_EVER_CONNECTED_KEY, 'true');
  } catch {
    // Storage unavailable — the gate holds for this session via in-memory state.
  }
}
