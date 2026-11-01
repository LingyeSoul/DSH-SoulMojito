import { describe, expect, it } from 'vitest'
import {
  advanceCheckpoint,
  CHECKPOINT_WRITE_DELAY_MS,
  CHECKPOINT_WRITE_LAG,
  checkpointPathOf,
  createCheckpointBatch,
  isProjectedCursor,
  normalizeCheckpoint,
  pendingCheckpoint,
  ProjectionCheckpointLagError,
  validateCheckpoint,
  type CheckpointBatch,
  type CheckpointBatchHost,
  type ProjectionCheckpoint,
} from '../src/agent-tavern/checkpoint-batch.js'

const SESSION = 'checkpoint-batch-session'

function checkpointOf(lastCursor: number): ProjectionCheckpoint {
  return { version: 2, sessionId: SESSION, lastCursor, status: 'ok', updatedAt: new Date(0).toISOString() }
}

interface BatchHarness {
  batch: CheckpointBatch
  /** Durable writes, in order — the record the batch must coalesce. */
  written: ProjectionCheckpoint[]
  /** In-memory checkpoints the projector would hand out through `read`. */
  cache: Map<string, ProjectionCheckpoint>
  /** Refuse the next `count` writes, then let them through again. */
  refuse: (count: number) => void
}

/**
 * The batch against an injected host: the write seam is a list, so a write
 * count is observed directly instead of by patching a private method.
 */
function harness(): BatchHarness {
  const cache = new Map<string, ProjectionCheckpoint>()
  const written: ProjectionCheckpoint[] = []
  const tails = new Map<string, Promise<void>>()
  let refusals = 0
  const host: CheckpointBatchHost = {
    read: (sessionId) => cache.get(sessionId),
    write: async (checkpoint) => {
      if (refusals > 0) {
        refusals -= 1
        throw new Error(`checkpoint write refused for session '${checkpoint.sessionId}'`)
      }
      written.push(checkpoint)
      cache.set(checkpoint.sessionId, checkpoint)
    },
    enqueue: (sessionId, task) => {
      // Same contract as the projector's tail: per-session serial, a rejection
      // does not block the next task.
      const run = (tails.get(sessionId) ?? Promise.resolve()).then(task)
      tails.set(sessionId, run.then(() => {}, () => {}))
      return run
    },
  }
  return {
    batch: createCheckpointBatch(host),
    written,
    cache,
    refuse: (count: number) => { refusals = count },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `predicate` holds, failing loudly instead of hanging. */
async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`never observed: ${label}`)
    await sleep(5)
  }
}

describe('checkpoint path', () => {
  it('names the file after the session id hash, deterministically', () => {
    const first = checkpointPathOf('C:/tavern/projections', SESSION)
    expect(first).toBe(checkpointPathOf('C:/tavern/projections', SESSION))
    expect(first.endsWith('.json')).toBe(true)
    expect(/[\\/]projections[\\/]/.test(first)).toBe(true)
    expect(checkpointPathOf('C:/tavern/projections', 'another-session')).not.toBe(first)
    // The name is the sha256 hex of the session id, not the id itself.
    expect(first).not.toContain(SESSION)
  })
})

