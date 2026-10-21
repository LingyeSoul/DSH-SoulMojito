import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { readMvuAudit } from '../src/agent-tavern/projector.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Schema Settle Character'

// 卡内 stat_data 约定（extensions.agentTavern.initialVariables）携带 $schema：
// 新聊天整树播种进 chat_metadata.variables，守卫据此锁定结构与约束。
const SCHEMA = {
  mvu: {
    favor: { $range: [0, 100] },
    mood: { $enum: ['calm', 'tense'] },
    name: { $ro: true },
    stats: { hp: 0, mp: 0 },
    allies: { '*': { hp: 0 } },
    bag: [{ item: '', count: { $range: [0, 99] } }],
  },
}
const SEEDED_VARIABLES = {
  $schema: SCHEMA,
  mvu: { favor: 10, mood: 'calm', name: '艾琳', stats: { hp: 5, mp: 5 } },
}

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('AgentTavern tavern_variable_settle under the $schema guard (C-1)', () => {
  let home: string
  let tools: Map<string, RegisteredTool>
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-mvu-guard-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'A character with a guarded MVU schema.',
        personality: 'Steady',
        scenario: 'A guard test scene.',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
        extensions: { agentTavern: { initialVariables: structuredClone(SEEDED_VARIABLES) } },
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString(), variables: structuredClone(SEEDED_VARIABLES) },
    })
    await store.updateState(() => ({
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))

    tools = new Map()
    apply({
      systemPrompt: {
        section: () => {},
        context: () => {},
      },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const settle = (changes: unknown[]) =>
    tools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: 'native' } })
  const chatOf = async () => (await (await TavernStore.open(join(home, 'soulmojito'))).getChat(CHARACTER, chatId))!
  const storedValue = async (name: string) =>
    (await (await VariableStore.open(join(home, 'soulmojito'))).get('chat', chatId, name))?.value

  it('clamps an out-of-range settle and records the guard note in receipt and audit', async () => {
    const result = await settle([{ name: 'mvu.favor', value: 150, reason: 'shared a meal' }])
    expect(result.applied).toEqual(['mvu.favor'])
    expect(result.failed).toEqual([])
    expect(result.receipt.status).toBe('updated')
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 10, after: 100, reason: 'mvu.favor: guard clamp: 150 -> 100' },
    ])
    expect(await storedValue('mvu.favor')).toBe(100)
    const audit = await readMvuAudit(join(home, 'soulmojito'))
    expect(audit.at(-1)!.changes[0]).toEqual({
      name: 'mvu.favor', reason: 'shared a meal; mvu.favor: guard clamp: 150 -> 100', before: 10, after: 100,
    })
  })

  it('rejects enum / readonly / type-mismatch writes as retryable per-item failures', async () => {
    const result = await settle([
      { name: 'mvu.mood', value: 'angry', reason: 'provoked' },
      { name: 'mvu.name', value: '新名字' },
      { name: 'mvu.favor', value: 'high' },
    ])
    expect(result.applied).toEqual([])
    expect(result.failed.map((failure) => failure.error)).toEqual([
      expect.stringContaining('guard enum-violation'),
      expect.stringContaining('guard readonly'),
      expect.stringContaining('guard type-mismatch'),
    ])
    expect(result.receipt.status).toBe('failed')
    expect(result.receipt.changes).toEqual([])
    // 原值保留：flat store 未写，聊天播种树未动
    expect(await storedValue('mvu.mood')).toBeUndefined()
    const chat = await chatOf()
    expect(chat.header.chat_metadata.variables).toEqual(SEEDED_VARIABLES)
    // 审计线与请求逐项对齐（失败项只有名字与 reason）
    const audit = await readMvuAudit(join(home, 'soulmojito'))
    expect(audit.at(-1)!.status).toBe('failed')
    expect(audit.at(-1)!.changes).toEqual([
      { name: 'mvu.mood', reason: 'provoked' },
      { name: 'mvu.name' },
      { name: 'mvu.favor' },
    ])
  })

  it('rejects structure violations: extra keys on locked objects, nested paths under scalars', async () => {
    const result = await settle([
      { name: 'mvu.stats.extra', value: 1 },
      { name: 'mvu.stats', value: { hp: 9 }, reason: 'buff' },
      { name: 'mvu.favor.deeper', value: 1 },
    ])
    expect(result.applied).toEqual([])
    expect(result.failed[0].error).toContain('guard structure')
    expect(result.failed[0].error).toContain("'mvu.stats.extra' is not in the schema template")
    expect(result.failed[1].error).toContain('guard structure')
    expect(result.failed[1].error).toContain("'mp' would be deleted")
    expect(result.failed[2].error).toContain('guard structure')
    // 部分写入放行（不要求模板字段齐全）：
    const partial = await settle([{ name: 'mvu.stats', value: { hp: 9, mp: 5 }, reason: 'buff' }])
    expect(partial.applied).toEqual(['mvu.stats'])
    expect(partial.receipt.changes).toEqual([
      { name: 'mvu.stats', before: { hp: 5, mp: 5 }, after: { hp: 9, mp: 5 } },
    ])
  })

  it('accepts wildcard dynamic keys and clamps array item templates per item', async () => {
    const result = await settle([
      { name: 'mvu.allies.莉娜.hp', value: 8, reason: 'join' },
      { name: 'mvu.bag', value: [
        { item: '回血药', count: 3 },
        { item: '蓝药', count: 300 },
      ] },
    ])
    expect(result.applied).toEqual(['mvu.allies.莉娜.hp', 'mvu.bag'])
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.allies.莉娜.hp', after: 8 },
      { name: 'mvu.bag', after: [{ item: '回血药', count: 3 }, { item: '蓝药', count: 99 }], reason: expect.stringContaining('mvu.bag[1].count: guard clamp: 300 -> 99') },
    ])
    expect(await storedValue('mvu.bag')).toEqual([{ item: '回血药', count: 3 }, { item: '蓝药', count: 99 }])
  })

  it('refuses to settle the $schema subtree itself', async () => {
    const result = await settle([{ name: '$schema', value: {} }, { name: '$schema.mvu.favor', value: { $range: [0, 1] } }])
    expect(result.applied).toEqual([])
    expect(result.failed[0].error).toContain('guard readonly')
    expect(result.failed[1].error).toContain('guard readonly')
  })

  it('a rejected item retries cleanly as a fresh settle once the value conforms', async () => {
    const rejected = await settle([{ name: 'mvu.mood', value: 'angry' }])
    expect(rejected.failed).toHaveLength(1)
    const retried = await settle([{ name: 'mvu.mood', value: 'tense', reason: 'tension rises' }])
    expect(retried.applied).toEqual(['mvu.mood'])
    expect(retried.receipt.status).toBe('updated')
    expect(retried.receipt.changes).toEqual([
      // before 取聊天播种树（flat store 此前无该条目）
      { name: 'mvu.mood', before: 'calm', after: 'tense' },
    ])
    expect(await storedValue('mvu.mood')).toBe('tense')
  })

  it('isolates a guard rejection from a valid clamp in the same batch', async () => {
    const result = await settle([
      { name: 'mvu.favor', value: 120, reason: 'feast' },
      { name: 'mvu.mood', value: 'angry' },
    ])
    expect(result.applied).toEqual(['mvu.favor'])
    expect(result.failed).toHaveLength(1)
    expect(result.receipt.status).toBe('failed')
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 100, after: 100, reason: 'mvu.favor: guard clamp: 120 -> 100' },
    ])
    expect(result.receipt.failures[0]).toContain('mvu.mood: guard enum-violation')
    expect(await storedValue('mvu.favor')).toBe(100)
  })
})
