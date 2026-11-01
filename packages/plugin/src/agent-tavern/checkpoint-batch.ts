/**
 * Batched persistence of projection checkpoints.
 *
 * Split out of `projector.ts` so that file stays inside the source budget. This
 * module owns two things and nothing else:
 *
 * 1. the checkpoint record — its shape, file path, validation, v1 migration and
 *    pure watermark arithmetic (`isProjectedCursor`, `advanceCheckpoint`,
 *    `pendingCheckpoint`, `normalizeCheckpoint`, `checkpointPathOf`);
 * 2. the write schedule — how many staged events close a batch, how long an
 *    idle batch may stay in memory, and what a failed write owes the caller.
 *
 * It holds no projection business: no store, no binding, no regex, no session
 * log, no decision about which floor an event becomes. Every side effect is
 * injected through {@link CheckpointBatchHost}: `read` returns the newest
 * in-memory checkpoint, `write` persists one, `enqueue` runs the flush on the
 * session's projection tail so it cannot race the work that reads the same
 * cache.
 *
 * The in-memory checkpoint is authoritative for reads; the file is only the
 * crash watermark `replay()` resumes from. Coalescing turns a 16-61 event round
 * into a handful of writes instead of one per event, and both bounds cap what a
 * crash makes `replay()` re-project — idempotently, see `appendMessage` and
 * `projectBodyEvent` in the projector.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

export interface ProjectionCheckpoint {
  /** On-disk format. v1 watermarks are untrusted and migrate to v2 on read. */
  version: 1 | 2
  sessionId: string
  /** Contiguous watermark: every seq at or below it is projected (or absent). */
  lastCursor: number
  status: 'ok' | 'pending'
  /**
   * Lowest seq that failed and still needs replay. Present while a hole exists;
   * v2 writers keep it strictly above `lastCursor`, so a v2 checkpoint cannot
   * hide an unprojected seq below its watermark. v1 files never carry a
   * trustworthy one (see `normalizeCheckpoint`) and are reset wholesale.
   */
  pendingCursor?: number
  error?: string
  updatedAt: string
}

/** Staged events that close a batch without waiting for the idle window. */
export const CHECKPOINT_WRITE_LAG = 8

/** How long a batch may stay in memory when no further event arrives. */
export const CHECKPOINT_WRITE_DELAY_MS = 250

/**
 * One bounded retry of a timer flush that failed.
 *
 * A timer flush has no caller to reject, so a single failure must not be the
 * last word: retrying once closes transient write failures (a rename over a
 * briefly locked file) without hiding a persistent one behind an endless retry
 * loop. A second failure is kept in `deferredError` until a write lands.
 */
export const CHECKPOINT_WRITE_RETRY_MS = 250

/**
 * A timer flush never wrote its checkpoint, but the events it covers are
 * already projected: every floor it staged is in the chat. What stayed in
 * memory is the checkpoint — the watermark that tells a replay how far it got,
 * and any pending hole that watermark still records.
 *
 * The pending hole matters for the wording: the failed checkpoint is not
 * always a clean `ok` watermark, so "only the watermark" would be a lie about a
 * seq whose floor never landed. The message names both possibilities instead.
 *
 * It exists as its own type because those two facts must not be confused:
 * a caller's generic `<operation> failed: ${error.message}` line would read
 * like a lost message, while nothing the batch staged is lost. The message
 * therefore carries the whole fact — what landed, what did not (the watermark,
 * and any pending hole it carried), which session, how wide the window — so one
 * log line is self-explanatory without the caller knowing this type. The
 * underlying write error rides on `cause`; its message can carry an absolute
 * path, so it is deliberately never spliced into this one.
 */
export class ProjectionCheckpointLagError extends Error {
  readonly sessionId: string

  constructor(sessionId: string, cause: unknown) {
    super(
      `projection floors were already appended, but the checkpoint watermark (and any pending hole it carried) did not reach disk in this write for session '${sessionId}' `
      + `(batch window: ${CHECKPOINT_WRITE_LAG} events / ${CHECKPOINT_WRITE_DELAY_MS} ms); `
      + 'a replay re-projects that window idempotently',
      { cause },
    )
    this.name = 'ProjectionCheckpointLagError'
    this.sessionId = sessionId
  }
}

/** The checkpoint file of one session inside a projections root. */
export function checkpointPathOf(root: string, sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex')
  return join(root, `${name}.json`)
}

