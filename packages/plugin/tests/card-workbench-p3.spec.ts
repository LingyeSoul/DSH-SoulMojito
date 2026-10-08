import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as applyPlugin } from '../src/index.js'
import { apply, type AgentContextLike } from '../src/card-workbench/agent.js'
import { statusTemplateOf } from '../src/mvu.js'
import {
  TavernStore,
  applyScriptBinding,
  importScript,
  readOriginalSnapshot,
} from '../../tavern-store/src/index.js'

const LEGACY = 'Legacy Card'
const PLAIN = 'Plain Card'
const EMPTY_SEED = 'Empty Seed Card'
const BOUND_SCRIPT = 'Bound Script'
const SOURCE_NOVEL = 'Source Novel'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown>; required?: string[] }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<any>
}

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function cardPayload(name: string, extensions: Record<string, unknown> = {}) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: `${name} description with a status bar block.`,
      personality: 'Calm.',
      scenario: 'A conversion room.',
      first_mes: 'Hello.\n<status>favor: 0</status>',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      extensions,
    },
  }
}

/** 每段 ~400 字符 × count 段：按 1200 目标聚合成多个 ~2000 内的块。 */
function longContent(paragraphCount: number): string {
  const paragraphs: string[] = []
  for (let i = 0; i < paragraphCount; i++) {
    paragraphs.push(`Paragraph ${i}: ${'word '.repeat(79).trim()}.`)
  }
  return paragraphs.join('\n\n')
}

