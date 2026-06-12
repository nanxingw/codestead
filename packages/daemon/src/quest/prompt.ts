/**
 * Prompt builder (ai-quests §4.4) — assembles the `-p` instruction string and the
 * stdin context document from a sanitized ExtractedContext.
 *
 * The instruction骨架 is the §4.4 text (three村民 personas, decision/reflection
 * rules, 简体中文, ≤2 句/段, contextEcho ≤120, strict JSON schema). The context
 * document is the sanitized title/lastPrompt/turns, capped at MAX_CONTEXT_CHARS
 * and passed via STDIN (never argv) — `-p` carries only the fixed instructions.
 *
 * SKELETON: the build signature + the instruction constant placeholder. The
 * sanitize sub-task supplies the already-sanitized text; this module only
 * concatenates and caps. Final instruction wording is定稿 here by the prompt
 * sub-task (kept out of the contract because文案 quality is unmeasurable, §Testing).
 */
import type { ExtractedContext } from './transcript-reader.js';
import { MAX_CONTEXT_CHARS } from './types.js';

/**
 * Fixed instruction text passed as the `-p` argument (§4.4). SKELETON — the
 * prompt sub-task finalizes the wording from the §4.4骨架. It MUST: name the
 * three NPCs + their routing tags, force kind∈{decision,reflection} with the
 * decision-options-each-with-tradeoff rule, demand 简体中文 / ≤2 句 per段 /
 * one metaphor max, forbid echoing anything key-like, cap contextEcho at 120,
 * and require strict JSON-schema output.
 */
export const INSTRUCTION_SKELETON = [
  '你是像素农场游戏 Codestead 的关卡作者。stdin 是一位程序员玩家当前真实工作的脱敏摘要。',
  '生成恰好一个 NPC 任务，帮助他在等待 AI 干活的间隙梳理思路、看清一个取舍。',
  '',
  '三位村民（选最贴合话题的一位，npcId 必须取自枚举）：',
  '- npc_carpenter 老榆，木匠：架构、重构边界、模块划分。话少句短，用房子打比方。',
  '- npc_grocer 阿穗，杂货店老板娘：命名、API 形状、对外契约。热络，爱复述与举例。',
  '- npc_keeper 渠叔，水渠管理员：测试、边界情况、失败处理。谨慎，常问「如果…会怎样？」。',
  '',
  '规则：',
  '1. kind 二选一：上下文里有真实的、未决的取舍 → decision（2~4 个选项，每个必须给一句',
  '   各自的代价 tradeoff，不允许出现明显的标准答案）；只有进展叙述、没有未决取舍 →',
  '   reflection（一个开放问题，引导玩家把当前思路讲清楚）。',
  '2. 语言：简体中文。NPC 台词每段 ≤2 句，温暖、克制、像村民闲谈，不堆术语；',
  '   用 NPC 自己的行当打比方，但比方只许一个。',
  '3. 只基于 stdin 内容提问，不臆测细节；不复述任何看起来像密钥、内网地址的内容；',
  '   不要求玩家离开游戏做任何事。',
  '4. contextEcho 用 ≤120 字复述你理解的工作背景（写入玩家笔记存档用）。',
  '5. 严格按 JSON schema 输出。',
].join('\n');

export interface BuiltPrompt {
  /** Goes to `-p "<instructions>"`. */
  readonly instructions: string;
  /** Goes to stdin (≤MAX_CONTEXT_CHARS); already sanitized by the caller. */
  readonly stdinContext: string;
}

/**
 * Assemble the prompt. `sanitizedContext` is the §4.3 output (already secret-free
 * and length-bounded); this only formats the title/lastPrompt/turns into the
 * stdin doc and applies the final MAX_CONTEXT_CHARS cap. PURE. SKELETON — body
 * by the prompt sub-task.
 */
/**
 * Render an ExtractedContext into a flat, line-oriented document for sanitize()
 * to clean and for the model to read. The shape mirrors §4.2's whitelist: a
 * theme line, the latest intent, then the discussion turns. This text is what
 * the caller passes through sanitize() — it is NOT yet secret-free here.
 */
export function renderContextDocument(ctx: ExtractedContext): string {
  const lines: string[] = [];
  if (ctx.title !== null && ctx.title !== '') lines.push(`工作主题：${ctx.title}`);
  if (ctx.lastPrompt !== null && ctx.lastPrompt !== '') lines.push(`最新意图：${ctx.lastPrompt}`);
  if (ctx.turns.length > 0) {
    lines.push('讨论脉络：');
    for (const turn of ctx.turns) {
      const who = turn.role === 'user' ? '玩家' : '助手';
      lines.push(`${who}：${turn.text}`);
    }
  }
  return lines.join('\n');
}

export function buildPrompt(_ctx: ExtractedContext, sanitizedContext: string): BuiltPrompt {
  // The instructions are FIXED (carry no work content); only the stdin context is
  // derived from the transcript and it arrives here already secret-free + bounded
  // by sanitize(). Apply the final hard cap defensively so stdin can never exceed
  // MAX_CONTEXT_CHARS even if a caller forgets the whole-text gate (§4.3-3/§4.5).
  const stdinContext =
    sanitizedContext.length > MAX_CONTEXT_CHARS
      ? sanitizedContext.slice(0, MAX_CONTEXT_CHARS)
      : sanitizedContext;
  return { instructions: INSTRUCTION_SKELETON, stdinContext };
}
