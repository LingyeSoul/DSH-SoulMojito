import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { formatRewriteBlock, optionalFeedback } from '../src/rewrite.js'

const CHARACTER = '艾达'

/* ---------------------------- 纯函数：参数与注入块 ---------------------------- */

describe('optionalFeedback', () => {
  it('passes undefined through and normalizes blank strings to undefined', () => {
    expect(optionalFeedback(undefined)).toBeUndefined()
    expect(optionalFeedback('')).toBeUndefined()
    expect(optionalFeedback('   \n\t ')).toBeUndefined()
  })

  it('trims surrounding whitespace', () => {
    expect(optionalFeedback('  保留事件  ')).toBe('保留事件')
  })

  it('accepts up to 1000 characters and rejects longer input', () => {
    expect(optionalFeedback('a'.repeat(1000))).toBe('a'.repeat(1000))
    expect(() => optionalFeedback('a'.repeat(1001))).toThrow('at most 1000')
  })

  it('rejects non-string values', () => {
    expect(() => optionalFeedback(42)).toThrow('feedback must be a string')
    expect(() => optionalFeedback(null)).toThrow('feedback must be a string')
    expect(() => optionalFeedback({ text: 'no' })).toThrow('feedback must be a string')
  })
})

describe('formatRewriteBlock', () => {
  it('returns undefined when there is no feedback', () => {
    expect(formatRewriteBlock(undefined)).toBeUndefined()
    expect(formatRewriteBlock('')).toBeUndefined()
  })

  it('formats the rewrite directive with the fixed prefix', () => {
    expect(formatRewriteBlock('保留事件，但减少旁白解释'))
      .toBe('Rewrite directive for this reply (user feedback; the previous reply is being rewritten): 保留事件，但减少旁白解释')
  })
})

/* ---------------------------- 端到端：generate 参数组合 ---------------------------- */

function makeRequest(body: unknown, url = '/api/dsh-tavern/generate') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
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

describe('rewrite with feedback (integration)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<{ system?: string }>
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-rewrite-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: '灯塔看守人。', personality: '沉静', scenario: '风暴之夜的灯塔',
        first_mes: '欢迎光临。', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    const now = new Date().toISOString()
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '欢迎来到灯塔，风暴要来了。' },
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: '讲个故事吧。' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '旧回复：从前有座山，山里有座塔。' },
    ])
    llmRequests = []
    await apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { system?: string }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: '重写后的回复：山上有一座亮着的灯。' }
          yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => void) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('rewrites with feedback: directive lands in system, feedback rides the swipe metadata, never a floor', async () => {
    const feedback = '保留事件，但减少旁白解释'
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, mode: 'regenerate', feedback, revision: before!.revision,
    }), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)

    // 注入块位于本次请求的 system 段
    expect(llmRequests.at(-1)!.system).toContain(
      `Rewrite directive for this reply (user feedback; the previous reply is being rewritten): ${feedback}`,
    )

    const after = await store.getChatSnapshot(CHARACTER, chatId)
    const last = after!.chat.messages.at(-1)!
    // 重写结果作为新 swipe 追加：旧回复仍在候选里可切换
    expect(last.mes).toBe('重写后的回复：山上有一座亮着的灯。')
    expect(last.swipes).toEqual(['旧回复：从前有座山，山里有座塔。', '重写后的回复：山上有一座亮着的灯。'])
    expect(last.swipe_info).toHaveLength(2)
    expect((last.swipe_info![1] as { extra?: { feedback?: string } }).extra!.feedback).toBe(feedback)
    // 意见不是楼层：任何消息文本都不携带意见或注入块
    expect(after!.chat.messages.some((m) => m.mes.includes(feedback) || m.mes.includes('Rewrite directive'))).toBe(false)
    // 用户消息不被重写触碰
    expect(after!.chat.messages[1]!.mes).toBe('讲个故事吧。')
    expect(after!.chat.messages).toHaveLength(3)
  })

  it('regenerate with blank feedback behaves like a plain reroll (no injection, no metadata)', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, mode: 'regenerate', feedback: '   ', revision: before!.revision,
    }), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
    expect(llmRequests.at(-1)!.system).not.toContain('Rewrite directive')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    const last = after!.chat.messages.at(-1)!
    expect((last.swipe_info!.at(-1) as { extra?: { feedback?: string } }).extra).not.toHaveProperty('feedback')
  })

  it('rejects feedback on send mode without touching the chat', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHARACTER, chatId, mode: 'send', message: '你好', feedback: '不该被接受', revision: before!.revision,
    }), res)
    expect(res.statusCode).toBe(500)
    expect(res.chunks.join('')).toContain('feedback is only allowed when mode is regenerate')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(before!.revision)
    expect(after!.chat.messages).toHaveLength(3)
    expect(llmRequests.at(-1)!.system).not.toContain('Rewrite directive')
  })
})
