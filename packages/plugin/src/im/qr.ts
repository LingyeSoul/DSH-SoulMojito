/**
 * 最小 QR 编码器（byte 模式），供 IM 扫码绑定在服务端渲染二维码。
 *
 * 为什么自己写：仓库的分发产物必须零第三方依赖，而宿主与运行时目录都没有
 * 可用的二维码实现。扫码绑定又必须真的画出可扫的码——把「内容字符串」当成
 * `<img src>` 是渲染不出二维码的（2026-10-30 实机反馈）。
 *
 * 实现范围刻意收窄：`byte` 模式、版本 1–10、四个纠错等级、8 种掩码与惩罚
 * 评分。IM 的扫码内容是一条 URL（ASCII），这个范围足够；其余模式不实现。
 *
 * 正确性由测试保证：每个 RS 块必须满足全部校验子为 0（标准级约束），并且
 * 测试里有一套独立读回器把数据码字从矩阵里取回来逐字节比对。
 */

export type QrEcl = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  size: number
  version: number
  ecl: QrEcl
  mask: number
  /** `modules[y][x]`：true 表示深色。 */
  modules: readonly (readonly boolean[])[]
}

export interface QrOptions {
  ecl: QrEcl
  /** 允许的最大版本（1–10）；内容超长直接抛错，不静默截断。 */
  maxVersion: number
}

const MIN_VERSION = 1
const MAX_VERSION = 10

const ECL_BITS: Readonly<Record<QrEcl, number>> = { L: 1, M: 0, Q: 3, H: 2 }
const ECL_INDEX: Readonly<Record<QrEcl, number>> = { L: 0, M: 1, Q: 2, H: 3 }

/** 每个 RS 块的纠错码字数：`[ecl][version]`，version 0 占位。 */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
]

/** RS 块数量：`[ecl][version]`。 */
const NUM_EC_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
]

/** 对齐图形中心坐标；v1 没有对齐图形。 */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** 版本信息（v7+）的 18 位 BCH 编码。 */
const VERSION_INFO: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0x07c94, 0x085bc, 0x09a99, 0x0a4d3]

const FORMAT_MASK = 0x5412

export class QrEncodeError extends Error {
  readonly code: 'QR_TOO_LONG' | 'QR_BAD_OPTIONS'
  constructor(code: QrEncodeError['code'], message: string) {
    super(message)
    this.name = 'QrEncodeError'
    this.code = code
  }
}

/** 原始数据模块数（不含功能图形），除以 8 即总码字数。 */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

function numDataCodewords(version: number, ecl: QrEcl): number {
  const index = ECL_INDEX[ecl]
  // 先取整再减纠错码字：原始模块数除以 8 会留 remainder bits（v2–6 为 7 位），
  // 那几位不是码字，直接参与除法会把每个块多算一个字节。
  return Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[index]![version]! * NUM_EC_BLOCKS[index]![version]!
}

/** byte 模式可用字节数（模式指示符 4 位 + 字符计数 8/16 位）。 */
export function qrByteCapacity(version: number, ecl: QrEcl): number {
  const countBits = version <= 9 ? 8 : 16
  return Math.floor((numDataCodewords(version, ecl) * 8 - 4 - countBits) / 8)
}

function pickVersion(byteLength: number, options: QrOptions): number {
  if (!Number.isSafeInteger(options.maxVersion) || options.maxVersion < MIN_VERSION || options.maxVersion > MAX_VERSION) {
    throw new QrEncodeError('QR_BAD_OPTIONS', `maxVersion must be an integer in ${MIN_VERSION}..${MAX_VERSION}`)
  }
  for (let version = MIN_VERSION; version <= options.maxVersion; version += 1) {
    if (qrByteCapacity(version, options.ecl) >= byteLength) return version
  }
  throw new QrEncodeError(
    'QR_TOO_LONG',
    `the payload is ${byteLength} bytes, which exceeds QR version ${options.maxVersion} at EC level ${options.ecl} (max ${qrByteCapacity(options.maxVersion, options.ecl)} bytes)`,
  )
}

/* ------------------------------ Reed-Solomon ------------------------------ */

function gfMultiply(left: number, right: number): number {
  let product = 0
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((right >>> bit) & 1) * left
  }
  return product & 0xff
}

