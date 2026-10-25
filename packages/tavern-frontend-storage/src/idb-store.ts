/**
 * Host-backed virtual IndexedDB (2026-10-22).
 *
 * Sandboxed card frontends have an opaque origin, so the browser's IndexedDB is
 * unavailable (and enabling allow-same-origin would expose the host DOM/cookies).
 * This module stores the small IndexedDB surface the bridge exposes under a
 * caller-supplied data root (the plugin passes its tavern root):
 *
 *   <root>/frontend-idb/<sha256(character)>/<sha256(database)>/
 *     meta.json                  version + stores + record descriptors
 *     records/<sha256(key)>.bin  raw ArrayBuffer payload
 *
 * Names are always hashed, so a card cannot escape its directory. Records are
 * written to a temp file and renamed atomically (cross-device staging falls
 * back to copy + fsync); metadata is replaced by a same-directory rename so a
 * crash keeps the previous meta.json. Metadata writes are serialized per
 * database. Quotas are per record and per character, not global.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const IDB_MAX_RECORD_BYTES = 1024 * 1024 * 1024
export const IDB_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

export interface IdbIndexDescriptor {
  keyPath: string
  unique: boolean
  multiEntry: boolean
}

export interface IdbStoreDescriptor {
  keyPath: string
  indexes: Record<string, IdbIndexDescriptor>
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
  storeKeyPaths: Record<string, string>
  storeIndexes: Record<string, Record<string, IdbIndexDescriptor>>
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

function databaseDir(root: string, character: string, name: string): string {
  return join(root, 'frontend-idb', sha256(character), sha256(name))
}

function recordKeyHash(store: string, key: string): string {
  return sha256(`${store}\u0000${key}`)
}

function recordPath(root: string, character: string, name: string, store: string, key: string): string {
  return join(databaseDir(root, character, name), 'records', `${recordKeyHash(store, key)}.bin`)
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

function normalizeIndexes(value: unknown): Record<string, IdbIndexDescriptor> {
  const indexes: Record<string, IdbIndexDescriptor> = {}
  const record = asRecord(value)
  if (record === undefined) return indexes
  for (const [indexName, descriptor] of Object.entries(record)) {
    const entry = asRecord(descriptor)
    if (entry === undefined || typeof entry.keyPath !== 'string' || entry.keyPath.trim() === '') continue
    indexes[indexName] = {
      keyPath: entry.keyPath,
      unique: entry.unique === true,
      multiEntry: entry.multiEntry === true,
    }
  }
  return indexes
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
      stores[storeName] = {
        keyPath: typeof entry.keyPath === 'string' ? entry.keyPath : '',
        indexes: normalizeIndexes(entry.indexes),
      }
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

async function readDatabase(root: string, character: string, name: string): Promise<IdbDatabaseDescriptor> {
  const dir = databaseDir(root, character, name)
  try {
    const text = await readFile(metaPath(dir), 'utf8')
    return normalizeDatabase(JSON.parse(text) as unknown, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase(name)
    throw new Error(`idb metadata for '${name}' is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let temporarySeq = 0

/** Unique sibling temp name; same directory as the target, so rename stays on-device. */
function temporarySibling(target: string): string {
  temporarySeq += 1
  return `${target}.${process.pid}.${Date.now()}.${temporarySeq}.tmp`
}

/** Flush file content before publishing it with rename (rename only orders names). */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Publish `source` at `target` with rename. POSIX rename replaces atomically; a
 * Windows handle on the target can make rename fail (EPERM/EACCES/EBUSY/EEXIST),
 * and only then is remove + rename the recovery path (it leaves a small window
 * where the target is absent, unlike the rename-only path).
 */
async function renameReplacing(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') throw error
    await rm(target, { force: true })
    await rename(source, target)
  }
}

function describeFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === undefined ? error.message : `${code}: ${error.message}`
  }
  return String(error)
}

async function writeDatabase(root: string, character: string, database: IdbDatabaseDescriptor): Promise<void> {
  const dir = databaseDir(root, character, database.name)
  await mkdir(dir, { recursive: true })
  const target = metaPath(dir)
  const temporary = temporarySibling(target)
  try {
    await writeFile(temporary, `${JSON.stringify(database)}`, 'utf8')
    await syncFile(temporary)
    await renameReplacing(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function withDatabaseLock<T>(root: string, character: string, name: string, operation: () => Promise<T>): Promise<T> {
  const key = `${root}\u0000${character}\u0000${name}`
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
  root: string,
  character: string,
  value: unknown,
  versionValue: unknown,
): Promise<IdbOpenResult> {
  const name = requireDatabaseName(value)
  const requested = typeof versionValue === 'number' && Number.isInteger(versionValue) && versionValue > 0
    ? versionValue
    : 1
  return withDatabaseLock(root, character, name, async () => {
    const database = await readDatabase(root, character, name)
    const previousVersion = database.version
    if (database.version === 0) database.version = requested
    else if (requested > database.version) database.version = requested
    database.updatedAt = Date.now()
    await writeDatabase(root, character, database)
    return {
      version: database.version,
      previousVersion,
      stores: Object.keys(database.stores),
      storeKeyPaths: Object.fromEntries(Object.entries(database.stores).map(([name, descriptor]) => [name, descriptor.keyPath])),
      storeIndexes: Object.fromEntries(Object.entries(database.stores).map(([name, descriptor]) => [name, descriptor.indexes])),
    }
  })
}

/** Create an object store descriptor (idempotent for the same name). */
export async function createIdbStore(
  root: string,
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyPathValue: unknown,
  indexesValue?: unknown,
): Promise<{ stores: string[]; indexes: Record<string, IdbIndexDescriptor> }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const keyPath = typeof keyPathValue === 'string' ? keyPathValue : ''
  const indexes = normalizeIndexes(indexesValue)
  return withDatabaseLock(root, character, name, async () => {
    const database = await readDatabase(root, character, name)
    database.stores[store] = { keyPath, indexes }
    database.updatedAt = Date.now()
    await writeDatabase(root, character, database)
    return { stores: Object.keys(database.stores), indexes }
  })
}

/**
 * Move the caller's staged upload into its record slot. A same-device rename is
 * atomic. EXDEV (staging in os.tmpdir() tmpfs, or a data root on another drive)
 * falls back to copy + fsync in the destination directory, rename there, then
 * unlink the source; the source survives until the destination is published.
 */
async function moveRecordFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      await copyRecordAcrossDevices(source, destination)
      return
    }
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
      throw new Error(`idb record could not be moved to '${destination}': ${describeFsError(error)}`)
    }
  }
  try {
    await renameReplacing(source, destination)
  } catch (error) {
    throw new Error(`idb record could not be moved to '${destination}': ${describeFsError(error)}`)
  }
}

