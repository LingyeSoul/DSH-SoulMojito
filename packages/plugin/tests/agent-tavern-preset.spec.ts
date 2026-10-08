import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyAgentTavern, type AgentContextLike } from '../src/agent-tavern/agent.js'
import {
  AGENT_PRESET_BLOCK_HEADER,
  effectiveAgentPresetPrompts,
  renderAgentPresetBlock,
} from '../src/agent-tavern/preset.js'
import { decodeCharacterCard, parsePreset, type PresetIR } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Preset Character'
const AGENT = 'preset-agent'

const PRESET_A = {
  temperature: 0.35,
  openai_max_context: 8192,
  openai_max_tokens: 500,
  prompts: [
    { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'Follow the preset main rule with {{char}} and {{user}}.', system_prompt: true },
    { name: 'Style Guide', identifier: 'styleGuide', role: 'system', content: 'Use terse prose.', system_prompt: true },
    { name: 'Disabled By Slot', identifier: 'slotOff', role: 'system', content: 'SHOULD NOT APPEAR (slot disabled).', system_prompt: true },
    { name: 'Prompt Field False', identifier: 'promptOff', role: 'system', content: 'PROMPT-FIELD FALSE STILL INJECTS.', system_prompt: true, enabled: false },
    { name: 'Panel Toggle False', identifier: 'panelOff', role: 'system', content: 'PANEL TOGGLE FALSE STILL INJECTS.', system_prompt: false },
    { name: 'Empty Entry', identifier: 'emptyOne', role: 'system', content: '   ', system_prompt: true },
    { name: 'Character Description', identifier: 'charDescription', marker: true, system_prompt: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'styleGuide', enabled: true },
      { identifier: 'slotOff', enabled: false },
      { identifier: 'promptOff', enabled: true },
      { identifier: 'panelOff', enabled: true },
      { identifier: 'emptyOne', enabled: true },
      { identifier: 'charDescription', enabled: true },
    ],
  }],
}

const PRESET_B = {
  temperature: 1.25,
  prompts: [
    { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'PRESET B ONLY TEXT for {{char}}.', system_prompt: true },
  ],
  prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
}

const CARD = decodeCharacterCard({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: CHARACTER,
    description: 'A preset-test character.',
    personality: '', scenario: '', first_mes: 'Hello', mes_example: '',
    creator_notes: '', system_prompt: 'You are {{char}}. {{original}}', post_history_instructions: 'Stay in character.',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
  },
})

function makeAgent(id: string) {
  return {
    id,
    ctx: { id },
    injections: [] as unknown[],
    phase: { kind: 'idle', lastTurn: 0 },
    inject: () => undefined,
    session: { events: [] as unknown[], append: () => undefined },
  }
}

interface MockRequest {
  method: string
  url: string
  destroy: () => void
  on: (event: string, listener: (value?: unknown) => void) => undefined
}

