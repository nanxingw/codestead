/**
 * quest-settlement.ts — the §6.3 day-summary 「明日预告」 villager-quest line.
 *
 * PURE, Phaser-free (sim discipline): the day-summary panel renders the string this
 * builder returns. The line is APPEND-ONLY and shown IFF a quest is currently
 * pending — never a popup (ai-quests §6.3/§3.5). Returns null when there is no
 * pending quest (the panel then appends nothing).
 *
 *   🌾 {npc}在{place}，想听听你的想法
 *
 * npc = the villager displayName (npc-data.ts); place = his standing-point描述
 * (`quest.place.<npcId>` in the string table).
 */
import type { Quest } from '@codestead/shared';

import { NPCS_BY_ID } from './npc-data.js';

/** Translate-fn signature the helper needs (ui/strings.ts `t`). */
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/**
 * Build the §6.3 settlement 预告 line for the single pending quest, or null when
 * none is pending. PURE — the npc display name comes from npc-data, the place from
 * the injected `t` over `quest.place.<npcId>`.
 */
export function questSettlementLine(pending: Quest | null, t: TranslateFn): string | null {
  if (pending === null) return null;
  const npc = NPCS_BY_ID.get(pending.npcId)?.displayName ?? pending.npcId;
  const place = t(`quest.place.${pending.npcId}`);
  return t('quest.settlement.pending', { npc, place });
}
