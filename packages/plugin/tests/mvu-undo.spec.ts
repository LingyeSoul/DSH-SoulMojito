import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { apply as applyAgentTavern } from '../src/agent-tavern/agent.js'
import { modEvents } from '../src/mods/events.js'
import {
  appendMvuReceipt,
  applyMvuUndoRestores,
  latestValidMvuReceipt,
  planMvuUndoRestores,
  readMvuReceipts,
  screenMvuUndoRestores,
  type MvuReceipt,
} from '../src/mvu.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'

// B-6a MVU 回执撤销（2026-10-11）：把回执里已有的每项变更前后值变成能力——
// 撤销最新一条有效回执（newest-first 链），恢复到该轮结算前的变量树。
// 语义参考 LWB keyed-changes undo 链，见 decisions/2026-10-11-mvu-receipt-undo.md。

const UNDO_CHARACTER = '薇拉'
const CLAMP_CHARACTER = '珂拉'
const ENUM_CHARACTER = '黛尔'
const RANGE_CHARACTER = '琅'
const STATUS_CHARACTER = '罗塞'
const AGENT_CHARACTER = 'Settle Undo Character'

/* ---------------------------- 纯函数：计划 / 守卫 / 应用 ---------------------------- */

describe('MVU undo pure core', () => {
  it('latestValidMvuReceipt walks back from the newest entry to the last non-undone one', () => {
    const receipt = (turnKey: string, undoneAt?: string): MvuReceipt =>
      ({ at: `t${turnKey}`, turnKey, status: 'updated', changes: [], failures: [], ...(undoneAt !== undefined ? { undoneAt } : {}) })
    expect(latestValidMvuReceipt([])).toBeUndefined()
    expect(latestValidMvuReceipt([receipt('0'), receipt('1')])).toMatchObject({ index: 1 })
    // 撤销过的 newest 不再是链头，次新重新成为「最新有效」
    expect(latestValidMvuReceipt([receipt('0'), receipt('1', 'x')])).toMatchObject({ index: 0 })
    expect(latestValidMvuReceipt([receipt('0', 'x'), receipt('1', 'x')])).toBeUndefined()
  })

  it('plans restores from before values; creations become deletions; failures never participate', () => {
    expect(planMvuUndoRestores({
      at: 't', turnKey: '1', status: 'updated',
      changes: [
        { name: 'mvu.favor', before: 10, after: 20 },
        { name: 'mvu.scene', after: '夜' },
        { name: 'mvu.trust', before: 5 },
      ],
      failures: ['bad name!: invalid variable name'],
    })).toEqual([
      { path: 'mvu.favor', value: 10 },
      { path: 'mvu.scene' },
      { path: 'mvu.trust', value: 5 },
    ])
  })

  it('refuses incomplete receipts instead of guessing', () => {
    // 老版本/手改数据：change 既无 before 也无 after → 明确报数据不完整
    expect(() => planMvuUndoRestores({
      at: 't', turnKey: '0', status: 'updated', changes: [{ name: 'mvu.legacy' }], failures: [],
    })).toThrowError(/incomplete/i)
    // status 'updated' 却无变更记录：形状自相矛盾，同样不猜
    expect(() => planMvuUndoRestores({
      at: 't', turnKey: '0', status: 'updated', changes: [], failures: [],
    })).toThrowError(/incomplete/i)
  })

  it('applies restores onto the tree: whole-value restore, leaf delete and empty-intermediate pruning', () => {
    const tree: Record<string, unknown> = { mvu: { favor: 20, scene: '夜' } }
    applyMvuUndoRestores(tree, [{ path: 'mvu.favor', value: 10 }, { path: 'mvu.scene' }])
    expect(tree).toEqual({ mvu: { favor: 10 } })
    // 结算新增的整条链路撤销后修剪干净（before 伪树无该中间对象）
    const grown: Record<string, unknown> = { a: { b: { c: 1 } }, keep: true }
    applyMvuUndoRestores(grown, [{ path: 'a.b.c' }])
    expect(grown).toEqual({ keep: true })
    // 对象值整体恢复
    const stats: Record<string, unknown> = { stats: { hp: 20 } }
    applyMvuUndoRestores(stats, [{ path: 'stats', value: { hp: 10, mp: 5 } }])
    expect(stats).toEqual({ stats: { hp: 10, mp: 5 } })
  })

  it('screens restores through the guard: reject / would-adjust both refuse, pristine history passes', () => {
    const schema = { mvu: { mood: { $enum: ['angry', 'tense'] }, favor: { $range: [0, 100] }, name: { $ro: true } } }
    // 历史合法值天然通过（clamp 类回执的 before 仍在界内）
    expect(() => screenMvuUndoRestores(schema, [{ path: 'mvu.favor', value: 80 }], () => 100)).not.toThrow()
    // schema 后来改了（枚举收窄 / range 收紧 / ro）→ 整次拒绝并报因
    expect(() => screenMvuUndoRestores(schema, [{ path: 'mvu.mood', value: 'calm' }], () => 'tense'))
      .toThrowError(/mvu\.mood: guard enum-violation/)
    expect(() => screenMvuUndoRestores(schema, [{ path: 'mvu.favor', value: 150 }], () => 100))
      .toThrowError(/guard would adjust/)
    expect(() => screenMvuUndoRestores(schema, [{ path: 'mvu.name', value: '新名' }], () => '旧名'))
      .toThrowError(/mvu\.name: guard readonly/)
    // $schema 路径恒拒（无 schema 时也不许经撤销写入守卫契约）
    expect(() => screenMvuUndoRestores(undefined, [{ path: '$schema.mvu', value: 1 }], () => undefined))
      .toThrowError(/guard readonly/)
    // 无 schema：恒等放行
    expect(() => screenMvuUndoRestores(undefined, [{ path: 'anything', value: {} }], () => undefined)).not.toThrow()
  })
})

