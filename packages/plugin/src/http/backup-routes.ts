// Whole-library backup and restore (contract 2026-11-12 Wave 2 §3).
//
// `GET export/backup` packs the live data root into one zip: the asset
// directories, the chat files, the two state slices and a `manifest.json` with
// per-file sizes and SHA-256 digests. `POST import/backup` restores such a zip
// in `merge` (never overwrites) or `replace` (overwrites, after snapshotting the
// current root into `backup-before-restore-<timestamp>/`).
//
// The root is enumerated instead of naming files one by one: root-level `.json`
// files are discovered by listing, so `state.json` and the two state slices
// (packages/tavern-store/src/store.ts) are picked up by position, and a rename in
// the store cannot silently drop one from a backup. Nothing outside the data
// root is ever packed, and a restored entry only lands on a path this module
// accepts (see `isLibraryPath`), so a hostile archive cannot write elsewhere.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  unzipArchive,
  ZipArchiveError,
  zipArchive,
  zipEntryPathProblem,
  ZipLimitError,
  type ZipLimits,
} from '../../../tavern-format/src/index.js'
import { writeAtomicBytes } from '../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

/** Marker the manifest carries; a foreign zip is not a library backup. */
const BACKUP_FORMAT = 'soulmojito-backup'
const BACKUP_FORMAT_VERSION = 1
const MANIFEST_FILE = 'manifest.json'
const SNAPSHOT_PREFIX = 'backup-before-restore-'
/** Root-level files that belong to the library. */
const ROOT_FILE_SUFFIX = /\.json$/i
/**
 * Directories copied verbatim. Anything else at the root (workspace scratch
 * dirs, mod state, prior snapshots) is not library data and stays out of both
 * the archive and the pre-restore snapshot.
 */
const LIBRARY_DIRECTORIES = [
  'characters',
  'worlds',
  'presets',
  'personas',
  'groups',
  'chats',
  'data-bank',
] as const
/** Default bound on the archive a restore accepts (decoded bytes). */
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024
/**
 * Archive bounds for library data: thousands of chat files, up to 64 MiB per
 * file and 512 MiB in total. The CHARX/EPUB defaults (256 entries, 128 MiB)
 * would reject any real library.
 */
const DEFAULT_BACKUP_ZIP_LIMITS: ZipLimits = {
  maxEntries: 8192,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
}

export type BackupImportMode = 'merge' | 'replace'

/**
 * The only store capability this module needs: `TavernStore.getState()` awaits
 * the mutation tail, which is how a backup avoids packing a half-applied patch
 * (slices written, state.json not yet committed) and how a restore waits for an
 * in-flight write before renaming files underneath it.
 */
export interface BackupStoreHandle {
  getState(): Promise<unknown>
}

export interface BackupRouteOptions {
  /** Data root; defaults to `tavernDataRoot()` resolved per call. */
  root?: string
  /** Entry/per-file/total bounds for the archive in either direction. */
  zipLimits?: ZipLimits
  /** Bound on the decoded archive a restore accepts. */
  maxSourceBytes?: number
  /**
   * Write seam. Production uses the store's tmp+rename writer; tests inject one
   * to prove a mid-restore failure still reports the snapshot it created.
   */
  writeFile?: (target: string, bytes: Uint8Array) => Promise<void>
}

/** Restore receipt: `snapshot` is the directory name created before a replace. */
export interface BackupImportReport {
  ok: true
  mode: BackupImportMode
  imported: number
  skipped: number
  conflicts: number
  rejected: number
  files: number
  snapshot: string | null
}

interface ManifestEntry {
  path: string
  bytes: number
  sha256: string
}

interface BackupManifest {
  format: string
  version: number
  createdAt: string
  files: number
  totalBytes: number
  entries: ManifestEntry[]
}

