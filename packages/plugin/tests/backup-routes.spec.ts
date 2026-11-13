/**
 * Whole-library backup/restore (Wave 2 contract §3) through the real route
 * handlers: the exported archive carries the library layout plus a manifest,
 * `merge` never overwrites, `replace` snapshots the root before its first
 * write, and every hostile shape (not a zip, bad base64, absolute entry path,
 * `..` entry, symlinked parent, corrupt state file, oversized source, too many
 * entries) is refused with a caller error instead of touching the disk.
 *
 * Fixtures are synthetic and live in a per-test temp directory; no real library
 * data, absolute path or user name is involved.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipArchive, zipArchive } from '../../tavern-format/src/index.js'
import {
  handleBackupExportRoute,
  handleBackupImportRoute,
  type BackupRouteOptions,
  type BackupStoreHandle,
} from '../src/http/backup-routes.js'
import { HttpError } from '../src/http/errors.js'
import type { HttpRequest, HttpResponse } from '../src/http/io.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Generous bounds: the fixtures are tiny, the bounds are a separate test. */
const WIDE_LIMITS = { maxEntries: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }

function writeFixture(file: string, body: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function makeHost(): BackupStoreHandle & { drains: number } {
  const host: BackupStoreHandle & { drains: number } = {
    drains: 0,
    getState: async () => {
      host.drains += 1
      return {}
    },
  }
  return host
}

function jsonRequest(payload: unknown): HttpRequest {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    headers: { 'content-type': 'application/json' },
    on: (event: string, listener: (chunk?: unknown) => void) => {
      if (event === 'data') listener(body)
      if (event === 'end') listener()
      return undefined
    },
    destroy: () => {},
  } as unknown as HttpRequest
}

interface CapturedResponse {
  statusCode: number
  writableEnded: boolean
  headers: Map<string, string>
  body: () => Buffer
  text: () => string
}

function makeResponse(): CapturedResponse & HttpResponse {
  const chunks: Buffer[] = []
  const headers = new Map<string, string>()
  const response = {
    statusCode: 0,
    writableEnded: false,
    headersSent: false,
    headers,
    setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value) },
    end: (chunk?: string | Uint8Array) => {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      response.writableEnded = true
    },
    body: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  } as unknown as CapturedResponse & HttpResponse
  return response
}

async function exportBackup(root: string, options?: BackupRouteOptions) {
  const res = makeResponse()
  await handleBackupExportRoute(makeHost(), res, { root, zipLimits: WIDE_LIMITS, ...options })
  return res
}

/** The exported archive, unzipped, with its parsed manifest. */
async function exportedLibrary(root: string) {
  const res = await exportBackup(root)
  expect(res.statusCode).toBe(200)
  const files = unzipArchive(new Uint8Array(res.body()), WIDE_LIMITS)
  const manifest = JSON.parse(decoder.decode(files['manifest.json']!)) as {
    format: string
    version: number
    files: number
    totalBytes: number
    entries: Array<{ path: string; bytes: number; sha256: string }>
  }
  return { res, files, manifest }
}

async function importBackup(root: string, body: unknown, options?: BackupRouteOptions) {
  const res = makeResponse()
  await handleBackupImportRoute(makeHost(), jsonRequest(body), res, { root, zipLimits: WIDE_LIMITS, ...options })
  return { res, report: JSON.parse(res.text()) as Record<string, unknown> }
}

async function expectHttpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise
  } catch (cause) {
    if (cause instanceof HttpError) return cause
    throw cause
  }
  throw new Error('expected the route to reject with an HttpError')
}

/**
 * Rewrite an entry name inside a built archive. Both the local header and the
 * central directory store the name verbatim, so an equal-length replacement
 * keeps the container valid while carrying a shape `zipArchive` refuses to
 * build — exactly the archive a hostile sender would make.
 */
function renameEntry(archive: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error('entry names must be the same length for this fixture')
  const text = Buffer.from(archive).toString('latin1')
  const parts = text.split(from)
  if (parts.length < 3) throw new Error(`entry name '${from}' not found in the archive twice`)
  return new Uint8Array(Buffer.from(parts.join(to), 'latin1'))
}

