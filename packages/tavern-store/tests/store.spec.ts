import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore, TavernStore, VariableStore, normalizeMemoryEmbedding } from '../src/index.js'
import { decodeCharacterCard, encodeCharx, encodeCharacterCardPng, stableDeepEqual } from '@dsh-tavern/format'

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

  it('writeAtomic 对 Windows 瞬态 rename 占用（EPERM）做有界退避重试', withStore(async (store) => {
    // 背景：getState 的 readFile 与 updateState 的 rename 不互斥，Windows 上
    // rename 落到被打开的 state.json 上抛 EPERM（tavern-command 预热用例的
    // 间歇红）。此处确定性模拟：首次 rename 抛 EPERM，重试应成功且状态落盘。
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async () => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    try {
      await store.patchState({ activeCharacter: 'Retry Char' })
      expect(rename).toHaveBeenCalledTimes(2)
      expect((await store.getState()).activeCharacter).toBe('Retry Char')
    } finally {
      rename.mockRestore()
    }
  }))

  it('变更水位：资产写入推进、无写入稳定、聊天写入不参与', withStore(async (store) => {
    const initial = await store.storeRevision()
    expect(await store.storeRevision()).toBe(initial)
    await store.importWorldFile('Watermark Lore', {
      entries: {
        '0': {
          uid: 0, key: [], keysecondary: [], comment: 'watermark', content: 'lore',
          constant: true, selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    const afterWorld = await store.storeRevision()
    expect(afterWorld).not.toBe(initial)
    await store.importCharacter(sampleCard)
    const afterCharacter = await store.storeRevision()
    expect(afterCharacter).not.toBe(afterWorld)
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    await store.createChat('Test Char', header, [])
    // 聊天有各自的 CAS revision 通道，不推资产水位（避免面板为聊天写入空转重取）
    expect(await store.storeRevision()).toBe(afterCharacter)
  }))

  it('角色：删除连同聊天目录移除', withStore(async (store, dir) => {
    await store.importCharacter(sampleCard)
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    await store.createChat('Test Char', header, [
      { name: 'Test Char', is_user: false, is_system: false, send_date: 'now', mes: 'hello' },
    ])
    expect(await store.listChats('Test Char')).toHaveLength(1)
    expect(await store.deleteCharacter('Test Char')).toBe(true)
    expect(await store.listChats('Test Char')).toEqual([])
    const { existsSync } = await import('node:fs')
    expect(existsSync(path.join(dir, 'chats', 'Test Char'))).toBe(false)
    // 卡不存在时为 no-op，不误删
    expect(await store.deleteCharacter('Ghost')).toBe(false)
  }))

  it('角色：PNG 原样导入（真实 ExampleCard），导出保留图像与卡数据', withStore(async (store) => {
    const png = new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))
    const { card } = await store.importCharacter(png)
    expect(card.data.name).toBe('ExampleCard')
    const out = await store.exportCharacter('ExampleCard')
    expect(out.length).toBeGreaterThan(100_000) // 图像仍在
    expect((await store.getCharacter('ExampleCard'))?.card.data.name).toBe('ExampleCard')
  }))

  it('角色：按面板 IR 保存并保留原始 PNG 容器', withStore(async (store) => {
    const png = new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))
    const imported = await store.importCharacter(png)
    const saved = await store.updateCharacter('ExampleCard', {
      spec: imported.card.spec,
      specVersion: imported.card.specVersion,
      data: { ...imported.card.data, description: 'Edited from panel' },
    })
    expect(saved.kind).toBe('png')
    expect(saved.card.data.description).toBe('Edited from panel')
    const exported = await store.exportCharacter('ExampleCard')
    expect(exported.length).toBeGreaterThan(100_000)
    expect(decodeCharacterCard(exported).data.description).toBe('Edited from panel')
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

  it('角色：内嵌角色书自动物化为世界书并写回 extensions.world 链接', withStore(async (store) => {
    const card = {
      ...sampleCard,
      data: {
        ...sampleCard.data,
        character_book: {
          name: 'Carrier Lore',
          entries: [{ id: 0, keys: ['gate'], content: 'embedded lore', enabled: true, insertion_order: 100 }],
        },
      },
    }
    const { importedWorld, card: ir } = await store.importCharacter(card)
    expect(importedWorld).toBe('Carrier Lore')
    expect(await store.listWorlds()).toEqual(['Carrier Lore'])
    expect((await store.getWorld('Carrier Lore'))?.entries).toHaveLength(1)
    expect(ir.data.extensions['world']).toBe('Carrier Lore')
    // 落盘的卡重新读取后仍携带链接
    expect((await store.getCharacter('Test Char'))?.card.data.extensions['world']).toBe('Carrier Lore')
  }))

  it('角色：内嵌书物化沿用已有链接名并覆盖同名世界书（对齐 ST 覆盖语义）', withStore(async (store) => {
    await store.importWorldFile('Linked Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: '', content: 'manual lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
    const card = {
      ...sampleCard,
      data: {
        ...sampleCard.data,
        character_book: {
          entries: [{ id: 0, keys: [], content: 'embedded lore', enabled: true, insertion_order: 100 }],
        },
        extensions: { world: 'Linked Lore' },
      },
    }
    const { importedWorld, card: ir } = await store.importCharacter(card)
    expect(importedWorld).toBe('Linked Lore')
    expect(ir.data.extensions['world']).toBe('Linked Lore')
    expect(await store.listWorlds()).toEqual(['Linked Lore'])
    expect((await store.getWorld('Linked Lore'))?.entries[0]?.content).toBe('embedded lore')
  }))

  it('角色：PNG 内嵌书物化后图像保留、链接写回 chunk', withStore(async (store) => {
    const png = new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))
    const base = decodeCharacterCard(png)
    const withBook = {
      ...base,
      data: {
        ...base.data,
        characterBook: {
          name: 'PNG Lore',
          entries: [{ id: 0, keys: ['k'], content: 'png lore', enabled: true, insertion_order: 100 }],
        },
        extensions: {},
      },
    }
    const { importedWorld } = await store.importCharacter(encodeCharacterCardPng(withBook, png))
    expect(importedWorld).toBe('PNG Lore')
    expect(await store.listWorlds()).toContain('PNG Lore')
    const exported = await store.exportCharacter('ExampleCard')
    expect(exported.length).toBeGreaterThan(100_000)
    expect(decodeCharacterCard(exported).data.extensions['world']).toBe('PNG Lore')
    expect(decodeCharacterCard(exported).data.characterBook?.entries).toHaveLength(1)
  }))

  it('角色：卡内嵌 regex_scripts 物化为全局脚本，重名覆盖且非法跳过', withStore(async (store) => {
    const card = {
      ...sampleCard,
      data: {
        ...sampleCard.data,
        extensions: {
          regex_scripts: [
            { scriptName: 'Strip Thoughts', findRegex: '<think>[\\s\\S]*?</think>', replaceString: '', placement: [2], markdownOnly: true },
            { scriptName: 'Tame Input', findRegex: '你', replaceString: '您', placement: [1] },
          ],
        },
      },
    }
    const { importedRegex } = await store.importCharacter(card)
    expect(importedRegex).toBe(2)
    const state = await store.getState()
    expect(state.regexScripts.map((script) => script.scriptName)).toEqual(['Strip Thoughts', 'Tame Input'])
    expect(state.regexScripts[0]?.placement).toEqual([2])
    expect(state.regexScripts[0]?.markdownOnly).toBe(true)

    // 重导入同名脚本覆盖，不产生重复
    await store.importCharacter({
      ...card,
      data: {
        ...card.data,
        extensions: { regex_scripts: [{ scriptName: 'Strip Thoughts', findRegex: '<think>.*?</think>', replaceString: '', placement: [2] }] },
      },
    })
    const updated = await store.getState()
    expect(updated.regexScripts).toHaveLength(2)
    expect(updated.regexScripts.find((script) => script.scriptName === 'Strip Thoughts')?.findRegex).toBe('<think>.*?</think>')

    // 非法脚本不阻断角色导入
    const broken = await store.importCharacter({
      ...sampleCard,
      data: { ...sampleCard.data, name: 'Broken Regex Char', extensions: { regex_scripts: [{ scriptName: 'Bad', findRegex: '' }] } },
    })
    expect(broken.importedRegex).toBe(0)
    expect((await store.getState()).regexScripts).toHaveLength(2)
  }))

  it('状态：importRegexScripts 按 scriptName 合并且保持既有顺序', withStore(async (store) => {
    await store.updateState(() => ({
      regexScripts: [{ id: 'a', scriptName: 'A', findRegex: 'a', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null }],
    }))
    const imported = await store.importRegexScripts([
      { scriptName: 'B', findRegex: 'b', replaceString: '' },
      { scriptName: 'A', findRegex: 'a2', replaceString: '' },
    ])
    expect(imported).toBe(2)
    const state = await store.getState()
    expect(state.regexScripts.map((script) => [script.scriptName, script.findRegex])).toEqual([['A', 'a2'], ['B', 'b']])
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

  it('世界书/预设：导出返回原生 JSON', withStore(async (store) => {
    const raw = JSON.parse(readFileSync(`${fixturesDir}/ExampleWorld.json`, 'utf8'))
    await store.importWorldFile('ExampleWorld', raw)
    expect(JSON.parse(Buffer.from(await store.exportWorld('ExampleWorld')).toString('utf8')).entries).toBeTruthy()
    const preset = JSON.parse(readFileSync(`${fixturesDir}/preset-Default.json`, 'utf8'))
    await store.putPreset('Default', preset)
    expect(JSON.parse(Buffer.from(await store.exportPreset('Default')).toString('utf8')).prompts).toHaveLength(preset.prompts.length)
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
      session_1: { architecture: 'st', character: 'A', chatId: 'a.jsonl' },
      session_2: { architecture: 'st', character: 'B', chatId: 'b.jsonl' },
    })
  }))

  it('聊天：拒绝路径穿越 id', withStore(async (store) => {
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    await expect(store.getChat('Test Char', '../state.json')).rejects.toThrow('invalid chat id')
    await expect(store.saveChat('Test Char', '../state.json', { header, messages: [] })).rejects.toThrow('invalid chat id')
  }))
  it('状态：默认值 → patch 持久化', withStore(async (store) => {
    expect(await store.getState()).toEqual({
      activeWorlds: [], sessionBindings: {}, defaultArchitecture: 'agent-tavern', defaultContextMode: 'dsh-native',
      agentTavernPreloadAssets: false, agentTavernAllowGlobalWrites: false, worldFollowsCharacter: true,
      cardWorkbenchPresetEnabled: false, agentNovelPresetEnabled: false,
      modelSelections: {}, chats: {}, regexScripts: [], scriptGlobals: {},
      // Mod 三层开关的前两层（提案 0015 §3.2）：双默认 false。
      modsEnabled: false, mods: { enabled: {} },
    })
    await store.patchState({
      activeCharacter: 'ExampleCard',
      activeWorlds: ['ExampleWorld'],
      sessionBindings: { session_1: { character: 'ExampleCard', chatId: 'chat.jsonl' } },
    })
    const state = await store.getState()
    expect(state.activeCharacter).toBe('ExampleCard')
    expect(state.activeWorlds).toEqual(['ExampleWorld'])
    expect(state.sessionBindings.session_1).toEqual({ architecture: 'st', character: 'ExampleCard', chatId: 'chat.jsonl' })
  }))

  it('状态：世界书跟随角色卡开关默认开启，旧 state 文件缺字段补默认、显式 false 保留', withStore(async (store, dir) => {
    expect((await store.getState()).worldFollowsCharacter).toBe(true)
    // 旧版 state.json 没有该字段：归一化补默认 true，其余字段不受影响
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ activeWorlds: ['ExampleWorld'] }))
    expect((await store.getState()).worldFollowsCharacter).toBe(true)
    expect((await store.getState()).activeWorlds).toEqual(['ExampleWorld'])
    // 显式关闭持久化后重开仍保留
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ worldFollowsCharacter: false }))
    expect((await store.getState()).worldFollowsCharacter).toBe(false)
  }))

  it('状态：模型选择按 session 存取并随旧 state 文件补默认', withStore(async (store) => {
    await store.updateState((state) => ({
      modelSelections: { ...state.modelSelections, session_1: { provider: 'deepseek', model: 'deepseek-chat' } },
    }))
    await store.updateState((state) => ({
      modelSelections: { ...state.modelSelections, session_2: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' } },
    }))
    expect((await store.getState()).modelSelections).toEqual({
      session_1: { provider: 'deepseek', model: 'deepseek-chat' },
      session_2: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    })
  }))

  it('状态：Mod 开关双默认 false，旧 state 文件补默认、显式 true 保留、非 true 项过滤', withStore(async (store, dir) => {
    // 旧版 state.json 没有 mods 字段：两层开关都补默认关
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ activeWorlds: ['ExampleWorld'] }))
    expect(await store.getState()).toMatchObject({ modsEnabled: false, mods: { enabled: {} } })
    // 显式开启持久化保留；enabled 表里只保留显式 true 的项（手改容错）
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      modsEnabled: true,
      mods: { enabled: { 'dsh-tavern.asset-stats': true, 'ghost.mod': false, broken: 'yes' } },
    }))
    const state = await store.getState()
    expect(state.modsEnabled).toBe(true)
    expect(state.mods?.enabled).toEqual({ 'dsh-tavern.asset-stats': true })
  }))


  it('状态：压缩总结模型覆盖成对存取，半空/空白形状视为未设置', withStore(async (store, dir) => {
    await store.patchState({ compaction: { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' } })
    expect((await store.getState()).compaction).toEqual({ curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    // 持久化后重开（readState 归一化）保持不变。
    await store.patchState({ compaction: { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' } })
    expect((await store.getState()).compaction).toEqual({ curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' })
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      compaction: { curatorProvider: 'only-provider' },
    }))
    expect((await store.getState()).compaction).toBeUndefined()
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      compaction: { curatorProvider: '  ', curatorModel: 'm' },
    }))
    expect((await store.getState()).compaction).toBeUndefined()
  }))

  it('状态：legacy binding 迁移为 ST，AgentTavern 缺 mode 迁移为 native', withStore(async (store, dir) => {
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      sessionBindings: {
        legacy: { character: 'A', chatId: 'a.jsonl' },
        agent: { architecture: 'agent-tavern', character: 'B', chatId: 'b.jsonl' },
        group: { architecture: 'agent-tavern', group: true, character: 'G', chatId: 'g.jsonl' },
        invalid: { architecture: 'agent-tavern', character: '' },
      },
    }))
    expect((await store.getState()).sessionBindings).toEqual({
      legacy: { architecture: 'st', character: 'A', chatId: 'a.jsonl' },
      agent: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: 'B', chatId: 'b.jsonl' },
      group: { architecture: 'st', group: true, character: 'G', chatId: 'g.jsonl' },
    })
    expect((await store.getState()).agentTavernPreloadAssets).toBe(false)
  }))

  it('状态：card-workbench 绑定与来源聊天身份经归一化保留（提案 0013）', withStore(async (store, dir) => {
    await store.updateState((state) => ({
      sessionBindings: { ...state.sessionBindings, wb_1: { architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: 'A', sourceChatId: 'a.jsonl', createdCard: 'Hero', title: 'Hero Draft' } },
    }))
    expect((await store.getState()).sessionBindings.wb_1).toEqual({
      architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: 'A', sourceChatId: 'a.jsonl', createdCard: 'Hero', title: 'Hero Draft',
    })
    // 手写 state 文件缺 character/chatId/source 字段时补空串，绝不降级为 st
    // （降级会让客户端把工作台会话误判成 ST 架构、强制接管 composer）；
    // 旧数据（无 source 字段）归一化为自由工作台身份；createdCard 缺失同样
    // 补空串 = 尚未出卡（出卡后会话改名的数据源，提案 0013 补充）。title 是
    // 用户侧边栏显式改的名：非空字符串保留，空串/缺失视为未改名（回落派生
    // 标签，不落 title 键）。
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      sessionBindings: {
        wb_2: { architecture: 'card-workbench' },
        wb_3: { architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: 'B', sourceChatId: 'b.jsonl' },
        wb_4: { architecture: 'card-workbench', character: '', chatId: '', title: 'Kept Name' },
        wb_5: { architecture: 'card-workbench', character: '', chatId: '', title: '   ' },
      },
    }))
    const bindings = await store.getState().then((state) => state.sessionBindings)
    expect(bindings.wb_2).toEqual({
      architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: '', sourceChatId: '', createdCard: '',
    })
    expect(bindings.wb_3).toEqual({
      architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: 'B', sourceChatId: 'b.jsonl', createdCard: '',
    })
    expect(bindings.wb_4).toMatchObject({ title: 'Kept Name' })
    expect('title' in bindings.wb_5).toBe(false)
  }))

  it('memory：确定性检索、CAS 更新与软删除', withStore(async (_store, dir) => {
    const memory = await MemoryStore.open(path.join(dir, 'agent'))
    const created = await memory.put({
      scope: 'chat', scopeId: 'chat-1', kind: 'semantic', content: 'The silver key opens the west gate.',
      tags: ['gate', 'key'], importance: 0.8, confidence: 0.9, source: { kind: 'user', id: 'm1' },
    })
    const hits = await memory.search({ scope: 'chat', scopeId: 'chat-1', query: 'silver gate', limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.id).toBe(created.id)
    await expect(memory.put({
      id: created.id, scope: 'chat', scopeId: 'chat-1', kind: 'semantic', content: 'changed',
      source: { kind: 'user' },
    })).rejects.toMatchObject({ code: 'MEMORY_REVISION_CONFLICT' })
    const updated = await memory.put({
      id: created.id, scope: 'chat', scopeId: 'chat-1', kind: 'semantic', content: 'The silver key opens the north gate.',
      source: { kind: 'user' },
    }, created.revision)
    await memory.forget(updated.id, 'chat', 'chat-1', updated.revision)
    expect(await memory.read(updated.id, 'chat', 'chat-1')).toBeUndefined()
    expect((await memory.read(updated.id, 'chat', 'chat-1', true))?.deletedAt).toBeDefined()
  }))

  it('variables：作用域隔离、CAS 与原子 patch', withStore(async (_store, dir) => {
    const variables = await VariableStore.open(path.join(dir, 'agent'))
    const score = await variables.set('chat', 'chat-1', 'score', 1)
    expect((await variables.get('chat', 'chat-1', 'score'))?.value).toBe(1)
    await expect(variables.set('chat', 'chat-1', 'score', 2, 'stale'))
      .rejects.toMatchObject({ code: 'VARIABLE_REVISION_CONFLICT' })
    const next = await variables.set('chat', 'chat-1', 'score', 2, score.revision)
    const patched = await variables.patch('chat', 'chat-1', [
      { name: 'visited', value: true, expectedRevision: undefined },
      { name: 'label', value: 'north' },
    ])
    expect(patched.map((item) => item.name)).toEqual(['visited', 'label'])
    expect((await variables.list('chat', 'chat-1')).map((item) => item.name)).toEqual(['label', 'score', 'visited'])
    await variables.delete('chat', 'chat-1', 'score', next.revision)
    expect(await variables.get('chat', 'chat-1', 'score')).toBeUndefined()
    expect(await variables.get('character', 'chat-1', 'label')).toBeUndefined()
  }))

  it('variables：list 工具面封顶 100，listAll 全量（settle 基线/显示树不静默截断）', withStore(async (_store, dir) => {
    const variables = await VariableStore.open(path.join(dir, 'agent'))
    for (let index = 0; index < 130; index += 1) {
      await variables.set('chat', 'chat-cap', `var${String(index).padStart(3, '0')}`, index)
    }
    const listed = await variables.list('chat', 'chat-cap')
    expect(listed).toHaveLength(100)
    expect(listed[99]!.name).toBe('var099')
    const all = await variables.listAll('chat', 'chat-cap')
    expect(all).toHaveLength(130)
    expect(all.map((item) => item.name)).toEqual([...all.map((item) => item.name)].sort())
    expect(all[129]!.name).toBe('var129')
    // prefix 语义与 list 同源；显式更大 limit 仍被 MAX_LIST 钳住（工具面契约不变）。
    expect((await variables.listAll('chat', 'chat-cap', 'var12')).map((item) => item.name))
      .toEqual(['var120', 'var121', 'var122', 'var123', 'var124', 'var125', 'var126', 'var127', 'var128', 'var129'])
    expect(await variables.list('chat', 'chat-cap', '', 200)).toHaveLength(100)
  }))

  it('variables：非 ASCII（中文 MVU）变量名与点路径放行', withStore(async (_store, dir) => {
    const variables = await VariableStore.open(path.join(dir, 'agent'))
    await variables.set('chat', 'chat-1', '当前周期', 3)
    await variables.set('chat', 'chat-1', 'basic.好感度', { 等级: 5 })
    expect((await variables.get('chat', 'chat-1', '当前周期'))?.value).toBe(3)
    expect((await variables.list('chat', 'chat-1')).map((item) => item.name).sort())
      .toEqual(['basic.好感度', '当前周期'])
    // 非法名仍拒：空白、数字开头、标点、超 64 字符。
    await expect(variables.set('chat', 'chat-1', 'bad name', 1)).rejects.toThrow('invalid variable name')
    await expect(variables.set('chat', 'chat-1', '1abc', 1)).rejects.toThrow('invalid variable name')
    await expect(variables.set('chat', 'chat-1', '名字!', 1)).rejects.toThrow('invalid variable name')
    await expect(variables.set('chat', 'chat-1', 'a'.repeat(65), 1)).rejects.toThrow('invalid variable name')
  }))

  it('variables：turn 作用域整体 clear（turn 结束过期）', withStore(async (_store, dir) => {
    const variables = await VariableStore.open(path.join(dir, 'agent'))
    await variables.set('turn', 'session-1', 'step', 1)
    await variables.set('turn', 'session-1', 'mood', 'calm')
    await variables.set('turn', 'session-2', 'step', 2)
    expect(await variables.get('turn', 'session-1', 'step')).toBeDefined()
    await variables.clear('turn', 'session-1')
    expect(await variables.get('turn', 'session-1', 'step')).toBeUndefined()
    expect(await variables.get('turn', 'session-1', 'mood')).toBeUndefined()
    expect((await variables.get('turn', 'session-2', 'step'))?.value).toBe(2)
    await variables.clear('turn', 'missing')
  }))

  it('persona：存取', withStore(async (store) => {
    await store.putPersona({ name: 'Main', description: 'A traveler' })
    expect(await store.listPersonas()).toEqual(['Main'])
    expect((await store.getPersona('Main'))?.description).toBe('A traveler')
  }))

  it('persona：导入 PNG 提取内嵌描述并保存头像', withStore(async (store) => {
    const png = new Uint8Array(readFileSync(path.join(fixturesDir, 'ExampleCard.png')))
    const persona = await store.importPersonaPng(png, 'ExampleCard')
    expect(persona.name).toBe('ExampleCard')
    expect(persona.description.length).toBeGreaterThan(0)
    expect((await store.getPersonaAvatar('ExampleCard'))?.byteLength).toBe(png.byteLength)
    expect(await store.listPersonas()).toEqual(['ExampleCard'])
    expect(await store.deletePersona('ExampleCard')).toBe(true)
    expect(await store.getPersonaAvatar('ExampleCard')).toBeUndefined()
    expect(await store.deletePersona('ExampleCard')).toBe(false)
  }))

  it('persona：无内嵌卡的 PNG 退化为仅头像', withStore(async (store) => {
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const persona = await store.importPersonaPng(fake, 'Plain')
    expect(persona.name).toBe('Plain')
    expect(persona.description).toBe('')
    expect((await store.getPersonaAvatar('Plain'))?.byteLength).toBe(fake.byteLength)
  }))

  it('群组：CRUD 与 ST 文件往返', withStore(async (store) => {
    await store.putGroup({
      id: 'g1', name: 'Party', members: ['A', 'B'], allowSelfResponses: false,
      activationStrategy: 2, disabledMembers: ['B'], chatId: '', chats: [], autoModeDelay: 3,
    })
    expect(await store.listGroups()).toEqual(['Party'])
    const loaded = await store.getGroup('Party')
    expect(loaded?.members).toEqual(['A', 'B'])
    expect(loaded?.activationStrategy).toBe(2)
    await store.deleteGroup('Party')
    expect(await store.getGroup('Party')).toBeUndefined()
  }))

  it('分支：截断复制并写 bookmark_link', withStore(async (store) => {
    const id = await store.createChat('Test Char', { user_name: 'unused', character_name: 'unused', chat_metadata: {} }, [
      { name: 'Test Char', is_user: false, is_system: false, send_date: 'a', mes: 'one' },
      { name: 'User', is_user: true, is_system: false, send_date: 'b', mes: 'two' },
      { name: 'Test Char', is_user: false, is_system: false, send_date: 'c', mes: 'three' },
    ])
    const first = await store.getChatSnapshot('Test Char', id)
    const branch = await store.branchChat('Test Char', id, 1, first?.revision, undefined, {
      agentTavernOrigin: {
        architecture: 'st',
        targetArchitecture: 'agent-tavern',
        sessionId: 'session-source',
      },
    })
    expect(branch.chatId).toBe(id.replace(/\.jsonl$/, '') + ' - branch 1.jsonl')
    expect(branch.chat.messages).toHaveLength(2)
    expect(branch.chat.messages[1]?.mes).toBe('two')
    expect(branch.chat.header.chat_metadata['bookmark_link']).toEqual({ character: 'Test Char', chatId: id, messageId: 1 })
    expect(branch.chat.header.chat_metadata['agentTavernOrigin']).toEqual({
      architecture: 'st', targetArchitecture: 'agent-tavern', sessionId: 'session-source',
    })
    // 第二个分支递增编号
    const second = await store.branchChat('Test Char', id, 0, first?.revision)
    expect(second.chatId).toContain('branch 2')
    // revision 冲突传播
    await expect(store.branchChat('Test Char', id, 0, 'stale')).rejects.toThrow()
    // 越界报错
    await expect(store.branchChat('Test Char', id, 99, first?.revision)).rejects.toThrow(/out of range/)
  }))

  it('状态：regex/脚本变量随旧 state 补默认，已下线管线字段丢弃', withStore(async (store, dir) => {
    let state = await store.getState()
    expect(state.regexScripts).toEqual([])
    expect(state.scriptGlobals).toEqual({})
    await store.patchState({
      regexScripts: [{ id: 'r1', scriptName: 'strip', findRegex: 'x', replaceString: 'y', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null }],
      scriptGlobals: { mood: 'calm' },
    })
    state = await store.getState()
    expect(state.regexScripts[0]?.scriptName).toBe('strip')
    expect(state.scriptGlobals['mood']).toBe('calm')
    // 旧 state.json 的 text-completion 管线残留（Kobold 端点/密钥）读取时丢弃。
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      pipelineMode: 'text',
      textCompletion: { endpoint: 'http://127.0.0.1:5001', apiKey: 'secret', streaming: true },
      scriptGlobals: { mood: 'calm' },
    }))
    state = await store.getState()
    expect((state as Record<string, unknown>).pipelineMode).toBeUndefined()
    expect((state as Record<string, unknown>).textCompletion).toBeUndefined()
    expect(state.scriptGlobals['mood']).toBe('calm')
  }))
})

