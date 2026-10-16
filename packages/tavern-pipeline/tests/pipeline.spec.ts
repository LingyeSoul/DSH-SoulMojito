import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assemblePrompt, type AssembleInput, type LlmMessage } from '../src/index.js'
import { decodeCharacterCard, parsePreset, type CharacterCardIR, type PresetIR, type PromptOrderSet } from '@dsh-soulmojito/format'

const fixturesDir = fileURLToPath(new URL('../../tavern-format/tests/fixtures', import.meta.url))
const preset: PresetIR = parsePreset(JSON.parse(readFileSync(`${fixturesDir}/preset-Default.json`, 'utf8')))

const card: CharacterCardIR = decodeCharacterCard({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Seraphina', description: 'A dryad.', personality: 'gentle', scenario: 'In a forest.',
    first_mes: 'Hello!', mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
    creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
  },
})

const deps = {
  expand: (t: string) => t.replaceAll('{{char}}', 'Seraphina').replaceAll('{{user}}', 'Tester'),
  countTokens: (t: string) => Math.ceil(t.length / 4),
}

function baseInput(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    card,
    preset,
    messages: [
      { name: 'Seraphina', is_user: false, is_system: false, send_date: '', mes: 'Hello!' },
      { name: 'Tester', is_user: true, is_system: false, send_date: '', mes: 'Who are you?' },
    ],
    worldInfoBefore: ['WI-B1', 'WI-B2'],
    worldInfoAfter: ['WI-A1'],
    ...over,
  }
}

describe('装配顺序（ST Default.json 的 prompt_order）', () => {
  it('marker 依序展开，聊天前材料在 system，历史映射 user/assistant，jailbreak 在历史后', () => {
    const result = assemblePrompt(baseInput(), deps)
    const contents = result.messages.map((m) => m.content)
    const idx = (needle: string) => contents.findIndex((c) => c.includes(needle))
    // 顺序断言
    expect(idx('Write {{char}}')).toBeLessThanOrEqual(idx('WI-B1'))
    expect(idx('WI-B2')).toBeLessThan(idx('A dryad.'))
    expect(idx('A dryad.')).toBeLessThan(idx('gentle'))
    expect(idx('gentle')).toBeLessThan(idx('In a forest.'))
    expect(idx('In a forest.')).toBeLessThan(idx('WI-A1'))
    expect(idx('WI-A1')).toBeLessThan(idx('Who are you?'))
    // 历史角色映射
    const history = result.messages.filter((m) => m.content === 'Hello!' || m.content === 'Who are you?')
    expect(history.map((m) => m.role)).toEqual(['assistant', 'user'])
    // is_system 消息不进 prompt
    expect(result.messages.some((m) => m.content.includes('system-note'))).toBe(false)
  })

  it('wi_format 包裹激活条目', () => {
    const result = assemblePrompt(baseInput(), deps)
    const wi = result.messages.find((m) => m.content.includes('WI-B1'))
    expect(wi?.content).toBe('WI-B1\nWI-B2') // Default.json 的 wi_format 为 "{0}"
  })

  it('示例对话经 new_example_chat_prompt 前缀 + 宏展开', () => {
    const result = assemblePrompt(baseInput(), deps)
    const em = result.messages.find((m) => m.content.includes('Tester: hi'))
    expect(em?.content).toContain('Tester: hi')
    expect(em?.content).toContain('Seraphina: hello')
  })
})

describe('角色卡覆盖语义', () => {
  it('卡 system_prompt 覆盖 main，{{original}} 引用预设内容', () => {
    const withOverride = decodeCharacterCard({
      ...structuredClone(card.raw),
      data: { ...structuredClone(card.raw['data']), system_prompt: 'You are {{char}}. {{original}}' },
    })
    const result = assemblePrompt(baseInput({ card: withOverride }), deps)
    const main = result.messages[0]!
    expect(main.content).toContain('You are Seraphina.')
    expect(main.content).toContain("Write Seraphina's next reply") // {{original}} 内容同样过宏展开
  })

  it('卡 post_history_instructions 覆盖 jailbreak（历史之后）', () => {
    const withUjb = decodeCharacterCard({
      ...structuredClone(card.raw),
      data: { ...structuredClone(card.raw['data']), post_history_instructions: 'Stay in character.' },
    })
    const result = assemblePrompt(baseInput({ card: withUjb }), deps)
    const last = result.messages[result.messages.length - 1]!
    expect(last.role).toBe('system')
    expect(last.content).toBe('Stay in character.')
  })

  it('空串卡字段回落预设内容', () => {
    const result = assemblePrompt(baseInput(), deps)
    expect(result.messages[0]!.content).toContain("Write Seraphina's next reply")
  })
})

