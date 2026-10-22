/**
 * Host-backed virtual IndexedDB (2026-10-22).
 *
 * Sandboxed card frontends have an opaque origin, so the browser's IndexedDB is
 * unavailable (and enabling allow-same-origin would expose the host DOM/cookies).
 * This module stores the small IndexedDB surface the bridge exposes under the
 * plugin data root instead:
 *
 *   <tavern root>/frontend-idb/<sha256(character)>/<sha256(database)>/
 *     meta.json                  version + stores + record descriptors
 *     records/<sha256(key)>.bin  raw ArrayBuffer payload
 *
 * Names are always hashed, so a card cannot escape its directory. Records are
 * written to a temp file and renamed atomically; metadata writes are serialized
 * per database. Quotas are per record and per character, not global.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tavernDataRoot } from './dsh-home.js'

export const IDB_MAX_RECORD_BYTES = 1024 * 1024 * 1024
export const IDB_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

export interface IdbStoreDescriptor {
  keyPath: string
}

export interface IdbRecordDescriptor {
  store: string
  key: string
  size: number
  updatedAt: number
  meta: Record<string, unknown>
}

export interface IdbDatabaseDescriptor {
  name: string
  version: number
  stores: Record<string, IdbStoreDescriptor>
  records: Record<string, IdbRecordDescriptor>
  updatedAt: number
}

export interface IdbOpenResult {
  version: number
  previousVersion: number
  stores: string[]
}

export interface IdbRecordFile {
  path: string
  size: number
  meta: Record<string, unknown>
}

const databaseLocks = new Map<string, Promise<unknown>>()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function databaseDir(character: string, name: string): string {
  return join(tavernDataRoot(), 'frontend-idb', sha256(character), sha256(name))
}

function recordKeyHash(store: string, key: string): string {
  return sha256(`${store}\u0000${key}`)
}

function recordPath(character: string, name: string, store: string, key: string): string {
  return join(databaseDir(character, name), 'records', `${recordKeyHash(store, key)}.bin`)
}

function metaPath(dir: string): string {
  return join(dir, 'meta.json')
}

function emptyDatabase(name: string): IdbDatabaseDescriptor {
  return { name, version: 0, stores: {}, records: {}, updatedAt: 0 }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeDatabase(value: unknown, name: string): IdbDatabaseDescriptor {
  const record = asRecord(value)
  if (record === undefined) return emptyDatabase(name)
  const stores: Record<string, IdbStoreDescriptor> = {}
  const rawStores = asRecord(record.stores)
  if (rawStores !== undefined) {
    for (const [storeName, descriptor] of Object.entries(rawStores)) {
      const entry = asRecord(descriptor)
      if (entry === undefined) continue
      stores[storeName] = { keyPath: typeof entry.keyPath === 'string' ? entry.keyPath : '' }
    }
  }
  const records: Record<string, IdbRecordDescriptor> = {}
  const rawRecords = asRecord(record.records)
  if (rawRecords !== undefined) {
    for (const [keyHash, descriptor] of Object.entries(rawRecords)) {
      const entry = asRecord(descriptor)
      if (entry === undefined) continue
      if (typeof entry.key !== 'string' || typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) continue
      records[keyHash] = {
        store: typeof entry.store === 'string' ? entry.store : '',
        key: entry.key,
        size: entry.size,
        updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        meta: asRecord(entry.meta) ?? {},
      }
    }
  }
  return {
    name,
    version: typeof record.version === 'number' && Number.isInteger(record.version) && record.version >= 0 ? record.version : 0,
    stores,
    records,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

async function readDatabase(character: string, name: string): Promise<IdbDatabaseDescriptor> {
  const dir = databaseDir(character, name)
  try {
    const text = await readFile(metaPath(dir), 'utf8')
    return normalizeDatabase(JSON.parse(text) as unknown, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase(name)
    throw new Error(`idb metadata for '${name}' is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeDatabase(character: string, database: IdbDatabaseDescriptor): Promise<void> {
  const dir = databaseDir(character, database.name)
  await mkdir(dir, { recursive: true })
  const target = metaPath(dir)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(database)}`, 'utf8')
  await rm(target, { force: true })
  await rename(temporary, target)
}

function withDatabaseLock<T>(character: string, name: string, operation: () => Promise<T>): Promise<T> {
  const key = `${character}\u0000${name}`
  const previous = databaseLocks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  databaseLocks.set(key, next)
  return next.finally(() => {
    if (databaseLocks.get(key) === next) databaseLocks.delete(key)
  })
}

function requireDatabaseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('idb database name must be a non-empty string')
  if (value.length > 256) throw new Error('idb database name is too long (max 256)')
  return value
}

function requireStoreName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('idb store name must be a non-empty string')
  if (value.length > 256) throw new Error('idb store name is too long (max 256)')
  return value
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('idb record key must be a string or number')
  const key = String(value)
  if (key.length === 0) throw new Error('idb record key must not be empty')
  if (key.length > 1024) throw new Error('idb record key is too long (max 1024)')
  return key
}

function normalizeRecordMeta(value: unknown): Record<string, unknown> {
  const record = asRecord(value) ?? {}
  const text = JSON.stringify(record)
  if (text.length > 64 * 1024) throw new Error('idb record metadata is too large (max 64KB)')
  return record
}

function recordTotal(database: IdbDatabaseDescriptor, excludingKeyHash?: string): number {
  return Object.entries(database.records)
    .filter(([keyHash]) => keyHash !== excludingKeyHash)
    .reduce((sum, [, record]) => sum + record.size, 0)
}

/** Open (or create) a database. Returns the version before/after the request. */
export async function openIdbDatabase(
  character: string,
  value: unknown,
  versionValue: unknown,
): Promise<IdbOpenResult> {
  const name = requireDatabaseName(value)
  const requested = typeof versionValue === 'number' && Number.isInteger(versionValue) && versionValue > 0
    ? versionValue
    : 1
  return withDatabaseLock(character, name, async () => {
    const database = await readDatabase(character, name)
    const previousVersion = database.version
    if (database.version === 0) database.version = requested
    else if (requested > database.version) database.version = requested
    database.updatedAt = Date.now()
    await writeDatabase(character, database)
    return { version: database.version, previousVersion, stores: Object.keys(database.stores) }
  })
}