async function copyRecordAcrossDevices(source: string, destination: string): Promise<void> {
  const staged = temporarySibling(destination)
  try {
    await copyFile(source, staged)
    await syncFile(staged)
    await renameReplacing(staged, destination)
  } catch (error) {
    await rm(staged, { force: true })
    throw new Error(
      `idb record could not be copied from '${source}' to '${destination}' after a cross-device rename failed (EXDEV): ${describeFsError(error)}`,
    )
  }
  await rm(source, { force: true })
}

/** Move a temp upload into the record slot and update metadata. */
export async function putIdbRecordFromFile(
  root: string,
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
  const destination = recordPath(root, character, name, store, key)
  return withDatabaseLock(root, character, name, async () => {
    const database = await readDatabase(root, character, name)
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
    await moveRecordFile(temporaryPath, destination)
    database.records[keyHash] = { store, key, size, updatedAt: Date.now(), meta }
    database.updatedAt = Date.now()
    try {
      await writeDatabase(root, character, database)
    } catch (error) {
      await rm(destination, { force: true })
      throw error
    }
    return { key, size }
  })
}

/** List keys in a store (backs the virtual IndexedDB `getAll` / `getAllKeys`). */
export async function listIdbKeys(
  root: string,
  character: string,
  nameValue: unknown,
  storeValue: unknown,
): Promise<{ keys: string[] }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const database = await readDatabase(root, character, name)
  if (database.stores[store] === undefined) return { keys: [] }
  return {
    keys: Object.values(database.records)
      .filter((record) => record.store === store)
      .map((record) => record.key),
  }
}

/** Resolve a record file for the binary GET route. */
export async function getIdbRecord(
  root: string,
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyValue: unknown,
): Promise<IdbRecordFile | undefined> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const key = requireKey(keyValue)
  const database = await readDatabase(root, character, name)
  if (database.stores[store] === undefined) return undefined
  const record = database.records[recordKeyHash(store, key)]
  if (record === undefined || record.store !== store) return undefined
  const path = recordPath(root, character, name, store, key)
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
  root: string,
  character: string,
  nameValue: unknown,
  storeValue: unknown,
  keyValue: unknown,
): Promise<{ deleted: boolean }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  const key = requireKey(keyValue)
  const keyHash = recordKeyHash(store, key)
  return withDatabaseLock(root, character, name, async () => {
    const database = await readDatabase(root, character, name)
    if (database.stores[store] === undefined) return { deleted: false }
    const record = database.records[keyHash]
    const existed = record !== undefined && record.store === store
    delete database.records[keyHash]
    database.updatedAt = Date.now()
    await writeDatabase(root, character, database)
    await rm(recordPath(root, character, name, store, key), { force: true })
    return { deleted: existed }
  })
}

export async function clearIdbStore(
  root: string,
  character: string,
  nameValue: unknown,
  storeValue: unknown,
): Promise<{ cleared: number }> {
  const name = requireDatabaseName(nameValue)
  const store = requireStoreName(storeValue)
  return withDatabaseLock(root, character, name, async () => {
    const database = await readDatabase(root, character, name)
    if (database.stores[store] === undefined) return { cleared: 0 }
    const entries = Object.entries(database.records).filter(([, record]) => record.store === store)
    for (const [keyHash] of entries) delete database.records[keyHash]
    database.updatedAt = Date.now()
    await writeDatabase(root, character, database)
    await Promise.all(entries.map(([, record]) => rm(recordPath(root, character, name, store, record.key), { force: true })))
    return { cleared: entries.length }
  })
}

export async function deleteIdbDatabase(root: string, character: string, nameValue: unknown): Promise<{ deleted: boolean }> {
  const name = requireDatabaseName(nameValue)
  const directory = databaseDir(root, character, name)
  let existed = false
  try {
    existed = (await stat(directory)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rm(directory, { recursive: true, force: true })
  return { deleted: existed }
}
