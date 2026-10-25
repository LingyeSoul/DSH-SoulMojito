/**
 * Generic zip container decoding (shared entry outside CHARX — game package
 * import goes through here; fflate is already a dependency of this package).
 * Decoding is bounded by ZipLimits so a deflate bomb is rejected from the
 * central directory before its payload is inflated. Callers still own path
 * sanitising and on-disk placement (see
 * packages/plugin/src/games/registry.ts installFromZip).
 */

import { unzipSync } from 'fflate'

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipArchiveError'
  }
}

/** Which pre-extraction bound rejected an archive. */
export type ZipLimitKind = 'entries' | 'file-size' | 'total-size'

/**
 * A zip rejected by ZipLimits (still a ZipArchiveError). The kind/entry fields
 * let callers translate the rejection into their own user-facing wording.
 */
export class ZipLimitError extends ZipArchiveError {
  readonly kind: ZipLimitKind
  readonly entry: string | undefined

  constructor(message: string, kind: ZipLimitKind, entry: string | undefined) {
    super(message)
    this.name = 'ZipLimitError'
    this.kind = kind
    this.entry = entry
  }
}

/**
 * Pre-extraction bounds. Sizes are the declared original sizes from the zip
 * central directory, so the filter can reject an entry before fflate inflates
 * it. The sum is accumulated across entries in central-directory order: the
 * entry that crosses the total is rejected before it is inflated, and the whole
 * call fails (already-inflated entries are discarded, never returned).
 */
export interface ZipLimits {
  /** Maximum number of entries; directory entries are counted too. */
  maxEntries: number
  /** Maximum declared original size of a single entry. */
  maxFileBytes: number
  /** Maximum sum of declared original sizes across all entries. */
  maxTotalBytes: number
}

/**
 * Defaults are generous for legitimate CHARX/EPUB containers (card art, fonts,
 * embedded audio) while still bounding a deflate bomb: 256 entries, 64 MiB per
 * file, 128 MiB total.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 256,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
}

function requireLimit(value: number, name: keyof ZipLimits): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ZipArchiveError(`invalid zip limit '${name}': ${String(value)}`)
  }
  return value
}

/**
 * Unzip `bytes` into `{ entry path: bytes }`.
 *
 * `limits` defaults to DEFAULT_ZIP_LIMITS. Malformed archives and limit
 * rejections both throw ZipArchiveError; limit rejections are ZipLimitError so
 * callers can tell them apart from corrupt input.
 */
export function unzipArchive(bytes: Uint8Array, limits?: ZipLimits): Record<string, Uint8Array> {
  const source = limits ?? DEFAULT_ZIP_LIMITS
  const maxEntries = requireLimit(source.maxEntries, 'maxEntries')
  const maxFileBytes = requireLimit(source.maxFileBytes, 'maxFileBytes')
  const maxTotalBytes = requireLimit(source.maxTotalBytes, 'maxTotalBytes')
  let entries = 0
  let totalBytes = 0
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        entries += 1
        if (entries > maxEntries) {
          throw new ZipLimitError(
            `zip has more than ${maxEntries} entries (at '${file.name}')`,
            'entries',
            file.name,
          )
        }
        if (file.originalSize > maxFileBytes) {
          throw new ZipLimitError(
            `zip entry '${file.name}' declares ${file.originalSize} bytes, over the ${maxFileBytes}-byte per-file limit`,
            'file-size',
            file.name,
          )
        }
        totalBytes += file.originalSize
        if (totalBytes > maxTotalBytes) {
          throw new ZipLimitError(
            `zip declares ${totalBytes} bytes total (at '${file.name}'), over the ${maxTotalBytes}-byte total limit`,
            'total-size',
            file.name,
          )
        }
        return true
      },
    })
  } catch (cause) {
    if (cause instanceof ZipArchiveError) throw cause
    throw new ZipArchiveError(`not a valid zip: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
