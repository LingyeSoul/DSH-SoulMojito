import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { recoverBodyOperationWith, type BodyRecoveryOutcome } from '../src/agent-tavern/body-recovery.js'
import type { BodyRuntimeDeps } from '../src/agent-tavern/body-runtime.js'
import { appendMvuAudit, mvuAuditPath, readMvuAudit } from '../src/agent-tavern/projector.js'
import {
  SETTLE_INTENT_EVENT_TYPE,
  readSettleIntents,
} from '../src/agent-tavern/write-journal.js'
import {
  foldSettleIntents,
  recoverOpenSettleIntents,
  type SettleIntentOpenEntry,
  type WriteJournalSession,
} from '../src/agent-tavern/body-settle-intent.js'
import { appendMvuReceipt, MVU_RECEIPTS_LIMIT, MVU_SETTLE_RECEIPTS_RESERVED, readMvuReceipts, type MvuReceipt } from '../src/mvu.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Settle Character'
let chatId = ''

const hostState = vi.hoisted(() => ({
  module: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../../bind/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../bind/src/index.js')>()
  return {
    ...actual,
    importHostPackage: async (name: string): Promise<unknown> => {
      if (name !== '@deepseek-ai/dsh-session') throw new Error(`unexpected host package import: ${name}`)
      if (hostState.module === undefined) throw new Error('@deepseek-ai/dsh-session is not installed')
      return hostState.module
    },
  }
})

interface SettleSession {
  readonly id: string
  readonly events: unknown[]
  appendPluginRecord(type: string, data: unknown): number
  append(type: string, data: unknown): number
}

interface SettleHarness {
  readonly session: SettleSession
  failIntentPhase: 'open' | 'extend' | 'decide' | 'abort' | 'commit' | 'recovered' | undefined
  failIntentOnce: boolean
}

let sessionSeq = 0

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object value')
  return value as Record<string, unknown>
}

function createSettleSession(): SettleHarness {
  const events: unknown[] = []
  sessionSeq += 1
  const harness: SettleHarness = {
    failIntentPhase: undefined,
    failIntentOnce: false,
    session: {
      id: `settle-session-${sessionSeq}`,
      events,
      appendPluginRecord: (type: string, data: unknown): number => {
        const phase = asRecord(data)['phase']
        if (type === SETTLE_INTENT_EVENT_TYPE && phase === harness.failIntentPhase) {
          if (harness.failIntentOnce) harness.failIntentPhase = undefined
          throw new Error(`synthetic settle intent append failure for phase '${String(phase)}'`)
        }
        const seq = events.length
        events.push({ seq, type, data, ignorable: true })
        return seq
      },
      append: (type: string, data: unknown): number => {
        const seq = events.length
        events.push({ seq, type, data })
        return seq
      },
    },
  }
  return harness
}

function installSettleHost(): void {
  hostState.module = {
    appendPluginRecord: (session: unknown, type: string, data: unknown): unknown => {
      const method = asRecord(session)['appendPluginRecord']
      if (typeof method !== 'function') throw new Error('fake host: session has no appendPluginRecord')
      return method.call(session, type, data)
    },
  }
}

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string; session?: unknown } }): Promise<any>
}

interface SettleToolResult {
  readonly applied: readonly string[]
  readonly failed: ReadonlyArray<{ readonly name: string; readonly error: string }>
  readonly receipt: {
    readonly status: string
    readonly failures: readonly string[]
    readonly changes: ReadonlyArray<Record<string, unknown>>
  }
  readonly warnings?: readonly string[]
}

