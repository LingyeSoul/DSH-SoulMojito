/**
 * B-3 记忆维护 Agent（LWB maintenance 的 dsh 化）——零真实网络测试面。
 *
 * 维护 LLM 全部走脚本化 fake ctx.llm.stream（参考 compaction wiring 的假 llm
 * 模式）：按序产出 tool-call / 文本回复，工具结果经下一轮请求的 messages 回收
 * 断言。覆盖：
 * - 工具面逐个：ReadMemory 分页（32/页 + more 游标）、EditMemory CAS 冲突整组
 *   失败 + 重试消化 + abandonEdits 放弃声明、ReadSource/SearchSource 只读；
 * - E1 全链路（规格书例 E1 的 dsh 化）：同一剧情事件横跨两次写入批次——
 *   较早记录身份保留且内容补齐来源楼层、重复占位删除、收据生效、再次 run
 *   待维护范围排除已完成区间、编辑后 revision 更新且向量重嵌；
 * - 收据退役两路径：楼面指纹（原文编辑）与记录快照（覆盖记录被非维护写入）；
 * - run 纪律：预算 24 次如实收尾、同 scope 409 单飞、进程重启把 running 标
 *   error(interrupted) 不假装完成。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryMaintenanceStore,
  MemoryStore,
  MemoryVectorStore,
  TavernStore,
  floorSignature,
  memoryContentDigest,
} from '../../tavern-store/src/index.js'
import {
  MAINTENANCE_MAX_LLM_REQUESTS,
  MaintenanceRunConflictError,
  memoryMaintenanceStatus,
  startMemoryMaintenance,
  type MemoryMaintenanceDeps,
  type MemoryMaintenanceScope,
  type MaintenanceStreamChunk,
} from '../src/memory-maintenance.js'

const CHARACTER = 'Maintenance Tester'
const EMBED_CONFIG = {
  baseURL: 'http://embed.test/v1',
  apiKeyEnv: 'TEST_EMBED_KEY',
  model: 'test-embed',
  dims: 4,
  batchSize: 16,
  timeoutMs: 400,
}

/* ------------------------------ fake LLM ------------------------------ */

type ChunkProducer = () => AsyncIterable<MaintenanceStreamChunk>

let callSeq = 0

