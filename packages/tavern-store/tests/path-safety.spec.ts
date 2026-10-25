import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TavernStore, safeFileName } from '../src/store.js'
import { importScript } from '../src/scripts.js'

function withRoot(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tavern-path-safety-'))
    try {
      await fn(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

const probeCard = (name: string): object => ({
  spec: 'chara_card_v2',
  specVersion: '2.0',
  data: { name, description: 'probe' },
})

describe('文件路径安全', () => {
  it('safeFileName 拒绝点段（含 trim 后的点段）', () => {
    expect(() => safeFileName('.')).toThrow("invalid file name '.'")
    expect(() => safeFileName('..')).toThrow("invalid file name '..'")
    expect(() => safeFileName(' .. ')).toThrow("invalid file name ' .. '")
    expect(() => safeFileName(' . ')).toThrow("invalid file name ' . '")
    // Empty names keep the legacy placeholder segment.
    expect(safeFileName('  ')).toBe('_unnamed')
  })

  it('角色：名为 .. 的卡导入被拒绝且不落盘', withRoot(async (root) => {
    const store = await TavernStore.open(root)
    await expect(store.importCharacter(probeCard('..'))).rejects.toThrow("invalid file name '..'")
    expect(await store.listCharacters()).toEqual([])
    expect(await readdir(path.join(root, 'characters'))).toEqual([])
  }))

  it('角色：名为 . 的卡导入被拒绝且不落盘', withRoot(async (root) => {
    const store = await TavernStore.open(root)
    await expect(store.importCharacter(probeCard('.'))).rejects.toThrow("invalid file name '.'")
    expect(await store.listCharacters()).toEqual([])
    expect(await readdir(path.join(root, 'characters'))).toEqual([])
  }))

  it('角色：删除点段名字不会触碰数据根或聊天目录', withRoot(async (root) => {
    const sentinel = path.join(root, 'sentinel.txt')
    await writeFile(sentinel, 'keep')
    const store = await TavernStore.open(root)
    const chatCanary = path.join(root, 'chats', 'canary.jsonl')
    await writeFile(chatCanary, '{}')

    await expect(store.deleteCharacter('..')).rejects.toThrow("invalid file name '..'")
    await expect(store.deleteCharacter('.')).rejects.toThrow("invalid file name '.'")

    expect(await readFile(sentinel, 'utf8')).toBe('keep')
    expect(existsSync(root)).toBe(true)
    expect(existsSync(path.join(root, 'chats'))).toBe(true)
    expect(await readFile(chatCanary, 'utf8')).toBe('{}')
  }))

  it('剧本：点段名字不会把 script.json 写到数据根', withRoot(async (root) => {
    await expect(importScript(root, '..', 'hello')).rejects.toThrow("invalid script name '..'")
    await expect(importScript(root, '.', 'hello')).rejects.toThrow("invalid script name '.'")
    expect(existsSync(path.join(root, 'script.json'))).toBe(false)
    expect(existsSync(path.join(root, 'scripts'))).toBe(false)
  }))

  it('角色：普通名字仍可导入、列出与删除', withRoot(async (root) => {
    const store = await TavernStore.open(root)
    await store.importCharacter(probeCard('ExampleCard'))
    expect(await store.listCharacters()).toEqual(['ExampleCard'])
    expect((await store.getCharacter('ExampleCard'))?.card.data.description).toBe('probe')
    expect(await store.deleteCharacter('ExampleCard')).toBe(true)
    expect(await store.listCharacters()).toEqual([])
  }))
})
