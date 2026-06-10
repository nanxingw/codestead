/**
 * Save schema & migration chain — PLACEHOLDER (do not implement before M1).
 *
 * The real save schema (versioned JSON document `{ schemaVersion, ... }`,
 * zod `safeParse` + ordered migration functions) lands with PRD 01 (M1 core loop).
 * Source of truth for the shape: docs/design/game-design.md §10.2 / §10.3.
 * Storage backend (idb-keyval, game-side `storage/` module only) also enters at M1;
 * the lint boundary for it is already active (see root eslint.config.js).
 */
export {};