function toolCall(name: string, args: Record<string, unknown>): ChunkProducer {
  return async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${++callSeq}`, name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function textStop(text: string): ChunkProducer {
  return async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface FakeCtx {
  ctx: {
    llm: { stream(options: Record<string, unknown>): AsyncIterable<MaintenanceStreamChunk> }
    agentDefaultModel: { currentSelection(): { provider: string; model: string } }
  }
  calls: Array<Record<string, unknown>>
}

/** 脚本化维护 LLM：按序消费 producers，用尽后重复最后一个（预算测试用）。 */
function fakeCtx(producers: ChunkProducer[]): FakeCtx {
  const calls: Array<Record<string, unknown>> = []
  let index = 0
  return {
    calls,
    ctx: {
      llm: {
        stream(options: Record<string, unknown>) {
          calls.push(options)
          const produce = producers[Math.min(index, producers.length - 1)]!
          index += 1
          return produce()
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    },
  }
}

/** 第 N 次请求（0 起）收到的工具结果（此前所有轮次，按序）。 */
function toolResultsOf(call: Record<string, unknown>): unknown[] {
  const messages = call.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content[0]!.text) as Record<string, unknown>)
}

/* ------------------------------ 夹具 ------------------------------ */

let home: string
let root: string
let db: TavernStore
let memory: MemoryStore
let vectors: MemoryVectorStore

function deps(): MemoryMaintenanceDeps {
  return { root, db, memory, vectors }
}

function floor(mes: string, isUser = false): { name: string; is_user: boolean; is_system: boolean; send_date: string; mes: string } {
  return { name: isUser ? 'User' : CHARACTER, is_user: isUser, is_system: false, send_date: '', mes }
}

/** E1 语料：同一剧情事件（林小雨的赌债）横跨第 17-20 楼与第 21-23 楼两个"写入批次"。 */
function e1Floors(): ReturnType<typeof floor>[] {
  const floors: ReturnType<typeof floor>[] = []
  for (let index = 0; index < 17; index += 1) floors.push(floor(`第${index}楼的日常：酒馆里平静的一天。`))
  floors.push(
    floor('林小雨在码头旧仓库与陈默对峙，承认自己在赌场欠下赌债。', true),
    floor('陈默压低声音：「三天。三天内还清，否则别怪我不讲旧情。」'),
    floor('林小雨攥紧口袋里仅剩的铜币，没有答应也没有拒绝。'),
    floor('旧仓库外下起了暴雨，两人不欢而散。'),
    floor('第二天，林小雨在赌场后门数出了全部积蓄。', true),
    floor('她把钱袋推给陈默：「都在这里了，两清。」'),
    floor('陈默收下钱袋，当着她的面撕掉了欠条。债务就此了结。'),
  )
  return floors // 24 楼（0-23）
}

async function seedChat(floors: ReturnType<typeof floor>[]): Promise<string> {
  return db.createChat(CHARACTER, {
    user_name: 'User',
    character_name: CHARACTER,
    chat_metadata: { createdAt: new Date().toISOString() },
  }, floors)
}

async function seedRecord(chatId: string, content: string, kind: 'semantic' | 'episodic' = 'episodic') {
  return memory.put({
    scope: 'chat',
    scopeId: chatId,
    kind,
    content,
    tags: [],
    source: { kind: 'agent-tool', sessionId: 'seed', chatId, character: CHARACTER },
  })
}

async function waitUntilIdle(scope: MemoryMaintenanceScope, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    const view = await memoryMaintenanceStatus(deps(), scope)
    if (view.status !== 'running') return view
    if (Date.now() - started > timeoutMs) throw new Error('maintenance run did not finish in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function runMaintenance(scope: MemoryMaintenanceScope, producers: ChunkProducer[]): Promise<{ view: Awaited<ReturnType<typeof waitUntilIdle>>; calls: Array<Record<string, unknown>> }> {
  const { ctx, calls } = fakeCtx(producers)
  await startMemoryMaintenance(ctx, deps(), scope)
  const view = await waitUntilIdle(scope)
  return { view, calls }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'memory-maintenance-'))
  process.env.DSH_HOME = home
  root = join(home, 'soulmojito')
  db = await TavernStore.open(root)
  await db.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER,
      description: 'Memory maintenance test character.',
      personality: 'Stable',
      scenario: 'A harbor town.',
      first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    },
  })
  memory = await MemoryStore.open(root)
  vectors = await MemoryVectorStore.open(root)
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }),
    text: async () => '{}',
  } as unknown as Response))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------ 工具面 ------------------------------ */

describe('维护工具面', () => {
  it('ReadMemory：40 条记录两页读完（32/页），more 游标正确，逐页内容与 revision 完整', async () => {
    const chatId = await seedChat(e1Floors())
    const seeded = []
    for (let index = 0; index < 40; index += 1) seeded.push(await seedRecord(chatId, `第${index}条测试记忆：港口的灯火与潮汐。`))
    const { view, calls } = await runMaintenance({ character: CHARACTER, chatId }, [
      toolCall('ReadMemory', { page: 0 }),
      toolCall('ReadMemory', { page: 1 }),
      textStop('done'),
    ])
    expect(view.status).toBe('done')
    expect(calls).toHaveLength(3)
    const page0 = toolResultsOf(calls[1]!)[0] as { total: number; more: boolean; records: Array<{ id: string; revision: string }> }
    const page1 = toolResultsOf(calls[2]!).at(-1) as { total: number; more: boolean; records: Array<{ id: string; revision: string }> }
    expect(page0.total).toBe(40)
    expect(page0.records).toHaveLength(32)
    expect(page0.more).toBe(true)
    expect(page1.records).toHaveLength(8)
    expect(page1.more).toBe(false)
    const covered = new Set([...page0.records, ...page1.records].map((record) => record.id))
    expect(covered).toEqual(new Set(seeded.map((record) => record.id)))
    const revisionById = new Map(seeded.map((record) => [record.id, record.revision]))
    for (const record of [...page0.records, ...page1.records]) {
      expect(record.revision).toBe(revisionById.get(record.id))
    }
  })

  it('EditMemory：CAS 冲突整组失败零写入；重交整组成功消化未决项；CompleteMaintenance 收据生效', async () => {
    const chatId = await seedChat(e1Floors())
    const a = await seedRecord(chatId, '记录A：林小雨欠陈默赌债。')
    const b = await seedRecord(chatId, '记录B：码头旧仓库的暴雨夜。')
    const scope = { character: CHARACTER, chatId }
    // 第一段 run：坏 revision 的组 + 拒绝记完成。run 结束后可断言零写入。
    const first = await runMaintenance(scope, [
      toolCall('EditMemory', {
        edits: [
          { op: 'update', id: a.id, expectedRevision: 'deadbeefdeadbeef', content: '记录A（改）：不应生效。' },
          { op: 'delete', id: b.id, expectedRevision: b.revision },
        ],
      }),
      toolCall('CompleteMaintenance', { baseFloor: 0, headFloor: 23 }),
      textStop('done'),
    ])
    // 第 2 次请求携带第 1 组的失败结果：冲突项定位 + 整组未生效。
    const failure = toolResultsOf(first.calls[1]!)[0] as { error: string; conflicts: Array<{ id: string }> }
    expect(failure.error).toContain('revision conflict')
    expect(failure.conflicts.map((conflict) => conflict.id)).toEqual([a.id])
    // CompleteMaintenance 在未决项未消化时拒绝记完成。
    const rejected = toolResultsOf(first.calls[2]!)[1] as { error: string; unresolved: string[] }
    expect(rejected.error).toContain('unresolved')
    expect(rejected.unresolved).toContain(a.id)
    expect(rejected.unresolved).toContain(b.id)
    // 整组失败零写入：A 原文未动、B 仍活跃、无收据。
    expect((await memory.read(a.id, 'chat', chatId))!.content).toBe('记录A：林小雨欠陈默赌债。')
    expect(await memory.read(b.id, 'chat', chatId)).toBeDefined()
    expect(first.view.summary).toMatchObject({ failedGroups: 1, editGroups: 0 })
    expect((await (await MemoryMaintenanceStore.open(root)).read(CHARACTER, chatId)).receipts).toHaveLength(0)
    // 第二段 run：重交整组（fresh revisions）成功 + 完成收据。
    const second = await runMaintenance(scope, [
      toolCall('EditMemory', {
        edits: [
          { op: 'update', id: a.id, expectedRevision: (await memory.read(a.id, 'chat', chatId))!.revision, content: '记录A（改）：林小雨限期三天还清赌债。', reason: 'correct' },
          { op: 'delete', id: b.id, expectedRevision: (await memory.read(b.id, 'chat', chatId, true))!.revision },
        ],
      }),
      toolCall('CompleteMaintenance', { baseFloor: 0, headFloor: 23 }),
      textStop('done'),
    ])
    const completion = toolResultsOf(second.calls[2]!).at(-1) as { ok: boolean; coveredRecords: number }
    expect(completion.ok).toBe(true)
    expect(second.view.status).toBe('done')
    expect(second.view.summary).toMatchObject({ editGroups: 1, failedGroups: 0, corrected: 1, deleted: 1, completion: { baseFloor: 0, headFloor: 23 } })
    expect((await memory.read(a.id, 'chat', chatId))!.content).toBe('记录A（改）：林小雨限期三天还清赌债。')
    expect(await memory.read(b.id, 'chat', chatId)).toBeUndefined()
    const state = await (await MemoryMaintenanceStore.open(root)).read(CHARACTER, chatId)
    expect(state.receipts).toHaveLength(1)
    expect(state.receipts[0]).toMatchObject({ baseFloor: 0, headFloor: 23 })
  })

  it('EditMemory：放弃声明（abandonEdits）同样能消化未决项', async () => {
    const chatId = await seedChat(e1Floors())
    const a = await seedRecord(chatId, '记录A：无需修正的正常记录。')
    const { calls } = await runMaintenance({ character: CHARACTER, chatId }, [
      toolCall('EditMemory', { edits: [{ op: 'update', id: a.id, expectedRevision: 'stale', content: 'x' }] }),
      toolCall('CompleteMaintenance', { baseFloor: 0, headFloor: 23, abandonEdits: [a.id] }),
      textStop('done'),
    ])
    const completion = toolResultsOf(calls[2]!).at(-1) as { ok: boolean }
    expect(completion.ok).toBe(true)
    const state = await (await MemoryMaintenanceStore.open(root)).read(CHARACTER, chatId)
    expect(state.receipts).toHaveLength(1)
  })

  it('ReadSource / SearchSource：只读源——run 前后聊天快照 revision 与原文逐字节不变', async () => {
    const floors = e1Floors()
    const chatId = await seedChat(floors)
    const before = await db.getChatSnapshot(CHARACTER, chatId)
    const { calls } = await runMaintenance({ character: CHARACTER, chatId }, [
      toolCall('ReadSource', { fromFloor: 16, toFloor: 23 }),
      toolCall('SearchSource', { query: '赌场 欠下 赌债' }),
      textStop('done'),
    ])
    const [source, search] = toolResultsOf(calls[2]!) as Array<{ messages: Array<{ floor: number; content: string }>; hits: Array<{ floor: number; excerpt: string }> }>
    expect(source.messages).toHaveLength(8)
    expect(source.messages[0]).toMatchObject({ floor: 16 })
    expect(source.messages[7]!.content).toContain('撕掉了欠条')
    expect(search.hits.length).toBeGreaterThan(0)
    expect(search.hits.some((hit) => hit.floor === 17)).toBe(true)
    const after = await db.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(before!.revision)
    expect(after!.chat.messages).toEqual(before!.chat.messages)
  })

  it('开场请求：不带 purpose（宿主封闭枚举不私加），system 是记忆管理员指令，工具面五个齐备', async () => {
    const chatId = await seedChat(e1Floors())
    await seedRecord(chatId, '一条记忆。')
    const { calls } = await runMaintenance({ character: CHARACTER, chatId }, [textStop('done')])
    const first = calls[0]!
    expect(first.purpose).toBeUndefined()
    expect(String(first.system)).toContain('记忆管理员')
    expect((first.tools as Array<{ name: string }>).map((tool) => tool.name).sort())
      .toEqual(['CompleteMaintenance', 'EditMemory', 'ReadMemory', 'ReadSource', 'SearchSource'])
    const opening = (first.messages as Array<{ role: string; content: Array<{ text: string }> }>)[0]!
    expect(opening.role).toBe('user')
    expect(opening.content[0]!.text).toContain('0-23')
    expect(opening.content[0]!.text).toContain('维护指令')
  })
})

/* ------------------------------ E1 全链路 ------------------------------ */

describe('E1：跨批次同一事件合并（规格书例 E1 的 dsh 化）', () => {
  const MERGED_CONTENT = '林小雨在码头旧仓库向陈默承认在赌场欠下赌债，被限期三天；次日她在赌场后门把全部积蓄还给陈默，陈默当面撕掉欠条，债务两清（第17-23楼）'
  let chatId: string
  let recordA: Awaited<ReturnType<typeof seedRecord>>
  let recordB: Awaited<ReturnType<typeof seedRecord>>
  let recordC: Awaited<ReturnType<typeof seedRecord>>
  let recordD: Awaited<ReturnType<typeof seedRecord>>

  beforeAll(async () => {
    chatId = await seedChat(e1Floors())
    // 批次一（较早）：事件前半段。
    recordA = await seedRecord(chatId, '林小雨在码头旧仓库向陈默承认欠下赌债，被限期三天，两人不欢而散（第17-20楼）')
    // 批次二（较晚）：同一事件的收尾被当成新事件写入——重复占位。
    recordB = await seedRecord(chatId, '林小雨把全部积蓄还给陈默，陈默撕掉欠条，债务两清（第21-23楼）')
    // 相关记忆：正常，不应被动。
    recordC = await seedRecord(chatId, '陈默是码头的放贷人，与林小雨有旧交情。', 'semantic')
    // 与原文冲突的陈述：期限写成一周，应被纠正为三天。
    recordD = await seedRecord(chatId, '林小雨一周后才还清赌债。')
    // 开启 embed 配置（B-2 路径）：编辑成功后必须重嵌。
    await db.updateState(() => ({ memoryEmbedding: { ...EMBED_CONFIG } }))
  })

  it('mock 维护 LLM 走完 ReadMemory→ReadSource→EditMemory(合并组)→CompleteMaintenance', async () => {
    const { view } = await runMaintenance({ character: CHARACTER, chatId }, [
      toolCall('ReadMemory', {}),
      toolCall('ReadSource', { fromFloor: 15, toFloor: 23 }),
      toolCall('EditMemory', {
        edits: [
          // 合并：保留较早记录 A 的身份，内容补齐来源至 17-23 楼。
          { op: 'update', id: recordA.id, expectedRevision: recordA.revision, content: MERGED_CONTENT, reason: 'merge' },
          // 删除重复占位 B。
          { op: 'delete', id: recordB.id, expectedRevision: recordB.revision },
          // 纠正与原文冲突的期限陈述。
          { op: 'update', id: recordD.id, expectedRevision: recordD.revision, content: '林小雨三天内还清了赌债。', reason: 'correct' },
        ],
      }),
      toolCall('CompleteMaintenance', { baseFloor: 0, headFloor: 23 }),
      textStop('维护完成：合并跨批次事件，删除重复占位，修正期限陈述。'),
    ])
    expect(view.status).toBe('done')
    expect(view.summary).toMatchObject({
      editGroups: 1,
      merged: 1,
      corrected: 1,
      deleted: 1,
      created: 0,
      failedGroups: 0,
      retiredReceipts: 0,
      completion: { baseFloor: 0, headFloor: 23 },
      totalFloors: 24,
      llmRequests: 5,
    })
    expect(view.summary!.report).toContain('维护完成')
  })

  it('较早记录身份保留且内容补齐、来源楼层并入；原 source 出处不因维护丢失', async () => {
    const merged = await memory.read(recordA.id, 'chat', chatId)
    expect(merged).toBeDefined()
    expect(merged!.content).toBe(MERGED_CONTENT)
    expect(merged!.content).toContain('第17-23楼')
    expect(merged!.revision).not.toBe(recordA.revision)
    expect(merged!.source.kind).toBe('agent-tool')
  })

  it('重复占位已删除；无关记录 C 未被触碰', async () => {
    expect(await memory.read(recordB.id, 'chat', chatId)).toBeUndefined()
    const softDeleted = await memory.read(recordB.id, 'chat', chatId, true)
    expect(softDeleted!.deletedAt).toBeDefined()
    const untouched = await memory.read(recordC.id, 'chat', chatId)
    expect(untouched!.revision).toBe(recordC.revision)
  })

  it('编辑后向量按新内容重嵌（B-2 路径，digest 不 stale）', async () => {
    const entry = await vectors.get(recordA.id, 'chat', chatId)
    expect(entry).toMatchObject({
      model: 'test-embed',
      digest: memoryContentDigest('test-embed', MERGED_CONTENT),
    })
  })

  it('收据生效：再次 run 待维护范围为空，零 LLM 调用收尾', async () => {
    const idle = await memoryMaintenanceStatus(deps(), { character: CHARACTER, chatId })
    expect(idle.pending.floors).toBe(0)
    expect(idle.pending.ranges).toEqual([])
    const { view, calls } = await runMaintenance({ character: CHARACTER, chatId }, [textStop('should not be called')])
    expect(view.summary).toMatchObject({ pendingFloors: 0, llmRequests: 0, totalFloors: 24 })
    expect(calls).toHaveLength(0)
  })

  it('新楼面追加后：待维护范围只含新楼面（已完成区间被收据排除）', async () => {
    const snapshot = await db.getChatSnapshot(CHARACTER, chatId)
    const chat = snapshot!.chat
    chat.messages.push(floor('一个月后，码头上再没人提起那笔赌债。'), floor('林小雨重新在酒馆唱起了歌。'), floor('陈默偶尔还会来听。'))
    await db.saveChat(CHARACTER, chatId, chat, snapshot!.revision)
    const idle = await memoryMaintenanceStatus(deps(), { character: CHARACTER, chatId })
    expect(idle.pending.floors).toBe(3)
    expect(idle.pending.ranges).toEqual([{ baseFloor: 24, headFloor: 26 }])
  })
})

/* ------------------------------ 收据退役 ------------------------------ */

describe('收据退役', () => {
  /** 造一个带完成收据（0-23 全覆盖）的 scope；返回 scope 与夹具记录 id。 */
  async function scopeWithReceipt(): Promise<MemoryMaintenanceScope & { recordId: string }> {
    const chatId = await seedChat(e1Floors())
    const record = await seedRecord(chatId, '退役夹具记忆：码头灯塔。')
    const scope = { character: CHARACTER, chatId }
    await runMaintenance(scope, [
      toolCall('CompleteMaintenance', { baseFloor: 0, headFloor: 23 }),
      textStop('done'),
    ])
    const state = await (await MemoryMaintenanceStore.open(root)).read(CHARACTER, chatId)
    expect(state.receipts).toHaveLength(1)
    expect(state.receipts[0]!.floorSig).toBe(floorSignature(e1Floors(), 0, 23))
    return { ...scope, recordId: record.id }
  }

  it('路径一：收据覆盖楼面被编辑 → 指纹不符 → 退役，对应范围重新待维护', async () => {
    const scope = await scopeWithReceipt()
    const snapshot = await db.getChatSnapshot(CHARACTER, scope.chatId)
    const chat = snapshot!.chat
    chat.messages[20]!.mes = '（编辑过）旧仓库外的暴雨停了，两人达成了口头约定。'
    await db.saveChat(CHARACTER, scope.chatId, chat, snapshot!.revision)
    const view = await memoryMaintenanceStatus(deps(), scope)
    expect(view.receipts).toBe(0)
    expect(view.pending.floors).toBe(24)
    expect(view.pending.ranges).toEqual([{ baseFloor: 0, headFloor: 23 }])
  })

  it('路径二：收据覆盖记录被非维护写入（revision 不符）→ 退役', async () => {
    const scope = await scopeWithReceipt()
    const current = (await memory.read(scope.recordId, 'chat', scope.chatId))!
    await memory.put({
      id: current.id,
      scope: 'chat',
      scopeId: scope.chatId,
      kind: current.kind,
      content: '退役夹具记忆（模型后续改写）：码头灯塔在雾夜特别亮。',
      tags: current.tags,
      importance: current.importance,
      confidence: current.confidence,
      source: { kind: 'agent-tool', sessionId: 'model-turn', chatId: scope.chatId, character: CHARACTER },
    }, current.revision)
    const view = await memoryMaintenanceStatus(deps(), scope)
    expect(view.receipts).toBe(0)
    expect(view.pending.floors).toBe(24)
    // 下次 run 开始时退役被持久化（receipts 清空），summary 如实报告退役数。
    const { view: runView } = await runMaintenance(scope, [textStop('done')])
    expect(runView.summary!.retiredReceipts).toBe(1)
    expect(runView.summary!.retiredReasons[0]).toContain('record')
  })
})

/* ------------------------------ run 纪律 ------------------------------ */

describe('run 纪律', () => {
  it('预算耗尽如实收尾：24 次 LLM 请求（失败也计数的上限）后停止，成果保留、无收据、outcome=budget-exhausted', async () => {
    const chatId = await seedChat(e1Floors())
    await seedRecord(chatId, '预算测试记忆。')
    const { view, calls } = await runMaintenance({ character: CHARACTER, chatId }, [
      toolCall('ReadMemory', { page: 0 }),
    ])
    expect(view.status).toBe('done')
    expect(view.summary!.outcome).toBe('budget-exhausted')
    expect(view.summary!.llmRequests).toBe(MAINTENANCE_MAX_LLM_REQUESTS)
    expect(view.summary!.budget).toBe(MAINTENANCE_MAX_LLM_REQUESTS)
    expect(calls).toHaveLength(MAINTENANCE_MAX_LLM_REQUESTS)
    expect(view.summary!.completion).toBeUndefined()
    expect(view.summary!.report).toContain('budget')
    expect(view.summary!.error).toBeUndefined()
    const state = await (await MemoryMaintenanceStore.open(root)).read(CHARACTER, chatId)
    expect(state.receipts).toHaveLength(0)
  })

  it('同 scope 409 单飞：在跑 run 未收尾前二次启动被拒；run 结束后可再次启动', async () => {
    const chatId = await seedChat(e1Floors())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated: ChunkProducer = async function* () {
      await gate
      yield { type: 'text-delta', index: 0, text: 'gated done' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx } = fakeCtx([gated])
    const scope = { character: CHARACTER, chatId }
    await startMemoryMaintenance(ctx, deps(), scope)
    await expect(startMemoryMaintenance(ctx, deps(), scope)).rejects.toBeInstanceOf(MaintenanceRunConflictError)
    release()
    const view = await waitUntilIdle(scope)
    expect(view.status).toBe('done')
    // run 结束后注册表释放：可再次启动。
    const { view: second } = await runMaintenance(scope, [textStop('done again')])
    expect(second.status).toBe('done')
  })

  it('进程重启：状态文件遗留的 running（无在跑注册）被标 error(interrupted)，不假装完成', async () => {
    const chatId = await seedChat(e1Floors())
    const stateStore = await MemoryMaintenanceStore.open(root)
    // 模拟崩溃前落下的 running 记录（本进程注册表里没有这个 run）。
    await stateStore.write(CHARACTER, chatId, {
      version: 1,
      receipts: [],
      lastRun: {
        runId: 'crashed-run',
        status: 'running',
        startedAt: new Date().toISOString(),
        summary: {
          totalFloors: 24,
          pendingRanges: [{ baseFloor: 0, headFloor: 23 }],
          pendingFloors: 24,
          editGroups: 0, merged: 0, corrected: 0, created: 0, deleted: 0, failedGroups: 0,
          retiredReceipts: 0, retiredReasons: [],
        },
      },
    })
    const view = await memoryMaintenanceStatus(deps(), { character: CHARACTER, chatId })
    expect(view.status).toBe('error')
    expect(view.runId).toBe('crashed-run')
    expect(view.summary!.error).toContain('interrupted')
    // 扫描结果落盘：后续读取稳定为 error，不回退 running。
    const persisted = await stateStore.read(CHARACTER, chatId)
    expect(persisted.lastRun!.status).toBe('error')
    expect(persisted.lastRun!.outcome).toBe('interrupted')
    expect(persisted.lastRun!.finishedAt).toBeDefined()
  })
})