function base64(archive: Uint8Array): string {
  return Buffer.from(archive).toString('base64')
}

const fixtures = {
  'state.json': '{"activeCharacter":"Fixture Hero","version":7}',
  'regex-scripts.json': '{"version":1,"regexScripts":[],"regexScriptOwners":{}}',
  'frontend-storage.json': '{"version":1,"frontendStorage":{}}',
  'characters/Fixture Hero.json': '{"spec":"chara_card_v2","data":{"name":"Fixture Hero"}}',
  'characters/Fixture Hero.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'worlds/Fixture World.json': '{"entries":{}}',
  'presets/Fixture Preset.json': '{"temperature":0.7,"prompts":[]}',
  'personas/Me.json': '{"name":"Me","description":"fixture"}',
  'personas/avatars/Me.png': new Uint8Array([1, 2, 3, 4]),
  'groups/Fixture Group.json': '{"members":[],"activation_strategy":1}',
  'chats/Fixture Hero/2026-01-01.jsonl': '{"mes":"hello"}\n{"mes":"world"}\n',
  'data-bank/fixture.json': '{"id":"fixture","name":"notes.txt","chunks":[]}',
  'data-bank/fixture.txt': 'reference text',
} as const

const LIBRARY_PATHS = Object.keys(fixtures)

let temporaryRoots: string[] = []

function makeLibraryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'soulmojito-backup-'))
  temporaryRoots.push(root)
  for (const [relative, body] of Object.entries(fixtures)) writeFixture(join(root, relative), body)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
  temporaryRoots = []
  delete process.env.DSH_HOME
})