describe('Card Workbench P3: creation, materials, MVU conversion and chat seeding', () => {
  let home: string
  let tavern: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let tools: Map<string, RegisteredTool>
  let kernel: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'card-workbench-p3-'))
    process.env.DSH_HOME = home
    tavern = join(home, 'tavern')
    store = await TavernStore.open(tavern)

    await applyPlugin({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()

    tools = new Map()
    const sections: string[] = []
    apply({
      systemPrompt: { section: (section) => { sections.push(typeof section.text === 'string' ? section.text : section.text()) } },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
    kernel = sections.join('\n')

    // store 层直接导入 = 无原版快照（P1 导入钩子未覆盖的老卡），供转换补拍测试。
    await store.importCharacter(cardPayload(LEGACY))
    await store.importCharacter(cardPayload(PLAIN))
    await store.importCharacter(cardPayload(EMPTY_SEED, { agentTavern: { initialVariables: {} } }))
    await importScript(tavern, BOUND_SCRIPT, 'Chapter one.\n\nChapter two follows.')
    await importScript(tavern, SOURCE_NOVEL, longContent(12))
    await applyScriptBinding(store, LEGACY, BOUND_SCRIPT)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /* ------------------------------ 注册与内核 ------------------------------ */

  it('registers the P3 tools and kernel starting-task flows', () => {
    for (const name of ['card_create', 'material_list', 'material_read', 'card_apply_mvu']) {
      expect(tools.has(name)).toBe(true)
    }
    for (const name of ['card_create', 'card_apply_mvu']) {
      expect(tools.get(name)!.parameters).toMatchObject({ required: expect.arrayContaining(['confirmed']) })
    }
    expect(kernel).toContain('Starting tasks')
    expect(kernel).toContain('card_create')
    expect(kernel).toContain('material_list')
    expect(kernel).toContain('material_read')
    expect(kernel).toContain('card_apply_mvu')
  })

  /* --------------------------------- 制卡 --------------------------------- */

  it('card_create refuses unconfirmed calls, unknown fields and mismatched names', async () => {
    const base = { name: 'Refused Card', fields: { description: 'no' } }
    await expect(tools.get('card_create')!.execute(base)).rejects.toThrow('confirmation required')
    await expect(tools.get('card_create')!.execute({ ...base, confirmed: false })).rejects.toThrow('confirmation required')
    await expect(tools.get('card_create')!.execute({ ...base, confirmed: true, fields: { extensions: '{}' } }))
      .rejects.toThrow('is not settable')
    await expect(tools.get('card_create')!.execute({ ...base, confirmed: true, fields: { alternateGreetings: 'hi' } }))
      .rejects.toThrow('alternateGreetings must be an array')
    await expect(tools.get('card_create')!.execute({ name: 'Refused Card', confirmed: true, fields: { name: 'Other Name' } }))
      .rejects.toThrow('must match the name argument')
    await expect(tools.get('card_create')!.execute({ name: '   ', confirmed: true })).rejects.toThrow('must not be blank')
    expect(await store.getCharacter('Refused Card')).toBeUndefined()
  })

  it('card_create refuses duplicate names and never overwrites', async () => {
    await expect(tools.get('card_create')!.execute({ name: LEGACY, confirmed: true }))
      .rejects.toThrow(`character '${LEGACY}' already exists`)
    expect((await store.getCharacter(LEGACY))!.card.data.description).toContain('status bar block')
  })

  it('card_create builds blank and populated cards, round-tripping alternateGreetings', async () => {
    const blank = await tools.get('card_create')!.execute({ name: 'Blank Slate', confirmed: true })
    expect(blank).toMatchObject({
      created: true,
      character: 'Blank Slate',
      alternateGreetings: 0,
      fieldLengths: { description: 0, personality: 0, scenario: 0, firstMes: 0, creatorNotes: 0 },
    })
    expect(JSON.parse(JSON.stringify(blank))).toEqual(blank)

    const populated = await tools.get('card_create')!.execute({
      name: 'Script Hero',
      confirmed: true,
      fields: {
        description: 'Distilled from the novel.',
        personality: 'Brave.',
        scenario: 'A harbour town.',
        firstMes: 'The ship arrives at dawn.',
        creatorNotes: 'Extracted via material_read.',
        nickname: 'Hero',
        alternateGreetings: ['Evening variant.', 'Storm variant.'],
      },
    })
    expect(populated).toMatchObject({
      created: true,
      character: 'Script Hero',
      alternateGreetings: 2,
      fieldLengths: { description: 'Distilled from the novel.'.length },
    })
    const saved = (await store.getCharacter('Script Hero'))!.card
    expect(saved.data.description).toBe('Distilled from the novel.')
    expect(saved.data.personality).toBe('Brave.')
    expect(saved.data.nickname).toBe('Hero')
    expect(saved.data.alternateGreetings).toEqual(['Evening variant.', 'Storm variant.'])
    // 创建不绑定任何剧本/世界书：extensions 干净。
    expect(saved.data.extensions).toEqual({})
  })

  /* -------------------------------- 素材 -------------------------------- */

  it('material_list lists the library with formats, chunk counts and bindings', async () => {
    const result = await tools.get('material_list')!.execute({})
    expect(result.count).toBe(2)
    const bound = result.scripts.find((script: { name: string }) => script.name === BOUND_SCRIPT)
    const novel = result.scripts.find((script: { name: string }) => script.name === SOURCE_NOVEL)
    expect(bound).toMatchObject({ format: 'txt', chunkCount: 1, boundCards: [LEGACY] })
    expect(novel).toMatchObject({ format: 'txt', boundCards: [] })
    expect(novel.chunkCount).toBeGreaterThan(1)
  })

  it('material_read reads one chunk with index and budget clamping', async () => {
    const first = await tools.get('material_read')!.execute({ scriptName: SOURCE_NOVEL })
    expect(first).toMatchObject({ found: true, script: SOURCE_NOVEL, chunkIndex: 0, truncated: false })
    expect(first.totalChunks).toBeGreaterThan(1)
    expect(first.text.length).toBeLessThanOrEqual(2400)
    expect(first.text).toBe(first.text.slice(0, 2400))

    // maxChars 越界钳制：<1 不合理值钳到 1；>8000 钳到 8000（块本就 ≤2000，取回全文）。
    const tiny = await tools.get('material_read')!.execute({ scriptName: SOURCE_NOVEL, maxChars: 0 })
    expect(tiny.truncated).toBe(true)
    expect(tiny.text.length).toBe(1)
    const huge = await tools.get('material_read')!.execute({ scriptName: SOURCE_NOVEL, maxChars: 99999 })
    expect(huge.truncated).toBe(false)
    expect(huge.text.length).toBe(huge.length)

    // chunkIndex 越界钳制到最后一块，并回报请求值。
    const clamped = await tools.get('material_read')!.execute({ scriptName: SOURCE_NOVEL, chunkIndex: 999 })
    expect(clamped.chunkIndex).toBe(clamped.totalChunks - 1)
    expect(clamped.requestedChunkIndex).toBe(999)
    const negative = await tools.get('material_read')!.execute({ scriptName: SOURCE_NOVEL, chunkIndex: -7 })
    expect(negative.chunkIndex).toBe(0)

    // 未知剧本 found:false，不抛错。
    expect(await tools.get('material_read')!.execute({ scriptName: 'No Such Script' }))
      .toMatchObject({ found: false, script: 'No Such Script' })
  })

  /* ------------------------------ 转 MVU ------------------------------ */

  it('card_apply_mvu requires confirmation and validates template and variables', async () => {
    const base = { character: LEGACY, statusTemplate: '<%= it.day %>' }
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, initialVariables: { day: 1 } }))
      .rejects.toThrow('confirmation required')
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, initialVariables: { day: 1 }, confirmed: false }))
      .rejects.toThrow('confirmation required')
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, confirmed: true, statusTemplate: '   ' }))
      .rejects.toThrow('non-empty string')
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, confirmed: true, statusTemplate: 'x'.repeat(16001) }))
      .rejects.toThrow('16000-character limit')
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, confirmed: true, initialVariables: [] }))
      .rejects.toThrow('plain object')
    await expect(tools.get('card_apply_mvu')!.execute({ ...base, confirmed: true, initialVariables: 'nope' }))
      .rejects.toThrow('plain object')
    await expect(tools.get('card_apply_mvu')!.execute({
      ...base, confirmed: true, initialVariables: { blob: 'b'.repeat(64 * 1024 + 1) },
    })).rejects.toThrow('64KB serialized limit')
    // 校验失败不落任何东西：卡上还没有 statusTemplate。
    expect(statusTemplateOf((await store.getCharacter(LEGACY))!.card)).toBeUndefined()
  })

  it('card_apply_mvu snapshots the pre-conversion card once and preserves agentTavern keys', async () => {
    expect(await readOriginalSnapshot(tavern, LEGACY)).toBeUndefined()
    const template = 'Day <%= getvar("day") %> — favor <%= getvar("mvu.favor") %>'
    const first = await tools.get('card_apply_mvu')!.execute({
      character: LEGACY,
      statusTemplate: template,
      initialVariables: { day: 1, mvu: { favor: 0 } },
      confirmed: true,
    })
    expect(first).toMatchObject({
      character: LEGACY,
      statusTemplateLength: template.length,
      variableKeys: ['day', 'mvu'],
      snapshotTaken: true,
      retainedAgentTavernKeys: ['scriptId'],
    })

    const saved = (await store.getCharacter(LEGACY))!.card
    const agentTavern = saved.data.extensions.agentTavern as Record<string, unknown>
    expect(agentTavern).toMatchObject({ scriptId: BOUND_SCRIPT, statusTemplate: template })
    expect(agentTavern.initialVariables).toEqual({ day: 1, mvu: { favor: 0 } })
    // 产物直接对接 P1 渲染路径（mvu.ts statusTemplateOf）。
    expect(statusTemplateOf(saved)).toBe(template)
    // 正文/开场白不动：旧状态栏块留给确认后的 card_put。
    expect(saved.data.firstMes).toContain('<status>favor: 0</status>')

    // 补拍的快照是转换前状态：有 scriptId、无 statusTemplate。
    const snapshot = (await readOriginalSnapshot(tavern, LEGACY))!
    expect((snapshot.data.extensions.agentTavern as Record<string, unknown>).scriptId).toBe(BOUND_SCRIPT)
    expect((snapshot.data.extensions.agentTavern as Record<string, unknown>).statusTemplate).toBeUndefined()

    // 二次转换：工作版已被改过（personality），快照也不覆盖——首个胜出。
    await tools.get('card_put')!.execute({
      character: LEGACY, confirmed: true,
      changes: [{ field: 'personality', value: 'Drifted before second conversion.' }],
    })
    const second = await tools.get('card_apply_mvu')!.execute({
      character: LEGACY,
      statusTemplate: 'v2 template',
      confirmed: true,
    })
    expect(second.snapshotTaken).toBe(false)
    // initialVariables 省略 → 保留既有；scriptId 仍保留。
    expect(second.variableKeys).toEqual(['day', 'mvu'])
    expect(second.retainedAgentTavernKeys).toEqual(['scriptId'])
    const snapshotAfter = (await readOriginalSnapshot(tavern, LEGACY))!
    expect((snapshotAfter.data.extensions.agentTavern as Record<string, unknown>).statusTemplate).toBeUndefined()
    expect(snapshotAfter.data.personality).toBe('Calm.')
  })

  /* --------------------------- 新聊天变量种子 --------------------------- */

  it('seeds new chats with a deep copy of initialVariables', async () => {
    const response = makeResponse()
    await apiHandler(makeRequest({ character: LEGACY }, '/api/dsh-tavern/chats'), response)
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.chunks[0]!)
    expect(body.ok).toBe(true)
    expect(body.chat.header.chat_metadata.variables).toEqual({ day: 1, mvu: { favor: 0 } })

    // 深拷贝隔离：改聊天变量（含嵌套）不回写卡上的 initialVariables。
    const chatId = body.id as string
    const chat = (await store.getChatSnapshot(LEGACY, chatId))!.chat
    const variables = chat.header.chat_metadata.variables as Record<string, unknown>
    ;(variables.mvu as Record<string, unknown>).favor = 99
    variables.extra = 'chat-only'
    await store.saveChat(LEGACY, chatId, chat)
    const cardAgain = (await store.getCharacter(LEGACY))!.card
    expect((cardAgain.data.extensions.agentTavern as Record<string, unknown>).initialVariables)
      .toEqual({ day: 1, mvu: { favor: 0 } })
    expect(statusTemplateOf(cardAgain)).toBe('v2 template')
  })

  it('writes no variables key for cards without (or with empty) initialVariables', async () => {
    for (const character of [PLAIN, EMPTY_SEED]) {
      const response = makeResponse()
      await apiHandler(makeRequest({ character }, '/api/dsh-tavern/chats'), response)
      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.chunks[0]!)
      expect(body.ok).toBe(true)
      expect(body.chat.header.chat_metadata.variables).toBeUndefined()
      expect('variables' in body.chat.header.chat_metadata).toBe(false)
    }
  })
})
