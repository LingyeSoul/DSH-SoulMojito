/**
 * AgentTavern 自动上下文注入（契约 2026-11-12 §2.10，Owner E）。
 *
 * 覆盖四件事：
 * 1. 开关关闭（默认）不注入；
 * 2. 开启后世界书/记忆/summary/note 各出一块，且每块带 reference data 标注；
 * 3. 没有数据不产出空块（纯格式化 + 未绑定 agent 两条路径）；
 * 4. 字符上限截断生效，以及预设投影对 instruct/context 形态的明确「不投影」。
 *
 * 夹具全部代码合成（占位角色/世界书/记忆），不引用真实素材或绝对用户路径。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as applyAgentTavern, refreshAgentContextInjection, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { registeredAgentPromptParts } from '../src/agent-tavern/prompt-parts.js'
import {
  AGENT_CONTEXT_LIMITS,
  AGENT_CONTEXT_REFERENCE_LABEL,
  createAgentContextInjectionChannel,
  formatLoreBlock,
  formatMemoryBlock,
  formatNoteBlock,
  formatSummaryBlock,
  joinAgentContextBlocks,
} from '../src/agent-tavern/context-injection.js'
import { emitAgentPresetChanged, projectAgentPreset } from '../src/agent-tavern/preset.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import { sharedMemoryStore } from '../src/shared-stores.js'
import { TavernStore, type TavernState } from '../../tavern-store/src/index.js'

const CHARACTER = 'Context Character'
const AGENT = 'context-injection-agent'
const UNBOUND_AGENT = 'context-injection-unbound'
const SUMMARY_TEXT = 'Earlier the party crossed the salt marsh and met the ferryman.'
const NOTE_TEXT = 'Keep prose terse and never write dialogue for the user.'

/** 注入块读取面：与宿主装配回调取同一个部件（同源即所见）。 */
function contextTextOf(agentId: string | undefined): string {
  const part = registeredAgentPromptParts().find((entry) => entry.name === 'dsh-soulmojito:agent-context')
  return part!.text(agentId)
}