function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let step = 0; step < degree; step += 1) {
    for (let index = 0; index < degree; index += 1) {
      result[index] = gfMultiply(result[index]!, root)
      if (index + 1 < degree) result[index] = result[index]! ^ result[index + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length)
  for (const byte of data) {
    const factor = byte ^ result[0]!
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let index = 0; index < divisor.length; index += 1) {
      result[index] = result[index]! ^ gfMultiply(divisor[index]!, factor)
    }
  }
  return result
}

/** 测试用：某个 RS 块的全部校验子必须为 0。 */
export function rsSyndromesAreZero(block: Uint8Array, ecCodewords: number): boolean {
  for (let power = 0; power < ecCodewords; power += 1) {
    let alpha = 1
    for (let step = 0; step < power; step += 1) alpha = gfMultiply(alpha, 0x02)
    let sum = 0
    for (const byte of block) sum = gfMultiply(sum, alpha) ^ byte
    if (sum !== 0) return false
  }
  return true
}

/* --------------------------------- 编码 --------------------------------- */

function buildCodewords(bytes: Uint8Array, version: number, ecl: QrEcl): Uint8Array {
  const capacityBits = numDataCodewords(version, ecl) * 8
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  // 终止符最多 4 位
  const terminator = Math.min(4, capacityBits - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)
  const padBytes = [0xec, 0x11]
  let padIndex = 0
  while (bits.length < capacityBits) {
    push(padBytes[padIndex % 2]!, 8)
    padIndex += 1
  }
  const data = new Uint8Array(bits.length / 8)
  for (let index = 0; index < data.length; index += 1) {
    let value = 0
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index * 8 + bit]!
    data[index] = value
  }
  return addEccAndInterleave(data, version, ecl)
}

function addEccAndInterleave(data: Uint8Array, version: number, ecl: QrEcl): Uint8Array {
  const index = ECL_INDEX[ecl]
  const numBlocks = NUM_EC_BLOCKS[index]![version]!
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[index]![version]!
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: Uint8Array[] = []
  let offset = 0
  for (let block = 0; block < numBlocks; block += 1) {
    const dataLen = shortBlockLen - blockEccLen + (block < numShortBlocks ? 0 : 1)
    const chunk = data.subarray(offset, offset + dataLen)
    offset += dataLen
    const ecc = rsRemainder(chunk, divisor)
    const blockBytes = new Uint8Array(dataLen + blockEccLen)
    blockBytes.set(chunk, 0)
    blockBytes.set(ecc, dataLen)
    blocks.push(blockBytes)
  }
  const result = new Uint8Array(rawCodewords)
  let cursor = 0
  const maxDataLen = shortBlockLen - blockEccLen + 1
  for (let position = 0; position < maxDataLen; position += 1) {
    for (const block of blocks) {
      // 短块在该列没有第 maxDataLen 个数据字节，跳过。
      if (position < block.length - blockEccLen) {
        result[cursor] = block[position]!
        cursor += 1
      }
    }
  }
  for (let position = 0; position < blockEccLen; position += 1) {
    for (const block of blocks) {
      result[cursor] = block[block.length - blockEccLen + position]!
      cursor += 1
    }
  }
  return result
}

/* -------------------------------- 矩阵绘制 -------------------------------- */

class MatrixBuilder {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]

  constructor(version: number) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  setFunction(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }
}

function drawFinder(builder: MatrixBuilder, centerX: number, centerY: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      builder.setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4)
    }
  }
}

