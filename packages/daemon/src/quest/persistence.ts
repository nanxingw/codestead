/**
 * Quest state persistence (ai-quests §5 / §11-E3) — atomic load/save of the
 * QuestModuleState to `~/.codestead/quests/state.json` (path injected).
 *
 * Atomic write = write temp file + rename (§5). Restart recovery (§11-E3):
 *  - OFFERED is restored as-is and re-pushed via questSnapshot;
 *  - GENERATING is treated as FAILED (the spawned process is dead);
 *  - cooldown timers rebuild from the persisted `lastAttemptAt`.
 * File mode 0600 (§12-4). The recovery NORMALIZATION (GENERATING→FAILED) is a
 * pure transform so it is unit-testable without fs.
 *
 * SKELETON: store interface + the pure recovery-normalize signature. The fs
 * store (temp+rename, chmod 0600, safeParse-on-read with corrupt-file fallback)
 * is implemented by the persistence sub-task.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { QuestSchema } from '@codestead/shared';
import { z } from 'zod';

import type { QuestLifecyclePhase, QuestModuleState } from './types.js';

export interface QuestStateStore {
  /** Read + safeParse state.json; null when absent/corrupt (start fresh). */
  read(): Promise<QuestModuleState | null>;
  /** Atomic write (temp + rename), mode 0600. */
  write(state: QuestModuleState): Promise<void>;
}

/** File mode for every daemon-owned state/journal/note file (§12-4). */
export const QUEST_FILE_MODE = 0o600;

// ---- on-disk schema (safeParse on read so a hand-edit / corruption starts fresh) ----

const phaseSchema: z.ZodType<QuestLifecyclePhase> = z.enum([
  'IDLE',
  'GENERATING',
  'OFFERED',
  'ANSWERED',
  'ARCHIVED',
  'FAILED',
  'DISMISSED',
]);

const questMetaSchema = z.object({
  questId: z.string(),
  phase: z.enum(['ARCHIVED', 'DISMISSED']),
  source: z.enum(['ai', 'local', 'scripted']),
  npcId: z.enum(['npc_carpenter', 'npc_grocer', 'npc_keeper']),
  relatedSessionId: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  noteRef: z.string().nullable(),
});

const countersSchema = z.object({
  lastAttemptAt: z.number().nullable(),
  dailyDate: z.string().nullable(),
  dailyCount: z.number(),
  dailyCostUsd: z.number(),
  consecutiveFailures: z.number(),
  backoffMinutes: z.number(),
  localPoolMode: z.boolean(),
  lastRecoveryProbeAt: z.number().nullable(),
  asked: z.boolean(),
  firstConsentChoice: z.enum(['a', 'b', 'c']).nullable().default(null),
  askedFollowUp: z.boolean(),
  localCompletedCount: z.number(),
  usedLocalPoolIds: z.array(z.string()),
});

const moduleStateSchema = z.object({
  phase: phaseSchema,
  pending: QuestSchema.nullable(),
  history: z.array(questMetaSchema),
  counters: countersSchema,
});

/**
 * fs-backed QuestStateStore (path injected — NEVER the real ~/.codestead). Read
 * safeParses and returns null on absent/corrupt; write is temp-file + rename with
 * mode 0600 (§5/§12-4). The parent dir is created lazily on first write.
 */
export function createFileQuestStateStore(stateFile: string): QuestStateStore {
  return {
    async read(): Promise<QuestModuleState | null> {
      let raw: string;
      try {
        raw = await readFile(stateFile, 'utf8');
      } catch {
        return null; // absent — start fresh
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null; // corrupt JSON — start fresh (never crash, §11)
      }
      const result = moduleStateSchema.safeParse(parsed);
      return result.success ? result.data : null;
    },

    async write(state: QuestModuleState): Promise<void> {
      await mkdir(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp-${String(process.pid)}-${String(Date.now())}`;
      await writeFile(tmp, JSON.stringify(state), { mode: QUEST_FILE_MODE });
      await rename(tmp, stateFile);
    },
  };
}

/**
 * Normalize a just-loaded state for restart (§11-E3): GENERATING → FAILED-ish
 * reset to IDLE with the pending cleared (the dead process can never resume),
 * OFFERED/ANSWERED kept verbatim for re-push, counters untouched (cooldown
 * rebuilds from lastAttemptAt). PURE. SKELETON — body by the persistence sub-task.
 */
export function normalizeOnRestart(loaded: QuestModuleState): QuestModuleState {
  switch (loaded.phase) {
    case 'GENERATING':
      // The spawned process died with the previous daemon — it can never resume.
      // Drop to IDLE with no pending; cooldown rebuilds from lastAttemptAt so the
      // dead attempt still counts toward防抖 (§11-E3). Counters untouched.
      return { ...loaded, phase: 'IDLE', pending: null };
    case 'ANSWERED':
      // A crash between answer and reward: the note may or may not have landed.
      // Re-offer is unsafe (would double-ask); free the slot to IDLE so the next
      // trigger can run. Any un-pushed reward is covered by the game's
      // grantedQuestIds idempotency (§11-E4) — a missed reward is not re-driven
      // here (rare crash window; the design only pins OFFERED/GENERATING).
      return { ...loaded, phase: 'IDLE', pending: null };
    case 'FAILED':
      // A persisted FAILED simply resumes its backoff window from lastAttemptAt;
      // free the slot so the trigger owns recovery timing.
      return { ...loaded, phase: 'IDLE', pending: null };
    case 'OFFERED':
      // OFFERED is restored verbatim so questSnapshot can re-push it (§5/§11-E3).
      return loaded;
    case 'DISMISSED':
    case 'ARCHIVED':
      // Terminal transient phases left mid-cycle: free the slot.
      return { ...loaded, phase: 'IDLE', pending: null };
    case 'IDLE':
    default:
      return loaded;
  }
}