/** `GET export/backup`: the whole data root as `application/zip`. */
export async function handleBackupExportRoute(
  host: BackupStoreHandle,
  res: HttpResponse,
  options?: BackupRouteOptions,
): Promise<void> {
  const root = options?.root ?? tavernDataRoot()
  const limits = options?.zipLimits ?? DEFAULT_BACKUP_ZIP_LIMITS
  // Drain pending writes first: a patch is committed slice-then-state, and the
  // pack must not straddle that commit.
  await host.getState()

  const encoded = new TextEncoder()
  const entries: Record<string, Uint8Array> = {}
  const manifestEntries: ManifestEntry[] = []
  let totalBytes = 0
  for (const relative of await listLibraryFiles(root)) {
    const bytes = await readBounded(path.join(root, relative), relative, limits)
    totalBytes += bytes.byteLength
    if (totalBytes > limits.maxTotalBytes) {
      throw new HttpError(413, `library exceeds the ${limits.maxTotalBytes}-byte backup total limit at '${relative}'`)
    }
    entries[relative] = bytes
    manifestEntries.push({
      path: relative,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  if (manifestEntries.length + 1 > limits.maxEntries) {
    throw new HttpError(413, `library has ${manifestEntries.length} files, over the ${limits.maxEntries}-entry backup limit`)
  }
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    files: manifestEntries.length,
    totalBytes,
    entries: manifestEntries,
  }
  const manifestBytes = encoded.encode(JSON.stringify(manifest, null, 2))
  if (totalBytes + manifestBytes.byteLength > limits.maxTotalBytes) {
    throw new HttpError(413, `library plus manifest exceeds the ${limits.maxTotalBytes}-byte backup total limit`)
  }
  entries[MANIFEST_FILE] = manifestBytes

  const bytes = zipArchive(entries, limits)
  const fileName = `soulmojito-backup-${timestampToken()}.zip`
  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-length', String(bytes.byteLength))
  res.setHeader('content-disposition', `attachment; filename="${fileName}"`)
  res.end(Buffer.from(bytes))
}

/**
 * `POST import/backup` `{ zipBase64, mode }`.
 *
 * `merge` leaves every file that already exists alone and reports the ones that
 * differ as `conflicts`; `replace` overwrites them after snapshotting the whole
 * root. Both modes skip byte-identical files. Entry names are validated before
 * anything is written: an absolute path, a `..` segment, a path outside the
 * library layout or a symlinked parent is a 400, never a silent skip.
 */
export async function handleBackupImportRoute(
  host: BackupStoreHandle,
  req: HttpRequest,
  res: HttpResponse,
  options?: BackupRouteOptions,
): Promise<void> {
  const root = options?.root ?? tavernDataRoot()
  const limits = options?.zipLimits ?? DEFAULT_BACKUP_ZIP_LIMITS
  const maxSourceBytes = options?.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  // The JSON envelope only adds a `{"zipBase64":"…","mode":"…"}` wrapper around
  // the base64 text, so the body bound is the encoded archive plus slack.
  const body = await readJson(req, Math.ceil(maxSourceBytes / 3) * 4 + 64 * 1024)
  const mode = body.mode
  if (mode !== 'merge' && mode !== 'replace') {
    throw new HttpError(400, "expected { zipBase64, mode: 'merge' | 'replace' }")
  }
  if (typeof body.zipBase64 !== 'string' || body.zipBase64 === '') {
    throw new HttpError(400, 'zipBase64 must be a non-empty base64 string')
  }
  const files = unzipBackup(decodeBase64Archive(body.zipBase64, maxSourceBytes), limits)

  const restorable: string[] = []
  let rejected = 0
  for (const name of Object.keys(files).sort()) {
    // Directory entries carry no payload and no meaning for a restore.
    if (name.endsWith('/')) continue
    const problem = zipEntryPathProblem(name)
    if (problem !== undefined) {
      throw new HttpError(400, `backup entry '${displayEntryName(name)}' ${problem}`)
    }
    // The manifest describes the archive, not the library: restoring it into the
    // root would make it a root `.json` for the next export. It is not a
    // rejection, so it is skipped before the count.
    if (name === MANIFEST_FILE) continue
    // Skip unknown areas rather than fail the whole restore: a newer backup may
    // carry data this build does not know yet, and the count is reported.
    if (!isLibraryPath(name)) {
      rejected += 1
      continue
    }
    if (!name.includes('/') && ROOT_FILE_SUFFIX.test(name)) assertJsonEntry(name, files[name])
    restorable.push(name)
  }

  // Pre-flight every target before the first write: a symlinked parent or a
  // non-directory ancestor is a caller mistake (400), not a mid-restore failure.
  for (const relative of restorable) await assertLibraryTarget(root, relative)

  await host.getState()
  let snapshot: string | null = null
  if (mode === 'replace') {
    try {
      snapshot = await snapshotLibrary(root)
    } catch (cause) {
      throw new HttpError(500, `restore snapshot failed, no files were changed: ${describeWriteFailure(cause)}`)
    }
  }

  let imported = 0
  let skipped = 0
  let conflicts = 0
  try {
    for (const relative of restorable) {
      const bytes = files[relative]
      if (bytes === undefined) continue
      const target = path.join(root, relative)
      const existing = await readExisting(target)
      if (existing !== undefined && existing.equals(bytes)) {
        skipped += 1
        continue
      }
      if (existing !== undefined && mode === 'merge') {
        conflicts += 1
        continue
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      // tmp+rename keeps a reader (the store's fingerprint cache) from seeing a
      // half-written file, and a same-size replacement still lands a new inode.
      await (options?.writeFile ?? writeAtomicBytes)(target, bytes)
      imported += 1
    }
  } catch (cause) {
    // The snapshot name has to reach the caller: without it a partial replace
    // cannot be undone from the panel.
    throw new HttpError(500, snapshot === null
      ? `restore failed: ${describeWriteFailure(cause)}`
      : `restore failed after creating snapshot '${snapshot}': ${describeWriteFailure(cause)}`)
  }

  const report: BackupImportReport = {
    ok: true,
    mode,
    imported,
    skipped,
    conflicts,
    rejected,
    files: restorable.length,
    snapshot,
  }
  return sendJson(res, 200, report)
}

/* ------------------------------ export ------------------------------ */

/**
 * Library files under `root`, as `/`-separated relative paths, sorted.
 *
 * Symbolic links are skipped in both directions (never packed, never followed):
 * a link can point outside the root, and a backup that follows one both leaks
 * that file and makes the restore write through it. Editor/atomic-write
 * leftovers (`.tmp`, dotfiles) are skipped for the same reason: they are not
 * library data.
 */
async function listLibraryFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const rootEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || entry.name === MANIFEST_FILE) continue
    if (!ROOT_FILE_SUFFIX.test(entry.name)) continue
    files.push(entry.name)
  }
  for (const directory of LIBRARY_DIRECTORIES) await walkLibraryDirectory(root, directory, files)
  return files.sort()
}

