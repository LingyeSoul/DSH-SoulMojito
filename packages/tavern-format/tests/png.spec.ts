import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  encodeChunk,
  encodeTextChunk,
  extractCardJson,
  isPng,
  parsePngChunks,
  PngFormatError,
  readTextChunks,
  utf8ToBase64,
  writeTextChunks,
} from '../src/index.js'
import { deflateSync } from 'node:zlib'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))

/** 构造 1x1 灰度最小合法 PNG（chunk/CRC 用本库自举生成）。 */
function minimalPng(): Uint8Array {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])
  const idat = deflateSync(Uint8Array.from([0, 0x42]))
  const total = signature.length + ihdr.length + 12 + idat.length + 12 + 12
  const out = new Uint8Array(total)
  let at = 0
  out.set(signature, at); at += signature.length
  const ihdrChunk = encodeChunk('IHDR', ihdr); out.set(ihdrChunk, at); at += ihdrChunk.length
  const idatChunk = encodeChunk('IDAT', new Uint8Array(idat)); out.set(idatChunk, at); at += idatChunk.length
  const iendChunk = encodeChunk('IEND', new Uint8Array(0)); out.set(iendChunk, at)
  return out
}

describe('png chunk 解析', () => {
  it('最小 PNG 可解析出 IHDR/IDAT/IEND', () => {
    const chunks = parsePngChunks(minimalPng())
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('非 PNG 输入抛 PngFormatError', () => {
    expect(() => parsePngChunks(new Uint8Array([1, 2, 3]))).toThrow(PngFormatError)
  })

  it('CRC 损坏被检测', () => {
    const png = minimalPng()
    const corrupted = png.slice()
    corrupted[corrupted.length - 1]! ^= 0xff // 破坏 IEND 的 CRC
    expect(() => parsePngChunks(corrupted)).toThrow(/bad CRC/)
  })
})

describe('tEXt chunk 读写', () => {
  it('写入 → 读回，同名替换，异名追加于 IEND 前', () => {
    const png = minimalPng()
    const once = writeTextChunks(png, [{ keyword: 'chara', text: utf8ToBase64('{"a":1}') }])
    expect(readTextChunks(once)).toContainEqual({ keyword: 'chara', text: utf8ToBase64('{"a":1}') })

    const twice = writeTextChunks(once, [
      { keyword: 'chara', text: utf8ToBase64('{"a":2}') },
      { keyword: 'ccv3', text: utf8ToBase64('{"b":1}') },
    ])
    const texts = readTextChunks(twice)
    expect(texts.find((t) => t.keyword === 'chara')?.text).toBe(utf8ToBase64('{"a":2}'))
    expect(texts.find((t) => t.keyword === 'ccv3')?.text).toBe(utf8ToBase64('{"b":1}'))
    // 新 chunk 在 IEND 之前
    const types = parsePngChunks(twice).map((c) => c.type)
    expect(types.indexOf('tEXt')).toBeLessThan(types.indexOf('IEND'))
    // 结果仍是合法 PNG（自解析通过）
    expect(isPng(twice)).toBe(true)
  })

  it('encodeTextChunk 与 readTextChunks 对空文本 roundtrip', () => {
    const png = minimalPng()
    const withEmpty = writeTextChunks(png, [{ keyword: 'comment', text: '' }])
    expect(readTextChunks(withEmpty)).toContainEqual({ keyword: 'comment', text: '' })
  })
})

describe('角色卡数据提取', () => {
  it('真实 ExampleCard.png 含可提取卡 JSON', () => {
    const png = new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))
    const json = extractCardJson(png)
    expect(json).toBeTruthy()
    const card = JSON.parse(json!)
    expect(typeof card).toBe('object')
  })

  it('无 chara/ccv3 的 PNG 返回 null', () => {
    expect(extractCardJson(minimalPng())).toBeNull()
  })
})