function drawAlignment(builder: MatrixBuilder, centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      builder.setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

function drawFormatBits(builder: MatrixBuilder, ecl: QrEcl, mask: number): void {
  const data = (ECL_BITS[ecl] << 3) | mask
  let remainder = data
  for (let step = 0; step < 10; step += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  const bits = ((data << 10) | remainder) ^ FORMAT_MASK
  const size = builder.size
  const bit = (index: number): boolean => ((bits >>> index) & 1) !== 0
  for (let index = 0; index <= 5; index += 1) builder.setFunction(8, index, bit(index))
  builder.setFunction(8, 7, bit(6))
  builder.setFunction(8, 8, bit(7))
  builder.setFunction(7, 8, bit(8))
  for (let index = 9; index < 15; index += 1) builder.setFunction(14 - index, 8, bit(index))
  for (let index = 0; index < 8; index += 1) builder.setFunction(size - 1 - index, 8, bit(index))
  for (let index = 8; index < 15; index += 1) builder.setFunction(8, size - 15 + index, bit(index))
  // 固定深色模块
  builder.setFunction(8, size - 8, true)
}

function drawVersionBits(builder: MatrixBuilder, version: number): void {
  if (version < 7) return
  const bits = VERSION_INFO[version]!
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) !== 0
    const a = builder.size - 11 + (index % 3)
    const b = Math.floor(index / 3)
    builder.setFunction(a, b, dark)
    builder.setFunction(b, a, dark)
  }
}

function drawFunctionPatterns(builder: MatrixBuilder, version: number, ecl: QrEcl, mask: number): void {
  const size = builder.size
  for (let index = 0; index < size; index += 1) {
    builder.setFunction(6, index, index % 2 === 0)
    builder.setFunction(index, 6, index % 2 === 0)
  }
  drawFinder(builder, 3, 3)
  drawFinder(builder, size - 4, 3)
  drawFinder(builder, 3, size - 4)
  const positions = ALIGNMENT_POSITIONS[version]!
  const count = positions.length
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      const isCorner = (row === 0 && column === 0)
        || (row === 0 && column === count - 1)
        || (row === count - 1 && column === 0)
      if (isCorner) continue
      drawAlignment(builder, positions[column]!, positions[row]!)
    }
  }
  drawFormatBits(builder, ecl, mask)
  drawVersionBits(builder, version)
}

function drawCodewords(builder: MatrixBuilder, codewords: Uint8Array): void {
  const size = builder.size
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (builder.isFunction[y]![x]) continue
        if (index < codewords.length * 8) {
          builder.modules[y]![x] = ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0
          index += 1
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default: throw new QrEncodeError('QR_BAD_OPTIONS', `unknown mask ${mask}`)
  }
}

function applyMask(builder: MatrixBuilder, mask: number): void {
  for (let y = 0; y < builder.size; y += 1) {
    for (let x = 0; x < builder.size; x += 1) {
      if (builder.isFunction[y]![x]) continue
      if (maskBit(mask, x, y)) builder.modules[y]![x] = !builder.modules[y]![x]
    }
  }
}

/** 标准罚分（N1=3 / N2=3 / N3=40 / N4=10）：只用于挑掩码。 */
function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let penalty = 0
  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y]![0]!
    let runLength = 1
    for (let x = 1; x < size; x += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1
      } else {
        if (runLength >= 5) penalty += 3 + (runLength - 5)
        runColor = modules[y]![x]!
        runLength = 1
      }
    }
    if (runLength >= 5) penalty += 3 + (runLength - 5)
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0]![x]!
    let runLength = 1
    for (let y = 1; y < size; y += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1
      } else {
        if (runLength >= 5) penalty += 3 + (runLength - 5)
        runColor = modules[y]![x]!
        runLength = 1
      }
    }
    if (runLength >= 5) penalty += 3 + (runLength - 5)
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y]![x]!
      if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color) penalty += 3
    }
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size - 6; x += 1) {
      if (modules[y]![x] && !modules[y]![x + 1] && modules[y]![x + 2] && modules[y]![x + 3] && modules[y]![x + 4] && !modules[y]![x + 5] && modules[y]![x + 6]) {
        penalty += 40
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size - 6; y += 1) {
      if (modules[y]![x] && !modules[y + 1]![x] && modules[y + 2]![x] && modules[y + 3]![x] && modules[y + 4]![x] && !modules[y + 5]![x] && modules[y + 6]![x]) {
        penalty += 40
      }
    }
  }
  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark += 1
  const total = size * size
  const ratio = Math.abs(dark * 20 - total * 10) / total
  penalty += Math.floor(ratio) * 10
  return penalty
}

function clone(builder: MatrixBuilder): boolean[][] {
  return builder.modules.map((row) => [...row])
}

