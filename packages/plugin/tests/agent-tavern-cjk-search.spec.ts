import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = '沈青梧'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

// 中文 RP 语料：主角沈青梧（绑定角色）+ 剧情人物林小雨（检索目标）。
// 楼层命中数按查询 "林小雨欠的赌债还了吗"（7 个 bigram）预算：
// 0/1 楼各命中 3，4 楼命中 6，2/3/5/6 楼 0——阈值 ceil(40%×7)=3 下只有 0/1/4 入选。
const MESSAGES = [
  { name: 'User', is_user: true, is_system: false, send_date: '2026-10-01T10:00:00.000Z', mes: '听说林小雨在赌场欠下赌债，债主催得紧。' },
  { name: CHARACTER, is_user: false, is_system: false, send_date: '2026-10-01T10:01:00.000Z', mes: '林小雨垂下眼睛，低声说赌债的事她会自己处理。' },
  { name: 'User', is_user: true, is_system: false, send_date: '2026-10-01T10:02:00.000Z', mes: '今天天气不错，我们去集市逛逛吧。' },
  { name: CHARACTER, is_user: false, is_system: false, send_date: '2026-10-01T10:03:00.000Z', mes: '沈青梧把地下室酒架后的暗门重新锁好，没理会旁人的议论。' },
  { name: 'User', is_user: true, is_system: false, send_date: '2026-10-01T10:04:00.000Z', mes: '林小雨欠下的赌债还没还清，她最近很发愁。' },
  { name: CHARACTER, is_user: false, is_system: false, send_date: '2026-10-01T10:05:00.000Z', mes: '沈青梧收下了那张VIP会员卡，转身离开了酒馆。' },
  { name: CHARACTER, is_user: false, is_system: false, send_date: '2026-10-01T10:06:00.000Z', mes: 'The brass key stays hidden in the cellar behind the wine racks.' },
]

describe('AgentTavern 中文检索（决策 2026-10-11-cjk-tokenization）', () => {
  let home: string
  let tools: Map<string, RegisteredTool>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-cjk-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: '镇上当铺的老板娘，冷静自持。',
        personality: '沉稳',
        scenario: '一座临海的酒馆小镇。',
        first_mes: '欢迎光临。',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    const emptyChat = await store.getChatSnapshot(CHARACTER, chatId)
    await store.saveChat(CHARACTER, chatId, { ...emptyChat!.chat, messages: MESSAGES }, emptyChat!.revision)
    await store.updateState(() => ({
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))

    tools = new Map()
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('tavern_history_search：自然语言中文查询召回目标楼层且按命中数降序', async () => {
    const exec = { agent: { id: 'native' } }
    const result = await tools.get('tavern_history_search')!.execute({ query: '林小雨欠的赌债还了吗' }, exec)
    expect(result.hits.map((hit: { index: number }) => hit.index)).toEqual([4, 1, 0])
    for (const hit of result.hits) {
      expect(hit.excerpt).toContain('赌债')
    }
  })

  it('tavern_history_search：纯专名查询保持严格 AND 精确命中', async () => {
    const exec = { agent: { id: 'native' } }
    const result = await tools.get('tavern_history_search')!.execute({ query: '林小雨' }, exec)
    expect(result.hits.map((hit: { index: number }) => hit.index)).toEqual([4, 1, 0])
  })

  it('tavern_history_search：阈值挡掉低命中噪音楼层，中英混排查询可召回', async () => {
    const exec = { agent: { id: 'native' } }
    // 查询展开 [沈青,青梧,梧的,vip,卡放,放哪,哪了]（7 token，阈值 3）：
    // 5 楼命中 3（沈青/青梧/vip）入选；3 楼只命中 2（沈青/青梧）被挡。
    const result = await tools.get('tavern_history_search')!.execute({ query: '沈青梧的VIP卡放哪了' }, exec)
    expect(result.hits.map((hit: { index: number }) => hit.index)).toEqual([5])
    expect(result.hits[0].excerpt).toContain('VIP')
  })

  it('tavern_history_search：单字查询命中含该字的楼层', async () => {
    const exec = { agent: { id: 'native' } }
    const result = await tools.get('tavern_history_search')!.execute({ query: '赌' }, exec)
    expect(result.hits.map((hit: { index: number }) => hit.index)).toEqual([4, 1, 0])
  })

  it('tavern_history_search：英文查询回归不变', async () => {
    const exec = { agent: { id: 'native' } }
    const result = await tools.get('tavern_history_search')!.execute({ query: 'brass key' }, exec)
    expect(result.hits.map((hit: { index: number }) => hit.index)).toEqual([6])
    expect(result.hits[0].excerpt).toContain('brass key')
  })

  it('tavern_history_search：纯虚词组合查询因停用 bigram 归零而报错', async () => {
    const exec = { agent: { id: 'native' } }
    // "还了""了吗" 均被停用 → token 集为空。
    await expect(tools.get('tavern_history_search')!.execute({ query: '还了吗' }, exec))
      .rejects.toThrow('history query requires at least one word')
  })

  it('memory_search：自然语言中文查询将目标记忆排在最前', async () => {
    const exec = { agent: { id: 'native' } }
    const debt = await tools.get('memory_write')!.execute({
      scope: 'chat', kind: 'semantic', content: '林小雨在赌场欠下高额赌债，约定月底前还清。', tags: ['赌债'],
    }, exec)
    await tools.get('memory_write')!.execute({
      scope: 'chat', kind: 'semantic', content: '镇上连日暴雨，渡口停航。', tags: ['天气'],
    }, exec)
    const result = await tools.get('memory_search')!.execute({ query: '林小雨欠的赌债还了吗', scope: 'chat' }, exec)
    expect(result.hits[0]).toMatchObject({ id: debt.id })
    expect(result.hits[0].content).toContain('赌债')
    expect(result.hits.map((hit: { id: string }) => hit.id).indexOf(debt.id)).toBe(0)
  })
})