describe('AgentTavern automatic context injection', () => {
  let home: string
  let store: TavernStore
  let chatId: string
  const warnings: string[] = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-agent-context-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A context-injection character', personality: '', scenario: '',
        first_mes: 'Hello', mes_example: '', creator_notes: '', system_prompt: '',
        post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
        character_version: '', extensions: {},
      },
    })
    await store.importWorldFile('Context World', {
      entries: {
        '1': {
          uid: 1, key: [], comment: 'Standing canon', constant: true, order: 100,
          content: 'The harbor is ruled by the Tide Council.',
        },
        '2': {
          uid: 2, key: ['dragon'], comment: 'Dragon lore', order: 90,
          content: 'DRAGONKEY lore about the harbor dragons.',
        },
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        timedWorldInfo: {},
        summary: SUMMARY_TEXT,
        note_prompt: NOTE_TEXT,
      },
    }, [{
      name: 'User', is_user: true, is_system: false, send_date: '2026-01-01T00:00:01.000Z',
      mes: 'A dragon roars over the harbor.',
    }])
    await store.updateState((state) => ({
      activeWorlds: ['Context World'],
      sessionBindings: {
        ...state.sessionBindings,
        [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))

    // 记忆夹具：importance 递减，用于验证 top-N 与排序（低值两条应被挤出 top-5）。
    const memories = await sharedMemoryStore(tavernDataRoot())
    for (let index = 1; index <= 7; index += 1) {
      await memories.put({
        id: `memory-${index}`,
        scope: 'chat',
        scopeId: chatId,
        kind: 'semantic',
        // 高序号 = 低 importance；内容前缀便于断言在块内外的位置。
        content: `MEMORY-${index} Tide Council note ${index}`,
        importance: 1 - index * 0.1,
        confidence: 0.8,
        source: { kind: 'synthetic-test' },
      })
    }

    applyAgentTavern({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: () => {} },
      logger: { warn: (message: string) => { warnings.push(message) } },
      effect: (factory: () => unknown) => { factory(); return () => {} },
    } as unknown as AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('injects nothing while the behavior flag is off (default)', async () => {
    expect(registeredAgentPromptParts().find((part) => part.name === 'dsh-soulmojito:agent-context')?.order).toBe(-62)
    await refreshAgentContextInjection(AGENT)
    expect(contextTextOf(AGENT)).toBe('')
  })

  it('produces no blocks when every source is empty', async () => {
    expect(joinAgentContextBlocks([
      formatLoreBlock([]),
      formatMemoryBlock([]),
      formatSummaryBlock(''),
      formatSummaryBlock(undefined),
      formatNoteBlock('   '),
      formatNoteBlock(null),
    ])).toBe('')
    // 未绑定 agent：通道侧同样不产出文本（首次装配触发懒装载，refresh 后落定）。
    expect(contextTextOf(UNBOUND_AGENT)).toBe('')
    await refreshAgentContextInjection(UNBOUND_AGENT)
    expect(contextTextOf(UNBOUND_AGENT)).toBe('')
  })

  it('injects one reference-data block per source once the flag is on', async () => {
    await store.updateState(() => ({ agentContextInjection: true } as Partial<TavernState>))
    await refreshAgentContextInjection(AGENT)
    const text = contextTextOf(AGENT)
    expect(text).not.toBe('')

    const blocks = text.split('\n\n')
    // 每块都以统一的 reference-data 标注起头：世界书、记忆、summary、note 各一块。
    expect(blocks).toHaveLength(4)
    for (const block of blocks) expect(block.startsWith(AGENT_CONTEXT_REFERENCE_LABEL)).toBe(true)

    const lore = blocks.find((block) => block.includes('World information activated'))!
    // 常驻条目与关键词命中条目都进块。
    expect(lore).toContain('Tide Council')
    expect(lore).toContain('DRAGONKEY')
    expect(lore).toContain('[world book: Context World')

    const memory = blocks.find((block) => block.includes('Remembered facts'))!
    // top-5：高 importance 在前，最低的两条被挤出。
    expect(memory).toContain('MEMORY-1')
    expect(memory).toContain('MEMORY-5')
    expect(memory).not.toContain('MEMORY-6')
    expect(memory).not.toContain('MEMORY-7')
    expect(memory.indexOf('MEMORY-1')).toBeLessThan(memory.indexOf('MEMORY-2'))

    expect(text).toContain(SUMMARY_TEXT)
    expect(text).toContain(NOTE_TEXT)
    // 宏安全：注入文本不得残留 {{（宿主 interpolate 会中止装配）。
    expect(text).not.toContain('{{')
  })

  it('truncates oversized blocks and keeps the source annotation', async () => {
    const oversized = 'S'.repeat(5000)
    await store.withChat(CHARACTER, chatId, (chat) => {
      chat.header.chat_metadata['summary'] = oversized
    }, { attempts: 2, delayMs: () => 0 })
    await refreshAgentContextInjection(AGENT)
    const summary = contextTextOf(AGENT).split('\n\n').find((block) => block.includes('Chat summary'))!
    expect(summary.length).toBeLessThanOrEqual(AGENT_CONTEXT_LIMITS.summaryBlockChars)
    expect(summary.endsWith('…')).toBe(true)
    // 恢复夹具摘要，避免影响后续用例。
    await store.withChat(CHARACTER, chatId, (chat) => {
      chat.header.chat_metadata['summary'] = SUMMARY_TEXT
    }, { attempts: 2, delayMs: () => 0 })
  })

  it('reloads on the refresh interval and skips it inside the window', async () => {
    let clock = 0
    let builds = 0
    const channel = createAgentContextInjectionChannel({
      refreshMs: 1000,
      now: () => clock,
      build: async () => {
        builds += 1
        return `text-${builds}`
      },
    })
    expect(channel.textOf(AGENT)).toBe('')
    await channel.refreshOne(AGENT)
    expect(channel.textOf(AGENT)).toBe('text-1')
    clock = 500
    expect(channel.textOf(AGENT)).toBe('text-1')
    expect(builds).toBe(1)
    clock = 1500
    // 过期后 textOf 触发异步重载：调用瞬间仍返回旧值，落定后换新值。
    expect(channel.textOf(AGENT)).toBe('text-1')
    await channel.refreshOne(AGENT)
    expect(channel.textOf(AGENT)).toBe('text-2')
  })

  it('reports the preset kinds it cannot project instead of silently injecting nothing', async () => {
    // chat-completion 仍走既有投影（内容 + temperature）。
    const chatCompletion = projectAgentPreset({
      temperature: 0.4,
      prompts: [{ name: 'Main', identifier: 'main', role: 'system', content: 'STAY IN VOICE.', system_prompt: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    })
    expect(chatCompletion.refusals).toEqual([])
    expect(chatCompletion.text).toContain('STAY IN VOICE.')
    expect(chatCompletion.temperature).toBe(0.4)

    // context / instruct 形态：导入合法，但 AgentTavern 不拆 ST 的消息帧 → 明确拒绝。
    const contextTemplate = projectAgentPreset({ story_string: '{{description}}' })
    expect(contextTemplate.text).toBeUndefined()
    expect(contextTemplate.refusals).toHaveLength(1)
    expect(contextTemplate.refusals[0]!.kind).toBe('context')
    expect(contextTemplate.refusals[0]!.reason).toContain('nothing is projected')

    const instructTemplate = projectAgentPreset({ input_prefix: 'User: ', output_prefix: 'Char: ' })
    expect(instructTemplate.text).toBeUndefined()
    expect(instructTemplate.refusals[0]!.kind).toBe('instruct')

    // reasoning 形态（格式层分类由 §2.9 扩展）：无论是否已识别，都必须给出拒绝原因。
    const reasoning = projectAgentPreset({ name: 'Reasoning', reasoning_effort: 'high' })
    expect(reasoning.text).toBeUndefined()
    expect(reasoning.refusals).toHaveLength(1)
    expect(reasoning.refusals[0]!.reason.length).toBeGreaterThan(0)

    // 解析损坏的 chat-completion 预设：显式拒绝，而不是被懒装载吞成空白。
    const broken = projectAgentPreset({ prompts: ['not-an-object'], prompt_order: [{ character_id: 1, order: [] }] })
    expect(broken.text).toBeUndefined()
    expect(broken.refusals[0]!.kind).toBe('chat-completion')
    expect(broken.refusals[0]!.reason).toContain('could not be parsed')

    // 激活一个 instruct 预设走写穿：宿主日志必须出现「不投影」，不得静默。
    await store.putPreset('Instruct Only', { input_prefix: 'User: ', output_prefix: 'Char: ' })
    await store.updateState(() => ({ activePreset: 'Instruct Only' }))
    warnings.length = 0
    await emitAgentPresetChanged()
    expect(warnings.some((message) => message.includes('not projected') && message.includes('kind instruct'))).toBe(true)
    // 不投影 ⇒ 预设段为空（identity/kernel 段照常，不受影响）。
    expect(registeredAgentPromptParts().find((part) => part.name === 'dsh-soulmojito:agent-preset')!.text(AGENT)).toBe('')
  })
})