export function validateCheckpoint(value: ProjectionCheckpoint, sessionId: string): void {
  if ((value.version !== 1 && value.version !== 2) || value.sessionId !== sessionId || !Number.isSafeInteger(value.lastCursor)
    || !['ok', 'pending'].includes(value.status)) {
    throw new Error(`invalid AgentTavern projection checkpoint for '${sessionId}'`)
  }
  // v1 files are migrated wholesale by `normalizeCheckpoint`, and a hand-edited
  // v2 file may still carry `pendingCursor` below `lastCursor`; either way only
  // the shape is validated here.
  if (value.pendingCursor !== undefined
    && (!Number.isSafeInteger(value.pendingCursor) || value.pendingCursor < 0)) {
    throw new Error(`invalid AgentTavern projection checkpoint for '${sessionId}'`)
  }
}

/**
 * Keep a checkpoint repairable when its watermark cannot be trusted.
 *
 * v1 watermarks are untrusted wholesale: the pre-v2 success branch overwrote
 * the whole checkpoint with `{ lastCursor: seq, status: 'ok' }`, so a v1 `ok`
 * file can hide a failed seq anywhere below its watermark (and a v1 `pending`
 * file can hide one below its `pendingCursor`). Guessing `lastCursor + 1`
 * cannot repair a hole below the watermark, so a v1 checkpoint resets to an
 * unverified pending state whose first unproven cursor is 0: the next replay
 * re-projects every event idempotently (identity-checked floor appends,
 * slot-overwriting body writes) and rewrites a trustworthy v2 watermark, and a
 * live event before that replay can no longer stamp a false `ok` watermark.
 * The reset lives in the cache only, so an unreplayed file is re-migrated —
 * harmlessly — after every restart.
 *
 * v2 pending checkpoints that lost `pendingCursor` (hand-edited file or a
 * producer that only knew the scalar watermark) keep the decision-2026-10-29
 * normalization: the first unproven cursor is the next one after `lastCursor`.
 */
export function normalizeCheckpoint(checkpoint: ProjectionCheckpoint): ProjectionCheckpoint {
  if (checkpoint.version === 1) {
    return {
      version: 2,
      sessionId: checkpoint.sessionId,
      lastCursor: -1,
      status: 'pending',
      pendingCursor: 0,
      updatedAt: checkpoint.updatedAt,
    }
  }
  if (checkpoint.status !== 'pending' || checkpoint.pendingCursor !== undefined) return checkpoint
  if (checkpoint.lastCursor >= Number.MAX_SAFE_INTEGER) return checkpoint
  return { ...checkpoint, pendingCursor: checkpoint.lastCursor + 1 }
}

/** Injected side effects the batch needs; the projector wires its cache and tail. */
export interface CheckpointBatchHost {
  /** Newest in-memory checkpoint of a session; undefined once the cache was dropped. */
  read: (sessionId: string) => ProjectionCheckpoint | undefined
  /** Persist one checkpoint. The host owns the atomic write and its own cache. */
  write: (checkpoint: ProjectionCheckpoint) => Promise<void>
  /** Run `task` on the session's serial tail. */
  enqueue: (sessionId: string, task: () => Promise<void>) => Promise<void>
}

export interface CheckpointBatch {
  /** Record a projected event and flush once the batch window is full. */
  stage: (sessionId: string) => Promise<void>
  /**
   * Write the cached checkpoint unconditionally.
   *
   * The failure path needs this: a checkpoint recording a pending hole must be
   * durable even when the batch is otherwise clean, or a crash would replay the
   * hole away.
   */
  commit: (sessionId: string) => Promise<void>
  /** Write the cached checkpoint if the file is behind it. */
  flush: (sessionId: string) => Promise<void>
  /** Drop staged writes and timers for a session; a deferred failure stays until a write lands. */
  reset: (sessionId: string) => void
  /** Whether the cached checkpoint is ahead of the file on disk. */
  dirty: (sessionId: string) => boolean
  /**
   * Failure of a timer flush, which has no caller to reject.
   *
   * Kept until a write lands, so the session's next `project()`, `status()` or
   * `replay()` can raise it instead of answering with a watermark the file does
   * not carry.
   */
  deferredError: (sessionId: string) => unknown
}

