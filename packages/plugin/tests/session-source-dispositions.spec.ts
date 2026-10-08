/**
 * Regression guard for the released Session source dispositions, v0 and v4.
 *
 * v0（DSH 0.1.x）：v0→v1 迁移边按封闭成员集校验每个消息 source——plugin
 * source 只允许 {kind, plugin, form, sections, summary}，form 限定
 * instructions | catalog | snapshot | notice | relay | recall；model source
 * 只允许 {kind, provider, model, replayState}；user source 只允许
 * {kind, rpcId, clientTimeZone}。写入其他成员毒化工件，历史加载死于
 * "unexpected member"（2026-09 novel-notice 事故：spliced notice 上的
 * novelId/intentId 让 41 个会话不可加载）。
 *
 * v4（DSH 0.2.0-rc.2 起）：持久化校验要求 producer-owned kind（显式拒绝
 * kind === 'plugin'，"format v4 message requires a producer-owned source
 * kind"）；宿主 v3→v4 迁移把 {kind: 'plugin', plugin} 重写为
 * 'plugin:<name>' 并丢弃 plugin 成员，其余自有 JSON 成员保留。v2→v3 迁移边
 * 另以封闭 kind 集合拒绝未知 kind，v4 形状写入 v0-v3 工件会在升级时死于
 * "cannot safely transform unclassified message source"——因此写入形状必须
 * 按会话 header.version 分支（bind hostPluginMessageSource），v4 kind 与
 * 宿主迁移产物收敛为 'plugin:dsh-tavern'。
 *
 * 本插件落会话日志的每个消息 source 都必须落在其中一张表内；身份数据只进
 * 消息 id、summary 文本或 content，绝不进新的 source 成员。
 */
import { describe, expect, it } from 'vitest'
import { ANCHOR_TEXT, OPENING_TEXT, createAnchorMessage, createOpeningMessage } from '../src/agent-tavern/anchor.js'
import { historyImportAppends } from '../src/agent-tavern/projector.js'
import type { ChatLogIR } from '../../../tavern-format/src/index.js'

const PLUGIN_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

/** v4 会话 stub：header.version = 4（宿主 Session 公开的创建元数据字段）。 */
const v4Session = { header: { version: 4 } }

function expectV0LegalSource(source: unknown): void {
  expect(typeof source).toBe('object')
  const record = source as Record<string, unknown>
  if (record.kind === 'plugin') {
    expect(record.plugin).toBe('dsh-tavern')
    for (const member of Object.keys(record)) {
      expect(['kind', 'plugin', 'form', 'sections', 'summary']).toContain(member)
    }
    if (record.form !== undefined) {
      expect(typeof record.form).toBe('string')
      expect(PLUGIN_FORMS.has(record.form as string)).toBe(true)
    }
    if (record.form === 'notice') expect(typeof record.summary).toBe('string')
    else expect(record.summary).toBeUndefined()
    return
  }
  if (record.kind === 'model') {
    for (const member of Object.keys(record)) {
      expect(['kind', 'provider', 'model', 'replayState']).toContain(member)
    }
    expect(typeof record.provider).toBe('string')
    expect(typeof record.model).toBe('string')
    return
  }
  throw new Error(`unexpected source kind '${String(record.kind)}' in plugin-emitted session message`)
}

function expectV4LegalSource(source: unknown): void {
  expect(typeof source).toBe('object')
  const record = source as Record<string, unknown>
  expect(record.kind).not.toBe('plugin')
  expect(typeof record.kind).toBe('string')
  expect((record.kind as string).length).toBeGreaterThan(0)
}

describe('session-log source dispositions (v0 hosts)', () => {
  it('anchor and opening reminders carry only legal plugin-source members', () => {
    expectV0LegalSource(createAnchorMessage().source)
    expectV0LegalSource(createOpeningMessage().source)
    expect(createAnchorMessage().content).toEqual([{ type: 'text', text: ANCHOR_TEXT }])
    expect(createOpeningMessage().content).toEqual([{ type: 'text', text: OPENING_TEXT }])
  })

  it('history import appends carry only legal user and model source members', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Bob', chat_metadata: {} },
      messages: [
        { name: 'Bob', is_user: false, is_system: false, send_date: '', mes: '你好。' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: '你好呀。' },
      ],
    }
    const appends = historyImportAppends(chat, 'session-1', [], undefined)
    // 导入现在携带完整 turn/step 边界（v4 准入要求）；source 形状仍然只允许
    // 表内的成员，边界事件不参与 source 校验。
    expect(appends.map((append) => append.type)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
    ])
    // v0 宿主没有 assistant 结算流（`stream` 是 v4 的 token-meter 契约）：v0 会话
    // 的导入不得写入 v4 专属成员。
    for (const append of appends) {
      if (append.type === 'assistant/message') expect('stream' in append.data).toBe(false)
    }
    for (const append of appends) {
      if (append.type === 'user/message') expectV0LegalSource((append.data as { source: unknown }).source)
      if (append.type === 'assistant/message') {
        expectV0LegalSource(((append.data as { message: { source: unknown } }).message).source)
      }
    }
  })
})

describe('session-log source dispositions (v4 hosts)', () => {
  it('anchor and opening reminders carry the producer-owned plugin kind', () => {
    expect(createAnchorMessage(v4Session).source).toEqual({ kind: 'plugin:dsh-tavern' })
    expect(createOpeningMessage(v4Session).source).toEqual({ kind: 'plugin:dsh-tavern' })
    expectV4LegalSource(createAnchorMessage(v4Session).source)
    expectV4LegalSource(createOpeningMessage(v4Session).source)
  })

  it('history import appends carry the producer-owned plugin kind without a plugin member', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Bob', chat_metadata: {} },
      messages: [{ name: 'Alice', is_user: true, is_system: false, send_date: '', mes: '你好呀。' }],
    }
    const appends = historyImportAppends(chat, 'session-1', [], undefined, v4Session)
    const userAppend = appends.find((append) => append.type === 'user/message')
    expect(userAppend).toBeDefined()
    expect((userAppend!.data as { source: unknown }).source).toEqual({ kind: 'plugin:dsh-tavern' })
    // 受保护 system 头（surface 首节点）的 source 必须是宿主恢复校验唯一放行的
    // system-prompt 形状；这层校验不查 plugin 成员以外还禁任何额外成员。
    const headAppend = appends.find((append) => append.type === 'system/message')
    expect(headAppend).toBeDefined()
    expect(((headAppend!.data as { message: { source: unknown } }).message).source).toEqual({ kind: 'system-prompt' })
    expect(((headAppend!.data as { message: { content: unknown } }).message).content).toEqual([])
    // v4 assistant 结算契约：token-meter 的 usageOf() 在 usage/stream 双缺时读
    // undefined.length 抛 TypeError，整会话投影失效；导入补空流。
    for (const append of appends.filter((item) => item.type === 'assistant/message')) {
      expect((append.data as { stream?: unknown }).stream).toEqual([])
    }
  })

  it('falls back to the v0 shape when the session header is unreadable', () => {
    expect(createAnchorMessage().source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern' })
    expect(createAnchorMessage({}).source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern' })
    expect(createAnchorMessage({ header: {} }).source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern' })
    expect(createAnchorMessage({ header: { version: 'four' } }).source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern' })
    expect(createAnchorMessage({ header: { version: 3 } }).source).toEqual({ kind: 'plugin', plugin: 'dsh-tavern' })
  })
})
