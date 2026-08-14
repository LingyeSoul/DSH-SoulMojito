import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TavernStore } from '../src/index.js'
import { decodeCharacterCard, encodeCharx, stableDeepEqual } from '@dsh-tavern/format'

const fixturesDir = fileURLToPath(new URL('../../tavern-format/tests/fixtures', import.meta.url))

function withStore(fn: (store: TavernStore, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tavern-store-'))
    try {
      await fn(await TavernStore.open(dir), dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

const sampleCard = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Test Char', description: 'd', personality: 'p', scenario: 's', first_mes: 'hi',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
  },
}

describe('TavernStore', () => {
  it('角色：JSON 导入 → 列表/读取/导出/删除', withStore(async (store) => {
    const { card } = await store.importCharacter(sampleCard)
    expect(card.data.name).toBe('Test Char')
    expect(await store.listCharacters()).toEqual(['Test Char'])
    const loaded = await store.getCharacter('Test Char')
    expect(loaded?.kind).toBe('json')
    expect(loaded?.card.data.firstMes).toBe('hi')
    const exported = await store.exportCharacter('Test Char')
    expect(JSON.parse(Buffer.from(exported).toString('utf8')).data.name).toBe('Test Char')
    expect(await store.deleteCharacter('Test Char')).toBe(true)
    expect(await store.listCharacters()).toEqual([])
  }))

  it('角色：PNG 原样导入（真实 ExampleCard），导出保留图像与卡数据', withStore(async (store) => {
    const png = new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))
    const { card } = await store.importCharacter(png)
    expect(card.data.name).toBe('ExampleCard')
    const out = await store.exportCharacter('ExampleCard')
    expect(out.length).toBeGreaterThan(100_000) // 图像仍在
    expect((await store.getCharacter('ExampleCard'))?.card.data.name).toBe('ExampleCard')
  }))

  it('角色：CHARX 原样导入并保留 embeded assets', withStore(async (store) => {
    const card = decodeCharacterCard({
      ...sampleCard,
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        ...sampleCard.data,
        assets: [{ type: 'icon', uri: 'embeded://assets/icon/main.png', name: 'main', ext: 'png' }],
      },
    })
    const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const charx = encodeCharx(card, [{ path: 'assets/icon/main.png', data: icon }])
    const imported = await store.importCharacter(charx)
    expect(imported.fileName).toBe('Test Char.charx')
    expect((await store.getCharacter('Test Char'))?.kind).toBe('charx')
    expect(await store.exportCharacter('Test Char')).toEqual(charx)

    await store.importCharacter(sampleCard)
    expect((await store.getCharacter('Test Char'))?.kind).toBe('json')
    expect(await store.listCharacters()).toEqual(['Test Char'])
  }))

  it('世界书：导入 → 读取 roundtrip → 删除', withStore(async (store) => {
    const raw = JSON.parse(readFileSync(`${fixturesDir}/ExampleWorld.json`, 'utf8'))
    const ir = await store.importWorldFile('ExampleWorld', raw)
    expect(ir.entries.length).toBeGreaterThan(3)
    const back = await store.getWorld('ExampleWorld')
    expect(back?.entries.length).toBe(ir.entries.length)
    expect(await store.listWorlds()).toEqual(['ExampleWorld'])
    await store.deleteWorld('ExampleWorld')
    expect(await store.listWorlds()).toEqual([])
  }))

  it('预设：存取原样透传', withStore(async (store) => {
    const preset = JSON.parse(readFileSync(`${fixturesDir}/preset-Default.json`, 'utf8'))
    await store.putPreset('Default', preset)
    expect(await store.listPresets()).toEqual(['Default'])
    expect(stableDeepEqual(await store.getPreset('Default'), preset)).toBe(true)
  }))

  it('聊天：创建 → revision 安全保存 → 重命名/删除', withStore(async (store) => {
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    const chatId = await store.createChat('Test Char', header)
    const initial = await store.getChatSnapshot('Test Char', chatId)
    expect(initial?.chat.messages).toEqual([])
    const messages = [
      { name: 'Test Char', is_user: false, is_system: false, send_date: 'now', mes: 'hello', swipe_id: 0, swipes: ['hello', 'hi'] },
      { name: 'User', is_user: true, is_system: false, send_date: 'now', mes: 'hey' },
    ]
    const savedRevision = await store.saveChat('Test Char', chatId, { header, messages }, initial?.revision)
    const reloaded = await store.getChatSnapshot('Test Char', chatId)
    expect(reloaded?.chat.messages[0]?.swipes).toEqual(['hello', 'hi'])
    expect(reloaded?.revision).toBe(savedRevision)
    await expect(store.saveChat('Test Char', chatId, { header, messages: [] }, initial?.revision))
      .rejects.toThrow('Chat changed in another tab')

    const renamedId = 'renamed.jsonl'
    await store.renameChat('Test Char', chatId, renamedId, savedRevision)
    expect(await store.getChat('Test Char', chatId)).toBeUndefined()
    expect((await store.getChat('Test Char', renamedId))?.messages).toEqual(messages)
    expect(await store.listChats('Test Char')).toEqual([renamedId])
    const renamed = await store.getChatSnapshot('Test Char', renamedId)
    expect(await store.deleteChat('Test Char', renamedId, renamed?.revision)).toBe(true)
    expect(await store.deleteChat('Test Char', renamedId)).toBe(false)
    expect(await store.listChats('Test Char')).toEqual([])
  }))

  it('状态：并发 update 不丢失不同 session 的绑定', withStore(async (store) => {
    await Promise.all([
      store.updateState((state) => ({
        sessionBindings: { ...state.sessionBindings, session_1: { character: 'A', chatId: 'a.jsonl' } },
      })),
      store.updateState((state) => ({
        sessionBindings: { ...state.sessionBindings, session_2: { character: 'B', chatId: 'b.jsonl' } },
      })),
    ])
    expect((await store.getState()).sessionBindings).toEqual({
      session_1: { character: 'A', chatId: 'a.jsonl' },
      session_2: { character: 'B', chatId: 'b.jsonl' },
    })
  }))

  it('聊天：拒绝路径穿越 id', withStore(async (store) => {
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    await expect(store.getChat('Test Char', '../state.json')).rejects.toThrow('invalid chat id')
    await expect(store.saveChat('Test Char', '../state.json', { header, messages: [] })).rejects.toThrow('invalid chat id')
  }))
  it('状态：默认值 → patch 持久化', withStore(async (store) => {
    expect(await store.getState()).toEqual({ activeWorlds: [], sessionBindings: {}, chats: {} })
    await store.patchState({
      activeCharacter: 'ExampleCard',
      activeWorlds: ['ExampleWorld'],
      sessionBindings: { session_1: { character: 'ExampleCard', chatId: 'chat.jsonl' } },
    })
    const state = await store.getState()
    expect(state.activeCharacter).toBe('ExampleCard')
    expect(state.activeWorlds).toEqual(['ExampleWorld'])
    expect(state.sessionBindings.session_1).toEqual({ character: 'ExampleCard', chatId: 'chat.jsonl' })
  }))

  it('persona：存取', withStore(async (store) => {
    await store.putPersona({ name: 'Main', description: 'A traveler' })
    expect(await store.listPersonas()).toEqual(['Main'])
    expect((await store.getPersona('Main'))?.description).toBe('A traveler')
  }))
})
