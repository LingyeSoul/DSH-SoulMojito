/**
 * Regression guard for the released-v0 Session source dispositions.
 *
 * The v0→v1 migration edge (@deepseek-ai/dsh-session-format-v0-to-v1)
 * validates every message source in a v0 artifact against a closed member
 * set: plugin sources admit only {kind, plugin, form, sections, summary}
 * with form limited to instructions | catalog | snapshot | notice | relay |
 * recall; model sources admit only {kind, provider, model, replayState};
 * user sources admit only {kind, rpcId, clientTimeZone}. Writing any other
 * member poisons the artifact and history loading fails with
 * "unexpected member" (the 2026-09 novel-notice outage: novelId/intentId on
 * spliced notices made 41 sessions unloadable). Every session-log message
 * source this plugin emits must stay inside this table; identity data rides
 * in message ids, summary text or content, never in new source members.
 */
import { describe, expect, it } from 'vitest'
import { ANCHOR_TEXT, OPENING_TEXT, createAnchorMessage, createOpeningMessage } from '../src/agent-tavern/anchor.js'
import { historyImportAppends } from '../src/agent-tavern/projector.js'
import type { ChatLogIR } from '../../../tavern-format/src/index.js'

const PLUGIN_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

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

describe('session-log source dispositions', () => {
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
    expect(appends.map((append) => append.type)).toEqual(['assistant/message', 'user/message'])
    for (const append of appends) {
      if (append.type === 'user/message') expectV0LegalSource((append.data as { source: unknown }).source)
      if (append.type === 'assistant/message') {
        expectV0LegalSource(((append.data as { message: { source: unknown } }).message).source)
      }
    }
  })
})
