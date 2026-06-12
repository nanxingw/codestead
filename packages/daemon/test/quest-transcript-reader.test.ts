/**
 * Transcript reader whitelist (ai-quests §4.2) + tolerance (§11-E6) — daemon-quest
 * owner tests. Asserts the ❌ list (tool_use / tool_result / thinking / non-external
 * user input) is dropped, the ✅ list (ai-title / last-prompt / external user /
 * assistant text) is kept, the last 30-message window holds, and bad lines never throw.
 */
import { describe, expect, it } from 'vitest';

import {
  extractContext,
  readTranscriptContext,
  TRANSCRIPT_MESSAGE_WINDOW,
  type TranscriptTailReader,
} from '../src/quest/transcript-reader.js';

/** Build a jsonl tail from records (one JSON object per line). */
function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

const aiTitle = (t: string) => ({ type: 'ai-title', aiTitle: t });
const lastPrompt = (t: string) => ({ type: 'last-prompt', lastPrompt: t });
const externalUser = (t: string) => ({
  type: 'user',
  userType: 'external',
  message: { content: t },
});
const internalUser = (t: string) => ({
  type: 'user',
  userType: 'internal',
  message: { content: t },
});
const toolResultUser = () => ({
  type: 'user',
  userType: 'external',
  message: { content: [{ type: 'tool_result', content: 'secret file contents' }] },
});
const assistantText = (t: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: t }] },
});
const assistantToolUse = () => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', input: { cmd: 'rm -rf /' } }] },
});
const assistantThinking = () => ({
  type: 'assistant',
  message: { content: [{ type: 'thinking', thinking: 'internal reasoning' }] },
});

describe('extractContext (§4.2 whitelist)', () => {
  it('keeps the latest ai-title and last-prompt (latest wins)', () => {
    const ctx = extractContext(
      jsonl([aiTitle('first title'), aiTitle('latest title'), lastPrompt('latest intent')]),
    );
    expect(ctx.title).toBe('latest title');
    expect(ctx.lastPrompt).toBe('latest intent');
  });

  it('keeps external user string input and assistant text blocks', () => {
    const ctx = extractContext(
      jsonl([externalUser('how should I retry?'), assistantText('consider backoff')]),
    );
    expect(ctx.turns).toEqual([
      { role: 'user', text: 'how should I retry?' },
      { role: 'assistant', text: 'consider backoff' },
    ]);
  });

  it('DROPS tool_use / tool_result / thinking / non-external user (the ❌ list, §4.2)', () => {
    const ctx = extractContext(
      jsonl([
        toolResultUser(), // external user but array content (tool_result) → dropped
        internalUser('internal echo'), // userType !== external → dropped
        assistantToolUse(), // tool_use block → dropped
        assistantThinking(), // thinking block → dropped
      ]),
    );
    expect(ctx.turns).toEqual([]);
    // and the dropped secret content never appears anywhere
    const blob = JSON.stringify(ctx);
    expect(blob).not.toContain('secret file contents');
    expect(blob).not.toContain('rm -rf');
  });

  it('keeps only the LAST 30 conversational turns (§4.2 window)', () => {
    const many = [];
    for (let i = 0; i < 50; i++) many.push(externalUser(`prompt ${String(i)}`));
    const ctx = extractContext(jsonl(many));
    expect(ctx.turns).toHaveLength(TRANSCRIPT_MESSAGE_WINDOW);
    expect(ctx.turns[0]?.text).toBe('prompt 20'); // 50 - 30
    expect(ctx.turns[TRANSCRIPT_MESSAGE_WINDOW - 1]?.text).toBe('prompt 49');
  });

  it('tolerates bad / partial / non-object lines without throwing (§11-E6)', () => {
    const text =
      'not json at all\n' +
      '{ broken json\n' +
      JSON.stringify(42) +
      '\n' + // non-object
      JSON.stringify(aiTitle('survives')) +
      '\n' +
      '{"partial":'; /* clipped tail line, no newline */
    expect(() => extractContext(text)).not.toThrow();
    expect(extractContext(text).title).toBe('survives');
  });

  it('an assistant line mixing text + tool_use keeps ONLY the text', () => {
    const mixed = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'visible answer' },
          { type: 'tool_use', input: { secret: 'AKIAIOSFODNN7EXAMPLE' } },
        ],
      },
    };
    const ctx = extractContext(jsonl([mixed]));
    expect(ctx.turns).toEqual([{ role: 'assistant', text: 'visible answer' }]);
    expect(JSON.stringify(ctx)).not.toContain('AKIA');
  });
});

describe('readTranscriptContext (injected reader, §11-E6)', () => {
  it('uses the injected tail reader and parses its output', async () => {
    const reader: TranscriptTailReader = {
      readTail: () => Promise.resolve(jsonl([aiTitle('from reader')])),
    };
    const ctx = await readTranscriptContext(reader, '/whatever.jsonl');
    expect(ctx.title).toBe('from reader');
  });

  it("a reader returning '' (error) yields empty context, never throws", async () => {
    const reader: TranscriptTailReader = { readTail: () => Promise.resolve('') };
    const ctx = await readTranscriptContext(reader, '/missing.jsonl');
    expect(ctx).toEqual({ title: null, lastPrompt: null, turns: [] });
  });
});