/* ------------- memoryEmbedding 判别联合（提案 0017 本地 ONNX 形态） ------------- */

describe('normalizeMemoryEmbedding provider union', () => {
  it('legacy endpoint shape stays valid without provider field', () => {
    const config = normalizeMemoryEmbedding({
      baseURL: 'https://api.example.com/v1/',
      apiKeyEnv: 'MY_KEY',
      model: 'text-embedding-3-small',
    })
    expect(config).toEqual({
      baseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'MY_KEY',
      model: 'text-embedding-3-small',
    })
  })

  it("provider 'openai' is accepted as explicit endpoint form", () => {
    const config = normalizeMemoryEmbedding({ provider: 'openai', baseURL: 'http://x/v1', apiKeyEnv: '', model: 'm' })
    expect(config?.provider).toBeUndefined()
    expect(config?.baseURL).toBe('http://x/v1')
  })

  it("provider 'local' requires non-empty modelDir", () => {
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: '' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ provider: 'local' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: 'a\0b' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: 'x'.repeat(1025) })).toBeUndefined()
  })

  it("provider 'local' keeps pooling/dims/batchSize and drops unknown pooling", () => {
    const config = normalizeMemoryEmbedding({
      provider: 'local', modelDir: 'D:\models\bge', pooling: 'mean', dims: 512, batchSize: 8,
    })
    expect(config).toEqual({ provider: 'local', modelDir: 'D:\models\bge', pooling: 'mean', dims: 512, batchSize: 8 })
    const defaulted = normalizeMemoryEmbedding({ provider: 'local', modelDir: 'D:\models\bge', pooling: 'max' })
    expect(defaulted).toEqual({ provider: 'local', modelDir: 'D:\models\bge' })
  })

  it("provider 'local' keeps valid precision and drops unknown values（2026-10-13 量化精度）", () => {
    for (const precision of ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'q2', 'q2f16', 'q1', 'q1f16'] as const) {
      expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: '/m', precision })).toEqual({ provider: 'local', modelDir: '/m', precision })
    }
    // 手改 state.json 的废值静默丢弃（回落 auto），bnb4 不在可选面（bitsandbytes
    // JIT 量化不是文件加载路径）。
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: '/m', precision: 'bnb4' })).toEqual({ provider: 'local', modelDir: '/m' })
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: '/m', precision: 'int4' })).toEqual({ provider: 'local', modelDir: '/m' })
    expect(normalizeMemoryEmbedding({ provider: 'local', modelDir: '/m', precision: 7 })).toEqual({ provider: 'local', modelDir: '/m' })
  })

  it('unknown provider is rejected (safely falls back to lexical)', () => {
    expect(normalizeMemoryEmbedding({ provider: 'ollama', modelDir: 'x' })).toBeUndefined()
    expect(normalizeMemoryEmbedding({ provider: 42 })).toBeUndefined()
  })

  it('endpoint fields are ignored on the local form and vice versa', () => {
    const local = normalizeMemoryEmbedding({ provider: 'local', modelDir: '/m', baseURL: 'http://ignored/v1', model: 'ignored' })
    expect(local).toEqual({ provider: 'local', modelDir: '/m' })
    // endpoint 形态下混入 modelDir 不影响其自身合法性
    const endpoint = normalizeMemoryEmbedding({ baseURL: 'http://x/v1', apiKeyEnv: '', model: 'm', modelDir: '/m' })
    expect(endpoint?.model).toBe('m')
  })
})
