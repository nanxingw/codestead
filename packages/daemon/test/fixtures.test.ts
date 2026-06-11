/**
 * Fixture privacy pipeline + mechanical commit gate (privacy red line):
 * every committed fixture line must be scrubbed=true and whitelist-only —
 * this suite IS the CI check the recorder's `scrubbed` flag promises.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { HOOK_EVENTS } from '../src/install/installer.js';
import { startHookRecorder, type RecordedHookEvent } from '../src/install/recorder.js';
import {
  SCRUB_KEEP_FIELDS,
  detectUsername,
  isScrubbedRecordedEvent,
  scrubFixture,
  scrubHookBody,
} from '../src/install/scrub.js';
import { HookWireEventSchema } from '../src/signals/hooks-wire.js';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('scrub — fixture privacy pipeline', () => {
  it('derives the whitelist from HookWireEventSchema so the two can never drift', () => {
    expect([...SCRUB_KEEP_FIELDS].sort()).toEqual(Object.keys(HookWireEventSchema.shape).sort());
    expect(SCRUB_KEEP_FIELDS).not.toContain('prompt');
    expect(SCRUB_KEEP_FIELDS).not.toContain('tool_input');
    expect(SCRUB_KEEP_FIELDS).not.toContain('tool_output');
    expect(SCRUB_KEEP_FIELDS).not.toContain('message');
  });

  it('whitelists fields and replaces the username in every kept value', () => {
    const scrubbed = scrubHookBody({
      session_id: 's-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/Users/alice/Desktop/secret-project',
      transcript_path:
        '/Users/alice/.claude/projects/-Users-alice-Desktop-secret-project/s-1.jsonl',
      prompt: 'please refactor the billing module',
      tool_input: { command: 'rm -rf /' },
      permission_mode: 'default',
    });
    expect(scrubbed).toEqual({
      session_id: 's-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/Users/user/Desktop/secret-project',
      transcript_path: '/Users/user/.claude/projects/-Users-user-Desktop-secret-project/s-1.jsonl',
    });
  });

  it('detects the username from cwd or transcript_path (macOS and Linux homes)', () => {
    expect(detectUsername({ cwd: '/Users/alice/x' })).toBe('alice');
    expect(detectUsername({ transcript_path: '/home/bob/.claude/projects/p/s.jsonl' })).toBe('bob');
    expect(detectUsername({ cwd: '/srv/build' })).toBeNull();
    expect(detectUsername('nope')).toBeNull();
  });

  it('scrubFixture flips lines to scrubbed=true and drops unreplayable lines', () => {
    const raw =
      [
        JSON.stringify({
          at: '2026-06-10T09:00:00.000Z',
          body: { session_id: 's-1', hook_event_name: 'Stop', cwd: '/Users/alice/p', prompt: 'x' },
          scrubbed: false,
        }),
        'not json at all',
        JSON.stringify({
          at: '2026-06-10T09:00:01.000Z',
          body: 'unparseable raw',
          scrubbed: false,
        }),
        JSON.stringify({
          at: '2026-06-10T09:00:02.000Z',
          body: { hook_event_name: 'Stop' }, // missing session_id → not a wire event → dropped
          scrubbed: false,
        }),
      ].join('\n') + '\n';

    const out = scrubFixture(raw);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as RecordedHookEvent;
    expect(event.scrubbed).toBe(true);
    expect(event.body).toEqual({
      session_id: 's-1',
      hook_event_name: 'Stop',
      cwd: '/Users/user/p',
    });
    expect(isScrubbedRecordedEvent(event)).toBe(true);
  });

  it('isScrubbedRecordedEvent rejects raw lines, extra fields, and non-string values', () => {
    const good = {
      at: '2026-06-10T09:00:00.000Z',
      body: { session_id: 's', hook_event_name: 'Stop' },
      scrubbed: true,
    };
    expect(isScrubbedRecordedEvent(good)).toBe(true);
    expect(isScrubbedRecordedEvent({ ...good, scrubbed: false })).toBe(false);
    expect(isScrubbedRecordedEvent({ ...good, body: { ...good.body, prompt: 'leak' } })).toBe(
      false,
    );
    expect(isScrubbedRecordedEvent({ ...good, body: { ...good.body, source: 7 } })).toBe(false);
    expect(isScrubbedRecordedEvent({ ...good, at: 'not-a-date' })).toBe(false);
    expect(isScrubbedRecordedEvent({ ...good, body: 'raw' })).toBe(false);
  });
});

describe('recorder → scrub end-to-end (temp dirs only)', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('a raw recording with prompt content scrubs down to committed-fixture shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codestead-scrub-e2e-'));
    tempDirs.push(dir);
    const outFile = join(dir, 'raw.jsonl');
    const recorder = await startHookRecorder({ outFile, basePort: 0 });
    try {
      await fetch(`http://127.0.0.1:${String(recorder.port)}/hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 's-9',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/Users/carol/work/topsecret',
          prompt: 'do not leak me',
        }),
      });
    } finally {
      await recorder.close();
    }

    const scrubbed = scrubFixture(await readFile(outFile, 'utf8'));
    expect(scrubbed).not.toContain('do not leak me');
    expect(scrubbed).not.toContain('carol');
    const line = JSON.parse(scrubbed.trim()) as RecordedHookEvent;
    expect(isScrubbedRecordedEvent(line)).toBe(true);
    expect(line.body).toEqual({
      session_id: 's-9',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/Users/user/work/topsecret',
    });
  });
});

describe('committed fixtures — mechanical privacy + replayability gate', () => {
  it('every line of every committed fixture passes the privacy gate (scrubbed=true, whitelist-only)', async () => {
    // Privacy ONLY — deliberately-malformed tolerance probes (e.g. a body
    // missing session_id to pin "normalize → null") are allowed, as long as
    // they contain nothing but whitelisted string fields.
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0); // the synthetic baseline must exist
    for (const file of files) {
      const content = await readFile(join(FIXTURES_DIR, file), 'utf8');
      const lines = content.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        expect(isScrubbedRecordedEvent(parsed), `${file}: ${line.slice(0, 80)}`).toBe(true);
      }
    }
  });

  it('hooks-synthetic.jsonl is fully wire-parseable (replay baseline)', async () => {
    const content = await readFile(join(FIXTURES_DIR, 'hooks-synthetic.jsonl'), 'utf8');
    for (const line of content.split('\n').filter((l) => l.trim() !== '')) {
      const body = (JSON.parse(line) as RecordedHookEvent).body;
      expect(HookWireEventSchema.safeParse(body).success, line.slice(0, 80)).toBe(true);
    }
  });

  it('the synthetic fixture covers the full installed event set plus ignore cases', async () => {
    const content = await readFile(join(FIXTURES_DIR, 'hooks-synthetic.jsonl'), 'utf8');
    const events = content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { body: { hook_event_name: string } }).body.hook_event_name);
    for (const name of HOOK_EVENTS) {
      expect(events, `missing ${name}`).toContain(name);
    }
    expect(events).toContain('SubagentStop'); // unknown event → normalizer must ignore, not throw

    const notificationTypes = content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map(
        (l) => (JSON.parse(l) as { body: { notification_type?: string } }).body.notification_type,
      )
      .filter((t): t is string => typeof t === 'string');
    expect(notificationTypes).toContain('permission_prompt');
    expect(notificationTypes).toContain('idle_prompt');
    expect(notificationTypes).toContain('auth_success'); // ignored matcher value
  });
});