/** 把文本编码成二维码矩阵。超过 `maxVersion` 的容量直接抛错。 */
export function encodeQr(text: string, options: QrOptions): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length === 0) throw new QrEncodeError('QR_BAD_OPTIONS', 'the QR payload must not be empty')
  const version = pickVersion(bytes.length, options)
  const codewords = buildCodewords(bytes, version, options.ecl)
  let best: { mask: number; modules: boolean[][]; penalty: number } | undefined
  for (let mask = 0; mask < 8; mask += 1) {
    const builder = new MatrixBuilder(version)
    drawFunctionPatterns(builder, version, options.ecl, mask)
    drawCodewords(builder, codewords)
    applyMask(builder, mask)
    drawFormatBits(builder, options.ecl, mask)
    const modules = clone(builder)
    const penalty = penaltyScore(modules)
    if (best === undefined || penalty < best.penalty) best = { mask, modules, penalty }
  }
  if (best === undefined) throw new QrEncodeError('QR_BAD_OPTIONS', 'no mask candidate was produced')
  return { size: best.modules.length, version, ecl: options.ecl, mask: best.mask, modules: best.modules }
}

/** 渲染成 SVG 文本（带 4 模块静区）。 */
export function qrSvg(text: string, options: QrOptions, scale: number): string {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new QrEncodeError('QR_BAD_OPTIONS', `scale must be a positive integer, received ${String(scale)}`)
  const matrix = encodeQr(text, options)
  const margin = 4
  const dimension = (matrix.size + margin * 2) * scale
  let path = ''
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.modules[y]![x]) continue
      path += `M${(x + margin) * scale},${(y + margin) * scale}h${scale}v${scale}h-${scale}z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="${dimension}" height="${dimension}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
}

/** 面板直接可用的 data URL（不依赖任何静态资源）。 */
export function qrSvgDataUrl(text: string, options: QrOptions, scale: number): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options, scale), 'utf8').toString('base64')}`
}

/**
 * 扫码绑定专用：内容超长时返回 undefined 让面板退回链接，而不是让整次绑定失败。
 * 绑定流程不该因为一张展示图编码不了而中断。
 */
export function qrSvgForBind(url: string): string | undefined {
  try {
    return qrSvgDataUrl(url, { ecl: 'L', maxVersion: 10 }, 4)
  } catch {
    return undefined
  }
}

/* ------------------------------- 读回（校验） ------------------------------ */

export interface QrBlockLayout {
  numBlocks: number
  eccLen: number
  shortBlockLen: number
  numShortBlocks: number
  totalCodewords: number
}

export function qrBlockLayout(version: number, ecl: QrEcl): QrBlockLayout {
  const index = ECL_INDEX[ecl]
  const numBlocks = NUM_EC_BLOCKS[index]![version]!
  const totalCodewords = Math.floor(numRawDataModules(version) / 8)
  const eccLen = ECC_CODEWORDS_PER_BLOCK[index]![version]!
  return {
    numBlocks,
    eccLen,
    shortBlockLen: Math.floor(totalCodewords / numBlocks),
    numShortBlocks: numBlocks - (totalCodewords % numBlocks),
    totalCodewords,
  }
}

/**
 * 从矩阵里把交织后的码字读回来（测试与排障用）。
 *
 * 它按标准反着走：重建功能图形遮罩 → 去掩码 → 之字形取位。这是对编码器
 * 「写入/掩码/放置」三者是否自洽的独立校验：任何一步写错，读回来的 RS 块
 * 都不可能通过校验子检查。
 */
export function readQrCodewords(matrix: QrMatrix): Uint8Array {
  const builder = new MatrixBuilder(matrix.version)
  drawFunctionPatterns(builder, matrix.version, matrix.ecl, matrix.mask)
  const size = builder.size
  const modules = matrix.modules.map((row) => [...row])
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (builder.isFunction[y]![x]) continue
      if (maskBit(matrix.mask, x, y)) modules[y]![x] = !modules[y]![x]
    }
  }
  const total = Math.floor(numRawDataModules(matrix.version) / 8)
  const result = new Uint8Array(total)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (builder.isFunction[y]![x]) continue
        if (index < total * 8) {
          if (modules[y]![x]) result[index >>> 3] = result[index >>> 3]! | (1 << (7 - (index & 7)))
          index += 1
        }
      }
    }
  }
  return result
}