function makeRequest(body: unknown, url: string, method = 'POST'): MockRequest {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
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

function parseBody(res: { chunks: string[] }): Record<string, any> {
  return JSON.parse(res.chunks.join('') || '{}') as Record<string, any>
}

describe('AgentTavern preset projection', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let agentSections: Map<string, { name: string; order: number; text: unknown }>
  let eventListeners: Map<string, (payload: any, next: () => Promise<any>) => Promise<any>>
  let chatId: string

  const presetTextOf = (agentId: string | undefined): string => {
    const def = agentSections.get('dsh-tavern:agent-preset') as
      | { text: (assembly?: { agent?: { id?: string } }) => string }
      | undefined
    return def!.text(agentId === undefined ? undefined : { agent: { id: agentId } })
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-agent-preset-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A preset-test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])
    await store.putPreset('Preset A', structuredClone(PRESET_A))
    await store.putPreset('Preset B', structuredClone(PRESET_B))
    await store.updateState(() => ({
      activePreset: 'Preset A',
      activePersona: 'Rin',
      sessionBindings: {
        [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))

    let apiHandlerRef: ((req: unknown, res: unknown) => Promise<void>) | undefined
    const agents = new Map([[AGENT, makeAgent(AGENT)]])
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandlerRef = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: (id: string) => agents.get(id) },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    apiHandler = apiHandlerRef!

    agentSections = new Map()
    eventListeners = new Map()
    applyAgentTavern({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => { agentSections.set(def.name, def) },
        context: () => {},
      },
      tools: { register: () => {} },
      on: (event: string, listener: (payload: any, next: () => Promise<any>) => Promise<any>) => {
        eventListeners.set(event, listener)
        return undefined
      },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as unknown as AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('renders enabled content prompts in prompt_order and skips markers/disabled/empty', () => {
    const block = renderAgentPresetBlock(parsePreset(structuredClone(PRESET_A)))
    expect(block).toBeDefined()
    expect(block!.startsWith(AGENT_PRESET_BLOCK_HEADER)).toBe(true)
    expect(block).toContain('Follow the preset main rule with {{char}} and {{user}}.')
    expect(block).toContain('Use terse prose.')
    // 启用判定只看 prompt_order[].enabled（ST PromptManager.getPromptCollection）：
    // system_prompt 是分类标记、prompt.enabled 不覆盖 slot——两者为 false 仍注入
    // （社区预设的写作风格/思考链条目常为 system_prompt:false 且启用，曾因误判整组丢失）。
    expect(block).toContain('PANEL TOGGLE FALSE STILL INJECTS.')
    expect(block).toContain('PROMPT-FIELD FALSE STILL INJECTS.')
    // slot.enabled === false 才是禁用
    expect(block).not.toContain('SHOULD NOT APPEAR')
    // marker 条目（角色卡描述占位）不进固定 prompt
    expect(block).not.toContain('Character Description')
    // 顺序：main 在 styleGuide 之前
    expect(block!.indexOf('Follow the preset main rule')).toBeLessThan(block!.indexOf('Use terse prose.'))
    // 只有 marker 的预设不产生注入块
    const markersOnly: PresetIR = {
      prompts: [{ name: 'Character Description', identifier: 'charDescription', marker: true, system_prompt: true }],
      promptOrder: [{ character_id: 100001, order: [{ identifier: 'charDescription', enabled: true }] }],
      sampler: {},
    }
    expect(renderAgentPresetBlock(markersOnly)).toBeUndefined()
  })

  it('prefers the ST global order set 100001 and falls back to 100000 then the first set', () => {
    const raw = {
      prompts: [
        { name: 'Global', identifier: 'globalOnly', role: 'system', content: 'GLOBAL SET TEXT.', system_prompt: true },
        { name: 'Legacy', identifier: 'legacyOnly', role: 'system', content: 'LEGACY SET TEXT.', system_prompt: true },
        { name: 'First', identifier: 'firstOnly', role: 'system', content: 'FIRST SET TEXT.', system_prompt: true },
      ],
      prompt_order: [
        { character_id: 100000, order: [{ identifier: 'legacyOnly', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'globalOnly', enabled: true }] },
        { character_id: 555, order: [{ identifier: 'firstOnly', enabled: true }] },
      ],
    }
    const block = renderAgentPresetBlock(parsePreset(structuredClone(raw)))
    expect(block).toContain('GLOBAL SET TEXT.')
    expect(block).not.toContain('LEGACY SET TEXT.')
    expect(block).not.toContain('FIRST SET TEXT.')

    const legacyOnly = structuredClone(raw)
    legacyOnly.prompt_order.splice(1, 1)
    expect(renderAgentPresetBlock(parsePreset(legacyOnly))).toContain('LEGACY SET TEXT.')

    const firstOnly = structuredClone(raw)
    firstOnly.prompt_order.splice(0, 2)
    expect(renderAgentPresetBlock(parsePreset(firstOnly))).toContain('FIRST SET TEXT.')
  })

  it('applies card systemPrompt/postHistoryInstructions overrides with {{original}}', () => {
    const preset = structuredClone(PRESET_A) as Record<string, any>
    preset.prompts.push({ name: 'Post-History Instructions', identifier: 'jailbreak', role: 'system', content: 'base jailbreak text', system_prompt: true })
    preset.prompt_order[0].order.push({ identifier: 'jailbreak', enabled: true })
    const parsed = parsePreset(preset)

    const withoutCard = effectiveAgentPresetPrompts(parsed)
    expect(withoutCard.find((prompt) => prompt.identifier === 'main')?.content)
      .toBe('Follow the preset main rule with {{char}} and {{user}}.')

    const withCard = effectiveAgentPresetPrompts(parsed, CARD)
    expect(withCard.find((prompt) => prompt.identifier === 'main')?.content)
      .toBe('You are {{char}}. Follow the preset main rule with {{char}} and {{user}}.')
    expect(withCard.find((prompt) => prompt.identifier === 'jailbreak')?.content).toBe('Stay in character.')
  })

  it('registers the -75 preset section and lazy-loads the active preset with macros expanded', async () => {
    expect(agentSections.get('dsh-tavern:agent-preset')?.order).toBe(-75)
    expect(presetTextOf(AGENT)).toBe('')
    await vi.waitFor(() => {
      expect(presetTextOf(AGENT)).toContain('Follow the preset main rule')
    })
    const text = presetTextOf(AGENT)
    expect(text).toContain('Follow the preset main rule with Preset Character and Rin.')
    expect(text).toContain('Use terse prose.')
    expect(text.startsWith(AGENT_PRESET_BLOCK_HEADER)).toBe(true)
    // 宿主插值守卫：展开 + 中性化后不得残留 {{（见 prompt-safety.ts）
    expect(text).not.toContain('{{')
    expect(presetTextOf(undefined)).toBe('')
    expect(presetTextOf('unbound-agent')).toBe('')
  })

  it('projects the preset temperature through agent/request and passes unbound agents through', async () => {
    const listener = eventListeners.get('agent/request')
    expect(listener).toBeDefined()
    const base = { provider: 'test-provider', model: 'test-model' }
    const config = await listener!({ agent: { id: AGENT } }, async () => base)
    expect(config.temperature).toBe(0.35)
    // 非 AgentTavern 绑定原样透传（不叠加温度）
    const untouched = await listener!({ agent: { id: 'unbound-agent' } }, async () => base)
    expect(untouched).toEqual(base)
  })

  it('refreshes the projection through the state, preset edit and delete routes', async () => {
    const switchRes = makeResponse()
    await apiHandler(makeRequest({ activePreset: 'Preset B' }, '/api/dsh-tavern/state'), switchRes)
    expect(switchRes.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(presetTextOf(AGENT)).toContain('PRESET B ONLY TEXT for Preset Character.')
    })
    expect(presetTextOf(AGENT)).not.toContain('Follow the preset main rule')

    const listener = eventListeners.get('agent/request')!
    const config = await listener({ agent: { id: AGENT } }, async () => ({ provider: 'p', model: 'm' }))
    expect(config.temperature).toBe(1.25)

    const edited = structuredClone(PRESET_B)
    edited.prompts[0]!.content = 'PRESET B EDITED TEXT for {{char}}.'
    const editRes = makeResponse()
    await apiHandler(makeRequest({ name: 'Preset B', data: edited }, `/api/dsh-tavern/preset/${encodeURIComponent('Preset B')}`, 'PUT'), editRes)
    expect(editRes.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(presetTextOf(AGENT)).toContain('PRESET B EDITED TEXT for Preset Character.')
    })

    const deleteRes = makeResponse()
    await apiHandler(makeRequest({}, `/api/dsh-tavern/preset?name=${encodeURIComponent('Preset B')}`, 'DELETE'), deleteRes)
    expect(deleteRes.statusCode).toBe(200)
    // 删除激活预设 → 回落内置默认预设（面板「内置角色扮演预设」的同一份语义）
    await vi.waitFor(() => {
      expect(presetTextOf(AGENT)).toContain('fictional roleplay chat between Preset Character and Rin')
    })
    expect(presetTextOf(AGENT)).not.toContain('PRESET B')
    // 内置默认预设的 temperature = 1
    const fallback = await listener({ agent: { id: AGENT } }, async () => ({ provider: 'p', model: 'm' }))
    expect(fallback.temperature).toBe(1)
  })

  it('keeps the invalidation registry shared across module instances (split bundles)', async () => {
    // 真实部署里 emit 在 index.mjs / card-workbench.mjs、监听在 agent.mjs：模块级
    // Set 会各持一份，写穿静默失效。globalThis（Symbol.for）锚定必须跨实例共享。
    vi.resetModules()
    const first = await import('../src/agent-tavern/preset.js')
    let fired = 0
    const dispose = first.onAgentPresetChanged(() => { fired += 1 })
    try {
      vi.resetModules()
      const second = await import('../src/agent-tavern/preset.js')
      // 前提：确实是两个模块实例（否则本测试不能证明注册表跨实例共享）。
      expect(second).not.toBe(first)
      await second.emitAgentPresetChanged()
      expect(fired).toBe(1)
    } finally {
      dispose()
    }
  })
})