describe('裁剪与注入', () => {
  it('预算不足丢最旧消息并告警', () => {
    const result = assemblePrompt(baseInput({ maxContextTokens: 60, maxResponseTokens: 20 }), deps)
    expect(result.stats.historyDropped).toBeGreaterThan(0)
    expect(result.warnings.join()).toContain('dropped')
    expect(result.messages.some((m) => m.content === 'Hello!')).toBe(false)
    expect(result.messages.some((m) => m.content === 'Who are you?')).toBe(true)
  })

  it('squash_system_messages 合并相邻 system', () => {
    const squashPreset: PresetIR = { ...preset, sampler: { ...preset.sampler, squash_system_messages: true } }
    const result = assemblePrompt(baseInput({ preset: squashPreset }), deps)
    let adjacent = 0
    for (let i = 1; i < result.messages.length; i++) {
      if (result.messages[i]!.role === 'system' && result.messages[i - 1]!.role === 'system') adjacent++
    }
    expect(adjacent).toBe(0)
  })

  it('@Depth 注入：depth=1 插在最后一条历史之前', () => {
    const result = assemblePrompt(baseInput({
      depthInjections: [{ depth: 1, role: 'system', text: 'authors note' }],
    }), deps)
    const idxNote = result.messages.findIndex((m) => m.content === 'authors note')
    const idxLastHistory = result.messages.findIndex((m) => m.content === 'Who are you?')
    expect(idxNote).toBeGreaterThan(-1)
    expect(idxNote).toBe(idxLastHistory - 1)
  })
})

describe('prompt_order 选集与启用语义（ST openai.js: global dummy 100001）', () => {
  const selection = parsePreset({
    prompts: [
      { name: 'Global', identifier: 'globalOnly', role: 'system', content: 'GLOBAL SET TEXT.', system_prompt: true },
      { name: 'Legacy', identifier: 'legacyOnly', role: 'system', content: 'LEGACY SET TEXT.', system_prompt: true },
      { name: 'Disabled', identifier: 'disabledEntry', role: 'system', content: 'DISABLED SET TEXT.', system_prompt: true },
      { name: 'Style', identifier: 'styleEntry', role: 'system', content: 'STYLE MARKER TEXT.', system_prompt: false },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'legacyOnly', enabled: true }] },
      {
        character_id: 100001,
        order: [
          { identifier: 'globalOnly', enabled: true },
          { identifier: 'disabledEntry', enabled: false },
          { identifier: 'styleEntry', enabled: true },
        ],
      },
    ],
  })

  it('优先装配 global dummy 100001 组，跳过 enabled:false，system_prompt:false 仍注入', () => {
    const result = assemblePrompt(baseInput({ preset: selection }), deps)
    const text = result.messages.map((m) => m.content).join('\n')
    expect(text).toContain('GLOBAL SET TEXT.')
    // system_prompt 只是分类标记，不参与启用判定（社区预设的写作风格条目形状）
    expect(text).toContain('STYLE MARKER TEXT.')
    expect(text).not.toContain('DISABLED SET TEXT.')
    // 100001 存在时 100000 组不参与装配
    expect(text).not.toContain('LEGACY SET TEXT.')
  })

  it('缺少 100001 时回落 100000 组', () => {
    const legacy: PresetIR = { ...selection, promptOrder: selection.promptOrder.filter((o) => Number(o.character_id) !== 100001) }
    const result = assemblePrompt(baseInput({ preset: legacy }), deps)
    const text = result.messages.map((m) => m.content).join('\n')
    expect(text).toContain('LEGACY SET TEXT.')
    expect(text).not.toContain('GLOBAL SET TEXT.')
  })

  it('顺序表缺 enabled 布尔时回落条目自身 enabled（ST PromptManager 语义，决策 2026-10-09-dedup-refactor）', () => {
    const selfDisabled = parsePreset({
      prompts: [
        { name: 'Global', identifier: 'globalOnly', role: 'system', content: 'GLOBAL SET TEXT.', system_prompt: true },
        { name: 'SelfDisabled', identifier: 'selfDisabled', role: 'system', content: 'SELF DISABLED TEXT.', system_prompt: true, enabled: false },
      ],
      prompt_order: [
        // 手改数据的畸形形状：slot 缺 enabled 布尔 → 回落条目自身 enabled
        { character_id: 100001, order: [{ identifier: 'globalOnly' }, { identifier: 'selfDisabled' }] as PromptOrderSet['order'] },
      ],
    })
    const result = assemblePrompt(baseInput({ preset: selfDisabled }), deps)
    const text = result.messages.map((m) => m.content).join('\n')
    expect(text).toContain('GLOBAL SET TEXT.')
    expect(text).not.toContain('SELF DISABLED TEXT.')
  })
})
