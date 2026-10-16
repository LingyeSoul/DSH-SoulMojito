/**
 * 提示词查看器 Agent 模式（决策 2026-10-11-agent-prompt-viewer）：
 * - prompt-capture 的 pre-step 捕获面：只收本插件注入的消息（source 识别），
 *   decision 原样透传、异常吞掉（宿主 waterfall 链上零改写零抛错）；
 * - agent/request 链尾合成：绑定校验（未绑定/群聊跳过——含 tavern_deduce
 *   子代理）、预注入 section 快照（内置五段 + mod 段，与 apply 注册面对齐）、
 *   链尾最终配置为实发 params（含预设温度覆盖 + 密钥样键净化）；
 * - 覆盖面锁：apply 注册的内置 section 与 agentPromptSectionsFor 的读取面
 *   双向对账（新增注册忘了读面/反之都在这里炸）；
 * - 客户端 marker：Agent 模式渲染键在 zh/en 两张表各出现一次。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply as applyAgentTavern, agentPromptSectionsFor, type AgentContextLike } from '../src/agent-tavern/agent.js'
import {
  agentStepCaptureOf,
  registerAgentTavernPromptCapture,
  resetAgentStepCaptures,
} from '../src/agent-tavern/prompt-capture.js'
import { listPromptViews, resetPromptViews } from '../src/prompt-viewer.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { clearModRegistryForTest, modSectionSnapshot, registerModSection } from '../src/mods/cross-bundle.js'

const CHARACTER = 'Prompt View Agent Character'
const AGENT = 'prompt-view-agent'
const GROUP_AGENT = 'prompt-view-group-agent'
const UNBOUND_AGENT = 'prompt-view-unbound-agent'

const PRESET = {
  temperature: 0.7,
  prompts: [
    { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'Agent preset body for {{char}}.', system_prompt: true },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
}

const PLUGIN_MESSAGE = {
  id: 'msg-plugin',
  role: 'user',
  content: [{ type: 'text', text: '<tavern-anchor>reminder</tavern-anchor>' }],
  source: { kind: 'plugin:dsh-soulmojito' },
}
const USER_MESSAGE = {
  id: 'msg-user',
  role: 'user',
  content: [{ type: 'text', text: 'hello there' }],
  source: { kind: 'user' },
}
const FOREIGN_PLUGIN_MESSAGE = {
  id: 'msg-foreign',
  role: 'user',
  content: [{ type: 'text', text: 'someone else injection' }],
  source: { kind: 'plugin', plugin: 'another-plugin' },
}

async function until(condition: () => boolean, deadlineMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > deadlineMs) throw new Error('condition not met before deadline')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/* ------------------------------ pre-step 捕获面 ------------------------------ */

describe('agent pre-step prompt capture', () => {
  type Listener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  let listener: Listener

  beforeEach(() => {
    resetAgentStepCaptures()
    const listeners = new Map<string, Listener>()
    registerAgentTavernPromptCapture({
      on: (event: string, l: Listener) => { listeners.set(event, l); return undefined },
    })
    listener = listeners.get('agent/pre-step')!
  })

  const invoke = (payload: unknown, decision: unknown) => listener(payload, async () => decision)

  it('captures only plugin-sourced messages with turn/step for enter decisions', async () => {
    const decision = { kind: 'enter', messages: [USER_MESSAGE, PLUGIN_MESSAGE, FOREIGN_PLUGIN_MESSAGE] }
    const returned = await invoke({ agent: { session: { id: AGENT } }, turn: 3, step: 1 }, decision)
    expect(returned).toBe(decision)
    const capture = agentStepCaptureOf(AGENT)
    expect(capture?.turn).toBe(3)
    expect(capture?.step).toBe(1)
    expect(capture?.injected).toEqual([PLUGIN_MESSAGE])
  })

  it('passes non-enter decisions through without touching the capture', async () => {
    const decision = { kind: 'defer' }
    const returned = await invoke({ agent: { session: { id: AGENT } }, turn: 3, step: 1 }, decision)
    expect(returned).toBe(decision)
    expect(agentStepCaptureOf(AGENT)).toBeUndefined()
  })

  it('keeps the last capture per agent and ignores payloads without a session id', async () => {
    await invoke({ agent: { session: { id: AGENT } }, turn: 1, step: 1 }, { kind: 'enter', messages: [PLUGIN_MESSAGE] })
    await invoke({ agent: { session: { id: AGENT } }, turn: 2, step: 1 }, { kind: 'enter', messages: [] })
    expect(agentStepCaptureOf(AGENT)?.turn).toBe(2)
    await invoke({ turn: 9, step: 9 }, { kind: 'enter', messages: [PLUGIN_MESSAGE] })
    expect(agentStepCaptureOf('unknown')).toBeUndefined()
  })

  it('swallows capture failures and returns the decision untouched', async () => {
    const decision = {
      kind: 'enter',
      get messages(): unknown[] { throw new Error('boom') },
    }
    const returned = await invoke({ agent: { session: { id: AGENT } }, turn: 4, step: 1 }, decision)
    expect(returned).toBe(decision)
    expect(agentStepCaptureOf(AGENT)).toBeUndefined()
  })
})