async function walkLibraryDirectory(root: string, relative: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      await walkLibraryDirectory(root, child, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue
    out.push(child)
  }
}

async function readBounded(file: string, relative: string, limits: ZipLimits): Promise<Uint8Array> {
  // Stat first so an oversized file is refused before it is loaded, then check
  // the bytes actually read: the file may grow between the two calls.
  const stat = await fs.stat(file)
  if (stat.size > limits.maxFileBytes) {
    throw new HttpError(413, `'${relative}' is ${stat.size} bytes, over the ${limits.maxFileBytes}-byte per-file backup limit`)
  }
  const bytes = new Uint8Array(await fs.readFile(file))
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new HttpError(413, `'${relative}' is ${bytes.byteLength} bytes, over the ${limits.maxFileBytes}-byte per-file backup limit`)
  }
  return bytes
}

/* ------------------------------ import ------------------------------ */

function unzipBackup(bytes: Uint8Array, limits: ZipLimits): Record<string, Uint8Array> {
  try {
    return unzipArchive(bytes, limits)
  } catch (cause) {
    if (cause instanceof ZipLimitError) throw new HttpError(413, cause.message)
    if (cause instanceof ZipArchiveError) throw new HttpError(400, cause.message)
    throw cause
  }
}

/**
 * Decode the request payload. The base64 gate runs before decoding: a
 * `zipBase64` longer than the source bound cannot decode to a smaller archive,
 * so the 413 needs no allocation.
 */
