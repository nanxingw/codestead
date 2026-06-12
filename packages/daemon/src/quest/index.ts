/**
 * Quest module (M4, PRD 05) — public surface of the daemon-side AI-quest pipeline.
 *
 * Source of truth: docs/design/ai-quests.md (§2~§13). This is the SKELETON /
 * contract layer: every export here is either a fixed constant/shape (load-
 * bearing — pinned by tests) or a pure-function/interface signature whose body
 * the implementation sub-tasks fill in. NOTHING here starts a timer, opens a
 * port or spawns a process — composition lives in the daemon's start path and is
 * gated by the `enabled` 总开关 (§9 / A1: enabled=false ⇒ module never starts ⇒
 * 0 generation / 0 quest message / 0 claude call).
 */
export * from './config.js';
export * from './types.js';
export * from './lifecycle.js';
export * from './trigger.js';
export * from './candidate.js';
export * from './transcript-reader.js';
export * from './sanitize.js';
export * from './prompt.js';
export * from './exec-claude.js';
export * from './accounting.js';
export * from './persistence.js';
export * from './local-pool.js';
export * from './notes.js';
export * from './runtime.js';
