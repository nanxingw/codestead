/**
 * Local reflection pool (ai-quests §2.3) — the 30 ship-with-repo questions used
 * when AI is off or degraded. Pure data + a no-repeat draw interface.
 *
 * 30 entries, 老榆/阿穗/渠叔 each ~10 (affinity-balanced). Runtime draw is random
 * without repeat (`usedLocalPoolIds`, types.ts); once the pool is EXHAUSTED the
 * villager returns to pure chatter and emits no more local quests (§2.3 / §3.3-④
 * 宁缺毋滥) — there is NO reset. Each entry is reflection-only (§2.2); reward is
 * the local table value (40g/20XP, §8.1).
 *
 * SKELETON: the full 30-entry data table (load-bearing — the test counts per-NPC
 * affinity and asserts no-repeat draw) + the draw signature. The draw body
 * (random pick excluding usedIds; null when exhausted) is the local-pool sub-task.
 */
import type { NpcId } from '@codestead/shared';

export interface LocalPoolEntry {
  /** Stable id for the no-repeat set (kept across restarts). */
  readonly id: string;
  /** Question text (简体中文, §2.3 table). */
  readonly question: string;
  /** Affinity NPC (routing, §2.3). */
  readonly npcId: NpcId;
}

/** The 30 questions of ai-quests §2.3 (table order preserved). */
export const LOCAL_POOL: readonly LocalPoolEntry[] = [
  {
    id: 'lp01',
    npcId: 'npc_keeper',
    question: '你现在手头这件事，最初要解决的问题是什么？现在还在解决它吗？',
  },
  {
    id: 'lp02',
    npcId: 'npc_grocer',
    question: '如果明天要把今天的工作讲给一个新同事听，你会先讲哪一句？',
  },
  { id: 'lp03', npcId: 'npc_keeper', question: '今天写的代码里，哪一处你其实没想清楚就先写了？' },
  { id: 'lp04', npcId: 'npc_carpenter', question: '现在这个方案里，最让你不安的假设是什么？' },
  {
    id: 'lp05',
    npcId: 'npc_grocer',
    question: '有没有一个名字（变量/函数/模块），你看到就皱眉？它应该叫什么？',
  },
  { id: 'lp06', npcId: 'npc_keeper', question: '如果这个项目只能保留一个测试，你会留哪个？' },
  {
    id: 'lp07',
    npcId: 'npc_carpenter',
    question: '今天有没有差点走进去的弯路？是什么让你停下来的？',
  },
  {
    id: 'lp08',
    npcId: 'npc_keeper',
    question: '你正在等 AI 做的这件事，做完之后你第一个要检查什么？',
  },
  { id: 'lp09', npcId: 'npc_carpenter', question: '当前的工作里，哪一步其实可以删掉不做？' },
  { id: 'lp10', npcId: 'npc_grocer', question: '如果回到今天早上，你会换一个起点吗？' },
  { id: 'lp11', npcId: 'npc_keeper', question: '这个改动一旦上线，最先坏掉的会是哪里？' },
  {
    id: 'lp12',
    npcId: 'npc_carpenter',
    question: '你最近一次说「先这样，以后再改」是什么时候？「以后」到了吗？',
  },
  {
    id: 'lp13',
    npcId: 'npc_carpenter',
    question: '现在的代码里，哪两个模块其实在偷偷共用一面墙？拆开值得吗？',
  },
  { id: 'lp14', npcId: 'npc_carpenter', question: '如果把这个系统锯成两半，你会沿着哪条缝下锯？' },
  {
    id: 'lp15',
    npcId: 'npc_carpenter',
    question: '哪个依赖是你不敢动的「承重墙」？它真的在承重吗？',
  },
  {
    id: 'lp16',
    npcId: 'npc_carpenter',
    question: '你最近一次复制粘贴代码，是图省事，还是那两处本来就该分开长？',
  },
  {
    id: 'lp17',
    npcId: 'npc_carpenter',
    question: '项目里哪一处「临时搭的棚子」如今已经住进人了？',
  },
  {
    id: 'lp18',
    npcId: 'npc_carpenter',
    question: '如果允许你推倒重盖一个模块，你选哪个？为什么偏偏是它？',
  },
  { id: 'lp19', npcId: 'npc_grocer', question: '你今天定下的接口，调用方第一眼能猜对用法吗？' },
  {
    id: 'lp20',
    npcId: 'npc_grocer',
    question: '把那个函数的参数列表当货架标签念一遍，顾客听得懂吗？',
  },
  {
    id: 'lp21',
    npcId: 'npc_grocer',
    question: '有没有一个概念，团队里每个人的叫法都不一样？该统一成哪个？',
  },
  {
    id: 'lp22',
    npcId: 'npc_grocer',
    question: '你最近写的注释里，有没有一句其实是在替坏名字道歉？',
  },
  {
    id: 'lp23',
    npcId: 'npc_grocer',
    question: '这个 API 的返回值里，有没有调用方根本用不上的货？',
  },
  { id: 'lp24', npcId: 'npc_grocer', question: '哪个布尔参数其实早该拆成两个函数了？' },
  { id: 'lp25', npcId: 'npc_grocer', question: '把当前模块的对外接口连起来念，是一句通顺的话吗？' },
  { id: 'lp26', npcId: 'npc_keeper', question: '这个功能在用户网络最差的那天，会发生什么？' },
  {
    id: 'lp27',
    npcId: 'npc_keeper',
    question: '你最近一次只手动点了点就算验完的地方，下次改动时谁来守？',
  },
  {
    id: 'lp28',
    npcId: 'npc_keeper',
    question: '如果这段代码凌晨三点出错，报错信息够你睡眼惺忪地定位吗？',
  },
  {
    id: 'lp29',
    npcId: 'npc_keeper',
    question: '当前的输入校验里，你默认了哪件「不可能发生」的事？',
  },
  {
    id: 'lp30',
    npcId: 'npc_keeper',
    question: '这次改动碰到的老功能里，哪一个你还没回头看过一眼？',
  },
];

/** Total pool size (the §2.3 contract: 30). */
export const LOCAL_POOL_SIZE = LOCAL_POOL.length;

/** A source of randomness, injected so the draw is deterministic in tests. */
export type RandomFn = () => number;

/**
 * Draw one unused local question, or null if the pool is exhausted (§2.3 — NO
 * reset; villager returns to chatter). PURE over the injected `rand`. SKELETON —
 * body by the local-pool sub-task: filter out usedIds, random pick, null on empty.
 */
export function drawLocalQuestion(
  usedIds: readonly string[],
  rand: RandomFn,
): LocalPoolEntry | null {
  const used = new Set(usedIds);
  const available = LOCAL_POOL.filter((e) => !used.has(e.id));
  if (available.length === 0) return null; // exhausted → villager returns to chatter (§2.3, NO reset)
  // rand() ∈ [0,1); clamp the index defensively so a rand returning exactly 1 (or
  // a tiny FP overshoot) never reads past the end.
  const idx = Math.min(available.length - 1, Math.floor(rand() * available.length));
  return available[idx] ?? null;
}
