/**
 * 数据根解析（2026-10-21 用户需求「存储目录从 dsh/tavern 换成 dsh/soulmojito
 * 并提供旧目录兼容」）：新装写 soulmojito，存量 tavern 原地兼容，双库并存时
 * 新目录优先。纯函数、不经过 apply，独立文件不与 apply memoization 抢 DSH_HOME。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_TAVERN_DATA_DIR, TAVERN_DATA_DIR, tavernDataRoot } from '../src/dsh-home.js'

describe('tavern data root resolution', () => {
  let home: string

  function seed(...segments: string[]) {
    const dir = join(home, ...segments)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{}')
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-root-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('uses soulmojito on a fresh home', () => {
    expect(tavernDataRoot()).toBe(join(home, TAVERN_DATA_DIR))
    expect(tavernDataRoot('workspace')).toBe(join(home, TAVERN_DATA_DIR, 'workspace'))
  })

  it('keeps a populated legacy tavern store in place', () => {
    seed(LEGACY_TAVERN_DATA_DIR, 'characters')
    expect(tavernDataRoot()).toBe(join(home, LEGACY_TAVERN_DATA_DIR))
    expect(tavernDataRoot('mods')).toBe(join(home, LEGACY_TAVERN_DATA_DIR, 'mods'))
  })

  it('prefers soulmojito once it holds data, so an explicit migration wins', () => {
    seed(LEGACY_TAVERN_DATA_DIR, 'characters')
    seed(TAVERN_DATA_DIR, 'characters')
    expect(tavernDataRoot()).toBe(join(home, TAVERN_DATA_DIR))
  })

  it('ignores an empty soulmojito directory so it cannot shadow legacy data', () => {
    seed(LEGACY_TAVERN_DATA_DIR, 'characters')
    mkdirSync(join(home, TAVERN_DATA_DIR))
    expect(tavernDataRoot()).toBe(join(home, LEGACY_TAVERN_DATA_DIR))
  })
})
