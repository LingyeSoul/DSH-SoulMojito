/**
 * PNG chunk 读写：角色卡的 `chara` / `ccv3` 数据存于 tEXt chunk（base64）。
 * 纯实现（零依赖）：签名校验、chunk 遍历、tEXt 提取、chunk 替换/插入（IEND 前）、CRC32。
 */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngChunk {
  /** 4 字节 ASCII 类型码，如 'IHDR' / 'tEXt' / 'IEND' */
  type: string
  data: Uint8Array
  /** chunk 在源文件中的字节偏移（含 length 字段起点），调试用 */
  offset: number
}

export interface TextChunk {
  keyword: string
  text: string
}

export class PngFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngFormatError'
  }
}

/* ------------------------------- CRC32 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(...buffers: Uint8Array[]): number {
  let crc = 0xffffffff
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]!) >>> 0 & 0xff]! ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/* ------------------------------ 解析 ------------------------------ */

export function isPng(buf: Uint8Array): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false
  }
  return true
}

/** 遍历全部 chunk（含 IEND）。结构非法抛 PngFormatError。 */
export function parsePngChunks(buf: Uint8Array): PngChunk[] {
  if (!isPng(buf)) throw new PngFormatError('not a PNG file (bad signature)')
  const chunks: PngChunk[] = []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset)
    const typeBytes = buf.subarray(offset + 4, offset + 8)
    const type = String.fromCharCode(...typeBytes)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) {
      throw new PngFormatError(`chunk '${type}' at ${offset} overruns file end`)
    }
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd), offset })
    const storedCrc = view.getUint32(dataEnd)
    const actualCrc = crc32(typeBytes, buf.subarray(dataStart, dataEnd))
    if (storedCrc !== actualCrc) {
      throw new PngFormatError(`chunk '${type}' at ${offset} has bad CRC (stored ${storedCrc.toString(16)}, actual ${actualCrc.toString(16)})`)
    }
    offset = dataEnd + 4
    if (type === 'IEND') break
  }
  const last = chunks[chunks.length - 1]
  if (!last || last.type !== 'IEND') throw new PngFormatError('missing IEND chunk')
  return chunks
}

/** 提取全部 tEXt chunk（keyword\0text，latin1）。 */
export function readTextChunks(buf: Uint8Array): TextChunk[] {
  const out: TextChunk[] = []
  for (const chunk of parsePngChunks(buf)) {
    if (chunk.type !== 'tEXt') continue
    const nul = chunk.data.indexOf(0)
    if (nul < 0) continue
    const keyword = latin1Decode(chunk.data.subarray(0, nul))
    const text = latin1Decode(chunk.data.subarray(nul + 1))
    out.push({ keyword, text })
  }
  return out
}

/* ------------------------------ 编码 ------------------------------ */

function latin1Decode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

/** 组装一个完整 chunk 字节串（length + type + data + CRC）。 */
export function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = latin1Encode(type)
  const crc = crc32(typeBytes, data)
  const out = new Uint8Array(12 + data.length)
  out.set(u32be(data.length), 0)
  out.set(typeBytes, 4)
  out.set(data, 8)
  out.set(u32be(crc), 8 + data.length)
  return out
}

/** 组装 tEXt chunk。text 须为 latin1 安全（base64 恒安全）。 */
export function encodeTextChunk(keyword: string, text: string): Uint8Array {
  const data = new Uint8Array(keyword.length + 1 + text.length)
  data.set(latin1Encode(keyword), 0)
  data[keyword.length] = 0
  data.set(latin1Encode(text), keyword.length + 1)
  return encodeChunk('tEXt', data)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * 写入/替换 tEXt chunk：同名 keyword 已存在则原位替换（保序），否则插在 IEND 前。
 * 返回新 PNG 字节串。
 */
export function writeTextChunks(png: Uint8Array, entries: TextChunk[]): Uint8Array {
  const chunks = parsePngChunks(png)
  const parts: Uint8Array[] = [PNG_SIGNATURE]
  const pending = new Map(entries.map((e) => [e.keyword, e]))
  for (const chunk of chunks) {
    let bytes: Uint8Array
    if (chunk.type === 'tEXt') {
      const nul = chunk.data.indexOf(0)
      const keyword = nul >= 0 ? latin1Decode(chunk.data.subarray(0, nul)) : ''
      const replacement = pending.get(keyword)
      if (replacement) {
        pending.delete(keyword)
        bytes = encodeTextChunk(replacement.keyword, replacement.text)
      } else {
        bytes = sliceChunkBytes(png, chunk)
      }
    } else if (chunk.type === 'IEND') {
      // IEND 前插入所有新 keyword
      for (const e of pending.values()) parts.push(encodeTextChunk(e.keyword, e.text))
      pending.clear()
      bytes = sliceChunkBytes(png, chunk)
    } else {
      bytes = sliceChunkBytes(png, chunk)
    }
    parts.push(bytes)
  }
  return concat(...parts)
}

/** 从源缓冲区按 chunk 元数据切出完整 chunk 字节串（零重算 CRC）。 */
function sliceChunkBytes(png: Uint8Array, chunk: PngChunk): Uint8Array {
  return png.subarray(chunk.offset, chunk.offset + 12 + chunk.data.length)
}

/* --------------------------- 角色卡数据 --------------------------- */

export const CARD_CHUNK_V2 = 'chara'
export const CARD_CHUNK_V3 = 'ccv3'

/** 提取卡 JSON 字符串（ccv3 优先于 chara）。无则返回 null。 */
export function extractCardJson(png: Uint8Array): string | null {
  const texts = readTextChunks(png)
  const found = texts.find((t) => t.keyword === CARD_CHUNK_V3) ?? texts.find((t) => t.keyword === CARD_CHUNK_V2)
  if (!found || !found.text) return null
  return base64ToUtf8(found.text)
}

export function base64ToUtf8(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8')
}

export function utf8ToBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}
