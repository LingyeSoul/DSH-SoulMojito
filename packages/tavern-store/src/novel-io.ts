/** Novel filesystem and hashing helpers (§10.2), extracted from novel.ts. */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { stableStringify } from './novel-model.js'


export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function hash16(value: unknown): string {
  return sha256hex(stableStringify(value)).slice(0, 16)
}

export function jsonBytes(obj: unknown): Uint8Array {
  return textBytes(JSON.stringify(obj, null, 2))
}

export function textBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

export async function tryReadText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

/**
 * Immutable object write (§10.2 step 2): tmp file + fsync + rename. Existing
 * files are left untouched (content-addressed). Body and asset objects and
 * revision files all use this path; the file handle is synced before closing.
 */
export async function writeImmutableBytes(file: string, bytes: Uint8Array): Promise<void> {
  try {
    await fs.access(file)
    return
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, file)
}

/**
 * HEAD replacement (§10.2 step 4): tmp + fsync + rename is the logical commit
 * point. On Windows, Node's fs.rename replaces the existing target
 * (MoveFileExW MOVEFILE_REPLACE_EXISTING), verified by the test suite on a
 * real NTFS filesystem; one retry covers transient EPERM/EBUSY contention.
 */
export async function replaceHead(head: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${head}.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.rename(tmp, head)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
      try { await fs.rm(tmp, { force: true }) } catch { /* best effort */ }
      throw cause
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
    await fs.rename(tmp, head)
  }
}

export async function readDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}