describe('AgentTavern MVU settlement tool (proposal 0012 P2)', () => {
  let home: string
  let tools: Map<string, RegisteredTool>
  let sections: Array<{ name: string; text: string }>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-mvu-settle-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: 'A character with tracked story state.',
        personality: 'Steady',
        scenario: 'A settle test scene.',
        first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    await store.saveChat(CHARACTER, chatId, {
      ...snapshot!.chat,
      messages: [
        {
          name: 'User', is_user: true, is_system: false, send_date: '2026-10-07T10:00:00.000Z',
          mes: 'We share a meal by the cellar door.',
        },
        {
          name: CHARACTER, is_user: false, is_system: false, send_date: '2026-10-07T10:01:00.000Z',
          mes: 'The favor warms between us.',
        },
      ],
    }, snapshot!.revision)
    await store.updateState(() => ({
      sessionBindings: {
        native: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
    }))

    tools = new Map()
    sections = []
    apply({
      systemPrompt: {
        section: (section) => { sections.push({ name: section.name, text: section.text as string }) },
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

  beforeEach(() => {
    hostState.module = undefined
  })

  const settle = (changes: unknown[]) =>
    tools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: 'native' } })
  const settleWith = (harness: SettleHarness, changes: unknown[]) =>
    tools.get('tavern_variable_settle')!.execute(
      { changes },
      { agent: { id: 'native', session: harness.session } },
    )
  const boundChat = async () => {
    const store = await TavernStore.open(join(home, 'soulmojito'))
    const state = await store.getState()
    const binding = state.sessionBindings.native!
    return { store, chat: (await store.getChat(binding.character, binding.chatId))! }
  }
  const readChat = async (id: string) => {
    const store = await TavernStore.open(join(home, 'soulmojito'))
    return (await store.getChat(CHARACTER, id))!
  }
  const seedVariable = async (name: string, value: string | number): Promise<void> => {
    await (await VariableStore.open(join(home, 'soulmojito'))).set('chat', chatId, name, value)
  }
  const readVariable = async (name: string) =>
    (await VariableStore.open(join(home, 'soulmojito'))).get('chat', chatId, name)
  const recoverSettle = async (harness: SettleHarness): Promise<BodyRecoveryOutcome> => {
    const agent = { id: 'native', session: harness.session, followup: (): void => {} }
    return recoverBodyOperationWith(
      { bindingOf: async () => ({ architecture: 'agent-tavern', character: CHARACTER, chatId }) },
      agent,
      async (): Promise<BodyRuntimeDeps> => ({
        session: harness.session,
        agent,
        appendRecord: (_session, type, data) => harness.session.appendPluginRecord(type, data),
      }),
    )
  }
  // Direct pass over the folded intents: the body outcome only reports
  // status/pending, so replay counters are asserted through the port itself.
  const recoverDecisions = async (harness: SettleHarness) =>
    recoverOpenSettleIntents(
      {
        store: await TavernStore.open(join(home, 'soulmojito')),
        variableStore: await VariableStore.open(join(home, 'soulmojito')),
      },
      'native',
      harness.session,
      (_session, type, data) => harness.session.appendPluginRecord(type, data),
      foldSettleIntents(harness.session.events),
    )
  // Reproduce the crash window replay recovery owns: the decision is durable,
  // the chat save failed and the abort marker could not land either.
  const crashBeforeSave = async (harness: SettleHarness, changes: unknown[]): Promise<void> => {
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash between decide and saveChat')
    }
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleWith(harness, changes)).rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = original
      harness.failIntentPhase = undefined
    }
  }
  // Isolated chats keep rule receipts from cross-contaminating crash windows:
  // `settleReceiptPersisted` matches by turnKey, and every rules chat starts at 0.
  let ruleChatSeq = 0
  const createRuleChat = async (): Promise<{ agentId: string; chatId: string }> => {
    ruleChatSeq += 1
    const agentId = `rules-${ruleChatSeq}`
    const store = await TavernStore.open(join(home, 'soulmojito'))
    const ruleChatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: {
        createdAt: new Date().toISOString(),
        variables: {
          $rules: [{
            name: 'double-favor',
            when: "getvar('mvu.favor') >= 5",
            then: { 'mvu.derived': "getvar('mvu.favor') * 2" },
          }],
          mvu: { favor: 0, derived: 1 },
        },
      },
    })
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [agentId]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: ruleChatId },
      },
    }))
    return { agentId, chatId: ruleChatId }
  }
  // A schema-guarded chat for clamp/reject replay tests: favor clamps to
  // [0, 10] and mood only accepts the declared enum.
  let schemaChatSeq = 0
  const createSchemaChat = async (): Promise<{ agentId: string; chatId: string }> => {
    schemaChatSeq += 1
    const agentId = `schema-${schemaChatSeq}`
    const store = await TavernStore.open(join(home, 'soulmojito'))
    const schemaChatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: {
        createdAt: new Date().toISOString(),
        variables: {
          $schema: {
            mvu: {
              favor: { $range: [0, 10] },
              mood: { $enum: ['calm', 'tense'] },
            },
          },
          mvu: { favor: 0, mood: 'calm' },
        },
      },
    })
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [agentId]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: schemaChatId },
      },
    }))
    return { agentId, chatId: schemaChatId }
  }
  // A plain chat isolates settle-intent tests from the shared receipt ring so
  // their receipt deltas stay exact.
  let plainChatSeq = 0
  const createPlainChat = async (): Promise<{ agentId: string; chatId: string }> => {
    plainChatSeq += 1
    const agentId = `plain-${plainChatSeq}`
    const store = await TavernStore.open(join(home, 'soulmojito'))
    const plainChatId = await store.createChat(CHARACTER, {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { createdAt: new Date().toISOString() },
    })
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [agentId]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: plainChatId },
      },
    }))
    return { agentId, chatId: plainChatId }
  }
  const settleInChat = async (
    harness: SettleHarness,
    agentId: string,
    changes: unknown[],
  ): Promise<SettleToolResult> => {
    const result = await tools.get('tavern_variable_settle')!.execute(
      { changes },
      { agent: { id: agentId, session: harness.session } },
    )
    return result as SettleToolResult
  }
  const seedRuleVariable = async (targetChatId: string, name: string, value: string | number): Promise<void> => {
    const store = await VariableStore.open(join(home, 'soulmojito'))
    const existing = await store.get('chat', targetChatId, name)
    await store.set('chat', targetChatId, name, value, existing?.revision)
  }
  const readRuleVariable = async (targetChatId: string, name: string) =>
    (await VariableStore.open(join(home, 'soulmojito'))).get('chat', targetChatId, name)

  it('registers the settlement tool and teaches it in the kernel standing duties', () => {
    expect(tools.has('tavern_variable_settle')).toBe(true)
    const tool = tools.get('tavern_variable_settle')!
    // 作用域身份与其他工具一致：只从绑定推导，不暴露 identity 参数。
    for (const candidate of [tool.parameters.properties, (tool.parameters.properties.changes as any)?.items?.properties ?? {}]) {
      for (const identity of ['sessionId', 'scopeId', 'character', 'chatId']) {
        expect(candidate).not.toHaveProperty(identity)
      }
    }
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['changes'],
      additionalProperties: false,
    })
    const changes = tool.parameters.properties.changes as { type: string; items: { required: string[] } }
    expect(changes.type).toBe('array')
    expect(changes.items.required).toEqual(['name', 'value'])
    const kernel = sections.find((section) => section.name === 'dsh-soulmojito:agent-kernel')!
    expect(kernel.text).toContain('tavern_variable_settle')
    expect(kernel.text).toContain('Standing duties')
  })

  it('settles a batch with before/after receipts and an audit line per call', async () => {
    const first = await settle([
      { name: 'mvu.favor', value: 3, reason: 'shared a meal' },
      { name: 'mvu.location', value: 'cellar' },
    ])
    expect(first.applied).toEqual(['mvu.favor', 'mvu.location'])
    expect(first.failed).toEqual([])
    expect(first.receipt).toMatchObject({ status: 'updated', failures: [] })
    // 新增变量无 before；已有值时记 before → after。
    expect(first.receipt.changes).toEqual([
      { name: 'mvu.favor', after: 3 },
      { name: 'mvu.location', after: 'cellar' },
    ])
    // turnKey：正在生成的楼层将占据的 messages 下标（当前 2 条楼层）。
    expect(first.receipt.turnKey).toBe('2')

    const second = await settle([{ name: 'mvu.favor', value: 5, reason: 'gift accepted' }])
    expect(second.receipt.changes).toEqual([{ name: 'mvu.favor', before: 3, after: 5 }])

    // 变量落在 variableStore 的 chat 作用域（variable_get 可见）。
    const variables = await VariableStore.open(join(home, 'soulmojito'))
    const state = await (await TavernStore.open(join(home, 'soulmojito'))).getState()
    const chatId = state.sessionBindings.native!.chatId
    expect(await variables.get('chat', chatId, 'mvu.favor')).toMatchObject({ name: 'mvu.favor', value: 5 })

    // 回执落 chat_metadata.mvu.receipts，且 P1 读取端形状兼容（环形由 P1 守卫）。
    const { chat } = await boundChat()
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toMatchObject({ status: 'updated', changes: [{ name: 'mvu.favor', before: 3, after: 5 }] })

    // 审计投影（选型：v4 会话词汇表封闭，落 <tavern>/mvu/audit.jsonl）。
    const audit = await readMvuAudit(join(home, 'soulmojito'))
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({
      sessionId: 'native',
      character: CHARACTER,
      chatId,
      turnKey: '2',
      status: 'updated',
      changes: [
        { name: 'mvu.favor', reason: 'shared a meal', after: 3 },
        { name: 'mvu.location', after: 'cellar' },
      ],
      failures: [],
    })
    expect(audit[1].changes[0]).toMatchObject({ name: 'mvu.favor', reason: 'gift accepted', before: 3, after: 5 })
  })

  it('isolates per-item failures and still records the successful ones', async () => {
    const result = await settle([
      { name: 'mvu.favor', value: 7, reason: 'kept the promise' },
      { name: 'bad name!', value: 1, reason: 'oops' },
      { name: 'novalue' },
    ])
    expect(result.applied).toEqual(['mvu.favor'])
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]).toMatchObject({ name: 'bad name!' })
    expect(result.failed[0].error).toContain('invalid variable name')
    expect(result.failed[1]).toMatchObject({ name: 'novalue' })
    expect(result.failed[1].error).toContain('invalid variable value')

    // 回执：status 'failed'，成功项照记 before/after，失败项只进 failures。
    expect(result.receipt).toMatchObject({ status: 'failed' })
    expect(result.receipt.changes).toEqual([{ name: 'mvu.favor', before: 5, after: 7 }])
    expect(result.receipt.failures).toHaveLength(2)
    expect(result.receipt.failures[0]).toContain('bad name!')

    const { chat } = await boundChat()
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(3)
    expect(receipts[2]).toMatchObject({ status: 'failed' })

    // 审计线与请求逐项对齐（含失败项的 reason，不带 after）。
    const audit = await readMvuAudit(join(home, 'soulmojito'))
    expect(audit).toHaveLength(3)
    expect(audit[2].status).toBe('failed')
    expect(audit[2].changes).toEqual([
      { name: 'mvu.favor', reason: 'kept the promise', before: 5, after: 7 },
      { name: 'bad name!', reason: 'oops' },
      { name: 'novalue' },
    ])
    expect(audit[2].failures).toHaveLength(2)
  })

  it('rejects malformed batches before touching any store', async () => {
    await expect(settle([])).rejects.toThrow('at most 16 entries')
    await expect(settle(Array.from({ length: 17 }, () => ({ name: 'mvu.x', value: 1 }))))
      .rejects.toThrow('at most 16 entries')
    await expect(settle([{ value: 1 }])).rejects.toThrow('non-empty string name')
    await expect(settle([{ name: '  ', value: 1 }])).rejects.toThrow('non-empty string name')
    // 拒绝后不留回执与审计线。
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(3)
    expect(await readMvuAudit(join(home, 'soulmojito'))).toHaveLength(3)
  })

  it('settles non-ASCII (Chinese MVU) variable names instead of rejecting them', async () => {
    // 回归：store 层名字校验曾为 ASCII-only，中文 MVU 变量名（`当前周期`、
    // `status.服从指令`）整批落 failures。
    const result = await settle([
      { name: '当前周期', value: 2, reason: '周期推进' },
      { name: 'status.服从指令', value: { 等级: 3 } },
    ])
    expect(result.applied).toEqual(['当前周期', 'status.服从指令'])
    expect(result.failed).toEqual([])
    expect(result.receipt).toMatchObject({
      status: 'updated',
      changes: [
        { name: '当前周期', after: 2 },
        { name: 'status.服从指令', after: { 等级: 3 } },
      ],
    })
    const { store } = await boundChat()
    const chatId = (await store.getState()).sessionBindings.native!.chatId
    expect(await (await VariableStore.open(join(home, 'soulmojito'))).get('chat', chatId, '当前周期'))
      .toMatchObject({ value: 2 })
  })

  it('propagates chat CAS conflicts for the agent to retry', async () => {
    const { store, chat } = await boundChat()
    const receiptsBefore = readMvuReceipts(chat).length
    const auditBefore = (await readMvuAudit(join(home, 'soulmojito'))).length
    // 让工具拿到过期 revision：与落盘 revision 永不相等 → saveChat 抛 CAS 冲突。
    const original = TavernStore.prototype.getChatSnapshot
    TavernStore.prototype.getChatSnapshot = async function (this: TavernStore, character: string, id: string) {
      const snapshot = await original.call(this, character, id)
      return snapshot === undefined ? undefined : { chat: snapshot.chat, revision: 'stale-revision' }
    }
    try {
      await expect(settle([{ name: 'mvu.trust', value: 1 }]))
        .rejects.toMatchObject({ code: 'CHAT_REVISION_CONFLICT' })
    } finally {
      TavernStore.prototype.getChatSnapshot = original
    }
    // 冲突时聊天文件与审计线不被写穿（回执未落，重试幂等）；
    // 变量本身已在冲突前写入 chat 作用域——重试会以新 before 重算。
    const after = await boundChat()
    expect(readMvuReceipts(after.chat)).toHaveLength(receiptsBefore)
    expect(await readMvuAudit(join(home, 'soulmojito'))).toHaveLength(auditBefore)
    const state = await store.getState()
    const chatId = state.sessionBindings.native!.chatId
    expect(await (await VariableStore.open(join(home, 'soulmojito'))).get('chat', chatId, 'mvu.trust'))
      .toMatchObject({ value: 1 })
    // 冲突恢复后重试成功：回执与审计线补齐。
    const retried = await settle([{ name: 'mvu.trust', value: 2 }])
    expect(retried.receipt).toMatchObject({ status: 'updated' })
    expect(retried.receipt.changes).toEqual([{ name: 'mvu.trust', before: 1, after: 2 }])
    expect(await readMvuAudit(join(home, 'soulmojito'))).toHaveLength(auditBefore + 1)
  })

  it('appends and reads the audit jsonl under <tavern>/mvu', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-tavern-mvu-audit-'))
    try {
      expect(await readMvuAudit(root)).toEqual([])
      const record = {
        at: '2026-10-07T00:00:00.000Z',
        sessionId: 's',
        character: 'c',
        chatId: 'chat',
        turnKey: '1',
        status: 'updated',
        changes: [{ name: 'mvu.favor', before: 1, after: 2 }],
        failures: [],
      }
      await appendMvuAudit(root, record)
      await appendMvuAudit(root, { ...record, status: 'failed', failures: ['x: boom'] })
      expect(mvuAuditPath(root)).toBe(join(root, 'mvu', 'audit.jsonl'))
      const audit = await readMvuAudit(root)
      expect(audit).toHaveLength(2)
      expect(audit[0]).toEqual(record)
      expect(audit[1]).toMatchObject({ status: 'failed', failures: ['x: boom'] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records a durable settle intent and closes it after the chat save', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.normal', 'before')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length

    const result = await settleWith(harness, [
      { name: 'settle.normal', value: 'after' },
      { name: 'settle.created', value: 1 },
    ])

    expect(result.applied).toEqual(['settle.normal', 'settle.created'])
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
    const open = intents[0]
    if (open?.phase !== 'open') throw new Error('expected an open settle intent')
    expect(open).toMatchObject({
      sessionId: 'native',
      character: CHARACTER,
      scope: 'chat',
      scopeId: chatId,
      turnKey: '2',
      receiptAt: expect.any(String),
      // The batch promises an opId-carrying receipt, so recovery may not fall
      // back to the legacy at + turnKey match for it.
      receiptOpId: true,
      // The batch also promises post-guard values for every name it writes.
      afterVersion: 2,
      items: [
        { name: 'settle.normal', before: 'before', after: 'after' },
        { name: 'settle.created', after: 1 },
      ],
    })
    const extend = intents[1]
    if (extend?.phase !== 'extend') throw new Error('expected an extend settle intent')
    expect(extend.items).toEqual([
      { name: 'settle.normal', effectiveAfter: 'after' },
      { name: 'settle.created', effectiveAfter: 1 },
    ])
    const decide = intents[2]
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')
    // The decision carries the exact receipt the save persisted: recovery can
    // replay it without reading the receipt ring at all.
    expect(decide).toMatchObject({ opId: open.opId, chatCharacter: CHARACTER, chatId })
    expect(decide.receipt).toEqual(result.receipt)
    const { chat } = await boundChat()
    expect(readMvuReceipts(chat)).toHaveLength(receiptsBefore + 1)
    expect(readMvuReceipts(chat).at(-1)).toMatchObject({ at: open.receiptAt, turnKey: '2', opId: open.opId })
    expect(await readVariable('settle.normal')).toMatchObject({ value: 'after' })
    expect(await readVariable('settle.created')).toMatchObject({ value: 1 })

    // The commit marker closes the intent: a restart must not undo anything.
    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(foldSettleIntents(harness.session.events)).toEqual([])
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
    expect(await readVariable('settle.normal')).toMatchObject({ value: 'after' })
    expect(await readVariable('settle.created')).toMatchObject({ value: 1 })
  })

  it('restores flat variables and aborts the intent when saveChat fails after the decision', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.crash', 'before')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    const messagesBefore = (await boundChat()).chat.messages.length
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash before saveChat')
    }
    try {
      await expect(settleWith(harness, [
        { name: 'settle.crash', value: 'after' },
        { name: 'settle.crash.new', value: 7 },
      ])).rejects.toThrow('synthetic crash before saveChat')
    } finally {
      TavernStore.prototype.saveChat = original
    }

    // The decision was durable before the save, but its rollback succeeded, so
    // the batch closes as aborted and the flat store keeps no written value.
    expect(await readVariable('settle.crash')).toMatchObject({ value: 'before' })
    expect(await readVariable('settle.crash.new')).toBeUndefined()
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'abort'])
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore)

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'abort'])
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore)
    expect((await boundChat()).chat.messages).toHaveLength(messagesBefore)
    expect(harness.session.events.filter((event) => asRecord(event)['type'] === 'assistant/message')).toEqual([])

    // An aborted intent is closed: a later startup pass writes nothing.
    const again = await recoverSettle(harness)
    expect(again).toMatchObject({ status: 'clean', pending: 0 })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'abort'])
    expect(await readVariable('settle.crash')).toMatchObject({ value: 'before' })
  })

  it('restores flat variables from an intent that crashed before its decision', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createRuleChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.derived', 1)
    // The flat writes landed and the process died before the decide record: no
    // decision means the batch never committed, so recovery restores `before`.
    await seedRuleVariable(target.chatId, 'mvu.favor', 10)
    await seedRuleVariable(target.chatId, 'mvu.derived', 20)
    const at = new Date().toISOString()
    const opId = 'settle-crashed-before-decide'
    harness.session.appendPluginRecord(SETTLE_INTENT_EVENT_TYPE, {
      kind: 'settle-intent',
      phase: 'open',
      opId,
      sessionId: 'native',
      character: CHARACTER,
      scope: 'chat',
      scopeId: target.chatId,
      turnKey: '0',
      receiptAt: at,
      at,
      receiptOpId: true,
      items: [
        { name: 'mvu.favor', before: 0, after: 10 },
        { name: 'mvu.derived', before: 1, after: 20 },
      ],
    })

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'restored', pending: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'recovered'])
  })

  it('replays the decided receipt and commits after a crash before the save', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.replay', 'before')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash between decide and saveChat')
    }
    // The abort marker cannot land either, so the decision stays open exactly as
    // a hard crash between the decision and the save would leave it.
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleWith(harness, [{ name: 'settle.replay', value: 'after' }]))
        .rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = original
      harness.failIntentPhase = undefined
    }

    // The decision is final: the flat write stands and no receipt was saved.
    expect(await readVariable('settle.replay')).toMatchObject({ value: 'after' })
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore)
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide'])
    const decide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')

    const outcome = await recoverDecisions(harness)
    expect(outcome).toMatchObject({ restored: 0, committed: 1, replayed: 1, failed: 0 })

    const stored = readMvuReceipts((await boundChat()).chat)
    expect(stored).toHaveLength(receiptsBefore + 1)
    expect(stored.at(-1)).toEqual(decide.receipt)
    expect(await readVariable('settle.replay')).toMatchObject({ value: 'after' })
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide', 'commit'])

    // The decision was consumed: a second startup pass writes nothing.
    const again = await recoverDecisions(harness)
    expect(again).toMatchObject({ restored: 0, committed: 0, replayed: 0, failed: 0 })
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore + 1)
  })

  it('audits a decision replay once and not again on the next startup', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.audit.replay', 'before')
    await crashBeforeSave(harness, [{ name: 'settle.audit.replay', value: 'after' }])
    const decide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')
    // The crashed tool call never reached its own audit append.
    expect((await readMvuAudit(join(home, 'soulmojito'))).some((entry) => entry.opId === decide.opId)).toBe(false)

    const first = await recoverSettle(harness)
    expect(first).toMatchObject({ status: 'clean', pending: 0 })
    const lines = (await readMvuAudit(join(home, 'soulmojito'))).filter((entry) => entry.opId === decide.opId)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      opId: decide.opId,
      recovered: true,
      sessionId: 'native',
      character: CHARACTER,
      chatId,
      at: decide.receipt.at,
      turnKey: decide.receipt.turnKey,
      status: decide.receipt.status,
      changes: decide.receipt.changes,
      failures: [],
    })
    expect(readMvuReceipts((await boundChat()).chat).at(-1)).toEqual(decide.receipt)

    // A restarted pass has no open intent left, so the audit stays single.
    const second = await recoverSettle(harness)
    expect(second).toMatchObject({ status: 'clean', pending: 0 })
    expect((await readMvuAudit(join(home, 'soulmojito'))).filter((entry) => entry.opId === decide.opId)).toHaveLength(1)
  })

  it('does not append a recovery audit line whose opId is already stored', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.audit.once', 'before')
    await crashBeforeSave(harness, [{ name: 'settle.audit.once', value: 'after' }])
    const decide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')
    // Simulate a previous pass that wrote the line before it died: the sentinel
    // shape proves the retry leaves the existing line untouched.
    const sentinel = {
      at: decide.receipt.at,
      sessionId: 'native',
      character: CHARACTER,
      chatId,
      turnKey: decide.receipt.turnKey,
      status: 'unchanged',
      changes: [],
      failures: [],
      opId: decide.opId,
      recovered: true as const,
    }
    await appendMvuAudit(join(home, 'soulmojito'), sentinel)

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    const lines = (await readMvuAudit(join(home, 'soulmojito'))).filter((entry) => entry.opId === decide.opId)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual(sentinel)
    expect(readMvuReceipts((await boundChat()).chat).at(-1)).toEqual(decide.receipt)
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
  })

  it('keeps the commit marker when the recovery audit append fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.audit.down', 'before')
    await crashBeforeSave(harness, [{ name: 'settle.audit.down', value: 'after' }])
    const decide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')
    const warnings: Array<Record<string, unknown> | undefined> = []

    const outcome = await recoverOpenSettleIntents(
      {
        store: await TavernStore.open(join(home, 'soulmojito')),
        variableStore: await VariableStore.open(join(home, 'soulmojito')),
        logger: {
          warn: (_message: string, fields?: Record<string, unknown>): void => { warnings.push(fields) },
        },
        auditReceipt: async (): Promise<void> => { throw new Error('synthetic audit append failure') },
      },
      'native',
      harness.session,
      (_session, type, data) => harness.session.appendPluginRecord(type, data),
      foldSettleIntents(harness.session.events),
    )

    // The receipt, save and commit all stand; only the audit line is missing.
    expect(outcome).toMatchObject({ restored: 0, committed: 1, replayed: 1, failed: 0 })
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
    expect(readMvuReceipts((await boundChat()).chat).at(-1)).toEqual(decide.receipt)
    expect(await readVariable('settle.audit.down')).toMatchObject({ value: 'after' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      stage: 'audit',
      opId: decide.opId,
      error: 'synthetic audit append failure',
    })
  })

  it('keeps the intent when replaying the decision hits a save conflict', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.replay-conflict', 'before')
    const originalSave = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash before the decision save')
    }
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleWith(harness, [{ name: 'settle.replay-conflict', value: 'after' }]))
        .rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = originalSave
      harness.failIntentPhase = undefined
    }

    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic revision conflict during replay')
    }
    try {
      const failed = await recoverDecisions(harness)
      expect(failed).toMatchObject({ restored: 0, committed: 0, replayed: 0, failed: 1 })
      expect(failed.failures[0]).toContain('cannot save its receipt')
    } finally {
      TavernStore.prototype.saveChat = originalSave
    }

    // The decision still owns the batch: no flat rollback, intent still open.
    expect(await readVariable('settle.replay-conflict')).toMatchObject({ value: 'after' })
    expect(foldSettleIntents(harness.session.events)).toHaveLength(1)
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide'])

    const retried = await recoverDecisions(harness)
    expect(retried).toMatchObject({ restored: 0, committed: 1, replayed: 1, failed: 0 })
    expect(await readVariable('settle.replay-conflict')).toMatchObject({ value: 'after' })
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
  })

  it('does not match a receipt without an opId to an exact-only decision', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.exact-only', 'before')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    const originalSave = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash before the exact-only save')
    }
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleWith(harness, [{ name: 'settle.exact-only', value: 'after' }]))
        .rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = originalSave
      harness.failIntentPhase = undefined
    }
    const decide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (decide?.phase !== 'decide') throw new Error('expected a decide settle intent')

    // A legacy receipt at the same millisecond and floor, without any opId.
    const store = await TavernStore.open(join(home, 'soulmojito'))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('expected the bound chat snapshot')
    appendMvuReceipt(snapshot.chat, {
      at: decide.receipt.at,
      turnKey: decide.receipt.turnKey,
      status: 'updated',
      changes: [],
      failures: [],
    })
    await store.saveChat(CHARACTER, chatId, snapshot.chat, snapshot.revision)

    const outcome = await recoverDecisions(harness)
    // Exact identity only: the lookalike cannot prove this batch saved, so the
    // decision is replayed and both receipts are stored.
    expect(outcome).toMatchObject({ restored: 0, committed: 1, replayed: 1, failed: 0 })
    const stored = readMvuReceipts((await boundChat()).chat)
    expect(stored).toHaveLength(receiptsBefore + 2)
    expect(stored.at(-2)?.opId).toBeUndefined()
    expect(stored.at(-1)).toEqual(decide.receipt)
    expect(await readVariable('settle.exact-only')).toMatchObject({ value: 'after' })
  })

  it('does not save the chat when the decision append fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    harness.failIntentPhase = 'decide'
    await seedVariable('settle.nodecide', 'before')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    const auditBefore = (await readMvuAudit(join(home, 'soulmojito'))).length

    await expect(settleWith(harness, [{ name: 'settle.nodecide', value: 'after' }]))
      .rejects.toThrow(/settle intent decide record/)

    // No decision, no save: the flat write went back and the intent aborted.
    expect(await readVariable('settle.nodecide')).toMatchObject({ value: 'before' })
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore)
    expect(await readMvuAudit(join(home, 'soulmojito'))).toHaveLength(auditBefore)
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((entry) => entry.phase)).toEqual(['open', 'extend', 'abort'])
    expect(intents[2]).toMatchObject({ phase: 'abort', reason: 'commit decision was not recorded' })

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(await readVariable('settle.nodecide')).toMatchObject({ value: 'before' })
  })

  it('keeps a batch whose every item was rejected recoverable', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length

    const result = await settleWith(harness, [{ name: 'bad name!', value: 1 }])

    expect(result.applied).toEqual([])
    expect(result.receipt.status).toBe('failed')
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((entry) => entry.phase)).toEqual(['open', 'decide', 'commit'])
    // Nothing was writable, so the undo list is empty instead of listing a name
    // every later undo would reject.
    expect(intents[0]).toMatchObject({ phase: 'open', items: [] })
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore + 1)

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(foldSettleIntents(harness.session.events)).toEqual([])
  })

  it('restores rule-written flat variables when saveChat fails after the decision', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createRuleChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.derived', 1)
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic rule crash before saveChat')
    }
    try {
      await expect(settleInChat(harness, target.agentId, [{ name: 'mvu.favor', value: 10 }]))
        .rejects.toThrow('synthetic rule crash before saveChat')
    } finally {
      TavernStore.prototype.saveChat = original
    }

    // Both the request write and the rule write are back at their before values.
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((intent) => intent.phase)).toEqual(['open', 'extend', 'extend', 'decide', 'abort'])
    const open = intents[0]
    const extend = intents[1]
    if (open?.phase !== 'open' || extend?.phase !== 'extend') {
      throw new Error('expected an open and an extend settle intent')
    }
    expect(extend.opId).toBe(open.opId)
    expect(extend.items).toEqual([{ name: 'mvu.derived', before: 1, after: 20 }])
    // The second extend records the post-guard values the store accepted.
    expect(intents[2]).toMatchObject({
      phase: 'extend',
      items: [
        { name: 'mvu.favor', effectiveAfter: 10 },
        { name: 'mvu.derived', effectiveAfter: 20 },
      ],
    })

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase))
      .toEqual(['open', 'extend', 'extend', 'decide', 'abort'])
  })

  it('skips every rule flat write when the extend intent append fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    // Fail only the rule extend, not the later effective-value extend.
    harness.failIntentPhase = 'extend'
    harness.failIntentOnce = true
    const target = await createRuleChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.derived', 1)

    const result = await settleInChat(harness, target.agentId, [{ name: 'mvu.favor', value: 10 }])

    expect(result.applied).toEqual(['mvu.favor'])
    expect(result.failed).toEqual([])
    expect(result.receipt.status).toBe('failed')
    expect(result.receipt.failures).toEqual([expect.stringContaining('settle intent extend record')])
    expect(result.receipt.changes).toEqual([{ name: 'mvu.favor', before: 0, after: 10 }])
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
  })

  it('restores the earliest before when a request and a rule write the same name', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createRuleChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.derived', 1)
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic same-name crash before saveChat')
    }
    try {
      await expect(settleInChat(harness, target.agentId, [
        { name: 'mvu.favor', value: 10 },
        { name: 'mvu.derived', value: 7 },
      ])).rejects.toThrow('synthetic same-name crash before saveChat')
    } finally {
      TavernStore.prototype.saveChat = original
    }

    // The abort walks the merged items newest first: the rule write goes back to
    // the open record's before (1), not to the extend record's 7.
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
    const intents = readSettleIntents(harness.session.events)
    const open = intents[0]
    const extend = intents[1]
    if (open?.phase !== 'open' || extend?.phase !== 'extend') {
      throw new Error('expected an open and an extend settle intent')
    }
    expect(open.items).toEqual([
      { name: 'mvu.favor', before: 0, after: 10 },
      { name: 'mvu.derived', before: 1, after: 7 },
    ])
    expect(extend.items).toEqual([{ name: 'mvu.derived', before: 7, after: 20 }])
    expect(intents.map((intent) => intent.phase)).toEqual(['open', 'extend', 'extend', 'decide', 'abort'])

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 1 })
  })

  it('does not undo a committed rule settle on the next startup', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createRuleChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.derived', 1)

    const result = await settleInChat(harness, target.agentId, [{ name: 'mvu.favor', value: 10 }])

    expect(result.receipt.status).toBe('updated')
    expect(result.receipt.changes).toEqual([
      { name: 'mvu.favor', before: 0, after: 10 },
      { name: 'mvu.derived', before: 1, after: 20, reason: 'rule:double-favor' },
    ])
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase))
      .toEqual(['open', 'extend', 'extend', 'decide', 'commit'])
    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    expect(await readRuleVariable(target.chatId, 'mvu.derived')).toMatchObject({ value: 20 })
  })

  it('replays the post-guard value when the abort marker fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createSchemaChat()
    await seedRuleVariable(target.chatId, 'mvu.favor', 0)
    await seedRuleVariable(target.chatId, 'mvu.mood', 'calm')
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic schema crash before saveChat')
    }
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleInChat(harness, target.agentId, [
        { name: 'mvu.favor', value: 999 },
        { name: 'mvu.mood', value: 'angry' },
      ])).rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = original
      harness.failIntentPhase = undefined
    }

    // The replay wrote the clamped value, never the raw 999; the guard-rejected
    // mood item produced no write at all.
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    expect(await readRuleVariable(target.chatId, 'mvu.mood')).toMatchObject({ value: 'calm' })
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((entry) => entry.phase)).toEqual(['open', 'extend', 'decide'])
    const open = intents[0]
    const extend = intents[1]
    if (open?.phase !== 'open' || extend?.phase !== 'extend') {
      throw new Error('expected an open and an extend settle intent')
    }
    // The open record keeps the raw request values; the extend carries only the
    // post-guard value the store accepted.
    expect(open.items).toEqual([
      { name: 'mvu.favor', before: 0, after: 999 },
      { name: 'mvu.mood', before: 'calm', after: 'angry' },
    ])
    expect(extend.items).toEqual([{ name: 'mvu.favor', effectiveAfter: 10 }])

    const outcome = await recoverDecisions(harness)
    expect(outcome).toMatchObject({ restored: 0, committed: 1, replayed: 1, failed: 0 })
    expect(await readRuleVariable(target.chatId, 'mvu.favor')).toMatchObject({ value: 10 })
    expect(await readRuleVariable(target.chatId, 'mvu.mood')).toMatchObject({ value: 'calm' })
  })

  it('rejects malformed effective-after tracking instead of guessing', () => {
    const at = new Date().toISOString()
    const open = {
      kind: 'settle-intent',
      phase: 'open',
      opId: 'settle-after-version',
      sessionId: 'native',
      character: CHARACTER,
      scope: 'chat',
      scopeId: chatId,
      turnKey: '2',
      receiptAt: at,
      at,
      receiptOpId: true,
      afterVersion: 2,
      items: [{ name: 'mvu.favor', effectiveAfter: 1 }],
    }
    const event = (data: unknown) => [{ seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data }]

    expect(() => readSettleIntents(event({ ...open, afterVersion: 3 }))).toThrow(/afterVersion/)
    expect(() => readSettleIntents(event({ ...open, items: [{ name: 'mvu.favor', effectiveAfter: (): number => 1 }] })))
      .toThrow(/effectiveAfter/)
    // An open record carrying effective values must declare their version.
    expect(() => readSettleIntents(event({ ...open, afterVersion: undefined }))).toThrow(/afterVersion/)
    // A legacy open record has no afterVersion, so an effective extend cannot
    // be folded into it: replay would have to guess.
    const legacy = { ...open, afterVersion: undefined, items: [{ name: 'mvu.favor', after: 1 }] }
    const extend = {
      kind: 'settle-intent', phase: 'extend', opId: open.opId, sessionId: 'native', at,
      items: [{ name: 'mvu.favor', effectiveAfter: 2 }],
    }
    expect(() => foldSettleIntents([
      { seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data: legacy },
      { seq: 1, type: SETTLE_INTENT_EVENT_TYPE, data: extend },
    ])).toThrow(/afterVersion 2/)
  })

  it('closes an earlier failed intent when a retry commits', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.retry', 'first')
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic settle save failure')
    }
    try {
      await expect(settleWith(harness, [{ name: 'settle.retry', value: 'second' }]))
        .rejects.toThrow('synthetic settle save failure')
    } finally {
      TavernStore.prototype.saveChat = original
    }
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'abort'])

    const retried = await settleWith(harness, [{ name: 'settle.retry', value: 'third' }])

    expect(retried.applied).toEqual(['settle.retry'])
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase))
      .toEqual(['open', 'extend', 'decide', 'abort', 'open', 'extend', 'decide', 'commit'])
    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(foldSettleIntents(harness.session.events)).toEqual([])
    expect(await readVariable('settle.retry')).toMatchObject({ value: 'third' })
  })

  it('persists a superseded decided receipt and audits it without replaying', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.supersede', 'first')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    // A commit append failure now only warns: the first batch committed, and
    // its intent stays open until a later settle or startup recovery closes it.
    harness.failIntentPhase = 'commit'
    let first: SettleToolResult
    try {
      first = await settleWith(harness, [{ name: 'settle.supersede', value: 'second' }])
    } finally {
      harness.failIntentPhase = undefined
    }
    expect(first.warnings?.[0]).toContain('stayed open')
    const oldIntents = readSettleIntents(harness.session.events)
    const oldOpen = oldIntents[0]
    const oldDecide = oldIntents[2]
    if (oldOpen?.phase !== 'open' || oldDecide?.phase !== 'decide') {
      throw new Error('expected an open and a decide settle intent')
    }
    const firstStored = readMvuReceipts((await boundChat()).chat)
    expect(firstStored).toHaveLength(receiptsBefore + 1)
    expect(firstStored.at(-1)).toEqual(oldDecide.receipt)

    const retried = await settleWith(harness, [{ name: 'settle.supersede', value: 'third' }])
    expect(retried.receipt.changes).toEqual([{ name: 'settle.supersede', before: 'second', after: 'third' }])
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((entry) => entry.phase)).toEqual([
      'open', 'extend', 'decide', 'open', 'extend', 'decide', 'commit', 'commit',
    ])
    const newOpen = intents[3]
    if (newOpen?.phase !== 'open') throw new Error('expected the retry open settle intent')
    expect(intents[6]).toMatchObject({
      phase: 'commit',
      opId: oldOpen.opId,
      reason: `superseded by ${newOpen.opId}`,
    })
    // The superseded receipt is already stored exactly once and the new settle
    // owns the flat value.
    const stored = readMvuReceipts((await boundChat()).chat)
    expect(stored).toHaveLength(receiptsBefore + 2)
    expect(stored.filter((receipt) => receipt.opId === oldOpen.opId)).toHaveLength(1)
    expect(await readVariable('settle.supersede')).toMatchObject({ value: 'third' })

    const audit = await readMvuAudit(join(home, 'soulmojito'))
    const superseded = audit.filter((entry) => entry.supersededBy === newOpen.opId)
    expect(superseded).toHaveLength(1)
    expect(superseded[0]).toMatchObject({
      opId: oldOpen.opId,
      supersededBy: newOpen.opId,
      status: 'updated',
      changes: [{ name: 'settle.supersede', before: 'first', after: 'second' }],
    })
    // Superseded lines are written by the live tool, not by recovery.
    expect(superseded[0]!.recovered).toBeUndefined()
    const current = audit.filter((entry) => entry.opId === newOpen.opId)
    expect(current).toHaveLength(1)
    expect(current[0]!.supersededBy).toBeUndefined()
  })

  it('persists the receipt of a superseded decided intent that never saved', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createPlainChat()
    await seedRuleVariable(target.chatId, 'settle.carry', 'first')
    const receiptsBefore = readMvuReceipts(await readChat(target.chatId)).length
    const original = TavernStore.prototype.saveChat
    TavernStore.prototype.saveChat = async function (): Promise<string> {
      throw new Error('synthetic crash between decide and saveChat')
    }
    harness.failIntentPhase = 'abort'
    try {
      await expect(settleInChat(harness, target.agentId, [{ name: 'settle.carry', value: 'second' }]))
        .rejects.toThrow(/could not append its abort marker/)
    } finally {
      TavernStore.prototype.saveChat = original
      harness.failIntentPhase = undefined
    }
    const oldDecide = readSettleIntents(harness.session.events).find((entry) => entry.phase === 'decide')
    if (oldDecide?.phase !== 'decide') throw new Error('expected a decide settle intent')
    // The decision is durable but its receipt never reached the chat.
    expect(readMvuReceipts(await readChat(target.chatId))).toHaveLength(receiptsBefore)
    expect(foldSettleIntents(harness.session.events)).toHaveLength(1)

    const retried = await settleInChat(harness, target.agentId, [{ name: 'settle.carry', value: 'third' }])

    // The superseded decision is evidence: its receipt lands with the retry's
    // save, so the old batch's flat writes stay rollback-able.
    const stored = readMvuReceipts(await readChat(target.chatId))
    expect(stored).toHaveLength(receiptsBefore + 2)
    expect(stored.some((receipt) => receipt.opId === oldDecide.opId)).toBe(true)
    expect(stored.at(-1)).toEqual(retried.receipt)
    expect(retried.receipt.changes).toEqual([{ name: 'settle.carry', before: 'second', after: 'third' }])
    expect(foldSettleIntents(harness.session.events)).toEqual([])
  })

  it('restores an undecided superseded intent before the retry snapshots before', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createPlainChat()
    await seedRuleVariable(target.chatId, 'settle.undecided', 'clean')
    const at = new Date().toISOString()
    const opId = 'settle-undecided-open'
    harness.session.appendPluginRecord(SETTLE_INTENT_EVENT_TYPE, {
      kind: 'settle-intent',
      phase: 'open',
      opId,
      sessionId: 'native',
      character: CHARACTER,
      scope: 'chat',
      scopeId: target.chatId,
      turnKey: '0',
      receiptAt: at,
      at,
      receiptOpId: true,
      afterVersion: 2,
      items: [{ name: 'settle.undecided', before: 'clean', after: 'dirty' }],
    })
    // The crashed batch wrote its value but died before the decision.
    const seedStore = await VariableStore.open(join(home, 'soulmojito'))
    const seeded = await seedStore.get('chat', target.chatId, 'settle.undecided')
    await seedStore.set('chat', target.chatId, 'settle.undecided', 'dirty', seeded?.revision)

    const result = await settleInChat(harness, target.agentId, [{ name: 'settle.undecided', value: 'new' }])

    // The retry read `before` after the undo, so its receipt starts from the
    // clean value instead of the uncommitted dirty one.
    expect(result.receipt.changes).toEqual([{ name: 'settle.undecided', before: 'clean', after: 'new' }])
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual([
      'open', 'recovered', 'open', 'extend', 'decide', 'commit',
    ])
    expect(await readRuleVariable(target.chatId, 'settle.undecided')).toMatchObject({ value: 'new' })
    expect(foldSettleIntents(harness.session.events)).toEqual([])
  })

  it('leaves an undecided superseded intent open when its rollback fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    const target = await createPlainChat()
    const at = new Date().toISOString()
    const opId = 'settle-undecided-broken'
    harness.session.appendPluginRecord(SETTLE_INTENT_EVENT_TYPE, {
      kind: 'settle-intent',
      phase: 'open',
      opId,
      sessionId: 'native',
      character: CHARACTER,
      scope: 'chat',
      scopeId: target.chatId,
      turnKey: '0',
      receiptAt: at,
      at,
      receiptOpId: true,
      afterVersion: 2,
      // The store rejects this name, so the restore throws before any undo.
      items: [{ name: 'bad name!', before: 'clean', after: 'dirty' }],
    })

    await expect(settleInChat(harness, target.agentId, [{ name: 'settle.after-failure', value: 1 }]))
      .rejects.toThrow(/invalid variable name/)

    // The failure aborts this call before any new intent or flat write: startup
    // recovery still owns the open intent.
    expect(foldSettleIntents(harness.session.events)).toHaveLength(1)
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open'])
    expect(await readRuleVariable(target.chatId, 'settle.after-failure')).toBeUndefined()
  })

  it('matches a recovered intent by opId, not by another settle at the same at and turnKey', async () => {
    installSettleHost()
    const harness = createSettleSession()
    await seedVariable('settle.opid.keep', 'old')
    await seedVariable('settle.opid.other', 'dirty')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    // A commit append failure now only warns: the intent stays open after its
    // receipt persisted.
    harness.failIntentPhase = 'commit'
    let first: SettleToolResult
    try {
      first = await settleWith(harness, [{ name: 'settle.opid.keep', value: 'committed' }])
    } finally {
      harness.failIntentPhase = undefined
    }
    expect(first.warnings?.[0]).toContain('stayed open')
    const own = readSettleIntents(harness.session.events).find((intent) => intent.phase === 'open')
    if (own?.phase !== 'open') throw new Error('expected an open settle intent')
    const stored = readMvuReceipts((await boundChat()).chat)
    expect(stored).toHaveLength(receiptsBefore + 1)
    expect(stored.at(-1)).toMatchObject({ opId: own.opId, at: own.receiptAt, turnKey: own.turnKey })

    const foreign: SettleIntentOpenEntry = {
      kind: 'settle-intent', phase: 'open', opId: 'settle-opid-foreign', sessionId: 'native',
      character: CHARACTER, scope: 'chat', scopeId: chatId,
      turnKey: own.turnKey, receiptAt: own.receiptAt, at: own.receiptAt,
      items: [{ name: 'settle.opid.other', before: 'before', after: 'dirty' }],
    }
    harness.session.appendPluginRecord(SETTLE_INTENT_EVENT_TYPE, foreign)
    const outcome = await recoverSettle(harness)

    // Only the opId match commits; the foreign op at the same at + turnKey restores.
    expect(outcome).toMatchObject({ status: 'restored', pending: 0 })
    expect(await readVariable('settle.opid.keep')).toMatchObject({ value: 'committed' })
    expect(await readVariable('settle.opid.other')).toMatchObject({ value: 'before' })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase))
      .toEqual(['open', 'extend', 'decide', 'open', 'commit', 'recovered'])
  })

  it('keeps the legacy at + turnKey match for a receipt written without an opId', async () => {
    // No journal seam on this settle: the receipt keeps the pre-opId shape.
    await settle([{ name: 'settle.legacy', value: 'committed' }])
    const legacy = readMvuReceipts((await boundChat()).chat).at(-1)!
    expect(legacy).toMatchObject({ turnKey: '2' })
    expect(legacy.opId).toBeUndefined()

    installSettleHost()
    const harness = createSettleSession()
    const intent: SettleIntentOpenEntry = {
      kind: 'settle-intent', phase: 'open', opId: 'settle-legacy-intent', sessionId: 'native',
      character: CHARACTER, scope: 'chat', scopeId: chatId,
      turnKey: legacy.turnKey, receiptAt: legacy.at, at: legacy.at,
      items: [{ name: 'settle.legacy', before: 'before', after: 'dirty' }],
    }
    harness.session.appendPluginRecord(SETTLE_INTENT_EVENT_TYPE, intent)
    const outcome = await recoverSettle(harness)

    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(await readVariable('settle.legacy')).toMatchObject({ value: 'committed' })
    expect(readSettleIntents(harness.session.events).map((entry) => entry.phase)).toEqual(['open', 'commit'])
  })

  it('fails closed before any flat write when the intent append fails', async () => {
    installSettleHost()
    const harness = createSettleSession()
    harness.failIntentPhase = 'open'
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length
    const auditBefore = (await readMvuAudit(join(home, 'soulmojito'))).length

    await expect(settleWith(harness, [{ name: 'settle.blocked', value: 1 }]))
      .rejects.toThrow(/settle intent open record/)

    expect(await readVariable('settle.blocked')).toBeUndefined()
    expect(readSettleIntents(harness.session.events)).toEqual([])
    expect(readMvuReceipts((await boundChat()).chat)).toHaveLength(receiptsBefore)
    expect(await readMvuAudit(join(home, 'soulmojito'))).toHaveLength(auditBefore)

    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
  })

  it('fails closed when the host exposes the intent seam but the tool has no session', async () => {
    installSettleHost()

    await expect(settle([{ name: 'settle.no-session', value: 1 }]))
      .rejects.toThrow(/requires exec\.agent\.session/)
    expect(await readVariable('settle.no-session')).toBeUndefined()
  })

  it('returns ok with warnings when the commit marker append fails after the save', async () => {
    installSettleHost()
    const harness = createSettleSession()
    harness.failIntentPhase = 'commit'
    await seedVariable('settle.commit', 'old')
    const receiptsBefore = readMvuReceipts((await boundChat()).chat).length

    const result = await settleWith(harness, [{ name: 'settle.commit', value: 'new' }])

    // The save already committed the batch: the closure failure is downgraded
    // to a warning instead of asking the model to retry (a retry would append a
    // second receipt for the same floor).
    expect(result.applied).toEqual(['settle.commit'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toContain('settle commit is durable')
    expect(result.warnings?.[0]).toContain('stayed open')
    expect(await readVariable('settle.commit')).toMatchObject({ value: 'new' })
    const saved = readMvuReceipts((await boundChat()).chat)
    expect(saved).toHaveLength(receiptsBefore + 1)
    const intents = readSettleIntents(harness.session.events)
    expect(intents.map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide'])
    const open = intents[0]
    if (open?.phase !== 'open') throw new Error('expected an open settle intent')
    // The tool still wrote its own audit line after the failed closure.
    const ownAudit = (await readMvuAudit(join(home, 'soulmojito'))).filter((entry) => entry.opId === open.opId)
    expect(ownAudit).toHaveLength(1)
    expect(ownAudit[0]!.recovered).toBeUndefined()

    harness.failIntentPhase = undefined
    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(readSettleIntents(harness.session.events).map((intent) => intent.phase)).toEqual(['open', 'extend', 'decide', 'commit'])
    expect(await readVariable('settle.commit')).toMatchObject({ value: 'new' })
    // The stored receipt already proves the save: recovery appends the commit
    // marker only and never replays the decision a second time.
    const afterRecovery = readMvuReceipts((await boundChat()).chat)
    expect(afterRecovery).toHaveLength(receiptsBefore + 1)
    expect(afterRecovery.at(-1)).toEqual(saved.at(-1))
    // Recovery's audit sink deduplicates by opId, so the tool's line stays single.
    const afterAudit = (await readMvuAudit(join(home, 'soulmojito'))).filter((entry) => entry.opId === open.opId)
    expect(afterAudit).toHaveLength(1)
  })

  it('leaves a session without settle intents untouched', async () => {
    const harness = createSettleSession()
    const outcome = await recoverSettle(harness)
    expect(outcome).toMatchObject({ status: 'clean', pending: 0 })
    expect(harness.session.events).toEqual([])
  })
})

/* ---------------------- receipt ring: reserved settle slots ---------------------- */

function emptyRingChat() {
  return {
    header: { user_name: 'User', character_name: CHARACTER, chat_metadata: {} },
    messages: [],
  } as never
}

function ringSettle(turnKey: string): MvuReceipt {
  return { at: `settle-${turnKey}`, turnKey, status: 'updated', changes: [], failures: [] }
}

function ringBody(index: number): MvuReceipt {
  return { at: `body-${index}`, turnKey: `body:g${index}#${index}`, status: 'updated', changes: [], failures: [] }
}

describe('MVU receipt ring: reserved settle receipts', () => {
  it('keeps the newest three settle receipts while body candidates claim the rest', () => {
    const chat = emptyRingChat()
    for (let floor = 0; floor < 25; floor += 1) appendMvuReceipt(chat, ringSettle(String(floor)))
    for (let index = 0; index < MVU_RECEIPTS_LIMIT; index += 1) appendMvuReceipt(chat, ringBody(index))

    const keys = readMvuReceipts(chat).map((receipt) => receipt.turnKey)
    expect(keys).toHaveLength(MVU_RECEIPTS_LIMIT)
    // A body burst still leaves the newest three floors their rollback evidence;
    // with a single reserved slot only floor 24 would have survived.
    expect(keys.filter((key) => !key.startsWith('body:')))
      .toEqual(['22', '23', '24'])
    // Body candidates keep their priority: only the oldest ones yield, in stored
    // (append) order.
    expect(keys).toEqual([
      ...Array.from({ length: MVU_SETTLE_RECEIPTS_RESERVED }, (_, offset) => String(22 + offset)),
      ...Array.from(
        { length: MVU_RECEIPTS_LIMIT - MVU_SETTLE_RECEIPTS_RESERVED },
        (_, offset) => `body:g${3 + offset}#${3 + offset}`,
      ),
    ])
  })

  it('honours an explicit settle reservation override and keeps the total bounded', () => {
    const chat = emptyRingChat()
    for (let index = 0; index < MVU_RECEIPTS_LIMIT; index += 1) appendMvuReceipt(chat, ringBody(index))
    appendMvuReceipt(chat, ringSettle('0'), undefined, 1)

    const keys = readMvuReceipts(chat).map((receipt) => receipt.turnKey)
    expect(keys).toHaveLength(MVU_RECEIPTS_LIMIT)
    expect(keys.filter((key) => !key.startsWith('body:'))).toEqual(['0'])
    expect(keys).not.toContain('body:g0#0')
  })

  it('refuses an unusable settle reservation instead of clamping it', () => {
    const chat = emptyRingChat()
    expect(() => appendMvuReceipt(chat, ringSettle('0'), undefined, -1)).toThrow(/settle reservation/)
    expect(() => appendMvuReceipt(chat, ringSettle('0'), undefined, MVU_RECEIPTS_LIMIT + 1)).toThrow(/settle reservation/)
    expect(readMvuReceipts(chat)).toHaveLength(0)
  })
})