/* ------------------------- 端到端：ST 撤销 / AgentTavern 撤销 ------------------------- */

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: url.includes('/mvu/status/') ? 'GET' : 'POST',
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

function cardData(name: string, extensions: Record<string, unknown> = {}) {
  return {
    name, description: `${name}的描述。`, personality: '', scenario: '', first_mes: '你好。', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions,
  }
}

function receiptOf(turnKey: string, changes: MvuReceipt['changes'], extra: Partial<MvuReceipt> = {}): MvuReceipt {
  return { at: `2026-10-11T0${turnKey}:00:00.000Z`, turnKey, status: 'updated', changes, failures: [], ...extra }
}

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('MVU receipt undo (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let agentTools: Map<string, RegisteredTool>
  const chatSaved: Array<{ character: string; chatId: string; floorCount: number }> = []
  const eventOffs: Array<() => void> = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-mvu-undo-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))

    for (const [name, extensions] of [
      [UNDO_CHARACTER, {}],
      // clamp 卡：schema 与结算时一致（range 未变）——clamp 类回执按 before 精确恢复
      [CLAMP_CHARACTER, { agentTavern: { initialVariables: { $schema: { mvu: { favor: { $range: [0, 100] } } } } } }],
      // 枚举卡：schema 后来改了（收窄掉 'calm'）——恢复值被拒 → 整次撤销失败
      [ENUM_CHARACTER, { agentTavern: { initialVariables: { $schema: { mvu: { mood: { $enum: ['angry', 'tense'] } } } } } }],
      // 区间卡：schema 后来收紧（[0,100] → [0,50]）——恢复 80 会被 clamp → 拒绝「调整过的恢复值」
      [RANGE_CHARACTER, { agentTavern: { initialVariables: { $schema: { mvu: { favor: { $range: [0, 50] } } } } } }],
      [STATUS_CHARACTER, {
        world: '',
        agentTavern: { statusTemplate: '<div class="mvu-status">好感度：<%- getvar("mvu.favor") ?? 0 %>/100</div>' },
      }],
      [AGENT_CHARACTER, {}],
    ] as Array<[string, Record<string, unknown>]>) {
      await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(name, extensions) })
    }

    agentTools = new Map()
    const sections: Array<{ name: string; text: string }> = []
    const ctx = {
      systemPrompt: {
        section: (section: { name: string; text: string }) => { sections.push({ name: section.name, text: section.text as string }) },
        context: () => {},
      },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: (tool: RegisteredTool) => { agentTools.set(tool.name, tool) } },
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => void) => { fn(); return () => {} },
    } as never
    await apply(ctx)
    expect(apiHandler).toBeDefined()
    // AgentTavern 框架（settle 工具）与 HTTP 面共享同一 DSH_HOME：settle 产回执，撤销走路由
    await applyAgentTavern(ctx)
    expect(agentTools.has('tavern_variable_settle')).toBe(true)

    eventOffs.push(modEvents.on('chat-saved', (payload) => {
      chatSaved.push({ character: payload.character, chatId: payload.chatId, floorCount: payload.floorCount })
    }))
  })

  afterAll(() => {
    for (const off of eventOffs) off()
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 直接落一份带变量与回执的聊天（不经生成链路，控盘回执内容）。 */
  async function craftChat(character: string, variables: Record<string, unknown> | undefined, receipts: MvuReceipt[], messages = 0) {
    const now = new Date().toISOString()
    const floors = Array.from({ length: messages }, (_, index) => ({
      name: index % 2 === 0 ? 'User' : character,
      is_user: index % 2 === 0,
      is_system: false,
      send_date: now,
      mes: `floor ${index}`,
    }))
    return store.createChat(character, {
      user_name: 'User', character_name: character,
      chat_metadata: {
        createdAt: now, timedWorldInfo: {},
        ...(variables !== undefined ? { variables } : {}),
        ...(receipts.length > 0 ? { mvu: { receipts } } : {}),
      },
    }, floors)
  }

  async function undoCall(character: string, chatId: string, revision?: string) {
    const res = makeResponse()
    await apiHandler(makeRequest({ character, chatId, ...(revision !== undefined ? { revision } : {}) }, '/api/dsh-tavern/mvu/receipts/undo'), res)
    expect(res.writableEnded).toBe(true)
    const text = res.chunks.join('')
    return { status: res.statusCode, body: text === '' ? undefined : JSON.parse(text) }
  }

  async function statusCall(character: string, chatId: string) {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, `/api/dsh-tavern/mvu/status/${encodeURIComponent(character)}/${chatId}`), res)
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.chunks.join(''))
  }

  const variablesOf = async (character: string, chatId: string) =>
    (await store.getChatSnapshot(character, chatId))!.chat.header.chat_metadata.variables

  it('restores before values (clamp-class included) and marks the receipt undone', async () => {
    const chatId = await craftChat(CLAMP_CHARACTER, { mvu: { favor: 100 } }, [
      receiptOf('1', [{ name: 'mvu.favor', before: 80, after: 100, reason: 'mvu.favor: guard clamp: 150 -> 100' }]),
    ])
    const { status, body } = await undoCall(CLAMP_CHARACTER, chatId)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.undoneTurnKey).toBe('1')
    // clamp 后值 → clamp 前值，精确恢复（守卫天然通过）
    expect(body.restored).toEqual([{ path: 'mvu.favor', value: 80 }])
    expect(await variablesOf(CLAMP_CHARACTER, chatId)).toEqual({ mvu: { favor: 80 } })
    const receipts = readMvuReceipts((await store.getChatSnapshot(CLAMP_CHARACTER, chatId))!.chat)
    expect(receipts).toHaveLength(1)
    expect(typeof receipts[0]!.undoneAt).toBe('string')
    // 响应带新 revision（客户端同步用，与 retry 同款）
    expect(typeof body.revision).toBe('string')
  })

  it('undoes two rounds newest-first and then refuses with a classified 400', async () => {
    const chatId = await craftChat(UNDO_CHARACTER, { mvu: { favor: 35 } }, [
      receiptOf('1', [{ name: 'mvu.favor', before: 10, after: 20 }]),
      receiptOf('2', [{ name: 'mvu.favor', before: 20, after: 35 }]),
    ])
    const first = await undoCall(UNDO_CHARACTER, chatId)
    expect(first.status).toBe(200)
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toEqual({ mvu: { favor: 20 } })
    const second = await undoCall(UNDO_CHARACTER, chatId)
    expect(second.status).toBe(200)
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toEqual({ mvu: { favor: 10 } })
    const receipts = readMvuReceipts((await store.getChatSnapshot(UNDO_CHARACTER, chatId))!.chat)
    expect(receipts.map((receipt) => receipt.undoneAt !== undefined)).toEqual([true, true])
    // 全已撤销：幂等防重 → 400 明确报错，变量不动
    const third = await undoCall(UNDO_CHARACTER, chatId)
    expect(third.status).toBe(400)
    expect(third.body.code).toBe('MVU_UNDO_ALREADY_UNDONE')
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toEqual({ mvu: { favor: 10 } })
  })

  it('restores deleted keys and removes created keys (failures never participate)', async () => {
    const chatId = await craftChat(UNDO_CHARACTER, { mvu: { favor: 10, scene: '夜' } }, [
      receiptOf('1', [
        { name: 'mvu.favor', before: 10, after: 12 },
        { name: 'mvu.trust', before: 5 },
        { name: 'mvu.scene', after: '夜' },
      ], { failures: ['bad name!: invalid variable name'] }),
    ])
    const { status, body } = await undoCall(UNDO_CHARACTER, chatId)
    expect(status).toBe(200)
    // 删除的 trust 恢复 before；新增的 scene 撤销即删除；失败项从未落盘不参与
    expect(body.restored).toEqual([
      { path: 'mvu.favor', value: 10 },
      { path: 'mvu.trust', value: 5 },
      { path: 'mvu.scene' },
    ])
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toEqual({ mvu: { favor: 10, trust: 5 } })
  })

  it('drops the whole variables key when the undo empties the tree', async () => {
    const chatId = await craftChat(UNDO_CHARACTER, { mvu: { favor: 15 } }, [
      receiptOf('1', [{ name: 'mvu.favor', after: 15 }]),
    ])
    const { status } = await undoCall(UNDO_CHARACTER, chatId)
    expect(status).toBe(200)
    // 首轮结算前的空树：摘键与「无变量不写键」约定一致
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toBeUndefined()
  })

  it('re-renders the status bar from the restored tree', async () => {
    const chatId = await craftChat(STATUS_CHARACTER, { mvu: { favor: 35 } }, [
      receiptOf('1', [{ name: 'mvu.favor', before: 20, after: 35 }]),
    ])
    const before = await statusCall(STATUS_CHARACTER, chatId)
    expect(before.renderedHtml).toContain('好感度：35/100')
    const { status } = await undoCall(STATUS_CHARACTER, chatId)
    expect(status).toBe(200)
    const after = await statusCall(STATUS_CHARACTER, chatId)
    expect(after.variables).toEqual({ mvu: { favor: 20 } })
    expect(after.renderedHtml).toContain('好感度：20/100')
    // GET mvu/status 的回执投影带 undoneAt（面板灰显数据源）
    expect(typeof after.receipts[0].undoneAt).toBe('string')
  })

  it('refuses the whole undo when the guard rejects (schema changed since), leaving variables untouched', async () => {
    const enumChat = await craftChat(ENUM_CHARACTER, { mvu: { mood: 'tense' } }, [
      receiptOf('1', [{ name: 'mvu.mood', before: 'calm', after: 'tense' }]),
    ])
    const rejected = await undoCall(ENUM_CHARACTER, enumChat)
    expect(rejected.status).toBe(400)
    expect(rejected.body.code).toBe('MVU_UNDO_UNDO_REJECTED')
    expect(rejected.body.message).toContain('mvu.mood: guard enum-violation')
    expect(await variablesOf(ENUM_CHARACTER, enumChat)).toEqual({ mvu: { mood: 'tense' } })
    // 回执未标 undone（整次失败不动任何东西）
    expect(readMvuReceipts((await store.getChatSnapshot(ENUM_CHARACTER, enumChat))!.chat)[0]!.undoneAt).toBeUndefined()

    // schema 收紧到会 clamp 恢复值：同样拒绝——不写任何「被调整过的恢复值」
    const rangeChat = await craftChat(RANGE_CHARACTER, { mvu: { favor: 100 } }, [
      receiptOf('1', [{ name: 'mvu.favor', before: 80, after: 100 }]),
    ])
    const adjusted = await undoCall(RANGE_CHARACTER, rangeChat)
    expect(adjusted.status).toBe(400)
    expect(adjusted.body.message).toContain('guard would adjust')
    expect(await variablesOf(RANGE_CHARACTER, rangeChat)).toEqual({ mvu: { favor: 100 } })
  })

  it('answers 400 for no receipts and for incomplete legacy receipts', async () => {
    const empty = await craftChat(UNDO_CHARACTER, { mvu: { favor: 1 } }, [])
    const noReceipt = await undoCall(UNDO_CHARACTER, empty)
    expect(noReceipt.status).toBe(400)
    expect(noReceipt.body.code).toBe('MVU_UNDO_NO_VALID_RECEIPT')

    // 老版本数据缺前后值 → 明确报数据不完整，不猜
    const legacy = await craftChat(UNDO_CHARACTER, { mvu: { favor: 1 } }, [
      receiptOf('1', [{ name: 'mvu.legacy', after: 1 }, { name: 'mvu.old' }]),
    ])
    const incomplete = await undoCall(UNDO_CHARACTER, legacy)
    expect(incomplete.status).toBe(400)
    expect(incomplete.body.code).toBe('MVU_UNDO_INCOMPLETE_RECEIPT')
    expect(incomplete.body.message).toContain('incomplete')
    expect(await variablesOf(UNDO_CHARACTER, legacy)).toEqual({ mvu: { favor: 1 } })
  })

  it('rejects a stale revision with a CAS conflict and 404s an unknown chat', async () => {
    const chatId = await craftChat(UNDO_CHARACTER, { mvu: { favor: 5 } }, [
      receiptOf('1', [{ name: 'mvu.favor', before: 2, after: 5 }]),
    ])
    const snapshot = await store.getChatSnapshot(UNDO_CHARACTER, chatId)
    const conflict = await undoCall(UNDO_CHARACTER, chatId, 'stale')
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('CHAT_REVISION_CONFLICT')
    expect((await store.getChatSnapshot(UNDO_CHARACTER, chatId))!.revision).toBe(snapshot!.revision)
    expect(await variablesOf(UNDO_CHARACTER, chatId)).toEqual({ mvu: { favor: 5 } })

    const missing = await undoCall(UNDO_CHARACTER, '20990101000000000.jsonl')
    expect(missing.status).toBe(404)
  })

  it('emits chat-saved with the current floorCount after a successful undo', async () => {
    const chatId = await craftChat(UNDO_CHARACTER, { mvu: { favor: 7 } }, [
      receiptOf('3', [{ name: 'mvu.favor', before: 4, after: 7 }]),
    ], 4)
    chatSaved.length = 0
    const { status } = await undoCall(UNDO_CHARACTER, chatId)
    expect(status).toBe(200)
    expect(chatSaved).toEqual([
      { character: UNDO_CHARACTER, chatId, floorCount: 4 },
    ])
  })

  it('undoes AgentTavern settle receipts back into the chat-scope variable store', async () => {
    const now = new Date().toISOString()
    const chatId = await store.createChat(AGENT_CHARACTER, {
      user_name: 'User', character_name: AGENT_CHARACTER, chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [{
      name: 'User', is_user: true, is_system: false, send_date: now, mes: 'We share a meal by the cellar door.',
    }, {
      name: AGENT_CHARACTER, is_user: false, is_system: false, send_date: now, mes: 'The favor warms between us.',
    }])
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-agent-undo': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: AGENT_CHARACTER, chatId },
      },
    }))
    const settle = (changes: unknown[]) =>
      agentTools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: 'session-agent-undo' } })

    const first = await settle([
      { name: 'mvu.favor', value: 3, reason: 'shared a meal' },
      { name: 'mvu.location', value: 'cellar' },
    ])
    expect(first.failed).toEqual([])
    const second = await settle([{ name: 'mvu.favor', value: 5, reason: 'gift accepted' }])
    expect(second.receipt.changes).toEqual([{ name: 'mvu.favor', before: 3, after: 5 }])

    const scoped = await VariableStore.open(join(home, 'tavern'))
    // 撤销第二轮：flat 条目 5 → 恢复 before 3（location 不在回执里，不动）
    const undoSecond = await undoCall(AGENT_CHARACTER, chatId)
    expect(undoSecond.status).toBe(200)
    expect(undoSecond.body.restored).toEqual([{ path: 'mvu.favor', value: 3 }])
    expect(await scoped.get('chat', chatId, 'mvu.favor')).toMatchObject({ value: 3 })
    expect(await scoped.get('chat', chatId, 'mvu.location')).toMatchObject({ value: 'cellar' })

    // 撤销第一轮（新增键）：flat 条目删除，作用域回到结算前的空存储
    const undoFirst = await undoCall(AGENT_CHARACTER, chatId)
    expect(undoFirst.status).toBe(200)
    expect(await scoped.get('chat', chatId, 'mvu.favor')).toBeUndefined()
    expect(await scoped.get('chat', chatId, 'mvu.location')).toBeUndefined()
    const receipts = readMvuReceipts((await store.getChatSnapshot(AGENT_CHARACTER, chatId))!.chat)
    expect(receipts).toHaveLength(2)
    expect(receipts.every((receipt) => receipt.undoneAt !== undefined)).toBe(true)

    const exhausted = await undoCall(AGENT_CHARACTER, chatId)
    expect(exhausted.status).toBe(400)
    expect(exhausted.body.code).toBe('MVU_UNDO_ALREADY_UNDONE')
  })

  it('undoes a settle receipt that seeded values from the chat tree (before from the seed)', async () => {
    // 播种树带值、flat store 从未写过：回执 before 取播种视角当前值，撤销按需
    // 创建 flat 条目覆盖回播种值（overlay 语义下等效）。
    const now = new Date().toISOString()
    const chatId = await store.createChat(AGENT_CHARACTER, {
      user_name: 'User', character_name: AGENT_CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {}, variables: { mvu: { favor: 10 } } },
    }, [])
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'session-agent-seeded': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: AGENT_CHARACTER, chatId },
      },
    }))
    const settle = (changes: unknown[]) =>
      agentTools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: 'session-agent-seeded' } })
    const result = await settle([{ name: 'mvu.favor', value: 30 }])
    expect(result.receipt.changes).toEqual([{ name: 'mvu.favor', before: 10, after: 30 }])

    const undone = await undoCall(AGENT_CHARACTER, chatId)
    expect(undone.status).toBe(200)
    const scoped = await VariableStore.open(join(home, 'tavern'))
    expect(await scoped.get('chat', chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    // 播种树（chat_metadata.variables）不被撤销路径改写
    expect(await variablesOf(AGENT_CHARACTER, chatId)).toEqual({ mvu: { favor: 10 } })
  })
})
