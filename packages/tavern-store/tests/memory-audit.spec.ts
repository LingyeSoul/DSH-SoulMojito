import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRevisionConflictError, MemoryStore, type MemoryRecord } from '../src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function openStore(): Promise<{ root: string; store: MemoryStore }> {
  const root = mkdtempSync(join(tmpdir(), 'tavern-memory-audit-'))
  roots.push(root)
  return { root, store: await MemoryStore.open(root) }
}

function auditLines(root: string, scope: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(root, 'memory-audit', `${scope}.jsonl`), 'utf8')
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** A journaled record as body rollback keeps it: old timestamps, fixed revision. */
function journaledRecord(): MemoryRecord {
  return {
    id: 'example-memory',
    scope: 'chat',
    scopeId: 'example-chat',
    kind: 'semantic',
    content: 'Example memory.',
    tags: [],
    importance: 0.5,
    confidence: 0.5,
    source: { kind: 'test' },
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-02T03:04:05.000Z',
    revision: 'journaled-revision',
  }
}

describe('MemoryStore restore audit', () => {
  it('stamps the audit line with the restore time and keeps the record timestamp', async () => {
    const { root, store } = await openStore()
    const record = journaledRecord()

    const startedAt = Date.now()
    const restored = await store.restore(record)
    const finishedAt = Date.now()
    expect(restored).toEqual(record)

    const line = auditLines(root, 'chat').at(-1)!
    expect(line).toMatchObject({
      action: 'restore',
      id: record.id,
      scope: record.scope,
      scopeId: record.scopeId,
      revision: record.revision,
      recordUpdatedAt: record.updatedAt,
    })
    // The audit line must not move backwards: `at` is when restore ran, while
    // the journaled `updatedAt` only travels as the traceable extra field.
    expect(line['at']).not.toBe(record.updatedAt)
    const at = Date.parse(String(line['at']))
    expect(Number.isNaN(at)).toBe(false)
    expect(at).toBeGreaterThanOrEqual(startedAt)
    expect(at).toBeLessThanOrEqual(finishedAt)
  })

  it('keeps the restore CAS contract and audits nothing when it refuses', async () => {
    const { root, store } = await openStore()
    const created = await store.put({
      scope: 'chat',
      scopeId: 'example-chat',
      kind: 'semantic',
      content: 'First content.',
      source: { kind: 'test' },
    })

    await expect(store.restore({ ...created, content: 'Forged content.' }, 'stale-revision'))
      .rejects.toBeInstanceOf(MemoryRevisionConflictError)

    expect(auditLines(root, 'chat').map((line) => line['action'])).toEqual(['put'])
    expect(await store.read(created.id, 'chat', 'example-chat'))
      .toMatchObject({ content: 'First content.', revision: created.revision })
  })
})
