import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HostSessionEvent } from '../../bind/src/index.js'
import { agentPresetUserTextOf, apply as applyAgentTavern, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { registeredAgentPromptParts } from '../src/agent-tavern/prompt-parts.js'
import {
  AGENT_PRESET_BLOCK_HEADER,
  AGENT_PRESET_USER_HEADER,
  agentPresetPreambleEntries,
  projectAgentPreset,
  renderAgentPresetBlock,
  renderAgentPresetUserBlock,
} from '../src/agent-tavern/preset.js'
import {
  isPresetUserBlockEvent,
  presetUserBlockDue,
  registerAgentPresetUserBlock,
  type AgentPresetUserBlockContext,
} from '../src/agent-tavern/preset-user-block.js'
import { parsePreset } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const MIXED_PRESET = {
  temperature: 0.6,
  prompts: [
    { name: 'Main', identifier: 'main', role: 'system', content: 'SYSTEM MAIN for {{char}}.', system_prompt: true },
    { name: 'User Frame', identifier: 'userFrame', role: 'user', content: 'USER FRAME: speak as {{user}}.', system_prompt: true },
    { name: 'Second User Frame', identifier: 'userFrameTwo', role: 'user', content: 'USER FRAME TWO.', system_prompt: true },
    { name: 'Assistant Sample', identifier: 'assistantSample', role: 'assistant', content: 'ASSISTANT SAMPLE prose.', system_prompt: true },
  ],
  prompt_order: [{
    character_id: 100001,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'userFrame', enabled: true },
      { identifier: 'userFrameTwo', enabled: true },
      { identifier: 'assistantSample', enabled: true },
    ],
  }],
}

const USER_ONLY_PRESET = {
  prompts: [
    { name: 'User Frame', identifier: 'userFrame', role: 'user', content: 'USER ONLY TEXT.', system_prompt: true },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'userFrame', enabled: true }] }],
}

const CLAIMED_MESSAGE = { id: 'claimed', role: 'user', content: [{ type: 'text', text: 'claimed turn input' }] }

const PRESET_CHARACTER = 'Preset User Block Character'
const AGENT = 'preset-user-block-agent'

interface FakeSession {
  id: string
  events: unknown[]
  append: () => undefined
}

type PreStepListener = (
  payload: unknown,
  next: () => Promise<{ kind: string; messages: unknown[] }>,
) => Promise<{ kind: string; messages: Array<{ id?: string; content: Array<{ text: string }> }> }>

function makeSession(id: string): FakeSession {
  return { id, events: [], append: () => undefined }
}

function claimedNext(): Promise<{ kind: string; messages: unknown[] }> {
  return Promise.resolve({ kind: 'enter', messages: [{ ...CLAIMED_MESSAGE }] })
}

function mountListener(text: string | undefined, isTavern: boolean): PreStepListener {
  let listener: PreStepListener | undefined
  const ctx = {
    on: vi.fn((event: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      if (event === 'agent/pre-step') listener = fn as unknown as PreStepListener
      return () => {}
    }),
  }
  // Fake ctx 只实现注册面；模块自己声明的窄 ctx 类型在此收口。
  registerAgentPresetUserBlock(ctx as unknown as AgentPresetUserBlockContext, {
    ensureUserText: async () => text,
    isAgentTavernSession: async () => isTavern,
  })
  expect(listener).toBeDefined()
  return listener!
}

