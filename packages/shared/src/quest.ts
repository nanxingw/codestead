/**
 * Quest schema — PLACEHOLDER (do not implement before M4).
 *
 * The real QuestGenSchema / QuestSchema land with PRD 05 (M4 AI quests).
 * Source of truth for the shape: docs/design/ai-quests.md §4.6.
 * It will also feed `z.toJSONSchema` output for headless `claude -p --json-schema`
 * (tech-stack §4.2). Quest WS messages (questOffer / questAnswer / questSnapshot / …)
 * are added to protocol.ts at the same time, without bumping PROTOCOL_VERSION
 * (additive evolution rule, tech-stack §5).
 */
export {};
