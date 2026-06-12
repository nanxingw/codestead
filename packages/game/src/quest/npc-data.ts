/**
 * NPC data table (ai-quests §1.1 / §1.4) — the three M4 villagers as data, not
 * code. Pure, Phaser-free; the world layer reads it to place sprites at the map
 * `npc_anchors` and the dialogue/chatter UI reads personas + chatter lines.
 *
 * The three villagers (§1.1): 老榆 carpenter (architecture/refactoring/
 * boundaries), 阿穗 grocer (naming/api-design/interfaces), 渠叔 keeper (testing/
 * edge-cases/reliability/debugging). Topic→NPC routing tags feed the AI prompt
 * persona pick and the fallback (unroutable → npc_keeper, §1.1).
 *
 * Chatter (§1.4): 8–10 LOCAL, zero-AI template lines per villager, some keyed to
 * farm state (e.g. 渠叔's rain line reads weather). They give NO reward, count
 * NOTHING — pure ambience so the villager stands as a 村民 first. SKELETON: the
 * persona + anchor table is fixed (load-bearing — anchors must match the map's
 * npc_anchors ids); the full chatter line bodies are finalized by the NPC sub-task
 * (8–10 each, §1.4) — a couple are sketched here to fix the shape.
 */
import type { NpcId } from '@codestead/shared';

/** Routing tags (§1.1) used to pick a persona for an AI quest and to文档 affinity. */
export type QuestTopicTag =
  | 'architecture'
  | 'refactoring'
  | 'boundaries'
  | 'naming'
  | 'api-design'
  | 'interfaces'
  | 'testing'
  | 'edge-cases'
  | 'reliability'
  | 'debugging';

/** A farm-state-keyed chatter line: `when` gates it, `text` is a pure template. */
export interface ChatterLine {
  /** Optional gate over a read-only farm view (e.g. rained-last-night). Absent = always eligible. */
  readonly when?: 'rainedLastNight' | 'anyCropMature' | 'highLevel' | 'always';
  readonly text: string;
}

export interface NpcDef {
  readonly id: NpcId;
  /** Display name (工作名, §15-1 — final naming TBD with owner). */
  readonly displayName: string;
  /** Map `npc_anchors` object id this villager stands on (§13; must exist on the map). */
  readonly anchorId: string;
  /** Topic tags this villager owns for routing (§1.1). */
  readonly topics: readonly QuestTopicTag[];
  /** 8–10 local chatter lines (§1.4) — SKELETON: shape fixed, full set by NPC sub-task. */
  readonly chatter: readonly ChatterLine[];
}

/**
 * The three villagers. `anchorId`s correspond to farm-map-meta `npcAnchors`
 * (carpenter_bench / market_stall / pond_sluice — the three of the five anchors
 * §1.1 names; the other two anchors stay reserved). 老榆/阿穗 land on the carpenter
 * bench and market stall; 渠叔 on the pond sluice (§1.1 站位 column).
 */
