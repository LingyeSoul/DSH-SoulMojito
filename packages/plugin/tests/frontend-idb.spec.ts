/**
 * Host-backed virtual IndexedDB: real filesystem integration (2026-10-22).
 *
 * Covers the subset the sandbox shim exposes: open/create-store, put/get,
 * per-store key isolation, delete, clear and deleteDatabase. Paths are hashed
 * from character/database names, so a traversal-looking name must stay inside
 * the plugin data root.
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
} from '../src/frontend-idb.js'

const CHARACTER = 'Idb Probe'
const DATABASE = 'card-cache'
let home = ''
let temporarySeq = 0

function temporaryFile(content: string): string {
  temporarySeq += 1
  const path = join(home, `staged-${temporarySeq}.bin`)
  writeFileSync(path, content)
  return path
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-idb-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('host-backed virtual IndexedDB', () => {
  it('opens, creates stores and round-trips records with metadata', async () => {
    const opened = await openIdbDatabase(CHARACTER, DATABASE, 1)
    expect(opened).toMatchObject({ version: 1, previousVersion: 0, stores: [] })
    await createIdbStore(CHARACTER, DATABASE, 'records', 'key')
    const again = await openIdbDatabase(CHARACTER, DATABASE, 1)
    expect(again).toMatchObject({ version: 1, previousVersion: 1, stores: ['records'] })

    const put = await putIdbRecordFromFile(
      CHARACTER,
      DATABASE,
      'records',
      'pack-1',
      temporaryFile('0123456789'),
      { sha256: 'abc', expiresAt: 99, note: 'meta' },
    )
    expect(put).toEqual({ key: 'pack-1', size: 10 })

    const record = await getIdbRecord(CHARACTER, DATABASE, 'records', 'pack-1')
    expect(record).toBeDefined()
    expect(record?.size).toBe(10)
    expect(record?.meta).toEqual({ sha256: 'abc', expiresAt: 99, note: 'meta' })
    expect(readFileSync(record?.path ?? '', 'utf8')).toBe('0123456789')
  })

  it('isolates the same key across stores and supports delete/clear', async () => {
    await createIdbStore(CHARACTER, DATABASE, 'second-store', 'key')
    await putIdbRecordFromFile(CHARACTER, DATABASE, 'records', 'same-key', temporaryFile('first'), {})
    await putIdbRecordFromFile(CHARACTER, DATABASE, 'second-store', 'same-key', temporaryFile('second'), {})
    const first = await getIdbRecord(CHARACTER, DATABASE, 'records', 'same-key')
    const second = await getIdbRecord(CHARACTER, DATABASE, 'second-store', 'same-key')
    expect(readFileSync(first?.path ?? '', 'utf8')).toBe('first')
    expect(readFileSync(second?.path ?? '', 'utf8')).toBe('second')

    expect(await deleteIdbRecord(CHARACTER, DATABASE, 'records', 'same-key')).toEqual({ deleted: true })
    expect(await getIdbRecord(CHARACTER, DATABASE, 'records', 'same-key')).toBeUndefined()
    expect(await getIdbRecord(CHARACTER, DATABASE, 'second-store', 'same-key')).toBeDefined()

    expect(await clearIdbStore(CHARACTER, DATABASE, 'second-store')).toEqual({ cleared: 1 })
    expect(await getIdbRecord(CHARACTER, DATABASE, 'second-store', 'same-key')).toBeUndefined()
  })

  it('rejects unknown stores, oversized-looking names and deletes whole databases', async () => {
    await expect(putIdbRecordFromFile(CHARACTER, DATABASE, 'missing', 'k', temporaryFile('x'), {})).rejects.toThrow('does not exist')
    await expect(openIdbDatabase(CHARACTER, '', 1)).rejects.toThrow('non-empty')
    await expect(openIdbDatabase(CHARACTER, 'x'.repeat(257), 1)).rejects.toThrow('too long')
    expect(await deleteIdbDatabase(CHARACTER, DATABASE)).toEqual({ deleted: true })
    expect(await getIdbRecord(CHARACTER, DATABASE, 'records', 'pack-1')).toBeUndefined()
  })
})
