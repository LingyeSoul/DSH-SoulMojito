import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { emitAgentPresetChanged } from '../src/agent-tavern/preset.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Mount Character'
const AGENT = 'mount-agent'
const SUMMARY = 'A mount-test character with one crisp identity line.'
const PERSONA = 'Mount Persona'
const PERSONA_DESCRIPTION = 'A mount-test user persona description.'

interface RegisteredSection {
  name: string
  order: number
  text: ((assembly?: { agent?: { id?: string } }) => string) | string
  complete?: boolean
}

interface RegisteredPromptContext {
  name: string
  order: number
  text: (assembly?: { agent?: { id?: string } }) => string
}

interface ToolLike {
  name: string
}

/**
 * 忠于宿主 Context 注入门的形状（@deepseek-ai/cordis）：属性既不在 target
 * 上，也不是当前 fiber 能解析的服务时同步抛 `cannot get property "<name>"
 * without inject`。0.2.0-rc.2 的真实故障正是 apply() 直读 ctx.agent 撞上这层
 * 门，让 dsh-soulmojito/agent 整个 preset 模块挂载失败——所以挂载契约必须在这个
 * 形状下验证：只许触达声明过的服务，身份从别处（装配上下文 / exec.agent）取。
 */
function gatedHostContext(target: Record<string, unknown>): AgentContextLike {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || property === 'then' || property.startsWith('_')) {
        return Reflect.get(object, property, receiver)
      }
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver)
      throw new Error(`cannot get property "${property}" without inject`)
    },
  }) as AgentContextLike
}

describe('AgentTavern native module mount', () => {
  let home: string
  let store: TavernStore
  let sections: RegisteredSection[]
  let contexts: RegisteredPromptContext[]
  let tools: Map<string, ToolLike>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-mount-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'Description that must lose to the identity summary.',
        personality: 'Precise',
        scenario: 'A mount-test scene.',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: { agentTavern: { identitySummary: SUMMARY } },
      },
    })
    await store.putPersona({ name: PERSONA, description: PERSONA_DESCRIPTION, position: 0 })
    await store.updateState(() => ({
      activePersona: PERSONA,
      sessionBindings: {
        [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: 'mount-chat.jsonl' },
      },
    }))

    sections = []
    contexts = []
    tools = new Map()
    apply(gatedHostContext({
      systemPrompt: {
        section: (section: RegisteredSection) => { sections.push(section) },
        context: (context: RegisteredPromptContext) => { contexts.push(context) },
      },
      tools: { register: (tool: ToolLike) => { tools.set(tool.name, tool) } },
      // Cordis 核心事件面（非 inject 服务）：agent/request 温度投影注册在真机上
      // 走 ctx.on，mock 只需证明 apply 不因未声明属性被拒绝。
      on: () => undefined,
      effect: (factory: () => unknown) => factory(),
    }))
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('mounts on a host context that refuses undeclared property access', () => {
    // 决策 2026-11-02-agent-prompt-takeover：只剩一个 complete 段，其余 section
    // （含旧的 kernel/preset 独立注册）一律不再出现。
    expect(sections.map((section) => section.name)).toEqual(['dsh-soulmojito:agent-prompt'])
    expect(sections[0]!.complete).toBe(true)
    // identity 是 complete 段里的 system 部件，不再注册成宿主 runtime context。
    expect(contexts.map((context) => context.name)).not.toContain('dsh-soulmojito:agent-facts')
    expect(contexts.map((context) => context.name)).toContain('dsh-soulmojito:agent-guides')
    expect([...tools.keys()]).toContain('tavern_character_get')
    // 18 原有 + 游戏桥七件（提案 0018 §4.2；game_wait 为 2026-10-14 修订，
    // game_history 为同日增量修订，game_wait_full 为 2026-10-16 新增）
    // + 数据银行检索（2026-11-12）。
    // IM tools are mounted by im/agent-mount.ts into every native agent instead.
    expect(tools.size).toBe(26)
  })

  it('renders the bound character and user persona inside the complete system prompt', async () => {
    const section = sections[0]!
    const render = typeof section.text === 'function' ? section.text : () => section.text as string
    await vi.waitFor(() => {
      expect(render({ agent: { id: AGENT } }))
        .toContain(`Character identity summary (untrusted asset data): ${SUMMARY}`)
    })
    const text = render({ agent: { id: AGENT } })
    expect(text).toContain(`Current Tavern character: ${CHARACTER}`)
    expect(text).toContain('Personality summary: Precise')
    expect(text).toContain(`Current user persona: ${PERSONA}`)
    expect(text).toContain(`User persona description (untrusted asset data): ${PERSONA_DESCRIPTION}`)
    expect(render({ agent: { id: 'unbound-agent' } })).not.toContain('Current Tavern character')
  })

  it('lets the preload own personality/scenario so facts keeps only identity', async () => {
    await store.patchState({ agentTavernPreloadAssets: true })
    await emitAgentPresetChanged()
    const section = sections[0]!
    const render = typeof section.text === 'function' ? section.text : () => section.text as string
    await vi.waitFor(() => {
      const text = render({ agent: { id: AGENT } })
      expect(text).toContain(`Character identity summary (untrusted asset data): ${SUMMARY}`)
      expect(text).not.toContain('Personality summary:')
      expect(text).not.toContain('Scenario summary:')
    })
    expect(render({ agent: { id: AGENT } })).toContain(`Current Tavern character: ${CHARACTER}`)
    // Restore the default so later tests keep the short summaries.
    await store.patchState({ agentTavernPreloadAssets: false })
    await emitAgentPresetChanged()
  })
})