describe('preset user-role entries', () => {
  it('moves non-system preset entries out of the system block and keeps their order as a preamble', () => {
    const preset = parsePreset(structuredClone(MIXED_PRESET))
    const system = renderAgentPresetBlock(preset)
    const user = renderAgentPresetUserBlock(preset)

    expect(system).toBeDefined()
    expect(system!.startsWith(AGENT_PRESET_BLOCK_HEADER)).toBe(true)
    expect(system).toContain('SYSTEM MAIN for {{char}}.')
    // 非 system 条目全部移出 system 块（user 与 assistant 都是对话帧发言）。
    expect(system).not.toContain('USER FRAME')
    expect(system).not.toContain('ASSISTANT SAMPLE')

    expect(user).toBeDefined()
    expect(user!.startsWith(AGENT_PRESET_USER_HEADER)).toBe(true)
    expect(user).toContain('USER FRAME: speak as {{user}}.')
    expect(user).toContain('USER FRAME TWO.')
    expect(user).not.toContain('SYSTEM MAIN')
    expect(user).not.toContain('ASSISTANT SAMPLE')
    // prompt_order 顺序保持
    expect(user!.indexOf('USER FRAME: speak')).toBeLessThan(user!.indexOf('USER FRAME TWO.'))

    // 帧化原料：原始 content、按 prompt_order 顺序、含 assistant 条目。
    expect(agentPresetPreambleEntries(preset)).toEqual([
      { role: 'user', content: 'USER FRAME: speak as {{user}}.' },
      { role: 'user', content: 'USER FRAME TWO.' },
      { role: 'assistant', content: 'ASSISTANT SAMPLE prose.' },
    ])
  })

  it('leaves the system block undefined when the preset only holds user-role entries', () => {
    const preset = parsePreset(structuredClone(USER_ONLY_PRESET))
    expect(renderAgentPresetBlock(preset)).toBeUndefined()
    expect(renderAgentPresetUserBlock(preset)).toContain('USER ONLY TEXT.')
    // 投影层同一个判定：system 块为空，user 块与 preamble 各自产出
    const projection = projectAgentPreset(structuredClone(USER_ONLY_PRESET))
    expect(projection.text).toBeUndefined()
    expect(projection.userText).toContain(AGENT_PRESET_USER_HEADER)
    expect(projection.userText).toContain('USER ONLY TEXT.')
    expect(projection.preamble).toEqual([{ role: 'user', content: 'USER ONLY TEXT.' }])
  })

  it('injects one user message at the head of the batch and never repeats it', async () => {
    const listener = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, true)
    const session = makeSession('inject-once')

    const first = await listener({ agent: { session }, turn: 1, step: 1 }, claimedNext)
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(2)
    expect(first.messages[0]!.content[0]!.text).toContain('USER FRAME BODY')
    // 插件消息放在 claimed 批次之前（等价于历史之前）
    expect(first.messages[1]!.id).toBe('claimed')
    expect(isPresetUserBlockEvent({ type: 'user/message', data: first.messages[0] })).toBe(true)

    // 宿主把注入消息落进事件流后，第二次 pre-step 不再重复注入。
    session.events.push({ type: 'user/message', data: first.messages[0] })
    const second = await listener({ agent: { session }, turn: 1, step: 2 }, claimedNext)
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]!.id).toBe('claimed')
  })

  it('re-injects once after compaction/end', async () => {
    const listener = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, true)
    const session = makeSession('compact-reinject')

    const first = await listener({ agent: { session }, turn: 1, step: 1 }, claimedNext)
    session.events.push({ type: 'user/message', data: first.messages[0] })
    session.events.push({ type: 'compaction/start' }, { type: 'compaction/end' })

    const afterCompaction = await listener({ agent: { session }, turn: 2, step: 1 }, claimedNext)
    expect(afterCompaction.messages).toHaveLength(2)
    expect(afterCompaction.messages[0]!.content[0]!.text).toContain('USER FRAME BODY')
    session.events.push({ type: 'user/message', data: afterCompaction.messages[0] })

    const markerCount = session.events.filter((event) => isPresetUserBlockEvent(event as HostSessionEvent)).length
    expect(markerCount).toBe(2)
    const settled = await listener({ agent: { session }, turn: 2, step: 2 }, claimedNext)
    expect(settled.messages).toHaveLength(1)
  })

  it('does not re-inject after a failed compaction', async () => {
    const listener = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, true)
    const session = makeSession('failed-compaction')

    const first = await listener({ agent: { session }, turn: 1, step: 1 }, claimedNext)
    session.events.push({ type: 'user/message', data: first.messages[0] })
    session.events.push(
      { type: 'compaction/start' },
      { type: 'compaction/end', data: { error: { message: 'summary failed' } } },
    )

    const next = await listener({ agent: { session }, turn: 2, step: 1 }, claimedNext)
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]!.id).toBe('claimed')
  })

  it('skips sessions already seeded by the activation-time preamble', async () => {
    // 激活期已把 user 块写成带 presetUserBlock 标记的真实 user 消息：pre-step
    // 兜底通道必须认这条消息为已注入，不得重复。
    const listener = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, true)
    const session = makeSession('seeded-session')
    session.events.push({
      type: 'user/message',
      data: {
        id: 'seeded',
        role: 'user',
        content: [{ type: 'text', text: 'seeded preset user block' }],
        source: { kind: 'plugin:dsh-soulmojito', form: 'instructions', presetUserBlock: true },
      },
    })
    expect((await listener({ agent: { session }, turn: 2, step: 1 }, claimedNext)).messages).toHaveLength(1)

    // 压缩之后仍只重注一次 user 合并块（assistant 条目不在 re-injection 里）。
    session.events.push({ type: 'compaction/end' })
    const reinjected = await listener({ agent: { session }, turn: 3, step: 1 }, claimedNext)
    expect(reinjected.messages).toHaveLength(2)
    const text = reinjected.messages[0]!.content[0]!.text
    expect(text.startsWith(AGENT_PRESET_USER_HEADER)).toBe(true)
    expect(text).not.toContain('ASSISTANT SAMPLE')
  })

  it('skips non-AgentTavern bindings, empty user blocks and aborted steps', async () => {
    const session = makeSession('skip-cases')
    const foreign = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, false)
    expect((await foreign({ agent: { session } }, claimedNext)).messages).toHaveLength(1)

    const empty = mountListener(undefined, true)
    expect((await empty({ agent: { session } }, claimedNext)).messages).toHaveLength(1)

    const aborted = mountListener(`${AGENT_PRESET_USER_HEADER}\n\nUSER FRAME BODY`, true)
    const decision = await aborted({ agent: { session }, signal: { aborted: true } }, claimedNext)
    expect(decision.messages).toHaveLength(1)

    // 判定纯函数：无注入 ⇒ 需要注入；注入早于压缩 ⇒ 需要注入；无压缩且有注入 ⇒ 不需要。
    expect(presetUserBlockDue([])).toBe(true)
    expect(presetUserBlockDue([{ type: 'compaction/end' }])).toBe(true)
    expect(presetUserBlockDue([{ type: 'user/message', data: { source: { kind: 'user' } } }])).toBe(true)
  })
})

