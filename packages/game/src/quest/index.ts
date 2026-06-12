/**
 * Game-side quest module (M4, PRD 05) — public surface of the villager + dialogue
 * + settings client. Source of truth: docs/design/ai-quests.md.
 *
 * SKELETON / contract layer: NPC data (load-bearing — anchors match the map),
 * the pure QuestStore reducers (offer lifecycle / four-屏 flow / prefs merge), and
 * the §6.4 settings row model. The sim-side reward grant lives in sim/quest-reward.ts
 * (zero-Phaser, the §K economy seam); the dialogue panel UI in
 * ui/panels/quest-dialogue-panel.ts. Nothing here touches Phaser.
 */
export * from './npc-data.js';
export * from './quest-store.js';
export * from './quest-store-host.js';
export * from './quest-prefs.js';
export * from './quest-settings-rows.js';
