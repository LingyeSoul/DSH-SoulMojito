/**
 * ZIP writer (`zipArchive`) against the reader it shares a package with: a
 * round-trip of synthetic files, the entry-path gate (absolute / `..` /
 * backslash), and the same three bounds the reader enforces. The writer exists
 * for whole-library backups, so a path it accepted is a path a restore would
 * later have to place on disk — zip slip has to be refused at build time.
 */
import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8 } from 'fflate'
import {
  DEFAULT_ZIP_LIMITS,
  unzipArchive,
  zipArchive,
  ZipArchiveError,
  ZipLimitError,
} from '../src/index.js'

const SMALL_LIMITS = { maxEntries: 4, maxFileBytes: 32, maxTotalBytes: 64 }

describe('zip 打包（zipArchive）', () => {
  it('合成文件往返：嵌套路径、中文名、空文件都按原字节还原', () => {
    const entries = {
      'manifest.json': strToU8('{"format":"fixture"}'),
      'chats/Fixture Hero/2026-01-01.jsonl': strToU8('{"mes":"hello"}\n{"mes":"world"}\n'),
      'characters/Fixture Hero.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      'personas/avatars/Me.png': new Uint8Array([]),
      '世界书/夹具.json': strToU8('{"entries":{}}'),
    }
    const archive = zipArchive(entries, { maxEntries: 32, maxFileBytes: 1024, maxTotalBytes: 4096 })

    expect(archive).toBeInstanceOf(Uint8Array)
    const restored = unzipArchive(archive, { maxEntries: 32, maxFileBytes: 1024, maxTotalBytes: 4096 })
    expect(Object.keys(restored).sort()).toEqual(Object.keys(entries).sort())
    for (const [name, bytes] of Object.entries(entries)) {
      expect(restored[name]).toEqual(bytes)
    }
    expect(strFromU8(restored['chats/Fixture Hero/2026-01-01.jsonl']!)).toContain('world')
  })

  it('同一输入产生同一字节流（条目按路径排序，固定压缩级别）', () => {
    const first = { 'b.json': strToU8('{"b":1}'), 'a.json': strToU8('{"a":1}') }
    const reordered = { 'a.json': strToU8('{"a":1}'), 'b.json': strToU8('{"b":1}') }
    expect(Array.from(zipArchive(first))).toEqual(Array.from(zipArchive(reordered)))
  })

  it('绝对路径与反斜杠分隔符在打包前被拒绝', () => {
    for (const name of ['/etc/passwd', 'C:/Windows/win.ini', 'c:relative.json', 'a\\b.json', '\\\\host\\share\\x']) {
      expect(() => zipArchive({ [name]: strToU8('x') })).toThrow(ZipArchiveError)
    }
    expect(() => zipArchive({ '/etc/passwd': strToU8('x') })).toThrow(/absolute path/)
    expect(() => zipArchive({ 'a\\b.json': strToU8('x') })).toThrow(/backslash/)
    expect(() => zipArchive({ 'C:/x.json': strToU8('x') })).toThrow(/drive letter/)
  })

  it('`..`、`.` 与空路径段被拒绝', () => {
    for (const name of ['../outside.json', 'a/../../b.json', 'a/..', './a.json', 'a//b.json', 'a/', '']) {
      expect(() => zipArchive({ [name]: strToU8('x') }), name).toThrow(ZipArchiveError)
    }
    expect(() => zipArchive({ '../outside.json': strToU8('x') })).toThrow(/parent-directory/)
    expect(() => zipArchive({ 'a//b.json': strToU8('x') })).toThrow(/empty path segment/)
  })

  it('条目数、单文件与总量上限分别拒绝', () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}.json`, strToU8('x')]))
    expect(() => zipArchive(many, SMALL_LIMITS)).toThrow(/over the 4-entry limit/)

    expect(() => zipArchive({ 'big.bin': new Uint8Array(33) }, SMALL_LIMITS)).toThrow(/per-file limit/)

    const total = { 'a.bin': new Uint8Array(32), 'b.bin': new Uint8Array(32) }
    expect(() => zipArchive(total, { maxEntries: 8, maxFileBytes: 32, maxTotalBytes: 48 })).toThrow(/total limit/)
  })

  it('默认上限与解包侧共用同一组常量', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: DEFAULT_ZIP_LIMITS.maxEntries + 1 }, (_, index) => [`f${index}.json`, strToU8('x')]),
    )
    expect(() => zipArchive(tooMany)).toThrow(new RegExp(`over the ${DEFAULT_ZIP_LIMITS.maxEntries}-entry limit`))
    expect(DEFAULT_ZIP_LIMITS.maxEntries).toBe(256)
  })

  it('非 Uint8Array 条目与非法上限被拒绝', () => {
    expect(() => zipArchive({ 'a.json': 'text' as never })).toThrow(/not a Uint8Array/)
    expect(() => zipArchive({ 'a.json': strToU8('x') }, { maxEntries: -1, maxFileBytes: 1, maxTotalBytes: 1 }))
      .toThrow(/invalid zip limit/)
  })

  it('打包后的上限错误仍可被判为限制拒绝（调用方据此回 413）', () => {
    const error = (() => {
      try {
        zipArchive({ 'big.bin': new Uint8Array(33) }, SMALL_LIMITS)
      } catch (cause) {
        return cause
      }
      return undefined
    })()
    // 打包侧的越界是调用错误（解包侧才是 ZipLimitError），两类必须可区分。
    expect(error).toBeInstanceOf(ZipArchiveError)
    expect(error).not.toBeInstanceOf(ZipLimitError)
  })
})
