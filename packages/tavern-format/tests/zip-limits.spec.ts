import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, zipSync } from 'fflate'
import { DEFAULT_ZIP_LIMITS, unzipArchive, ZipArchiveError, ZipLimitError } from '../src/index.js'

const SMALL_LIMITS = { maxEntries: 8, maxFileBytes: 1024, maxTotalBytes: 2048 }

describe('zip 解包上限（解压前拒绝）', () => {
  it('声明原尺寸超过单文件上限的 deflate bomb 在解压前抛错', () => {
    // 64 KiB of one byte compresses to a few hundred bytes: the central
    // directory already declares the 64 KiB original size, so the filter can
    // reject it before fflate allocates/inflates the payload.
    const zip = zipSync({ 'bomb.txt': strToU8('a'.repeat(64 * 1024)) })
    expect(zip.length).toBeLessThan(1024)

    expect(() => unzipArchive(zip, SMALL_LIMITS)).toThrow(ZipArchiveError)
    expect(() => unzipArchive(zip, SMALL_LIMITS)).toThrow(/per-file limit/)
    const error = (() => {
      try {
        unzipArchive(zip, SMALL_LIMITS)
      } catch (cause) {
        return cause
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(ZipLimitError)
    expect((error as ZipLimitError).kind).toBe('file-size')
    expect((error as ZipLimitError).entry).toBe('bomb.txt')
  })

  it('正常小包照常解包（显式上限与默认上限）', () => {
    const zip = zipSync({
      'game.json': strToU8('{"id":"small"}'),
      'engine.mjs': strToU8('export const meta = {}'),
    })
    const files = unzipArchive(zip, SMALL_LIMITS)
    expect(strFromU8(files['game.json']!)).toBe('{"id":"small"}')
    expect(Object.keys(files).sort()).toEqual(['engine.mjs', 'game.json'])

    const withDefaults = unzipArchive(zip)
    expect(Object.keys(withDefaults).sort()).toEqual(['engine.mjs', 'game.json'])
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBe(256)
    expect(DEFAULT_ZIP_LIMITS.maxFileBytes).toBe(64 * 1024 * 1024)
    expect(DEFAULT_ZIP_LIMITS.maxTotalBytes).toBe(128 * 1024 * 1024)
  })

  it('条目数上限与总量上限分别拒绝', () => {
    const many = zipSync({
      'a.txt': strToU8('a'),
      'b.txt': strToU8('b'),
      'c.txt': strToU8('c'),
    })
    expect(() => unzipArchive(many, { maxEntries: 2, maxFileBytes: 1024, maxTotalBytes: 2048 }))
      .toThrow(/more than 2 entries/)

    const total = zipSync({
      'a.txt': strToU8('a'.repeat(800)),
      'b.txt': strToU8('b'.repeat(800)),
    })
    expect(() => unzipArchive(total, { maxEntries: 8, maxFileBytes: 1024, maxTotalBytes: 1200 }))
      .toThrow(/total limit/)
  })
})