export const NPCS: readonly NpcDef[] = [
  {
    id: 'npc_carpenter',
    displayName: '老榆',
    anchorId: 'carpenter_bench',
    topics: ['architecture', 'refactoring', 'boundaries'],
    // 8 lines: 老榆 话少句短，用承重墙/地基/翻修打比方 (§1.1).
    chatter: [
      { when: 'always', text: '谷仓的梁我又紧了紧。你那边的房子，靠哪根梁站着？' },
      { when: 'always', text: '拆一堵墙之前，先摸清楚它是不是在承重。' },
      { when: 'always', text: '地基歪一寸，墙就斜一尺。底下的事，急不得。' },
      { when: 'always', text: '翻修和推倒重盖，是两笔账。你算的是哪一笔？' },
      { when: 'always', text: '好木匠不多钉钉子。能少一根榫，就少一根。' },
      { when: 'anyCropMature', text: '你那片地长势不错。规整的东西，骨架都正。' },
      { when: 'highLevel', text: '农场起来了。盖得越大，越要看清哪几根是主梁。' },
      { when: 'rainedLastNight', text: '雨夜最考验屋顶。漏过的地方，今早都现了形。' },
    ],
  },
  {
    id: 'npc_grocer',
    displayName: '阿穗',
    anchorId: 'market_stall',
    topics: ['naming', 'api-design', 'interfaces'],
    // 8 lines: 阿穗 热络爱举例，执念是「名字不对货就卖不出去」 (§1.1).
    chatter: [
      { when: 'anyCropMature', text: '你的菜熟了吧？名字起好没有——名字不对，货可卖不出去。' },
      { when: 'always', text: '我这每件货都得贴对标签。叫错一个，客人就拿错一个。' },
      { when: 'always', text: '你说说看你那东西叫啥？念出来通顺，才记得住。' },
      { when: 'always', text: '货架上摆什么、怎么摆，比仓库里堆多少更要紧。' },
      { when: 'always', text: '一样的东西两个叫法，迟早要乱账。早点统一了吧。' },
      { when: 'anyCropMature', text: '新货上市，先把名字念给我听一遍——我替你当回客人。' },
      { when: 'highLevel', text: '生意做大了，对外那张脸更得清爽。门面就是接口呀。' },
      { when: 'rainedLastNight', text: '下雨天客人少，正好把标签都重新理一遍。' },
    ],
  },
  {
    id: 'npc_keeper',
    displayName: '渠叔',
    anchorId: 'pond_sluice',
    topics: ['testing', 'edge-cases', 'reliability', 'debugging'],
    // 9 lines: 渠叔 谨慎，口头禅「如果……会怎样？」，信「漏是巡出来的」 (§1.1).
    chatter: [
      { when: 'rainedLastNight', text: '昨夜下了雨，今天渠水满的，你的地也不用浇了吧。' },
      { when: 'always', text: '漏不是补出来的，是巡出来的。今天你巡过哪儿了？' },
      { when: 'always', text: '我总在想——如果上游突然来大水，这道闸顶得住吗？' },
      { when: 'always', text: '最稳的那段渠，往往是没人盯的那段。最该多看两眼。' },
      { when: 'always', text: '凌晨三点出了岔子，你看得懂自己留下的记号吗？' },
      { when: 'rainedLastNight', text: '雨一大，平时不漏的地方也会漏。极端天最见真章。' },
      { when: 'anyCropMature', text: '地里见收成了。越是顺，越要留神哪天会不顺。' },
      { when: 'highLevel', text: '渠修得越长，要巡的口子越多。一处都漏不得。' },
      { when: 'always', text: '你默认「这不可能发生」的那件事，往往就是会发生的那件。' },
    ],
  },
];

export const NPCS_BY_ID: ReadonlyMap<NpcId, NpcDef> = new Map(NPCS.map((n) => [n.id, n]));

/** Fallback villager for unroutable topics / local pool reflection (§1.1 兜底路由). */
export const FALLBACK_NPC_ID: NpcId = 'npc_keeper';

/**
 * Route a topic tag to a villager (§1.1): the owning persona, or the fallback
 * 渠叔 when no villager claims it (null / unroutable topic — reflection 类问题与
 * 渠叔的巡渠人设最自然). PURE.
 */
export function routeTopicToNpc(tag: QuestTopicTag | null): NpcId {
  if (tag === null) return FALLBACK_NPC_ID;
  const owner = NPCS.find((n) => n.topics.includes(tag));
  return owner?.id ?? FALLBACK_NPC_ID;
}

/** Read-only farm view the chatter picker gates lines against (§1.4). */
export interface ChatterFarmView {
  readonly rainedLastNight: boolean;
  readonly anyCropMature: boolean;
  readonly highLevel: boolean;
}

/**
 * Pick a local chatter line for a villager, gated by the current farm state (§1.4).
 * PURE — `rand01` selects among the eligible lines (an injected source keeps it
 * deterministic in tests). Returns null only when the npcId is unknown (never for a
 * real villager, since each carries `when: 'always'` lines). Zero AI, zero reward.
 */
export function pickChatter(npcId: NpcId, farm: ChatterFarmView, rand01: number): string | null {
  const def = NPCS_BY_ID.get(npcId);
  if (def === undefined) return null;
  const eligible = def.chatter.filter((line) => {
    switch (line.when) {
      case 'rainedLastNight':
        return farm.rainedLastNight;
      case 'anyCropMature':
        return farm.anyCropMature;
      case 'highLevel':
        return farm.highLevel;
      default:
        return true; // 'always' / undefined
    }
  });
  if (eligible.length === 0) return def.chatter[0]?.text ?? null;
  const idx = Math.min(eligible.length - 1, Math.floor(rand01 * eligible.length));
  return eligible[idx].text;
}
