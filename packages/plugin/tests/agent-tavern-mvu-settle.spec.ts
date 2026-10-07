import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { appendMvuAudit, mvuAuditPath, readMvuAudit } from '../src/agent-tavern/projector.js'
import { readMvuReceipts } from '../src/mvu.js'
import { TavernStore, VariableStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Settle Character'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

describe('AgentTavern MVU settlement tool (proposal 0012 P2)', () => {
  let home: string
  let tools: Map<string, RegisteredTool>
  let sections: Array<{ name: string; text: string }>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-tavern-mvu-settle-'))
    process.env.DSH_HOME = home
    const store = await TavernStore.open(join(home, 'tavern'))
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
    const chatId = await store.createChat(CHARACTER, {
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

  const settle = (changes: unknown[]) =>
    tools.get('tavern_variable_settle')!.execute({ changes }, { agent: { id: 'native' } })
  const boundChat = async () => {
    const store = await TavernStore.open(join(home, 'tavern'))
    const state = await store.getState()
    const binding = state.sessionBindings.native!
    return { store, chat: (await store.getChat(binding.character, binding.chatId))! }
  }

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
    const kernel = sections.find((section) => section.name === 'dsh-tavern:agent-kernel')!
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
    const variables = await VariableStore.open(join(home, 'tavern'))
    const state = await (await TavernStore.open(join(home, 'tavern'))).getState()
    const chatId = state.sessionBindings.native!.chatId
    expect(await variables.get('chat', chatId, 'mvu.favor')).toMatchObject({ name: 'mvu.favor', value: 5 })

    // 回执落 chat_metadata.mvu.receipts，且 P1 读取端形状兼容（环形由 P1 守卫）。
    const { chat } = await boundChat()
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toMatchObject({ status: 'updated', changes: [{ name: 'mvu.favor', before: 3, after: 5 }] })

    // 审计投影（选型：v4 会话词汇表封闭，落 <tavern>/mvu/audit.jsonl）。
    const audit = await readMvuAudit(join(home, 'tavern'))
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
    const audit = await readMvuAudit(join(home, 'tavern'))
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
    expect(await readMvuAudit(join(home, 'tavern'))).toHaveLength(3)
  })

  it('propagates chat CAS conflicts for the agent to retry', async () => {
    const { store, chat } = await boundChat()
    const receiptsBefore = readMvuReceipts(chat).length
    const auditBefore = (await readMvuAudit(join(home, 'tavern'))).length
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
    expect(await readMvuAudit(join(home, 'tavern'))).toHaveLength(auditBefore)
    const state = await store.getState()
    const chatId = state.sessionBindings.native!.chatId
    expect(await (await VariableStore.open(join(home, 'tavern'))).get('chat', chatId, 'mvu.trust'))
      .toMatchObject({ value: 1 })
    // 冲突恢复后重试成功：回执与审计线补齐。
    const retried = await settle([{ name: 'mvu.trust', value: 2 }])
    expect(retried.receipt).toMatchObject({ status: 'updated' })
    expect(retried.receipt.changes).toEqual([{ name: 'mvu.trust', before: 1, after: 2 }])
    expect(await readMvuAudit(join(home, 'tavern'))).toHaveLength(auditBefore + 1)
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
})