describe('GET export/backup', () => {
  it('packs the library layout with a per-file SHA-256 manifest and no paths outside the root', async () => {
    const root = makeLibraryRoot()
    const { res, files, manifest } = await exportedLibrary(root)

    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="soulmojito-backup-[\dTZ.-]+\.zip"$/)
    expect(manifest.format).toBe('soulmojito-backup')
    expect(manifest.version).toBe(1)
    expect(manifest.files).toBe(manifest.entries.length)

    // Every library file is present, and the manifest describes exactly them.
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([...LIBRARY_PATHS].sort())
    expect(Object.keys(files).sort()).toEqual(['manifest.json', ...[...LIBRARY_PATHS].sort()].sort())

    // Digest and size are computed from the real bytes on disk.
    for (const entry of manifest.entries) {
      const expected = readFileSync(join(root, entry.path))
      expect(entry.bytes).toBe(expected.byteLength)
      expect(entry.sha256).toBe(createHash('sha256').update(expected).digest('hex'))
    }
    expect(manifest.totalBytes).toBe(manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0))

    // Archive keys stay inside the data root by construction.
    for (const name of Object.keys(files)) {
      expect(name.startsWith('/')).toBe(false)
      expect(name.includes('\\')).toBe(false)
      expect(name.split('/')).not.toContain('..')
    }
  })

  it('leaves prior snapshots and non-library files out of the archive', async () => {
    const root = makeLibraryRoot()
    writeFixture(join(root, 'backup-before-restore-2020-01-01T00-00-00-000Z', 'state.json'), '{"stale":true}')
    writeFixture(join(root, 'backup-before-restore-2020-01-01T00-00-00-000Z', 'characters', 'Old.json'), '{}')
    writeFixture(join(root, 'notes.txt'), 'scratch')
    writeFixture(join(root, 'characters', 'partial.json.123.456.0.tmp'), '{}')

    const { files, manifest } = await exportedLibrary(root)
    expect(Object.keys(files).some((name) => name.startsWith('backup-before-restore-'))).toBe(false)
    expect(files['notes.txt']).toBeUndefined()
    expect(files['characters/partial.json.123.456.0.tmp']).toBeUndefined()
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('notes.txt')
  })

  it('skips a symlinked directory instead of following it outside the root', async () => {
    const root = makeLibraryRoot()
    const outside = mkdtempSync(join(tmpdir(), 'soulmojito-backup-outside-'))
    temporaryRoots.push(outside)
    writeFixture(join(outside, 'secret.json'), '{"secret":true}')
    let linked = false
    try {
      // A junction needs no elevation on Windows and is still a reparse point,
      // which is what the walk treats as a link.
      symlinkSync(outside, join(root, 'characters', 'linked'), 'junction')
      linked = true
    } catch {
      // A filesystem without link support leaves nothing to skip; the archive
      // assertions below still prove the walk stays inside the root.
    }

    const { files } = await exportedLibrary(root)
    expect(Object.keys(files).some((name) => name.startsWith('characters/linked/'))).toBe(false)
    expect(existsSync(join(outside, 'secret.json'))).toBe(true)
    if (linked) expect(lstatSync(join(root, 'characters', 'linked')).isSymbolicLink()).toBe(true)
  })

  it('resolves the data root from DSH_HOME when no root is passed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'soulmojito-backup-home-'))
    temporaryRoots.push(home)
    writeFixture(join(home, 'soulmojito', 'state.json'), '{"activeCharacter":"Fixture Hero"}')
    writeFixture(join(home, 'soulmojito', 'worlds', 'Fixture World.json'), '{"entries":{}}')
    process.env.DSH_HOME = home

    const res = makeResponse()
    await handleBackupExportRoute(makeHost(), res, { zipLimits: WIDE_LIMITS })
    const files = unzipArchive(new Uint8Array(res.body()), WIDE_LIMITS)
    expect(Object.keys(files).sort()).toEqual(['manifest.json', 'state.json', 'worlds/Fixture World.json'])
  })

  it('drains pending store writes before packing', async () => {
    const root = makeLibraryRoot()
    const host = makeHost()
    await handleBackupExportRoute(host, makeResponse(), { root, zipLimits: WIDE_LIMITS })
    expect(host.drains).toBe(1)
  })

  it('refuses to pack a file over the per-file bound', async () => {
    const root = makeLibraryRoot()
    const error = await expectHttpError(handleBackupExportRoute(makeHost(), makeResponse(), {
      root,
      zipLimits: { maxEntries: 256, maxFileBytes: 4, maxTotalBytes: 1024 },
    }))
    expect(error.status).toBe(413)
    expect(error.message).toMatch(/per-file backup limit/)
  })
})