/* --------------------------- agent/request 合成面 --------------------------- */

describe('agent prompt-viewer records (agent/request tail)', () => {
  let home: string
  let store: TavernStore
  let requestListener: (payload: { agent?: { id?: string } } | undefined, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
  let warnings: string[]

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-agent-prompt-view-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'An agent prompt-viewer character.', personality: 'Calm.', scenario: '',
        first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])
    await store.putPreset('Agent Preset', structuredClone(PRESET))
    await store.updateState(() => ({
      activePreset: 'Agent Preset',
      activePersona: 'Rin',
      sessionBindings: {
        [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
        [GROUP_AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId, group: true },
      },
    }))
    // 绑定先落库再挂载：preheat/懒装载与生产时序一致（preset spec 同款）。
    clearModRegistryForTest()

    warnings = []
    const eventListeners = new Map<string, (payload: never, next: () => Promise<never>) => Promise<never>>()
    applyAgentTavern({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: () => {} },
      on: (event: string, l: never) => { eventListeners.set(event, l) },
      effect: (fn: () => unknown) => { fn(); return () => {} },
      logger: { warn: (message: string) => { warnings.push(message) } },
    } as unknown as AgentContextLike)
    requestListener = eventListeners.get('agent/request') as typeof requestListener
    expect(requestListener).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetPromptViews()
    resetAgentStepCaptures()
  })

  it('records the pre-injection face with the final (post-override, sanitized) params', async () => {
    await registerCaptureFor(AGENT, 3, 1)
    const base = { provider: 'prov', model: 'mdl', temperature: 0.1, apiKeyEnv: 'SHOULD_NOT_APPEAR' }
    await requestListener({ agent: { id: AGENT } }, async () => structuredClone(base))

    // 懒装载首轮可能只带 kernel 段、预设温度也未就绪：轮询重放直到四条通道
    // （kernel/preset/facts/guides；script 未绑定剧本恒空摘除）齐面且温度覆盖
    // 生效再断言。
    await until(() => {
      void requestListener({ agent: { id: AGENT } }, async () => structuredClone(base))
      const latest = listPromptViews()[0]
      return latest !== undefined
        && latest.agent?.sections.some((section) => section.name === 'dsh-soulmojito:agent-facts')
        && latest.params.temperature === 0.7
    })
    // 链尾最终配置：预设温度覆盖生效（记录与返回同一形状——看到即实发）。
    const resolved = await requestListener({ agent: { id: AGENT } }, async () => structuredClone(base))
    expect(resolved.temperature).toBe(0.7)
    expect(resolved.provider).toBe('prov')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const record = listPromptViews()[0]!
    expect(record.mode).toBe('agent-tavern')
    expect(record.character).toBe(CHARACTER)
    expect(record.chatId).toBe((await store.getState()).sessionBindings[AGENT]!.chatId)
    // params 净化：密钥样键整对丢弃，温度是覆盖后的实发值。
    expect(record.params).toEqual({ provider: 'prov', model: 'mdl', temperature: 0.7 })
    // 预注入消息：本 step 插件注入的一条（用户消息/外来注入不计），脱壳成纯文本。
    expect(record.messages).toEqual([{ role: 'user', content: '<tavern-anchor>reminder</tavern-anchor>' }])
    // 补充面：会话 id + 轮/步标记 + 分面 section（order 升序）。
    expect(record.agent?.sessionId).toBe(AGENT)
    expect(record.agent?.turn).toBe(3)
    expect(record.agent?.step).toBe(1)
    // guides 未配置 / script 未绑定剧本：空文本段摘除（宿主对空 context 同款语义）。
    expect(record.agent?.sections.map((section) => section.name)).toEqual([
      'dsh-soulmojito:agent-kernel', 'dsh-soulmojito:agent-preset', 'dsh-soulmojito:agent-facts',
    ])
    const presetSection = record.agent!.sections.find((section) => section.name === 'dsh-soulmojito:agent-preset')!
    expect(presetSection.text).toContain('Agent preset body')
    expect(presetSection.order).toBe(-75)
    // system = 分面文本拼接（供 token 估算与快速浏览）。
    expect(record.system).toBe(record.agent!.sections.map((section) => section.text).join('\n\n'))
    expect(record.promptTokens).toBeGreaterThan(0)
    expect(record.loreTrace).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('skips unbound agents (deduce subagents) and group bindings', async () => {
    // 先 drain 前一测试末次 fire-and-forget 记录落账，再清缓冲——被测对象是
    // 「本测试的两次调用零记录」，不能被跨测试在途记录污染。
    await new Promise((resolve) => setTimeout(resolve, 100))
    resetPromptViews()
    await registerCaptureFor(UNBOUND_AGENT, 1, 1)
    await registerCaptureFor(GROUP_AGENT, 1, 1)
    await requestListener({ agent: { id: UNBOUND_AGENT } }, async () => ({ provider: 'p' }))
    await requestListener({ agent: { id: GROUP_AGENT } }, async () => ({ provider: 'p' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(listPromptViews()).toHaveLength(0)
  })

  it('records even when no pre-step capture exists (step markers absent, not mislabeled)', async () => {
    const resolved = await requestListener({ agent: { id: AGENT } }, async () => ({ provider: 'prov', model: 'mdl' }))
    expect(resolved.provider).toBe('prov')
    await until(() => listPromptViews().length > 0)
    const record = listPromptViews()[0]!
    expect(record.messages).toEqual([])
    expect(record.agent?.turn).toBeUndefined()
    expect(record.agent?.step).toBeUndefined()
    expect(record.agent?.sessionId).toBe(AGENT)
  })

  async function registerCaptureFor(agentId: string, turn: number, step: number): Promise<void> {
    const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    registerAgentTavernPromptCapture({
      on: (event: string, l: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => { listeners.set(event, l); return undefined },
    })
    await listeners.get('agent/pre-step')!(
      { agent: { session: { id: agentId } }, turn, step },
      async () => ({ kind: 'enter', messages: [USER_MESSAGE, PLUGIN_MESSAGE] }),
    )
  }
})

/* ------------------------------ 覆盖面锁 + mod 段 ------------------------------ */

describe('agentPromptSectionsFor coverage lock', () => {
  it('mirrors the apply() builtin registrations in both directions', async () => {
    const registered: Array<{ name: string; order: number; kind: string }> = []
    applyAgentTavern({
      systemPrompt: {
        section: (def: { name: string; order: number }) => { registered.push({ name: def.name, order: def.order, kind: 'section' }) },
        context: (def: { name: string; order: number }) => { registered.push({ name: def.name, order: def.order, kind: 'context' }) },
      },
      tools: { register: () => {} },
      on: () => undefined,
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as unknown as AgentContextLike)
    // 新增内置 section 必须同时改 apply 注册与 agentPromptSectionsFor 读取表：
    // 任一侧漂移都会在这里炸（名字或 order 不齐）。
    const builtin = [
      { name: 'dsh-soulmojito:agent-kernel', order: -80, kind: 'section' },
      { name: 'dsh-soulmojito:agent-preset', order: -75, kind: 'section' },
      { name: 'dsh-soulmojito:agent-facts', order: -70, kind: 'context' },
      { name: 'dsh-soulmojito:agent-guides', order: -65, kind: 'context' },
      { name: 'dsh-soulmojito:agent-script', order: -64, kind: 'context' },
      { name: 'dsh-soulmojito:agent-games', order: -63, kind: 'context' },
    ]
    expect(registered).toEqual(builtin)
    // 读面方向：unbound agent 懒装载恒空，只验证「读面不产生注册面之外的段」；
    // 「注册面五段都进记录」的方向由上面的端到端记录测试锁（装载后逐段断言）。
    const allowed = new Set([
      ...builtin.map((section) => section.name),
      ...modSectionSnapshot().map((entry) => `dsh-soulmojito:mod:${entry.modId}:${entry.definition.name}`),
    ])
    for (const name of agentPromptSectionsFor('coverage-agent').map((section) => section.name)) {
      expect(allowed.has(name)).toBe(true)
    }
  })

  it('includes mod sections with clamped order and neutralized text', () => {
    const dispose = registerModSection('mymod', { name: 'flavor', order: -999, text: 'MOD SECTION BODY {{raw}}' }, 0)
    try {
      const sections = agentPromptSectionsFor('coverage-agent')
      const mod = sections.find((section) => section.name === 'dsh-soulmojito:mod:mymod:flavor')
      expect(mod).toBeDefined()
      // 越界 order 钳进 mod 专属区间（-50..0），与 agent-mount 挂载面同式。
      expect(mod!.order).toBe(-50)
      expect(mod!.text).toContain('MOD SECTION BODY')
      expect(mod!.text).not.toContain('{{')
      // order 升序：mod 段排在核心段之后。
      const orders = sections.map((section) => section.order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
    } finally {
      dispose()
    }
  })
})

/* ------------------------------ 客户端 marker ------------------------------ */

describe('client agent prompt-viewer rendering markers (main.js source check)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')
  const sectionKey = "'settings.promptsAgentSections':"
  const messageKey = "'settings.promptsAgentMessages':"

  it('carries the agent rendering keys in both the zh and en tables', () => {
    expect(source.split(sectionKey).length - 1).toBe(2)
    expect(source.split(messageKey).length - 1).toBe(2)
  })

  it('marker does not match a near-miss key (negative sample)', () => {
    expect("'settings.promptsAgentSectionsX':".includes(sectionKey)).toBe(false)
    expect("'settings.promptsAgentMessagesX':".includes(messageKey)).toBe(false)
  })
})