describe('checkpoint value transitions', () => {
  it('treats a seq below a pending hole as unprojected', () => {
    const checkpoint: ProjectionCheckpoint = { ...checkpointOf(4), status: 'pending', pendingCursor: 3 }
    expect(isProjectedCursor(checkpoint, 2)).toBe(true)
    expect(isProjectedCursor(checkpoint, 3)).toBe(false)
    expect(isProjectedCursor(checkpoint, 4)).toBe(false)
    expect(isProjectedCursor(checkpointOf(4), 5)).toBe(false)
  })

  it('closes the hole only at its own cursor', () => {
    const holed: ProjectionCheckpoint = { ...checkpointOf(4), status: 'pending', pendingCursor: 3, error: 'boom' }
    expect(advanceCheckpoint(holed, 6)).toMatchObject({ lastCursor: 4, status: 'pending', pendingCursor: 3, error: 'boom' })
    expect(advanceCheckpoint(holed, 3)).toMatchObject({ lastCursor: 3, status: 'ok' })
    expect(advanceCheckpoint(checkpointOf(4), 9)).toMatchObject({ lastCursor: 9, status: 'ok' })
    expect(advanceCheckpoint(checkpointOf(9), 5)).toMatchObject({ lastCursor: 9, status: 'ok' })
  })

  it('keeps the lowest failed cursor when recording a failure', () => {
    expect(pendingCheckpoint(checkpointOf(4), 6, new Error('first'))).toMatchObject({
      lastCursor: 4, status: 'pending', pendingCursor: 6, error: 'first',
    })
    expect(pendingCheckpoint({ ...checkpointOf(4), pendingCursor: 6 }, 5, 'second')).toMatchObject({
      pendingCursor: 5, error: 'second',
    })
  })

  it('resets an untrusted v1 file and rejects a malformed checkpoint', () => {
    expect(normalizeCheckpoint({ ...checkpointOf(7), version: 1 })).toMatchObject({
      version: 2, lastCursor: -1, status: 'pending', pendingCursor: 0,
    })
    expect(normalizeCheckpoint({ ...checkpointOf(7), status: 'pending' })).toMatchObject({ pendingCursor: 8 })
    expect(() => validateCheckpoint({ ...checkpointOf(1), lastCursor: 1.5 }, SESSION))
      .toThrow(`invalid AgentTavern projection checkpoint for '${SESSION}'`)
    expect(() => validateCheckpoint(checkpointOf(1), 'other-session'))
      .toThrow(`invalid AgentTavern projection checkpoint for 'other-session'`)
  })
})

