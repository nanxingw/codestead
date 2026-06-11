/**
 * context.ts — the integration contract between UIScene and the rest of the game
 * (world driver, storage layer, audio). The UI renders ONLY from SimApi snapshots and
 * talks back ONLY via SimCommands + the narrow callbacks below (one-way flow, GDD §12).
 *
 * Wiring (integrator contract, see workflow apiDrift notes):
 *   game.registry.set(UI_CONTEXT_REGISTRY_KEY, ctx satisfies UiContext)
 * BEFORE WorldScene launches the UI scene — or pass the same object as scene data:
 *   this.scene.launch('UI', ctx). UIScene checks scene data first, then the registry,
 * and renders a passive shell when neither is present (M0-compatible).
 */
import type Phaser from 'phaser';

import type { SfxKey } from '../AssetKeys';
import type { SimApi } from '../sim/sim';
import type { MapMeta, PauseSource } from '../sim/types';

export const UI_CONTEXT_REGISTRY_KEY = 'codestead:uiContext';

/** Driver-owned pause-source set (GDD §2.4); UIScene adds/removes its own sources. */
export interface PauseController {
  add(source: PauseSource): void;
  remove(source: PauseSource): void;
}

/** Implemented by the audio system (world/render stream); 50ms dedupe lives there. */
export interface UiAudio {
  /**
   * `detune` in cents (harvest_pop plays at ±10% pitch ≈ ±170 cents, GDD §6.4);
   * `volume` 0..1 relative to the master bus (session chime plays at 0.4 —
   * hud-sessions §3.4 音量 40%).
   */
  play(key: SfxKey, opts?: { detune?: number; volume?: number }): void;
  /** Settings panel pushes master volume (0..100) / muted immediately on change. */
  setMasterVolume(volume: number, muted: boolean): void;
}

/** Implemented by the storage layer (storage/** stream); see GDD §10.6. */
export interface SaveTransfer {
  /** Pretty-printed SaveDoc download (Blob + <a download>, zero network). */
  exportSave(): Promise<void>;
  /**
   * JSON.parse → safeParse → replace; on ANY failure the existing save is untouched
   * and `ok:false` comes back (M1: no preview/confirm screen).
   */
  importSave(file: File): Promise<{ ok: boolean }>;
  /** Manual save (pause menu 保存); resolves true on success. */
  manualSave(): Promise<boolean>;
  /** "存储：正常 ✓ / 受限 / 内存模式" status line for the settings panel (M1: 正常). */
  storageStatusText(): string;
}

export interface UiContext {
  sim: SimApi;
  /** Optional — the M1 UI renders from sim snapshots only; kept for future panels. */
  map?: MapMeta;
  pause: PauseController;
  /** Optional until the audio stream lands; UI degrades to silent. */
  audio?: UiAudio;
  /** Optional until the storage stream lands; save buttons gray out without it. */
  saveTransfer?: SaveTransfer;
  /** Optional "回主菜单" route (autosaves first); button disabled when absent (M1). */
  returnToMainMenu?: () => void;
}

/** Resolve the context from scene-launch data or the game registry. */
export function resolveUiContext(scene: Phaser.Scene, data?: unknown): UiContext | null {
  if (isUiContext(data)) return data;
  const fromRegistry: unknown = scene.registry.get(UI_CONTEXT_REGISTRY_KEY);
  return isUiContext(fromRegistry) ? fromRegistry : null;
}

function isUiContext(value: unknown): value is UiContext {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sim === 'object' && v.sim !== null && typeof v.pause === 'object' && v.pause !== null
  );
}
