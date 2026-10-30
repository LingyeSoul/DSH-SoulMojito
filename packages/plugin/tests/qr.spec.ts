import { describe, expect, it } from 'vitest'
import {
  QrEncodeError,
  encodeQr,
  qrBlockLayout,
  qrByteCapacity,
  qrSvgDataUrl,
  readQrCodewords,
  rsSyndromesAreZero,
  type QrEcl,
} from '../src/im/qr.js'

/** 版本 1–10 在四个纠错等级下的 byte 模式容量（标准表）。 */
const CAPACITY: Readonly<Record<QrEcl, readonly number[]>> = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
}

/** 把交织后的码字按块的短/长规则拆开，用于校验子检查。 */
function deinterleave(codewords: Uint8Array, version: number, ecl: QrEcl): Uint8Array[] {
  const layout = qrBlockLayout(version, ecl)
  const blocks: Uint8Array[] = Array.from({ length: layout.numBlocks }, () => new Uint8Array(0))
  const dataLens = Array.from({ length: layout.numBlocks }, (_unused, block) =>
    layout.shortBlockLen - layout.eccLen + (block < layout.numShortBlocks ? 0 : 1))
  const maxDataLen = Math.max(...dataLens)
  const split: number[][] = Array.from({ length: layout.numBlocks }, () => [])
  let cursor = 0
  for (let position = 0; position < maxDataLen; position += 1) {
    for (let block = 0; block < layout.numBlocks; block += 1) {
      if (position < dataLens[block]!) {
        split[block]!.push(codewords[cursor]!)
        cursor += 1
      }
    }
  }
  for (let position = 0; position < layout.eccLen; position += 1) {
    for (let block = 0; block < layout.numBlocks; block += 1) {
      split[block]!.push(codewords[cursor]!)
      cursor += 1
    }
  }
  for (let block = 0; block < layout.numBlocks; block += 1) blocks[block] = Uint8Array.from(split[block]!)
  return blocks
}

/** 从矩阵读回 byte 模式的原始载荷。 */
function readPayload(matrix: ReturnType<typeof encodeQr>): Uint8Array {
  const blocks = deinterleave(readQrCodewords(matrix), matrix.version, matrix.ecl)
  const layout = qrBlockLayout(matrix.version, matrix.ecl)
  const data: number[] = []
  for (let block = 0; block < blocks.length; block += 1) {
    const dataLen = layout.shortBlockLen - layout.eccLen + (block < layout.numShortBlocks ? 0 : 1)
    for (let index = 0; index < dataLen; index += 1) data.push(blocks[block]![index]!)
  }
  const bits: number[] = []
  for (const byte of data) for (let bit = 7; bit >= 0; bit -= 1) bits.push((byte >>> bit) & 1)
  const take = (start: number, length: number): number => {
    let value = 0
    for (let index = 0; index < length; index += 1) value = (value << 1) | bits[start + index]!
    return value
  }
  expect(take(0, 4)).toBe(0b0100)
  const countBits = matrix.version <= 9 ? 8 : 16
  const length = take(4, countBits)
  const start = 4 + countBits
  const payload = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    payload[index] = take(start + index * 8, 8)
  }
  return payload
}

describe('qr capacity table', () => {
  for (const ecl of ['L', 'M', 'Q', 'H'] as const) {
    it(`matches the standard byte capacities at EC ${ecl}`, () => {
      const actual = Array.from({ length: 10 }, (_unused, index) => qrByteCapacity(index + 1, ecl))
      expect(actual).toEqual([...CAPACITY[ecl]])
    })
  }
})

describe('qr encoding', () => {
  it('round-trips the payload for every version at EC L', () => {
    for (let version = 1; version <= 10; version += 1) {
      const length = qrByteCapacity(version, 'L')
      const text = 'https://example.invalid/'.padEnd(length, 'a').slice(0, length)
      const matrix = encodeQr(text, { ecl: 'L', maxVersion: version })
      expect(matrix.version).toBe(version)
      expect(new TextDecoder().decode(readPayload(matrix))).toBe(text)
    }
  })

  it('round-trips a realistic WeChat bind URL', () => {
    const url = 'https://weixin.qq.com/x/abcdefghijklmnop?bot_type=3&ticket=0123456789abcdef'
    const matrix = encodeQr(url, { ecl: 'L', maxVersion: 10 })
    expect(matrix.version).toBeLessThanOrEqual(10)
    expect(new TextDecoder().decode(readPayload(matrix))).toBe(url)
  })

  it('produces Reed-Solomon blocks with all syndromes zero', () => {
    const matrix = encodeQr('https://example.invalid/bind?ticket=42', { ecl: 'L', maxVersion: 10 })
    const layout = qrBlockLayout(matrix.version, matrix.ecl)
    const blocks = deinterleave(readQrCodewords(matrix), matrix.version, matrix.ecl)
    expect(blocks).toHaveLength(layout.numBlocks)
    for (const block of blocks) {
      expect(rsSyndromesAreZero(block, layout.eccLen)).toBe(true)
    }
  })

  it('places the three finder patterns and the dark module', () => {
    const matrix = encodeQr('https://example.invalid/bind', { ecl: 'L', maxVersion: 10 })
    const dark = (x: number, y: number): boolean => matrix.modules[y]![x]!
    for (const [originX, originY] of [[0, 0], [matrix.size - 7, 0], [0, matrix.size - 7]]) {
      const x = originX!
      const y = originY!
      // 7x7 定位图形：外环实心、内环留白、中心 3x3 实心。
      expect(dark(x, y)).toBe(true)
      expect(dark(x + 1, y + 1)).toBe(false)
      expect(dark(x + 3, y + 3)).toBe(true)
      expect(dark(x + 6, y)).toBe(true)
      expect(dark(x + 6, y + 6)).toBe(true)
    }
    expect(dark(8, matrix.size - 8)).toBe(true)
  })

  it('rejects payloads longer than the allowed version', () => {
    expect(() => encodeQr('x'.repeat(18), { ecl: 'L', maxVersion: 1 })).toThrow(QrEncodeError)
  })

  it('renders an SVG data URL that the panel can use directly', () => {
    const url = qrSvgDataUrl('https://example.invalid/bind', { ecl: 'L', maxVersion: 10 }, 4)
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const svg = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toContain('#000000')
  })

  it('rejects a non-positive scale', () => {
    expect(() => qrSvgDataUrl('https://example.invalid', { ecl: 'L', maxVersion: 10 }, 0)).toThrow(/scale/)
  })
})