describe('POST import/backup', () => {
  it('merges: writes new files, skips identical ones, reports conflicts without overwriting', async () => {
    const root = makeLibraryRoot()
    writeFixture(join(root, 'worlds/Conflicting.json'), '{"entries":{},"version":"old"}')
    writeFixture(join(root, 'worlds/Identical.json'), '{"entries":{},"version":"same"}')
    writeFixture(join(root, 'state.json'), '{"activeCharacter":"Fixture Hero","version":7}')

    const archive = zipArchive({
      'worlds/Conflicting.json': encoder.encode('{"entries":{},"version":"new"}'),
      'worlds/Identical.json': encoder.encode('{"entries":{},"version":"same"}'),
      'worlds/Fresh.json': encoder.encode('{"entries":{},"version":1}'),
      'state.json': encoder.encode('{"activeCharacter":"Fixture Hero","version":7}'),
    })
    const { res, report } = await importBackup(root, { zipBase64: base64(archive), mode: 'merge' })

    expect(res.statusCode).toBe(200)
    expect(report).toMatchObject({ ok: true, mode: 'merge', imported: 1, skipped: 2, conflicts: 1, rejected: 0, files: 4, snapshot: null })
    expect(readFileSync(join(root, 'worlds/Conflicting.json'), 'utf8')).toContain('"old"')
    expect(readFileSync(join(root, 'worlds/Fresh.json'), 'utf8')).toContain('"version":1')
    // merge is non-destructive: nothing was snapshotted because nothing was replaced.
    expect(readdirSync(root).some((name) => name.startsWith('backup-before-restore-'))).toBe(false)
  })

  it('replaces: snapshots the whole library first, then overwrites', async () => {
    const root = makeLibraryRoot()
    const before = readFileSync(join(root, 'state.json'), 'utf8')

    const archive = zipArchive({
      'state.json': encoder.encode('{"activeCharacter":"Restored Hero","version":8}'),
      'worlds/Restored.json': encoder.encode('{"entries":{"0":{}}}'),
    })
    const { res, report } = await importBackup(root, { zipBase64: base64(archive), mode: 'replace' })

    expect(res.statusCode).toBe(200)
    expect(report).toMatchObject({ ok: true, mode: 'replace', imported: 2, skipped: 0, conflicts: 0 })
    expect(report.snapshot).toMatch(/^backup-before-restore-\d{4}-\d{2}-\d{2}T[\d-]+Z$/)

    const snapshot = join(root, report.snapshot as string)
    expect(readFileSync(join(snapshot, 'state.json'), 'utf8')).toBe(before)
    // The snapshot is a full library copy in the same layout…
    for (const relative of LIBRARY_PATHS) {
      expect(existsSync(join(snapshot, relative)), relative).toBe(true)
    }
    // …and never nests an older snapshot.
    expect(readdirSync(snapshot).some((name) => name.startsWith('backup-before-restore-'))).toBe(false)

    expect(readFileSync(join(root, 'state.json'), 'utf8')).toContain('Restored Hero')
    expect(existsSync(join(root, 'worlds/Restored.json'))).toBe(true)
    // replace overwrites but does not delete what the archive omits.
    expect(existsSync(join(root, 'characters/Fixture Hero.png'))).toBe(true)
  })

  it('reports the snapshot path when a write fails mid-restore', async () => {
    const root = makeLibraryRoot()
    let writes = 0
    const archive = zipArchive({
      'worlds/First.json': encoder.encode('{"entries":{}}'),
      'worlds/Second.json': encoder.encode('{"entries":{}}'),
    })
    const error = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(archive), mode: 'replace' }),
      makeResponse(),
      {
        root,
        zipLimits: WIDE_LIMITS,
        writeFile: async () => {
          writes += 1
          if (writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        },
      },
    ))

    expect(error.status).toBe(500)
    expect(error.message).toMatch(/restore failed after creating snapshot 'backup-before-restore-/)
    expect(error.message).toMatch(/ENOSPC/)
    const snapshot = /snapshot '([^']+)'/.exec(error.message)?.[1]
    expect(snapshot).toBeDefined()
    expect(existsSync(join(root, snapshot as string, 'state.json'))).toBe(true)
  })

  it('rejects a body that is not a zip and one that is not base64', async () => {
    const root = makeLibraryRoot()
    const notZip = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: Buffer.from('plain text').toString('base64'), mode: 'merge' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(notZip.status).toBe(400)
    expect(notZip.message).toMatch(/not a valid zip/)

    const notBase64 = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: 'not base64 !!', mode: 'merge' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(notBase64.status).toBe(400)
    expect(notBase64.message).toMatch(/not valid base64/)
  })

  it('rejects absolute and parent-directory entry names (zip slip)', async () => {
    const root = makeLibraryRoot()
    const benign = zipArchive({ 'ab/data.bin': encoder.encode('{"x":1}') })

    const slip = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(renameEntry(benign, 'ab/data.bin', '../data.bin')), mode: 'replace' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(slip.status).toBe(400)
    expect(slip.message).toMatch(/parent-directory/)

    const absolute = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(renameEntry(benign, 'ab/data.bin', '/a/data.bin')), mode: 'replace' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(absolute.status).toBe(400)
    expect(absolute.message).toMatch(/absolute path/)

    // Neither rejection may leave a snapshot or touch the root.
    expect(readdirSync(root).some((name) => name.startsWith('backup-before-restore-'))).toBe(false)
    expect(existsSync(join(root, 'data.bin'))).toBe(false)
  })

  it('rejects an entry that would be written through a symlinked parent', async () => {
    const root = makeLibraryRoot()
    const outside = mkdtempSync(join(tmpdir(), 'soulmojito-backup-outside-'))
    temporaryRoots.push(outside)
    mkdirSync(join(root, 'characters'), { recursive: true })
    symlinkSync(outside, join(root, 'characters', 'linked'), 'junction')

    const archive = zipArchive({ 'characters/linked/evil.json': encoder.encode('{"evil":true}') })
    const error = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(archive), mode: 'replace' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/symlinked parent/)
    expect(existsSync(join(outside, 'evil.json'))).toBe(false)
  })

  it('rejects a corrupt root state file and counts entries outside the library layout', async () => {
    const root = makeLibraryRoot()
    const corrupt = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(zipArchive({ 'state.json': encoder.encode('{"broken"') })), mode: 'merge' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(corrupt.status).toBe(400)
    expect(corrupt.message).toMatch(/not valid JSON/)
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toContain('Fixture Hero')

    const foreign = zipArchive({
      'mods/host.json': encoder.encode('{"enabled":true}'),
      'worlds/Kept.json': encoder.encode('{"entries":{}}'),
    })
    const { report } = await importBackup(root, { zipBase64: base64(foreign), mode: 'merge' })
    expect(report).toMatchObject({ imported: 1, rejected: 1 })
    expect(existsSync(join(root, 'mods', 'host.json'))).toBe(false)
  })

  it('bounds the decoded source and the entry count before writing anything', async () => {
    const root = makeLibraryRoot()
    const archive = zipArchive({ 'worlds/One.json': encoder.encode('{"entries":{}}') })

    const tooLarge = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(archive), mode: 'merge' }),
      makeResponse(),
      { root, maxSourceBytes: 16, zipLimits: WIDE_LIMITS },
    ))
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.message).toMatch(/source limit/)

    const manyEntries = zipArchive({
      'worlds/A.json': encoder.encode('{"entries":{}}'),
      'worlds/B.json': encoder.encode('{"entries":{}}'),
      'worlds/C.json': encoder.encode('{"entries":{}}'),
    })
    const tooMany = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(manyEntries), mode: 'merge' }),
      makeResponse(),
      { root, zipLimits: { maxEntries: 2, maxFileBytes: 1024, maxTotalBytes: 4096 } },
    ))
    expect(tooMany.status).toBe(413)
    expect(tooMany.message).toMatch(/more than 2 entries/)
  })

  it('requires an explicit merge/replace mode', async () => {
    const root = makeLibraryRoot()
    const missing = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(zipArchive({ 'worlds/A.json': encoder.encode('{}') })) }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(missing.status).toBe(400)
    expect(missing.message).toMatch(/mode: 'merge' \| 'replace'/)

    const unknown = await expectHttpError(handleBackupImportRoute(
      makeHost(),
      jsonRequest({ zipBase64: base64(zipArchive({ 'worlds/A.json': encoder.encode('{}') })), mode: 'overwrite' }),
      makeResponse(),
      { root, zipLimits: WIDE_LIMITS },
    ))
    expect(unknown.status).toBe(400)
  })

  it('round-trips an exported archive into an empty root', async () => {
    const source = makeLibraryRoot()
    const res = await exportBackup(source)
    const target = mkdtempSync(join(tmpdir(), 'soulmojito-backup-target-'))
    temporaryRoots.push(target)

    const { report } = await importBackup(target, { zipBase64: base64(new Uint8Array(res.body())), mode: 'replace' })
    expect(report).toMatchObject({ mode: 'replace', skipped: 0, conflicts: 0, files: LIBRARY_PATHS.length })
    // manifest.json is archive metadata, not library data: it must not land.
    expect(existsSync(join(target, 'manifest.json'))).toBe(false)
    for (const relative of LIBRARY_PATHS) {
      expect(readFileSync(join(target, relative)).equals(readFileSync(join(source, relative))), relative).toBe(true)
    }
    expect(Object.keys(unzipArchive(new Uint8Array(res.body()), WIDE_LIMITS))).toHaveLength(LIBRARY_PATHS.length + 1)
  })
})
