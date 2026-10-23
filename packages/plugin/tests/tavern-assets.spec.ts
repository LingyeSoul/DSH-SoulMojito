import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectRegexScripts, collectWorldInfoBooks } from '../src/tavern-assets.js'
import { decodeCharacterCard, normalizeEntry, RegexPlacement } from '../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../tavern-script/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Carrier'

describe('collectWorldInfoBooks', () => {
  let home: string
  let store: TavernStore
  let chatId: string

  const characterCard = (extensions: Record<string, unknown>) => decodeCharacterCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER, description: '', personality: '', scenario: '', first_mes: '',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      character_book: {
        entries: [
          { id: 0, keys: [], content: 'embedded constant lore', enabled: true, insertion_order: 100, constant: true },
        ],
      },
      extensions,
    },
  })

  function booksFor(extensions: Record<string, unknown>, activeWorlds: string[] = []) {
    return collectWorldInfoBooks(store, { activeWorlds }, CHARACTER, { card: characterCard(extensions) })
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'tavern-assets-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importWorldFile('Linked Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: '', content: 'linked lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
    await store.importWorldFile('Active Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: '', content: 'active lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
    chatId = await store.createChat(CHARACTER, { user_name: 'User', character_name: CHARACTER, chat_metadata: {} })
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('链接世界已导入时只保留世界书文件，不叠加内嵌书', async () => {
    const books = await booksFor({ world: 'Linked Lore' }, ['Active Lore'])
    expect(books.map((book) => book.name).sort()).toEqual(['Active Lore', 'Linked Lore'])
  })

  it('链接世界缺失时回退到卡内嵌书', async () => {
    const books = await booksFor({ world: 'Missing Lore' })
    expect(books).toHaveLength(1)
    expect(books[0]?.name).toBe(`${CHARACTER}:embedded`)
    expect(books[0]?.entries[0]?.content).toBe('embedded constant lore')
  })

  it('无链接时同样回退到卡内嵌书', async () => {
    const books = await booksFor({})
    expect(books).toHaveLength(1)
    expect(books[0]?.name).toBe(`${CHARACTER}:embedded`)
  })

  it('activeWorlds 中的世界书照常并入', async () => {
    const books = await booksFor({}, ['Active Lore'])
    expect(books.map((book) => book.name)).toEqual([`${CHARACTER}:embedded`, 'Active Lore'])
  })

  it('worldFollowsCharacter 关闭时链接世界与卡内嵌书都不注入', async () => {
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: ['Active Lore'], worldFollowsCharacter: false },
      CHARACTER,
      { card: characterCard({ world: 'Linked Lore' }) },
    )
    expect(books.map((book) => book.name)).toEqual(['Active Lore'])
  })

  it('worldFollowsCharacter 关闭时无链接卡的卡内嵌书同样不注入', async () => {
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: [], worldFollowsCharacter: false },
      CHARACTER,
      { card: characterCard({}) },
    )
    expect(books).toEqual([])
  })

  it('disabledAutoWorlds 停用链接书时不回落内嵌书（停用要真的生效）', async () => {
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: [], disabledAutoWorlds: ['Linked Lore'] },
      CHARACTER,
      { card: characterCard({ world: 'Linked Lore' }) },
    )
    expect(books).toEqual([])
  })

  it('手动 activeWorlds 优先于 disabledAutoWorlds', async () => {
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: ['Linked Lore'], disabledAutoWorlds: ['Linked Lore'] },
      CHARACTER,
      { card: characterCard({ world: 'Linked Lore' }) },
    )
    expect(books.map((book) => book.name)).toEqual(['Linked Lore'])
  })

  it('带 chatId 时会话副本优先于基础世界书（并视为已导入，不叠加内嵌书）', async () => {
    await store.putChatWorld(CHARACTER, chatId, {
      name: 'Linked Lore',
      entries: [normalizeEntry({ uid: 0, key: [], content: 'session copy lore', constant: true })],
    })
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: [] },
      CHARACTER,
      { card: characterCard({ world: 'Linked Lore' }) },
      chatId,
    )
    expect(books.map((book) => book.name)).toEqual(['Linked Lore'])
    expect(books[0]?.entries[0]?.content).toBe('session copy lore')
    // 基础资产不受影响
    expect((await store.getWorld('Linked Lore'))?.entries[0]?.content).toBe('linked lore')
  })

  it('不带 chatId 时保持原行为：仍然读基础世界书', async () => {
    const books = await collectWorldInfoBooks(
      store,
      { activeWorlds: [] },
      CHARACTER,
      { card: characterCard({ world: 'Linked Lore' }) },
    )
    expect(books.map((book) => book.name)).toEqual(['Linked Lore'])
    expect(books[0]?.entries[0]?.content).toBe('linked lore')
  })
})