/** Create an object store descriptor (idempotent for the same name). */
export async function createIdbStore(
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyPathValue: unknown,
): Promise<{ stores: string[] }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const keyPath = typeof keyPathValue === 'string' ? keyPathValue : ''
  return withDatabaseLock(character, name, async () => {
    const database = await readDatabase(character, name)
    database.stores[store] = { keyPath }
    database.updatedAt = Date.now()
    await writeDatabase(character, database)
    return { stores: Object.keys(database.stores) }
  })
}

/** Move a temp upload into the record slot and update metadata. */
export async function putIdbRecordFromFile(
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyValue: unknown,
  temporaryPath: string,
  metaValue: unknown,
): Promise<{ key: string; size: number }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const key = requireKey(keyValue)
  const meta = normalizeRecordMeta(metaValue)
  const keyHash = recordKeyHash(store, key)
  const destination = recordPath(character, name, store, key)
  return withDatabaseLock(character, name, async () => {
    const database = await readDatabase(character, name)
    if (database.stores[store] === undefined) throw new Error(`idb store '${store}' does not exist in database '${name}'`)
    const size = (await stat(temporaryPath)).size
    if (size > IDB_MAX_RECORD_BYTES) {
      throw new Error(`idb record is too large (${size} > ${IDB_MAX_RECORD_BYTES} bytes)`)
    }
    const total = recordTotal(database, keyHash) + size
    if (total > IDB_MAX_TOTAL_BYTES) {
      throw new Error(`idb storage for '${character}' exceeds ${IDB_MAX_TOTAL_BYTES} bytes`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await rm(destination, { force: true })
    await rename(temporaryPath, destination)
    database.records[keyHash] = { store, key, size, updatedAt: Date.now(), meta }
    database.updatedAt = Date.now()
    try {
      await writeDatabase(character, database)
    } catch (error) {
      await rm(destination, { force: true })
      throw error
    }
    return { key, size }
  })
}

/** Resolve a record file for the binary GET route. */
export async function getIdbRecord(
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyValue: unknown,
): Promise<IdbRecordFile | undefined> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const key = requireKey(keyValue)
  const database = await readDatabase(character, name)
  if (database.stores[store] === undefined) return undefined
  const record = database.records[recordKeyHash(store, key)]
  if (record === undefined || record.store !== store) return undefined
  const path = recordPath(character, name, store, key)
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined
    return { path, size: info.size, meta: record.meta }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function deleteIdbRecord(
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyValue: unknown,
): Promise<{ deleted: boolean }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const key = requireKey(keyValue)
  const keyHash = recordKeyHash(store, key)
  return withDatabaseLock(character, name, async () => {
    const database = await readDatabase(character, name)
    if (database.stores[store] === undefined) return { deleted: false }
    const record = database.records[keyHash]
    const existed = record !== undefined && record.store === store
    delete database.records[keyHash]
    database.updatedAt = Date.now()
    await writeDatabase(character, database)
    await rm(recordPath(character, name, store, key), { force: true })
    return { deleted: existed }
  })
}

export async function clearIdbStore(
  character: string,
  nameValue: unknown,
  storeValue: unknown,
): Promise<{ cleared: number }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  return withDatabaseLock(character, name, async () => {
    const database = await readDatabase(character, name)
    if (database.stores[store] === undefined) return { cleared: 0 }
    const entries = Object.entries(database.records).filter(([, record]) => record.store === store)
    for (const [keyHash] of entries) delete database.records[keyHash]
    database.updatedAt = Date.now()
    await writeDatabase(character, database)
    await Promise.all(entries.map(([, record]) => rm(recordPath(character, name, store, record.key), { force: true })))
    return { cleared: entries.length }
  })
}

export async function deleteIdbDatabase(character: string, nameValue: unknown): Promise<{ deleted: boolean }> {
  const name = requireDatabaseName(nameValue)
  const directory = databaseDir(character, name)
  let existed = false
  try {
    existed = (await stat(directory)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rm(directory, { recursive: true, force: true })
  return { deleted: existed }
}
