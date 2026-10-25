/**
 * Host-backed virtual IndexedDB: real filesystem integration.
 *
 * The root is explicit so the library cannot silently depend on plugin globals.
 * Covers the subset the sandbox shim exposes: open/create-store, put/get,
 * per-store key isolation, delete, clear and deleteDatabase. Paths are hashed
 * from character/database names, so a traversal-looking name stays inside the
 * supplied root.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearIdbStore,
  createIdbStore,
  deleteIdbDatabase,
  deleteIdbRecord,
  getIdbRecord,
  listIdbKeys,
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function databasePath(character: string, database: string): string {
  return join(root, 'frontend-idb', sha256(character), sha256(database))
}

function tempLeftovers(directory: string): string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))
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
    await createIdbStore(root, CHARACTER, DATABASE, 'records', 'key', {
      byChat: { keyPath: 'chatId', unique: false, multiEntry: false },
    })
    const again = await openIdbDatabase(root, CHARACTER, DATABASE, 1)
    expect(again).toMatchObject({ version: 1, previousVersion: 1, stores: ['records'] })
    expect(again.storeKeyPaths).toEqual({ records: 'key' })
    expect(again.storeIndexes).toEqual({
      records: { byChat: { keyPath: 'chatId', unique: false, multiEntry: false } },
    })

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
    expect(await listIdbKeys(root, CHARACTER, DATABASE, 'records')).toEqual({ keys: ['pack-1', 'same-key'] })

    expect(await deleteIdbRecord(root, CHARACTER, DATABASE, 'records', 'same-key')).toEqual({ deleted: true })
    expect(await getIdbRecord(root, CHARACTER, DATABASE, 'records', 'same-key')).toBeUndefined()
    expect(await listIdbKeys(root, CHARACTER, DATABASE, 'records')).toEqual({ keys: ['pack-1'] })
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

  it('replaces meta.json by rename: repeated writes stay readable and leave no temp file', async () => {
    const database = 'atomic-meta'
    for (let version = 1; version <= 5; version += 1) {
      const opened = await openIdbDatabase(root, CHARACTER, database, version)
      expect(opened.version).toBe(version)
    }
    const dir = databasePath(CHARACTER, database)
    expect(tempLeftovers(dir)).toEqual([])
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { name: string; version: number }
    expect(meta).toMatchObject({ name: database, version: 5 })
  })

  it('overwrites an existing record slot in place without staging leftovers', async () => {
    const database = 'record-replace'
    await openIdbDatabase(root, CHARACTER, database, 1)
    await createIdbStore(root, CHARACTER, database, 'records', 'key')
    await putIdbRecordFromFile(root, CHARACTER, database, 'records', 'k', temporaryFile('first'), {})
    const replaced = await putIdbRecordFromFile(root, CHARACTER, database, 'records', 'k', temporaryFile('second'), {})
    expect(replaced).toEqual({ key: 'k', size: 6 })
    const record = await getIdbRecord(root, CHARACTER, database, 'records', 'k')
    expect(readFileSync(record?.path ?? '', 'utf8')).toBe('second')
    expect(tempLeftovers(join(databasePath(CHARACTER, database), 'records'))).toEqual([])
  })

  // EXDEV needs the staging file and the data root on different devices, which
  // cannot be arranged deterministically in CI (no drive/mount control here).
  // The same-device rename paths above run for real; the cross-device branch in
  // src/idb-store.ts is intentionally not exercised with mocks.
})
