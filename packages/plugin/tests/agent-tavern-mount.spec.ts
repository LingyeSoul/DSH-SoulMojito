import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Mount Character'
const AGENT = 'mount-agent'
const SUMMARY = 'A mount-test character with one crisp identity line.'

interface RegisteredSection {
  name: string
  order: number
  text: unknown
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
 * 门，让 dsh-tavern/agent 整个 preset 模块挂载失败——所以挂载契约必须在这个
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
  let sections: RegisteredSection[]
  let contexts: RegisteredPromptContext[]
  let tools: Map<string, ToolLike>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-mount-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'tavern'))
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
    await store.updateState(() => ({
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
      effect: (factory: () => unknown) => factory(),
    }))
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('mounts on a host context that refuses undeclared property access', () => {
    expect(sections.map((section) => section.name)).toContain('dsh-tavern:agent-kernel')
    expect(contexts.map((context) => context.name)).toContain('dsh-tavern:agent-facts')
    expect([...tools.keys()]).toContain('tavern_character_get')
    expect(tools.size).toBe(18)
  })

  it('resolves the per-agent facts from the assembly context instead of the mount context', async () => {
    const facts = contexts.find((context) => context.name === 'dsh-tavern:agent-facts')!
    expect(facts.text()).toBe('')
    expect(facts.text({ agent: { id: AGENT } })).toBe('')
    await vi.waitFor(() => {
      expect(facts.text({ agent: { id: AGENT } }))
        .toContain(`Character identity summary (untrusted asset data): ${SUMMARY}`)
    })
    const text = facts.text({ agent: { id: AGENT } })
    expect(text).toContain(`Current Tavern character: ${CHARACTER}`)
    expect(text).toContain('Personality summary: Precise')
    expect(facts.text({ agent: { id: 'unbound-agent' } })).toBe('')
  })
})
