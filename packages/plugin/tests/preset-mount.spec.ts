import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyWorkbench } from '../src/card-workbench/agent.js'
import { apply as applyNovel } from '../src/agent-novel/agent.js'
import { AGENT_PRESET_BLOCK_HEADER, renderAgentPresetBlock } from '../src/agent-tavern/preset.js'
import { parsePreset } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * 写卡工作台 / AgentNovel 的预设投影（src/preset-mount.ts，决策
 * 2026-10-09-workbench-novel-preset-projection）：开关门控（默认关）、绑定过滤、
 * 宏展开与 {{...}} 中性化、开关/激活预设变化写穿，以及与 AgentTavern 投影的
 * 关键差异——无激活预设不回落内置默认 RP 预设。
 */

const CHARACTER = 'Mount Character'
const WORKBENCH_AGENT = 'workbench-agent'
const FREE_WORKBENCH_AGENT = 'free-workbench-agent'
const NOVEL_AGENT = 'novel-agent'
const RP_AGENT = 'rp-agent'

const PRESET = {
  temperature: 0.9,
  prompts: [
    { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'Write {{char}}\'s next reply addressing {{user}}.', system_prompt: true },
    { name: 'Style', identifier: 'style', role: 'system', content: 'Terse prose only.', system_prompt: true },
    { name: 'Slot Off', identifier: 'slotOff', role: 'system', content: 'SHOULD NOT APPEAR (slot disabled).', system_prompt: true },
    { name: 'Character Description', identifier: 'charDescription', marker: true, system_prompt: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'style', enabled: true },
      { identifier: 'slotOff', enabled: false },
      { identifier: 'charDescription', enabled: true },
    ],
  }],
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

describe('workbench/novel preset projection mounts', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let workbenchSection: { name: string; order: number; text: (assembly?: { agent?: { id?: string } }) => string } | undefined
  let novelSection: { name: string; order: number; text: (assembly?: { agent?: { id?: string } }) => string } | undefined

  const workbenchTextOf = (agentId: string | undefined) =>
    workbenchSection!.text(agentId === undefined ? undefined : { agent: { id: agentId } })
  const novelTextOf = (agentId: string | undefined) =>
    novelSection!.text(agentId === undefined ? undefined : { agent: { id: agentId } })

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-preset-mount-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.putPreset('Mount Preset', structuredClone(PRESET))
    await store.updateState(() => ({
      activePreset: 'Mount Preset',
      activePersona: 'Rin',
      sessionBindings: {
        [WORKBENCH_AGENT]: { architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: CHARACTER, sourceChatId: '2026-01-01@10h00m00s.jsonl', createdCard: '' },
        [FREE_WORKBENCH_AGENT]: { architecture: 'card-workbench', character: '', chatId: '', sourceCharacter: '', sourceChatId: '', createdCard: 'Draft Card' },
        [NOVEL_AGENT]: { architecture: 'agent-novel', character: '', chatId: '', novelId: 'novel-1' },
        [RP_AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: '' },
      },
    }))

    let apiHandlerRef: ((req: unknown, res: unknown) => Promise<void>) | undefined
    const agents = new Map([WORKBENCH_AGENT, FREE_WORKBENCH_AGENT, NOVEL_AGENT, RP_AGENT].map((id) => [id, makeAgent(id)]))
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

    applyWorkbench({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => {
          if (def.name === 'dsh-tavern:card-workbench-preset') {
            workbenchSection = def as typeof workbenchSection
          }
        },
      },
      tools: { register: () => {} },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    applyNovel({
      systemPrompt: {
        section: (def: { name: string; order: number; text: unknown }) => {
          if (def.name === 'dsh-tavern:novel-preset') {
            novelSection = def as typeof novelSection
          }
        },
      },
      tools: { register: () => {} },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('renders the shared block body under a custom header', () => {
    const block = renderAgentPresetBlock(parsePreset(structuredClone(PRESET)), undefined, 'CUSTOM HEADER:')
    expect(block).toBeDefined()
    expect(block!.startsWith('CUSTOM HEADER:')).toBe(true)
    expect(block).toContain('Terse prose only.')
    expect(block).not.toContain('SHOULD NOT APPEAR')
    // 默认 header 不受影响（AgentTavern 语义回归锚点）
    expect(renderAgentPresetBlock(parsePreset(structuredClone(PRESET)))!.startsWith(AGENT_PRESET_BLOCK_HEADER)).toBe(true)
  })

  it('registers both sections at -75 and stays empty while the switches are off', async () => {
    expect(workbenchSection?.order).toBe(-75)
    expect(novelSection?.order).toBe(-75)
    // 开关默认关闭：装载完成后仍是空投影（等待装载落定再断言，排除在途竞态）
    workbenchTextOf(WORKBENCH_AGENT)
    novelTextOf(NOVEL_AGENT)
    await vi.waitFor(() => {
      expect(workbenchTextOf(WORKBENCH_AGENT)).toBe('')
      expect(novelTextOf(NOVEL_AGENT)).toBe('')
    })
  })

  it('projects the active preset once the workbench switch is on, with macros expanded', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ cardWorkbenchPresetEnabled: true }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(workbenchTextOf(WORKBENCH_AGENT)).toContain('Write Mount Character\'s next reply addressing Rin.')
    })
    const text = workbenchTextOf(WORKBENCH_AGENT)
    // 引用式框架首行；启用过滤（slot off 不出现）；宏展开 + 无 {{ 残留
    expect(text.startsWith('Active chat completion preset')).toBe(true)
    expect(text).toContain('Terse prose only.')
    expect(text).not.toContain('SHOULD NOT APPEAR')
    expect(text).not.toContain('{{')
    // 自由工作台（无来源角色）：{{char}} 回落占位语义而不是空串残句
    expect(workbenchTextOf(FREE_WORKBENCH_AGENT)).toContain('Write Draft Card\'s next reply addressing Rin.')
    // 绑定过滤：AgentTavern 绑定不吃工作台投影
    expect(workbenchTextOf(RP_AGENT)).toBe('')
    // 开关只开工作台：小说仍空
    expect(novelTextOf(NOVEL_AGENT)).toBe('')
  })

  it('projects the active preset for the novel author under the follow header', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ agentNovelPresetEnabled: true }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(novelTextOf(NOVEL_AGENT)).toContain('next reply addressing Rin.')
    })
    const text = novelTextOf(NOVEL_AGENT)
    // 跟随式框架（与 AgentTavern 同一块头）；小说不绑卡，{{char}} 回落占位语义
    expect(text.startsWith(AGENT_PRESET_BLOCK_HEADER)).toBe(true)
    expect(text).toContain('Write the character\'s next reply addressing Rin.')
    expect(text).not.toContain('{{')
  })

  it('does not fall back to the built-in RP preset when no preset is active', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ activePreset: null }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(novelTextOf(NOVEL_AGENT)).toBe('')
      expect(workbenchTextOf(WORKBENCH_AGENT)).toBe('')
    })
    // 恢复激活预设供后续用例
    const back = makeResponse()
    await apiHandler(makeRequest({ activePreset: 'Mount Preset' }, '/api/dsh-tavern/state'), back)
    expect(back.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(novelTextOf(NOVEL_AGENT)).toContain('Terse prose only.')
    })
  })

  it('clears the projection through the switch-off write-through', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest({ cardWorkbenchPresetEnabled: false, agentNovelPresetEnabled: false }, '/api/dsh-tavern/state'), res)
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(workbenchTextOf(WORKBENCH_AGENT)).toBe('')
      expect(novelTextOf(NOVEL_AGENT)).toBe('')
    })
  })
})
