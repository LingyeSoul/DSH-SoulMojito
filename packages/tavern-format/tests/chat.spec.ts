import { describe, expect, it } from 'vitest'
import { parseChatLog, serializeChatLog } from '../src/index.js'

function sampleChat(): string {
  const header = { user_name: 'unused', character_name: 'unused', chat_metadata: { note_prompt: '', note_interval: 1 } }
  const m1 = {
    name: 'ExampleCard', is_user: false, is_system: false, send_date: 'August 14, 2026 3:05pm',
    mes: 'Hello {{user}}!', extra: { api: 'openai', model: 'gpt-4o' },
    swipe_id: 0, swipes: ['Hello!', 'Hi there!'], swipe_info: [{ send_date: 'x' }, { send_date: 'y' }],
  }
  const m2 = { name: 'User', is_user: true, is_system: false, send_date: 'August 14, 2026 3:06pm', mes: 'Hi' }
  return [header, m1, m2].map((o) => JSON.stringify(o)).join('\n') + '\n'
}

describe('ST 聊天 jsonl', () => {
  it('解析 header 与消息，swipes 字段完整', () => {
    const ir = parseChatLog(sampleChat())
    expect(ir.messages.length).toBe(2)
    expect(ir.messages[0]!.swipes).toEqual(['Hello!', 'Hi there!'])
    expect(ir.messages[0]!.swipe_id).toBe(0)
    expect(ir.messages[1]!.is_user).toBe(true)
    expect(ir.header.chat_metadata).toBeDefined()
  })

  it('字符串级 roundtrip', () => {
    expect(serializeChatLog(parseChatLog(sampleChat()))).toBe(sampleChat())
  })

  it('空行容忍 / 空文件抛错', () => {
    expect(parseChatLog(sampleChat() + '\n\n').messages.length).toBe(2)
    expect(() => parseChatLog('')).toThrow()
    expect(() => parseChatLog('not json')).toThrow()
  })
})
