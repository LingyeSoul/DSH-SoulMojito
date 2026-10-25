/**
 * CHARX（V3 容器）：zip 包，根目录 card.json，资源按 assets/ 目录约定存放。
 */

import { zipSync, strToU8, strFromU8 } from 'fflate'
import { encodeCharacterCardJson, decodeCharacterCard } from './card.js'
import type { CharacterCardIR } from './types.js'
import { unzipArchive } from './zip.js'

export class CharxFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharxFormatError'
  }
}

export interface CharxIR {
  card: CharacterCardIR
  /** zip 内非 card.json 的全部条目路径（assets 等，字节由 extractCharxAsset 取） */
  assetPaths: string[]
}

/**
 * CHARX containers use DEFAULT_ZIP_LIMITS (256 entries / 64 MiB per file /
 * 128 MiB total): generous for card art and embedded audio, bounded against
 * deflate bombs. Zip errors are rethrown as CharxFormatError for this module's
 * callers.
 */
function unzipCharx(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipArchive(bytes)
  } catch (cause) {
    throw new CharxFormatError(cause instanceof Error ? cause.message : String(cause))
  }
}

export function decodeCharx(bytes: Uint8Array): CharxIR {
  const files = unzipCharx(bytes)
  const cardJson = files['card.json']
  if (cardJson === undefined) throw new CharxFormatError("CHARX has no 'card.json' at zip root")
  const card = decodeCharacterCard(JSON.parse(strFromU8(cardJson)))
  const assetPaths = Object.keys(files).filter((p) => p !== 'card.json')
  return { card, assetPaths }
}

/** 取 CHARX 内指定资源的字节（embeded:// URI 对应的路径）。 */
export function decodeCharxAsset(bytes: Uint8Array, path: string): Uint8Array {
  const files = unzipCharx(bytes)
  const asset = files[path]
  if (asset === undefined) throw new CharxFormatError(`CHARX has no asset '${path}'`)
  return asset
}

export function encodeCharx(ir: CharacterCardIR, assets?: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'card.json': strToU8(JSON.stringify(encodeCharacterCardJson(ir))),
  }
  for (const asset of assets ?? []) files[asset.path] = asset.data
  return zipSync(files)
}
