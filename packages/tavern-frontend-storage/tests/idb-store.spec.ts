/**
 * Host-backed virtual IndexedDB: real filesystem integration.
 *
 * The root is explicit so the library cannot silently depend on plugin globals.
 * Covers the subset the sandbox shim exposes: open/create-store, put/get,
 * per-store key isolation, delete, clear and deleteDatabase. Paths are hashed
 * from character/database names, so a traversal-looking name stays inside the
 * supplied root.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearIdbStore,
  createIdbStore,
  deleteIdbDatabase,
  deleteIdbRecord,
  getIdbRecord,
  openIdbDatabase,
  putIdbRecordFromFile,
} from '../src/index.js'

const CHARACTER = 'Idb Probe'
const DATABASE = 'card-cache'
let root = ''
let temporarySeq = 0

function temporaryFile(content: string): string {
  temporarySeq += 1
  const path = join(root, `staged-${temporarySeq}.bin`)
  writeFileSync(path, content)
  return path
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-idb-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('host-backed virtual IndexedDB', () => {
  it('opens, creates stores and round-trips records with metadata', async () => {
    const opened = await openIdbDatabase(root, CHARACTER, DATABASE, 1)
    expect(opened).toMatchObject({ version: 1, previousVersion: 0, stores: [] })
    await createIdbStore(root, CHARACTER, DATABASE, 'records', 'key')
    const again = await openIdbDatabase(root, CHARACTER, DATABASE, 1)
    expect(again).toMatchObject({ version: 1, previousVersion: 1, stores: ['records'] })

    const put = await putIdbRecordFromFile(
      root,
      CHARACTER,
      DATABASE,
      'records',
      'pack-1',
      temporaryFile('0123456789'),
      { sha256: 'abc', expiresAt: 99, note: 'meta' },
    )
    expect(put).toEqual({ key: 'pack-1', size: 10 })

    const record = await getIdbRecord(root, CHARACTER, DATABASE, 'records', 'pack-1')
    expect(record).toBeDefined()
    expect(record?.size).toBe(10)
    expect(record?.meta).toEqual({ sha256: 'abc', expiresAt: 99, note: 'meta' })
    expect(readFileSync(record?.path ?? '', 'utf8')).toBe('0123456789')
  })

  it('isolates the same key across stores and supports delete/clear', async () => {
    await createIdbStore(root, CHARACTER, DATABASE, 'second-store', 'key')
    await putIdbRecordFromFile(root, CHARACTER, DATABASE, 'records', 'same-key', temporaryFile('first'), {})
    await putIdbRecordFromFile(root, CHARACTER, DATABASE, 'second-store', 'same-key', temporaryFile('second'), {})
    const first = await getIdbRecord(root, CHARACTER, DATABASE, 'records', 'same-key')
    const second = await getIdbRecord(root, CHARACTER, DATABASE, 'second-store', 'same-key')
    expect(readFileSync(first?.path ?? '', 'utf8')).toBe('first')
    expect(readFileSync(second?.path ?? '', 'utf8')).toBe('second')

    expect(await deleteIdbRecord(root, CHARACTER, DATABASE, 'records', 'same-key')).toEqual({ deleted: true })
    expect(await getIdbRecord(root, CHARACTER, DATABASE, 'records', 'same-key')).toBeUndefined()
    expect(await getIdbRecord(root, CHARACTER, DATABASE, 'second-store', 'same-key')).toBeDefined()

    expect(await clearIdbStore(root, CHARACTER, DATABASE, 'second-store')).toEqual({ cleared: 1 })
    expect(await getIdbRecord(root, CHARACTER, DATABASE, 'second-store', 'same-key')).toBeUndefined()
  })

  it('rejects unknown stores, oversized-looking names and deletes whole databases', async () => {
    await expect(putIdbRecordFromFile(root, CHARACTER, DATABASE, 'missing', 'k', temporaryFile('x'), {})).rejects.toThrow('does not exist')
    await expect(openIdbDatabase(root, CHARACTER, '', 1)).rejects.toThrow('non-empty')
    await expect(openIdbDatabase(root, CHARACTER, 'x'.repeat(257), 1)).rejects.toThrow('too long')
    expect(await deleteIdbDatabase(root, CHARACTER, DATABASE)).toEqual({ deleted: true })
    expect(await getIdbRecord(root, CHARACTER, DATABASE, 'records', 'pack-1')).toBeUndefined()
  })
})