describe('checkpoint batch', () => {
  it('coalesces a burst into one write per batch bound plus the idle window', async () => {
    const { batch, written, cache } = harness()
    const burst = CHECKPOINT_WRITE_LAG * 2 + 2
    for (let cursor = 0; cursor < burst; cursor += 1) {
      cache.set(SESSION, checkpointOf(cursor))
      await batch.stage(SESSION)
    }

    // The batch bound closed twice; the two events after it are still in memory.
    expect(written).toHaveLength(2)
    expect(batch.dirty(SESSION)).toBe(true)

    // The idle window closes on its own and persists the tail.
    await eventually(() => written.length === 3, 'the idle window flush')
    expect(written.at(-1)).toMatchObject({ lastCursor: burst - 1, status: 'ok' })
    expect(batch.dirty(SESSION)).toBe(false)
    expect(written.length).toBeLessThanOrEqual(Math.ceil(burst / CHECKPOINT_WRITE_LAG))
  })

  it('writes the cached checkpoint on commit even when the batch is clean', async () => {
    const { batch, written, cache } = harness()
    cache.set(SESSION, checkpointOf(1))
    await batch.commit(SESSION)
    await batch.commit(SESSION)
    expect(written).toHaveLength(2)
  })

  it('does not write a clean session on flush', async () => {
    const { batch, written, cache } = harness()
    cache.set(SESSION, checkpointOf(1))
    await batch.flush(SESSION)
    expect(written).toHaveLength(0)
  })

  it('retries a failed idle-window flush once and clears the failure with the write', async () => {
    const { batch, written, cache, refuse } = harness()
    refuse(1)
    cache.set(SESSION, checkpointOf(1))
    await batch.stage(SESSION)

    // The window flush is refused; the retry behind it lands and retires the
    // failure, so no operation ever sees it.
    await eventually(() => written.length === 1, 'the bounded retry')
    expect(batch.deferredError(SESSION)).toBeUndefined()
    expect(written.at(-1)).toMatchObject({ lastCursor: 1 })
  })

  it('keeps a twice-failed write for the session to raise, and does not retry again', async () => {
    const { batch, written, cache, refuse } = harness()
    refuse(2)
    cache.set(SESSION, checkpointOf(1))
    await batch.stage(SESSION)

    await eventually(() => batch.deferredError(SESSION) !== undefined, 'the retained failure')
    // One bounded retry only: a third attempt would be an endless loop.
    await sleep(300)
    expect(written).toHaveLength(0)
    expect(batch.dirty(SESSION)).toBe(true)
    expect(String(batch.deferredError(SESSION))).toContain('checkpoint write refused')

    // A landed write is what clears it.
    await batch.flush(SESSION)
    expect(batch.deferredError(SESSION)).toBeUndefined()
    expect(written).toHaveLength(1)
  })

  it('keeps a deferred failure across reset but drops the staged writes', async () => {
    const { batch, cache, refuse } = harness()
    refuse(2)
    cache.set(SESSION, checkpointOf(1))
    await batch.stage(SESSION)
    await eventually(() => batch.deferredError(SESSION) !== undefined, 'the retained failure')

    batch.reset(SESSION)
    expect(batch.dirty(SESSION)).toBe(false)
    expect(batch.deferredError(SESSION)).toBeDefined()
  })

  it('rejects an awaited batch-closing flush with the write error, not the lag type', async () => {
    const { batch, cache, refuse } = harness()
    refuse(1)
    let rejection: unknown
    for (let cursor = 0; cursor < CHECKPOINT_WRITE_LAG; cursor += 1) {
      cache.set(SESSION, checkpointOf(cursor))
      try {
        await batch.stage(SESSION)
      } catch (error) {
        rejection = error
      }
    }
    batch.reset(SESSION)

    // The caller awaited this write, so it hears the write failure as-is: the
    // floors of this event are NOT known to be appended.
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(ProjectionCheckpointLagError)
    expect((rejection as Error).message).toContain('checkpoint write refused')
  })

  it('holds the raw write error for a timer flush instead of the lag type', async () => {
    const { batch, cache, refuse } = harness()
    refuse(2)
    cache.set(SESSION, checkpointOf(1))
    await batch.stage(SESSION)
    await eventually(() => batch.deferredError(SESSION) !== undefined, 'the retained failure')
    batch.reset(SESSION)

    // Which fact a deferred failure means (floors landed, watermark did not)
    // belongs to the caller that appended them; the batch reports the write.
    const deferred = batch.deferredError(SESSION)
    expect(deferred).toBeInstanceOf(Error)
    expect(deferred).not.toBeInstanceOf(ProjectionCheckpointLagError)
    expect((deferred as Error).message).toContain('checkpoint write refused')
  })
})

describe('projection checkpoint lag error', () => {
  it('states the landed floors, the session and the window, and keeps the write error as cause', () => {
    const cause = new Error("ENOENT: no such file or directory, rename 'C:\\fake\\projections\\9f3a.json'")
    const error = new ProjectionCheckpointLagError(SESSION, cause)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ProjectionCheckpointLagError')
    expect(error.sessionId).toBe(SESSION)
    expect(error.stack).toContain('ProjectionCheckpointLagError')
    // The whole fact on one line: what landed, what did not, which session and
    // which batch window — a caller's generic prefix cannot invert it.
    expect(error.message).toContain('projection floors were already appended')
    // Not "only the watermark": the same failed checkpoint may carry a pending
    // hole whose floor never landed, so the line must admit it.
    expect(error.message).toContain('the checkpoint watermark (and any pending hole it carried) did not reach disk in this write')
    expect(error.message).not.toContain('only the checkpoint')
    expect(error.message).toContain(`session '${SESSION}'`)
    expect(error.message).toContain(`batch window: ${CHECKPOINT_WRITE_LAG} events / ${CHECKPOINT_WRITE_DELAY_MS} ms`)
    // The write error names its path; the lag line must not repeat it.
    expect(error.message).not.toContain('C:\\fake')
    expect(error.cause).toBe(cause)
  })
})
