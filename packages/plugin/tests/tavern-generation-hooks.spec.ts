import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { createGenerationHookBus, generationHooks } from '../src/generation-hooks.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// ST 生成管线 hook 总线（提案 0015 §3.4 P0 空总线）：
// - 单元：五相位无注册时输入输出全等（恒等基线）；waterfall 顺序；单 hook
//   抛错/超时（注入短超时）/忘 return 的降级跳过不中断。
// - 接线：runGeneration 五个调用点真实生效（注册 → 生成路径可见 → 反注册后
//   恢复原状），证明相位落在提案指定的变换点上。
// - 投影：bootstrap 的 mods 占位恒为空数组。
const CHAR = 'Hook Character'

function makeRequest(body: unknown, url: string, method = 'POST') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
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

function importBody(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name, description: `A test character ${name}`, personality: '', scenario: '', first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('generation hook bus unit (empty-bus identity and degradation)', () => {
  it('returns the identical payload (same reference) for all five phases when nothing is registered', async () => {
    const bus = createGenerationHookBus()
    const draft = { messages: [{ role: 'user' }], card: {} }
    const request = { messages: [], system: undefined, params: { provider: 'p' } }
    const view = { chat: {}, revision: 7, speaker: 'C', finalText: 't' }
    expect(await bus.dispatch('user-input', 'raw text', { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe('raw text')
    expect(await bus.dispatch('pre-assemble', draft, { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe(draft)
    expect(await bus.dispatch('pre-llm', request, { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe(request)
    expect(await bus.dispatch('post-output', 'model text', { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe('model text')
    expect(await bus.dispatch('post-save', view, { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe(view)
    expect(bus.degradationCount()).toBe(0)
  })

  it('applies hooks as an ordered waterfall (order asc, ties by registration order)', async () => {
    const bus = createGenerationHookBus()
    const seen: string[] = []
    bus.register('user-input', (text) => { seen.push(`b:${text}`); return `${text}+b` }, 20)
    bus.register('user-input', (text) => { seen.push(`a:${text}`); return `${text}+a` }, 10)
    const out = await bus.dispatch('user-input', 'x', { mode: 'send', character: 'C', chatId: 'c1', group: false })
    expect(seen).toEqual(['a:x', 'b:x+a'])
    expect(out).toBe('x+a+b')
  })

  it('degrades on a throwing hook and continues with the pre-hook value', async () => {
    const bus = createGenerationHookBus()
    bus.register('post-output', () => { throw new Error('boom') })
    bus.register('post-output', (text) => `${text}!`, 20)
    const out = await bus.dispatch('post-output', 'kept', { mode: 'send', character: 'C', chatId: 'c1', group: false })
    expect(out).toBe('kept!')
    expect(bus.degradationCount()).toBe(1)
  })

  it('degrades on a timing-out hook (injected short timeout) and keeps generation going', async () => {
    const bus = createGenerationHookBus({ timeoutMs: 20 })
    bus.register('user-input', async (text) => { await sleep(200); return 'never applied' })
    bus.register('user-input', (text) => `${text}?`, 20)
    const out = await bus.dispatch('user-input', 'original', { mode: 'send', character: 'C', chatId: 'c1', group: false })
    expect(out).toBe('original?')
    expect(bus.degradationCount()).toBe(1)
  })

  it('treats an async rejection like an error degradation (async waterfall)', async () => {
    const bus = createGenerationHookBus()
    bus.register('pre-llm', async () => { throw new Error('async boom') })
    const request = { messages: [1], system: 's', params: {} }
    const out = await bus.dispatch('pre-llm', request, { mode: 'trigger', character: 'C', chatId: 'c1', group: true })
    expect(out).toBe(request)
  })

  it('degrades on a hook that forgets to return (payload never becomes undefined)', async () => {
    const bus = createGenerationHookBus()
    bus.register('post-output', () => undefined as never)
    const out = await bus.dispatch('post-output', 'safe', { mode: 'send', character: 'C', chatId: 'c1', group: false })
    expect(out).toBe('safe')
    expect(bus.degradationCount()).toBe(1)
  })

  it('reports degradation reason and phase via onDegradation', async () => {
    const reports: Array<{ phase: string; reason: string }> = []
    const bus = createGenerationHookBus({ timeoutMs: 15, onDegradation: (info) => reports.push({ phase: info.phase, reason: info.reason }) })
    bus.register('post-output', () => { throw new Error('x') }, 5)
    bus.register('post-output', async () => sleep(100), 10)
    await bus.dispatch('post-output', 't', { mode: 'send', character: 'C', chatId: 'c1', group: false })
    expect(reports).toEqual([
      { phase: 'post-output', reason: 'error' },
      { phase: 'post-output', reason: 'timeout' },
    ])
    expect(bus.degradationCount()).toBe(2)
  })

  it('unregister removes the hook; later dispatches are identity', async () => {
    const bus = createGenerationHookBus()
    const off = bus.register('user-input', (text) => `${text}-hooked`)
    expect(await bus.dispatch('user-input', 'v', { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe('v-hooked')
    off()
    expect(await bus.dispatch('user-input', 'v', { mode: 'send', character: 'C', chatId: 'c1', group: false })).toBe('v')
  })
})

describe('generation hook wiring in runGeneration (five phases)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<{ messages?: Array<{ role?: string; content?: Array<{ text?: string }> }>; system?: string }>
  let chatId: string
  const offs: Array<() => void> = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-hooks-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter(importBody(CHAR))
    await store.putPreset('hook-preset', {
      prompts: [{ identifier: 'chatHistory', marker: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
    })
    await store.patchState({ activePreset: 'hook-preset' })
    chatId = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

    llmRequests = []
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent, presetId) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { messages?: Array<{ role?: string; content?: Array<{ text?: string }> }>; system?: string }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const off of offs.splice(0)) off()
  })

  async function generate(message = `hello ${Math.random()}`) {
    const snapshot = await store.getChatSnapshot(CHAR, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: CHAR, chatId, message, revision: snapshot!.revision,
    }, '/api/dsh-tavern/generate'), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
  }

  it('user-input hook rewrites the user text before the USER_INPUT regex and the push', async () => {
    offs.push(generationHooks.register('user-input', (text) => `[mod] ${text}`))
    await generate('plain input')
    const messages = llmRequests.at(-1)!.messages!
    expect(messages.at(-1)!.content![0]!.text).toBe('[mod] plain input')
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.at(-2)!.mes).toBe('[mod] plain input')
  })

  it('pre-assemble hook can rewrite the draft (nudge-visible last stop)', async () => {
    offs.push(generationHooks.register('pre-assemble', (draft) => ({
      ...draft,
      messages: [...draft.messages, { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'draft floor from hook' }],
    })))
    await generate('with draft floor')
    const messages = llmRequests.at(-1)!.messages!
    expect(messages.at(-1)!.content![0]!.text).toBe('draft floor from hook')
    // 合成楼层不落盘
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.some((m) => m.mes === 'draft floor from hook')).toBe(false)
  })

  it('pre-llm hook sees and can alter the final request (messages/system/params)', async () => {
    offs.push(generationHooks.register('pre-llm', (request) => ({
      ...request,
      system: 'hook-injected system',
      messages: request.messages.map((m) => m),
    })))
    await generate('system probe')
    const request = llmRequests.at(-1)!
    expect(request.system).toBe('hook-injected system')
  })

  it('post-output hook rewrites the model output before AI_OUTPUT regex and save', async () => {
    offs.push(generationHooks.register('post-output', (text) => `${text} [post-processed]`))
    await generate('output probe')
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.at(-1)!.mes).toBe('reply [post-processed]')
  })

  it('post-save hook observes the saved state read-only (return value ignored)', async () => {
    const observed: Array<{ speaker: string; finalText: string; messageCount: number }> = []
    offs.push(generationHooks.register('post-save', (view) => {
      observed.push({
        speaker: view.speaker,
        finalText: view.finalText,
        messageCount: (view.chat as { messages: unknown[] }).messages.length,
      })
      // 只读观察：返回改写值也不影响任何落盘状态
      return { ...view, finalText: 'MUST NOT BE USED' } as typeof view
    }))
    await generate('observe probe')
    expect(observed).toHaveLength(1)
    expect(observed[0]!.speaker).toBe(CHAR)
    expect(observed[0]!.finalText).toBe('reply')
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.at(-1)!.mes).toBe('reply')
  })

  it('after unregistering every hook the generation path is the pristine empty-bus behavior', async () => {
    // 上一个 afterEach 已反注册全部 hook：本轮无注册，行为回到空总线基线。
    expect(generationHooks.degradationCount()).toBe(0)
    await generate('clean pass')
    const messages = llmRequests.at(-1)!.messages!
    expect(messages.at(-1)!.content![0]!.text).toBe('clean pass')
    const saved = await store.getChatSnapshot(CHAR, chatId)
    expect(saved!.chat.messages.at(-1)!.mes).toBe('reply')
    expect(llmRequests.at(-1)!.system).toBeUndefined()
  })

  it('bootstrap carries the mods projection placeholder as an empty array', async () => {
    const res = makeResponse()
    await apiHandler(makeRequest(undefined, '/api/dsh-tavern/bootstrap', 'GET'), res)
    const body = JSON.parse(res.chunks.join('')) as { mods?: unknown }
    expect(Array.isArray(body.mods)).toBe(true)
    expect(body.mods).toEqual([])
  })
})
