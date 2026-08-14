/**
 * CHARX（V3 容器）：zip 包，根目录 card.json，资源按 assets/ 目录约定存放。
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { encodeCharacterCardJson, decodeCharacterCard } from './card.js'
import type { CharacterCardIR } from './types.js'

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

export function decodeCharx(bytes: Uint8Array): CharxIR {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (cause) {
    throw new CharxFormatError(`not a valid zip: ${String(cause)}`)
  }
  const cardJson = files['card.json']
  if (cardJson === undefined) throw new CharxFormatError("CHARX has no 'card.json' at zip root")
  const card = decodeCharacterCard(JSON.parse(strFromU8(cardJson)))
  const assetPaths = Object.keys(files).filter((p) => p !== 'card.json')
  return { card, assetPaths }
}

/** 取 CHARX 内指定资源的字节（embeded:// URI 对应的路径）。 */
export function decodeCharxAsset(bytes: Uint8Array, path: string): Uint8Array {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (cause) {
    throw new CharxFormatError(`not a valid zip: ${String(cause)}`)
  }
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