describe('collectRegexScripts', () => {
  const script = (scriptName: string, overrides: Record<string, unknown> = {}) => ({
    id: `regex-${scriptName}`, scriptName, findRegex: 'x', replaceString: 'y', trimStrings: [], placement: [2],
    disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false,
    minDepth: null, maxDepth: null, ...overrides,
  })
  const characterWithRegex = (cardScripts: unknown, name = CHARACTER) => ({
    card: decodeCharacterCard({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name, description: '', personality: '', scenario: '', first_mes: '',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: { regex_scripts: cardScripts },
      },
    }),
  })

  it('卡内嵌脚本并入全局脚本之后', () => {
    const state = { regexScripts: [script('Global', { findRegex: 'g' })] }
    const scripts = collectRegexScripts(state, characterWithRegex([script('Card', { findRegex: 'c' })]))
    expect(scripts.map((item) => [item.scriptName, item.findRegex])).toEqual([['Global', 'g'], ['Card', 'c']])
  })

  it('卡内脚本按卡内数组顺序恢复链式顺序（导入顺序被打乱也不影响）', () => {
    // 真实回归：state 里警告脚本先于「变量更新校验-放行」，警告先吃掉
    // <StatusPlaceHolderImpl/>，状态栏永远显示「AI 遗漏变量更新」。
    const state = {
      regexScripts: [
        script('Warning', { id: 'w', findRegex: 'impl' }),
        script('Global', { id: 'g', findRegex: 'g' }),
        script('Pass', { id: 'p', findRegex: 'impl' }),
        script('Status', { id: 's', findRegex: 'ready' }),
      ],
      regexScriptOwners: { w: CHARACTER, p: CHARACTER, s: CHARACTER },
    }
    const card = characterWithRegex([
      script('Pass', { findRegex: 'impl' }),
      script('Status', { findRegex: 'ready' }),
      script('Warning', { findRegex: 'impl' }),
    ])
    expect(collectRegexScripts(state, card).map((item) => item.scriptName))
      .toEqual(['Global', 'Pass', 'Status', 'Warning'])
  })

  it('变量更新校验先放行占位符，警告脚本不再抢跑', () => {
    const pass = script('[MVU] 变量更新校验-放行', {
      id: 'pass',
      markdownOnly: true,
      findRegex: '/(<\\/UpdateVariable>[\\s\\S]*?)<StatusPlaceHolderImpl\\/>/g',
      replaceString: '$1<StatusPlaceHolderREADY/>',
    })
    const warning = script('[变量]变量未更新警告', {
      id: 'warning',
      markdownOnly: true,
      findRegex: '<StatusPlaceHolderImpl\\/>',
      replaceString: 'WARNING',
    })
    const state = {
      regexScripts: [warning, pass],
      regexScriptOwners: { warning: CHARACTER, pass: CHARACTER },
    }
    const card = characterWithRegex([pass, warning])
    const scripts = collectRegexScripts(state, card)
    const rendered = applyRegexScripts(
      'prose\n</UpdateVariable>\n<StatusPlaceHolderImpl/>',
      scripts,
      RegexPlacement.AI_OUTPUT,
      { expand: (value) => value },
      { depth: 0 },
    )
    expect(rendered).toContain('<StatusPlaceHolderREADY/>')
    expect(rendered).not.toContain('WARNING')
  })

  it('同名脚本以已导入的全局版本为准，不重复应用', () => {
    const state = { regexScripts: [script('Shared', { findRegex: 'imported' })] }
    const scripts = collectRegexScripts(state, characterWithRegex([script('Shared', { findRegex: 'card' }), script('Only Card')]))
    expect(scripts.map((item) => [item.scriptName, item.findRegex])).toEqual([['Shared', 'imported'], ['Only Card', 'x']])
  })

  it('非法卡内嵌脚本不影响全局脚本', () => {
    const state = { regexScripts: [script('Global')] }
    const scripts = collectRegexScripts(state, characterWithRegex([{ scriptName: 'Broken' }]))
    expect(scripts.map((item) => item.scriptName)).toEqual(['Global'])
  })

  it('卡级脚本只在归属角色卡的会话里生效，无归属脚本保持全局', () => {
    const state = {
      regexScripts: [
        script('Global', { id: 'g' }),
        script('Owned A', { id: 'a' }),
        script('Owned B', { id: 'b' }),
      ],
      regexScriptOwners: { a: 'Card A', b: 'Card B' },
    }
    const inA = collectRegexScripts(state, characterWithRegex([], 'Card A'))
    expect(inA.map((item) => item.scriptName)).toEqual(['Global', 'Owned A'])
    const inB = collectRegexScripts(state, characterWithRegex([], 'Card B'))
    expect(inB.map((item) => item.scriptName)).toEqual(['Global', 'Owned B'])
  })

  it('同名脚本分属两张卡时各取自己那条（识别修复）', () => {
    const state = {
      regexScripts: [
        script('Shared Status', { id: 'a', findRegex: 'from a' }),
        script('Shared Status', { id: 'b', findRegex: 'from b' }),
      ],
      regexScriptOwners: { a: 'Card A', b: 'Card B' },
    }
    expect(collectRegexScripts(state, characterWithRegex([], 'Card A')).map((item) => item.findRegex)).toEqual(['from a'])
    expect(collectRegexScripts(state, characterWithRegex([], 'Card B')).map((item) => item.findRegex)).toEqual(['from b'])
    expect(collectRegexScripts(state, characterWithRegex([], 'Card C'))).toEqual([])
  })

  it('预设级脚本只在所属预设激活时生效', () => {
    const state = {
      regexScripts: [script('Global', { id: 'g' }), script('Preset Owned', { id: 'p' })],
      regexScriptPresetOwners: { p: 'Preset A' },
      activePreset: 'Preset A',
    }
    expect(collectRegexScripts(state, characterWithRegex([])).map((item) => item.scriptName))
      .toEqual(['Global', 'Preset Owned'])
    expect(collectRegexScripts({ ...state, activePreset: 'Preset B' }, characterWithRegex([])).map((item) => item.scriptName))
      .toEqual(['Global'])
    expect(collectRegexScripts({ ...state, activePreset: undefined }, characterWithRegex([])).map((item) => item.scriptName))
      .toEqual(['Global'])
  })

  it('卡与预设同时登记同一脚本时任一来源命中即生效', () => {
    const state = {
      regexScripts: [script('Shared', { id: 's' })],
      regexScriptOwners: { s: 'Card A' },
      regexScriptPresetOwners: { s: 'Preset A' },
      activePreset: 'Preset A',
    }
    expect(collectRegexScripts(state, characterWithRegex([], 'Card B')).map((item) => item.scriptName))
      .toEqual(['Shared'])
    expect(collectRegexScripts({ ...state, activePreset: 'Preset B' }, characterWithRegex([], 'Card A')).map((item) => item.scriptName))
      .toEqual(['Shared'])
    expect(collectRegexScripts({ ...state, activePreset: 'Preset B' }, characterWithRegex([], 'Card B')).map((item) => item.scriptName))
      .toEqual([])
  })

  it('别的卡占用的全局同名脚本被过滤后，当前卡的卡内版本仍会并入', () => {
    const state = {
      regexScripts: [script('Shared', { id: 'shared', findRegex: 'owned by b' })],
      regexScriptOwners: { shared: 'Card B' },
    }
    const scripts = collectRegexScripts(
      state,
      characterWithRegex([script('Shared', { findRegex: 'from card a' })], 'Card A'),
    )
    expect(scripts.map((item) => [item.scriptName, item.findRegex])).toEqual([['Shared', 'from card a']])
  })
})

describe('buildAgentTavernPreloadSnapshot', () => {
  it('卡片字段在写入快照前完成宏展开', async () => {
    const { buildAgentTavernPreloadSnapshot } = await import('../src/tavern-assets.js')
    const card = decodeCharacterCard({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: CHARACTER, description: '{{char}} meets {{user}}.', personality: '', scenario: '', first_mes: 'Hi {{user}}!',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const snapshot = await buildAgentTavernPreloadSnapshot(
      { getWorld: async () => undefined }, { activeWorlds: [] }, CHARACTER, { card },
      (text) => text.replaceAll('{{char}}', 'Carrier').replaceAll('{{user}}', 'Alice'))
    expect(snapshot).toContain('[character.description]\nCarrier meets Alice.')
    expect(snapshot).toContain('[character.first_message]\nHi Alice!')
  })
})