function decodeBase64Archive(value: string, maxSourceBytes: number): Uint8Array {
  const payload = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const maxCharacters = Math.ceil(maxSourceBytes / 3) * 4
  if (payload.length > maxCharacters) {
    throw new HttpError(413, `backup archive is larger than the ${maxSourceBytes}-byte source limit`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new HttpError(400, 'zipBase64 is not valid base64')
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
  if (bytes.byteLength > maxSourceBytes) {
    throw new HttpError(413, `backup archive is larger than the ${maxSourceBytes}-byte source limit`)
  }
  return bytes
}

/**
 * True when the entry lands inside the library layout: a root-level `.json`
 * file or a path under one of `LIBRARY_DIRECTORIES`.
 */
function isLibraryPath(name: string): boolean {
  const slash = name.indexOf('/')
  if (slash < 0) return ROOT_FILE_SUFFIX.test(name)
  return (LIBRARY_DIRECTORIES as readonly string[]).includes(name.slice(0, slash))
}

/** Root-level state files are machine-written JSON; a corrupt one must not land. */
function assertJsonEntry(name: string, bytes: Uint8Array | undefined): void {
  if (bytes === undefined) return
  try {
    JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(400, `backup entry '${displayEntryName(name)}' is not valid JSON`)
  }
}

/**
 * Reject a target whose parents (or itself) are outside the root or are links.
 * `relative` has already passed `zipEntryPathProblem`, so no `..` remains and
 * the resolve below only has to confirm containment.
 */
async function assertLibraryTarget(root: string, relative: string): Promise<void> {
  const rootResolved = path.resolve(root)
  const absolute = path.resolve(rootResolved, relative)
  if (absolute === rootResolved || !absolute.startsWith(`${rootResolved}${path.sep}`)) {
    throw new HttpError(400, `backup entry '${displayEntryName(relative)}' resolves outside the data root`)
  }
  let cursor = rootResolved
  const segments = relative.split('/')
  // Every ancestor must either not exist yet or be a real directory.
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment)
    const stat = await fs.lstat(cursor).catch(() => undefined)
    if (stat === undefined) break
    if (stat.isSymbolicLink()) {
      throw new HttpError(400, `backup entry '${displayEntryName(relative)}' has a symlinked parent directory`)
    }
    if (!stat.isDirectory()) {
      throw new HttpError(400, `backup entry '${displayEntryName(relative)}' passes through a non-directory path`)
    }
  }
  const existing = await fs.lstat(absolute).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    throw new HttpError(400, `backup entry '${displayEntryName(relative)}' is a symlink`)
  }
  if (existing?.isDirectory()) {
    throw new HttpError(400, `backup entry '${displayEntryName(relative)}' collides with a directory`)
  }
}

async function readExisting(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file)
  } catch {
    return undefined
  }
}

/**
 * Copy the library into `backup-before-restore-<timestamp>/` (same directory
 * layout, no manifest, no nested snapshots). Created before the first write of a
 * replace, so a failed restore always has a rollback source.
 */
async function snapshotLibrary(root: string): Promise<string> {
  const name = await uniqueSnapshotName(root, `${SNAPSHOT_PREFIX}${timestampToken()}`)
  const target = path.join(root, name)
  await fs.mkdir(target, { recursive: true })
  // Listing happens after the directory exists; `backup-before-restore-*` is
  // neither a library directory nor a root `.json`, so it cannot recurse.
  for (const relative of await listLibraryFiles(root)) {
    const to = path.join(target, relative)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(path.join(root, relative), to)
  }
  return name
}

async function uniqueSnapshotName(root: string, base: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`
    if ((await fs.lstat(path.join(root, name)).catch(() => undefined)) === undefined) return name
  }
}

/** `2026-11-12T05-04-03-123Z`: sortable, and valid as a Windows directory name. */
function timestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Echo of an entry name in a 4xx body: the name is caller-supplied, so keep it
 * to characters a library path can contain and bound its length.
 */
function displayEntryName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._/-]+/g, '?')
  return cleaned.length > 96 ? `${cleaned.slice(0, 96)}…` : cleaned
}

/** Redacted filesystem failure for a response body (never an absolute path). */
function describeWriteFailure(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause
    && typeof cause.code === 'string' && /^E[A-Z]+$/.test(cause.code)) {
    return `filesystem error ${cause.code}`
  }
  return 'filesystem write failed'
}