describe('AgentTavern preset user block wiring', () => {
  let home: string
  let store: TavernStore
  let chatId: string
  let preStep: PreStepListener | undefined

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-preset-user-block-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: PRESET_CHARACTER, description: 'A preset user block character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    chatId = await store.createChat(PRESET_CHARACTER, {
      user_name: 'Rin', character_name: PRESET_CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} },
    }, [])
    await store.putPreset('User Block Preset', structuredClone(MIXED_PRESET))
    await store.updateState(() => ({
      activePreset: 'User Block Preset',
      activePersona: 'Rin',
      sessionBindings: {
        [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: PRESET_CHARACTER, chatId },
      },
    }))

    applyAgentTavern({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: () => {} },
      on: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        if (event === 'agent/pre-step') preStep = listener as unknown as PreStepListener
        return undefined
      },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as unknown as AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('drives the real projection through agent/pre-step with macros expanded', async () => {
    await vi.waitFor(() => {
      expect(agentPresetUserTextOf(AGENT)).toContain('USER FRAME')
    })
    const session = makeSession(AGENT)
    const decision = await preStep!({ agent: { session }, turn: 1, step: 1 }, claimedNext)
    const injected = decision.messages[0]!
    expect(decision.messages).toHaveLength(2)
    expect(injected.content[0]!.text.startsWith(AGENT_PRESET_USER_HEADER)).toBe(true)
    // 冻结 expander 与 system 块同源：ST 宏已展开、无 {{...}} 残片
    expect(injected.content[0]!.text).toContain('USER FRAME: speak as Rin.')
    expect(injected.content[0]!.text).not.toContain('{{')
    // system 块只剩 system 条目；user/assistant 条目转为 preamble/兜底通道
    const part = registeredAgentPromptParts().find((entry) => entry.name === 'dsh-soulmojito:agent-preset')
    const system = part!.text(AGENT)
    expect(system).toContain('SYSTEM MAIN for Preset User Block Character.')
    expect(system).not.toContain('ASSISTANT SAMPLE')
    expect(system).not.toContain('USER FRAME')
  })

  it('does not inject into sessions without an AgentTavern binding', async () => {
    const session = makeSession('unbound-session')
    const decision = await preStep!({ agent: { session }, turn: 1, step: 1 }, claimedNext)
    expect(decision.messages).toHaveLength(1)
  })
})