export function createCheckpointBatch(host: CheckpointBatchHost): CheckpointBatch {
  const dirtySessions = new Set<string>()
  const stagedEvents = new Map<string, number>()
  const flushTimers = new Map<string, NodeJS.Timeout>()
  const flushErrors = new Map<string, unknown>()

  const disarm = (sessionId: string): void => {
    const timer = flushTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    flushTimers.delete(sessionId)
  }

  /** Write the cached checkpoint and drop every bit of state it supersedes. */
  const write = async (sessionId: string): Promise<void> => {
    // Re-read the cache instead of a staged snapshot: `reset()` may have
    // dropped it, and a later projection may have advanced it.
    const checkpoint = host.read(sessionId)
    if (checkpoint === undefined) {
      dirtySessions.delete(sessionId)
      stagedEvents.delete(sessionId)
      return
    }
    await host.write(checkpoint)
    // A landed write makes the earlier failure moot.
    dirtySessions.delete(sessionId)
    stagedEvents.delete(sessionId)
    flushErrors.delete(sessionId)
  }

  const flush = async (sessionId: string): Promise<void> => {
    disarm(sessionId)
    if (!dirtySessions.has(sessionId)) return
    await write(sessionId)
  }

  /**
   * Bound how long a batch may stay in memory when no further event arrives.
   *
   * The write is enqueued on the session tail rather than run here, so it stays
   * ordered with the projection work that reads the same cache and cannot race
   * another write of this checkpoint file.
   */
  const arm = (sessionId: string, delayMs: number, retry: boolean): void => {
    if (flushTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      flushTimers.delete(sessionId)
      void host.enqueue(sessionId, () => flush(sessionId)).catch((error: unknown) => {
        flushErrors.set(sessionId, error)
        // Nobody is awaiting a timer flush, so it retries once; a second failure
        // stays in `flushErrors` for the session's next operation to raise.
        if (!retry) arm(sessionId, CHECKPOINT_WRITE_RETRY_MS, true)
      })
    }, delayMs)
    // A pending flush must never keep the host process alive.
    timer.unref()
    flushTimers.set(sessionId, timer)
  }

  return {
    async stage(sessionId: string): Promise<void> {
      dirtySessions.add(sessionId)
      const staged = (stagedEvents.get(sessionId) ?? 0) + 1
      stagedEvents.set(sessionId, staged)
      if (staged >= CHECKPOINT_WRITE_LAG) {
        await flush(sessionId)
        return
      }
      arm(sessionId, CHECKPOINT_WRITE_DELAY_MS, false)
    },
    async commit(sessionId: string): Promise<void> {
      disarm(sessionId)
      await write(sessionId)
    },
    flush,
    reset(sessionId: string): void {
      disarm(sessionId)
      dirtySessions.delete(sessionId)
      stagedEvents.delete(sessionId)
      // The deferred failure deliberately survives: a replay that never managed a
      // write leaves the reason the file is behind intact for the caller to see.
    },
    dirty: (sessionId: string): boolean => dirtySessions.has(sessionId),
    deferredError: (sessionId: string): unknown => flushErrors.get(sessionId),
  }
}

/**
 * Whether `seq` already has a durable projection.
 *
 * `lastCursor` is the contiguous completed watermark; `pendingCursor` is the
 * lowest seq that still failed, so nothing at or above the hole is skipped.
 */
export function isProjectedCursor(checkpoint: ProjectionCheckpoint, seq: number): boolean {
  if (seq > checkpoint.lastCursor) return false
  return checkpoint.pendingCursor === undefined || seq < checkpoint.pendingCursor
}

/**
 * Advance the checkpoint after `seq` projected successfully.
 *
 * The pending hole closes only when `seq` is exactly `pendingCursor`. Any other
 * success behind a hole must not move the watermark past it: the seq is replayed
 * idempotently once the hole is repaired, so a second failed cursor cannot be
 * skipped by a later success.
 */
export function advanceCheckpoint(checkpoint: ProjectionCheckpoint, seq: number): ProjectionCheckpoint {
  const updatedAt = new Date().toISOString()
  const pendingCursor = checkpoint.pendingCursor
  if (pendingCursor === undefined) {
    return {
      version: 2,
      sessionId: checkpoint.sessionId,
      lastCursor: Math.max(checkpoint.lastCursor, seq),
      status: 'ok',
      updatedAt,
    }
  }
  if (pendingCursor !== seq) {
    return {
      version: 2,
      sessionId: checkpoint.sessionId,
      lastCursor: checkpoint.lastCursor,
      status: 'pending',
      pendingCursor,
      ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
      updatedAt,
    }
  }
  return { version: 2, sessionId: checkpoint.sessionId, lastCursor: seq, status: 'ok', updatedAt }
}

/** Record a failed `seq` while keeping the lowest unfinished cursor. */
export function pendingCheckpoint(checkpoint: ProjectionCheckpoint, seq: number, error: unknown): ProjectionCheckpoint {
  return {
    version: 2,
    sessionId: checkpoint.sessionId,
    lastCursor: checkpoint.lastCursor,
    status: 'pending',
    pendingCursor: checkpoint.pendingCursor === undefined
      ? seq
      : Math.min(checkpoint.pendingCursor, seq),
    error: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  }
}
