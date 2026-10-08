import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as applyPlugin } from '../src/index.js'
import { apply, type AgentContextLike } from '../src/card-workbench/agent.js'
import { TavernStore, readOriginalSnapshot, restoreOriginal, saveOriginalSnapshot } from '../../tavern-store/src/index.js'

const CHARACTER = 'Workbench Card'
const DIRECT_CHARACTER = 'Silent Card'
const ORIGINAL_DESCRIPTION = 'A'.repeat(2500)
const WORKING_DESCRIPTION = 'B'.repeat(100)

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
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

function cardPayload(name: string, description: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description,
      personality: 'Original personality',
      scenario: 'A quiet workshop.',
      first_mes: 'Hello from the workbench.',
      mes_example: '', creator_notes: 'Original notes', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      extensions: { world: 'Workbench Lore' },
    },
  }
}

describe('Card Workbench tools and original snapshots', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let tools: Map<string, RegisteredTool>
  let kernel: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'card-workbench-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))

    // 宿主 mock：与 tavern-command.spec 同款最小形状，只为拿到 import/character
    // 路由处理器（快照挂载点在插件 index.ts，不经路由测不到挂钩本身）。
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
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
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
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('registers the workbench kernel and the P1+P2 tools (cards, plans, worlds, presets, chat logs)', () => {
    expect(kernel).toContain('Card Workbench')
    expect(kernel).toContain('explicit confirmation')
    expect([...tools.keys()]).toEqual([
      'card_get', 'card_put', 'card_original_get', 'card_restore_original',
      'card_plan_propose', 'world_get', 'world_put', 'preset_get', 'preset_put', 'chat_log_read',
      'card_create', 'material_list', 'material_read', 'card_apply_mvu',
    ])
    for (const name of ['card_get', 'card_put', 'card_original_get', 'card_restore_original', 'card_plan_propose', 'chat_log_read']) {
      expect(tools.get(name)!.parameters.properties).toHaveProperty('character')
    }
    // 写入工具的确认闸门在参数面上可见：confirmed 是必填布尔（world/preset 同款）。
    for (const name of ['card_put', 'card_restore_original', 'world_put', 'preset_put']) {
      expect(tools.get(name)!.parameters).toMatchObject({ required: expect.arrayContaining(['confirmed']) })
    }
  })

  it('saves the original snapshot once on the import route', async () => {
    const first = makeResponse()
    await apiHandler(makeRequest({ card: cardPayload(CHARACTER, ORIGINAL_DESCRIPTION) }, '/api/dsh-tavern/import/character'), first)
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.chunks[0]!)).toMatchObject({ ok: true, name: CHARACTER })
    const snapshotFile = join(home, 'tavern', 'characters', 'originals', `${CHARACTER}.json`)
    expect(existsSync(snapshotFile)).toBe(true)
    // 重复导入（工作版覆盖）不得覆盖既有快照：首个导入胜出。
    const second = makeResponse()
    await apiHandler(makeRequest({ card: cardPayload(CHARACTER, WORKING_DESCRIPTION) }, '/api/dsh-tavern/import/character'), second)
    expect(second.statusCode).toBe(200)
    const snapshot = await readOriginalSnapshot(join(home, 'tavern'), CHARACTER)
    expect(snapshot).toBeDefined()
    expect(snapshot!.data.description).toBe(ORIGINAL_DESCRIPTION)
    expect((await store.getCharacter(CHARACTER))!.card.data.description).toBe(WORKING_DESCRIPTION)
    // 快照文件本身是规范 JSON（encodeCharacterCardJson 形态），人可读可 diff。
    expect(JSON.parse(readFileSync(snapshotFile, 'utf8'))).toMatchObject({ spec: 'chara_card_v2' })
  })

  it('card_get returns a working-copy summary with lengths and extension keys', async () => {
    await store.putPersona({ name: 'Tester', description: 'A tester persona.' })
    await store.patchState({ activePersona: 'Tester' })
    const summary = await tools.get('card_get')!.execute({ character: CHARACTER })
    expect(summary).toMatchObject({
      found: true,
      character: CHARACTER,
      name: CHARACTER,
      nickname: CHARACTER,
      description: WORKING_DESCRIPTION,
      personality: 'Original personality',
      scenario: 'A quiet workshop.',
      firstMes: 'Hello from the workbench.',
      creatorNotes: 'Original notes',
      persona: { name: 'Tester', description: 'A tester persona.' },
      fieldLengths: { description: WORKING_DESCRIPTION.length, personality: 'Original personality'.length },
      extensionKeys: ['world'],
      truncated: false,
    })
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
    await store.patchState({ activePersona: undefined })
    expect((await tools.get('card_get')!.execute({ character: CHARACTER })).persona).toEqual({ name: '', description: '' })
    await expect(tools.get('card_get')!.execute({ character: 'No Such Card' })).rejects.toThrow('not found')
  })

  it('card_get truncates the 2500-char original description at 2000 via card_original_get', async () => {
    const original = await tools.get('card_original_get')!.execute({ character: CHARACTER })
    expect(original).toMatchObject({ found: true, character: CHARACTER, truncated: true })
    expect(original.description).toBe(ORIGINAL_DESCRIPTION.slice(0, 2000))
    expect(original.fieldLengths).toMatchObject({ description: 2500 })
    // 无快照（未走导入路由直接 store 层导入）：found false，不抛。
    await store.importCharacter(cardPayload(DIRECT_CHARACTER, 'direct'))
    expect(await tools.get('card_original_get')!.execute({ character: DIRECT_CHARACTER })).toMatchObject({ found: false })
  })

  it('card_put refuses to write without explicit confirmation', async () => {
    await expect(tools.get('card_put')!.execute({
      character: CHARACTER,
      changes: [{ field: 'personality', value: 'Unconfirmed edit.' }],
    })).rejects.toThrow('confirmation required')
    await expect(tools.get('card_put')!.execute({
      character: CHARACTER,
      changes: [{ field: 'personality', value: 'Unconfirmed edit.' }],
      confirmed: false,
    })).rejects.toThrow('confirmation required')
    expect((await store.getCharacter(CHARACTER))!.card.data.personality).toBe('Original personality')
  })

  it('card_put rejects non-whitelisted fields, non-strings, oversized values and duplicates', async () => {
    const base = { character: CHARACTER, confirmed: true }
    await expect(tools.get('card_put')!.execute({ ...base, changes: [{ field: 'extensions', value: '{}' }] }))
      .rejects.toThrow('is not editable')
    await expect(tools.get('card_put')!.execute({ ...base, changes: [{ field: 'systemPrompt', value: 'no' }] }))
      .rejects.toThrow('is not editable')
    await expect(tools.get('card_put')!.execute({ ...base, changes: [{ field: 'personality', value: 42 }] }))
      .rejects.toThrow('must be a string')
    await expect(tools.get('card_put')!.execute({ ...base, changes: [{ field: 'description', value: 'C'.repeat(32001) }] }))
      .rejects.toThrow('32000-character limit')
    await expect(tools.get('card_put')!.execute({ ...base, changes: [{ field: 'name', value: '   ' }] }))
      .rejects.toThrow('must not be blank')
    await expect(tools.get('card_put')!.execute({
      ...base,
      changes: [
        { field: 'personality', value: 'one' },
        { field: 'personality', value: 'two' },
      ],
    })).rejects.toThrow('duplicate change')
    await expect(tools.get('card_put')!.execute({ ...base, changes: [] }))
      .rejects.toThrow('non-empty array')
    expect((await store.getCharacter(CHARACTER))!.card.data.personality).toBe('Original personality')
  })

  it('card_put applies confirmed changes and reports the modified field summary', async () => {
    const result = await tools.get('card_put')!.execute({
      character: CHARACTER,
      confirmed: true,
      changes: [
        { field: 'personality', value: 'Bold and curious.' },
        { field: 'creatorNotes', value: 'Revised notes' },
      ],
    })
    expect(result).toMatchObject({
      character: CHARACTER,
      changes: [
        { field: 'personality', length: 'Bold and curious.'.length, preview: 'Bold and curious.' },
        { field: 'creatorNotes', length: 'Revised notes'.length },
      ],
    })
    expect(result.renamedFrom).toBeUndefined()
    const saved = await store.getCharacter(CHARACTER)
    expect(saved!.card.data.personality).toBe('Bold and curious.')
    expect(saved!.card.data.creatorNotes).toBe('Revised notes')
    // 未提及字段原样保留（原子整体保存，不丢数据）。
    expect(saved!.card.data.description).toBe(WORKING_DESCRIPTION)
  })

  it('card_restore_original requires confirmation and restores the untouched original', async () => {
    await expect(tools.get('card_restore_original')!.execute({ character: CHARACTER }))
      .rejects.toThrow('confirmation required')
    await expect(tools.get('card_restore_original')!.execute({ character: DIRECT_CHARACTER, confirmed: true }))
      .rejects.toThrow('no original snapshot')
    expect((await store.getCharacter(CHARACTER))!.card.data.personality).toBe('Bold and curious.')
    const restored = await tools.get('card_restore_original')!.execute({ character: CHARACTER, confirmed: true })
    expect(restored).toMatchObject({ character: CHARACTER, fieldLengths: { description: 2500 } })
    const working = await store.getCharacter(CHARACTER)
    expect(working!.card.data.personality).toBe('Original personality')
    expect(working!.card.data.creatorNotes).toBe('Original notes')
    expect(working!.card.data.description).toBe(ORIGINAL_DESCRIPTION)
    // 恢复只动工作版：快照仍是导入时那份。
    expect((await readOriginalSnapshot(join(home, 'tavern'), CHARACTER))!.data.description).toBe(ORIGINAL_DESCRIPTION)
  })

  it('saveOriginalSnapshot is idempotent at the store layer and restoreOriginal is undefined without a snapshot', async () => {
    const root = join(home, 'tavern')
    expect(await restoreOriginal(root, DIRECT_CHARACTER)).toBeUndefined()
    const current = await store.getCharacter(DIRECT_CHARACTER)
    expect(await saveOriginalSnapshot(root, DIRECT_CHARACTER, current!.card)).toBe(true)
    expect(await saveOriginalSnapshot(root, DIRECT_CHARACTER, current!.card)).toBe(false)
    // 补快照后可恢复（直接 store 层使用方，如修复脚本）。
    await store.updateCharacter(DIRECT_CHARACTER, { data: { ...current!.card.data, personality: 'drifted' } })
    const restored = await restoreOriginal(root, DIRECT_CHARACTER)
    expect(restored!.card.data.personality).toBe('Original personality')
  })
})
