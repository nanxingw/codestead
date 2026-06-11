/**
 * Raw Claude Code hook POST bodies → normalized SessionEvent.
 *
 * Wire shape source: docs/design/research/hooks.md §3 (observed on v2.1.170).
 * These payloads are EXTERNAL input with no stability guarantee (tech-stack
 * risk #2), so:
 * - the schema is `looseObject` (unknown fields pass through unvalidated);
 * - everything beyond `session_id` + `hook_event_name` is optional;
 * - unrecognized events / matchers normalize to `null` (ignored), never throw;
 * - drift is caught by replaying recorded fixtures (install/recorder.ts) —
 *   re-record after upgrading Claude Code; a failing replay IS the drift alarm.
 *
 * PRIVACY (red line): `prompt`, `tool_input`, `tool_output`, `message` are
 * deliberately ABSENT from this schema. Hook bodies must never be logged;
 * normalized events carry no prompt/transcript content.
 */
import { z } from 'zod';

import type { SessionEvent } from '../state/events.js';

/** Tolerant parse target for `POST /hooks` bodies. */
export const HookWireEventSchema = z.looseObject({
  session_id: z.string(),
  hook_event_name: z.string(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  /** SessionStart only: startup | resume | clear | compact. */
  source: z.string().optional(),
  /** Notification only: permission_prompt | idle_prompt | … */
  notification_type: z.string().optional(),
  /** StopFailure only: rate_limit | overloaded | authentication_failed | billing_error | … */
  error_type: z.string().optional(),
  /** SessionEnd only. */
  reason: z.string().optional(),
});
export type HookWireEvent = z.infer<typeof HookWireEventSchema>;

/**
 * Normalization map (hud-sessions §7.3 rows 1–8; research/hooks.md §5.1):
 * - SessionStart            → hookSessionStart (startSource from `source`, default 'startup')
 * - UserPromptSubmit        → hookUserPromptSubmit
 * - PreToolUse / PostToolUse / PostToolUseFailure → hookToolHeartbeat
 * - PermissionRequest       → hookBlocked (via 'PermissionRequest')
 * - Notification(permission_prompt) → hookBlocked (via 'NotificationPermissionPrompt')
 * - Notification(idle_prompt)        → hookDone   (via 'NotificationIdlePrompt')
 * - Notification(other)     → null (ignored)
 * - Stop                    → hookDone (via 'Stop')
 * - StopFailure             → hookStopFailure (errorKind from `error_type`, fallback 'unknown')
 * - SessionEnd              → hookSessionEnd
 * - anything else (SubagentStop, MessageDisplay, future events…) → null
 *
 * Returns null for unparseable bodies too — the HTTP layer still answers an
 * empty 2xx regardless (listen-only contract, tech-stack §4.1-1).
 */
export function normalizeHookEvent(body: unknown, at: number): SessionEvent | null {
  const parsed = HookWireEventSchema.safeParse(body);
  if (!parsed.success) return null;
  const wire = parsed.data;
  const sessionId = wire.session_id;

  switch (wire.hook_event_name) {
    case 'SessionStart': {
      const startSource =
        wire.source === 'startup' ||
        wire.source === 'resume' ||
        wire.source === 'clear' ||
        wire.source === 'compact'
          ? wire.source
          : 'startup';
      return {
        kind: 'hookSessionStart',
        at,
        sessionId,
        startSource,
        cwd: wire.cwd ?? '',
        transcriptPath: wire.transcript_path ?? null,
      };
    }
    case 'UserPromptSubmit':
      return { kind: 'hookUserPromptSubmit', at, sessionId };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'hookToolHeartbeat', at, sessionId, hook: wire.hook_event_name };
    case 'PermissionRequest':
      return { kind: 'hookBlocked', at, sessionId, via: 'PermissionRequest' };
    case 'Notification': {
      if (wire.notification_type === 'permission_prompt') {
        return { kind: 'hookBlocked', at, sessionId, via: 'NotificationPermissionPrompt' };
      }
      if (wire.notification_type === 'idle_prompt') {
        return { kind: 'hookDone', at, sessionId, via: 'NotificationIdlePrompt' };
      }
      return null; // auth_success / elicitation_* / future types — ignored.
    }
    case 'Stop':
      return { kind: 'hookDone', at, sessionId, via: 'Stop' };
    case 'StopFailure':
      return { kind: 'hookStopFailure', at, sessionId, errorKind: wire.error_type ?? 'unknown' };
    case 'SessionEnd':
      return { kind: 'hookSessionEnd', at, sessionId };
    default:
      // SubagentStop, MessageDisplay, future events… — deliberately ignored.
      return null;
  }
}
