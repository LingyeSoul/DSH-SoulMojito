import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generate, runGeneration } from '../src/generation/pipeline.js'
import type { GenerationMode } from '../src/generation-hooks.js'
import type { HostLlmRequest, PluginContext } from '../src/host-contract.js'
import type { HttpRequest, HttpResponse } from '../src/http/io.js'
import type { ChatMessage, ChatLogIR } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * 生成内核（契约 §2.1/2.2/2.3/2.4/2.6）：continue / impersonate 动词、采样参数
 * 映射、is_hidden 历史过滤、Author's Note 两种注入位置与 summary 块、消息级 token
 * 估算、世界书 automationId 接线。夹具全部代码合成（占位名，无真实素材）。
 */
const CHARACTER = 'Fixture Char'
const CHAT_USER = 'Fixture User'
const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: CHARACTER,
    description: '{{char}} is a placeholder fixture character.',
    personality: 'calm',
    scenario: 'a placeholder room',
    first_mes: 'Placeholder greeting.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  },
}

const MINIMAL_PROMPTS = [
  { identifier: 'main', role: 'system', content: 'MAIN-PROMPT' },
  { identifier: 'worldInfoBefore', marker: true },
  { identifier: 'chatHistory', marker: true },
]
const MINIMAL_ORDER = [{
  character_id: 100001,
  order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ],
}]

/**
 * 最小 POST body 请求替身：`readJson` 只要求 `on('data'|'end')`。Node 的
 * IncomingMessage 形状过宽，测试在调用点用 HttpRequest 断言（route 边界）。
 */
function makeRequest(body: unknown) {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  return {
    method: 'POST',
    url: '/generate',
    on: (event: string, listener: (value?: unknown) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      if (event === 'end') {
        for (const data of listeners.get('data') ?? []) data(Buffer.from(JSON.stringify(body)))
        for (const end of listeners.get('end') ?? []) end()
      }
      return undefined
    },
    destroy: () => {},
  }
}

/** 生成请求里的消息只保证是 createMessage 产物；测试按 role 做运行时收窄。 */
function messageRoles(request: HostLlmRequest): string[] {
  const roles: string[] = []
  for (const message of request.messages) {
    if (typeof message === 'object' && message !== null && 'role' in message && typeof message.role === 'string') {
      roles.push(message.role)
    }
  }
  return roles
}

describe('generation modes (contract §2.1/2.2/2.3/2.4/2.6)', () => {
  let home: string
  let store: TavernStore
  let ctx: PluginContext
  let requests: HostLlmRequest[]
  let nextText: string
  let warnings: string[]

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-genmodes-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter(CARD)
    requests = []
    warnings = []
    nextText = 'GENERATED'
    ctx = {
      llm: {
        stream: async function* (request: HostLlmRequest) {
          requests.push(request)
          yield { type: 'text-delta', text: nextText }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) },
      logger: { warn: (message: string) => { warnings.push(message) } },
      effect: (fn: () => void) => { fn(); return () => {} },
    } as unknown as PluginContext
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  beforeEach(async () => {
    requests = []
    warnings = []
    nextText = 'GENERATED'
    await store.patchState({
      activePreset: undefined,
      activePersona: undefined,
      activeWorlds: [],
      quickReplies: [],
      quickRepliesEnabled: true,
    })
  })

  async function reopen(chatId: string): Promise<ChatLogIR> {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('fixture chat disappeared')
    return snapshot.chat
  }

  async function run(chatId: string, mode: GenerationMode) {
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('fixture chat disappeared')
    return runGeneration(ctx, store, {
      state: await store.getState(),
      characterName: CHARACTER,
      chatId,
      snapshot,
      mode,
      userText: '',
      group: false,
      write: () => {},
      signal: new AbortController().signal,
    })
  }

  async function makeChat(messages: ChatMessage[], metadata: Record<string, unknown> = {}): Promise<string> {
    const now = new Date().toISOString()
    return store.createChat(CHARACTER, {
      user_name: CHAT_USER,
      character_name: CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {}, ...metadata },
    }, messages)
  }

  function userMessage(mes: string): ChatMessage {
    return { name: CHAT_USER, is_user: true, is_system: false, send_date: '2026-01-01T00:00:00.000Z', mes }
  }

  function assistantMessage(mes: string, extra: Record<string, unknown> = {}): ChatMessage {
    return {
      name: CHARACTER, is_user: false, is_system: false, send_date: '2026-01-01T00:00:00.000Z', mes,
      swipe_id: 0, swipes: [mes], ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }
  }

  it('rejects continue when the last floor is not an assistant message', async () => {
    const chatId = await makeChat([userMessage('fixture opening line')])
    await expect(run(chatId, 'continue')).rejects.toThrow('cannot continue')
    expect(requests).toHaveLength(0)
  })

  it('appends continue output to the last floor mes and its active swipe without a new floor', async () => {
    const chatId = await makeChat([userMessage('go on'), assistantMessage('PART-A')])
    nextText = 'PART-B'
    const result = await run(chatId, 'continue')

    expect(result.chat.messages).toHaveLength(2)
    const last = result.chat.messages[1]!
    expect(last.mes).toBe('PART-APART-B')
    expect(last.swipes).toEqual(['PART-APART-B'])
    expect(last.swipe_id).toBe(0)
    expect(last.extra?.['tokenCount']).toBe(Math.round('PART-APART-B'.length / 3.5))
    expect((await reopen(chatId)).messages.map((message) => message.mes)).toEqual(['go on', 'PART-APART-B'])

    const request = requests.at(-1)!
    // 不新增用户楼：请求的最后一条仍是 assistant；续写指令进 system 段
    expect(messageRoles(request).at(-1)).toBe('assistant')
    expect(String(request.system)).toContain('Continue the last assistant message')
  })

  it('writes an is_user floor for impersonate and never appends an assistant floor', async () => {
    const chatId = await makeChat([userMessage('previous line')])
    nextText = 'IMPERSONATED'
    const result = await run(chatId, 'impersonate')

    expect(result.chat.messages).toHaveLength(2)
    const last = result.chat.messages[1]!
    expect(last.is_user).toBe(true)
    expect(last.name).toBe('User')
    expect(last.mes).toBe('IMPERSONATED')
    expect(last.extra?.['tokenCount']).toBe(Math.round('IMPERSONATED'.length / 3.5))
    const request = requests.at(-1)!
    expect(String(request.system)).toContain('Write the next message as User')
  })

  it('whitelists HTTP generation modes instead of silently falling back to send', async () => {
    const chatId = await makeChat([userMessage('hello')])
    const res = { statusCode: 0, writableEnded: false, setHeader: () => {}, write: () => true, end: () => {}, on: () => {} }
    // route 边界替身：只实现 readJson/generate 访问到的成员。
    const httpRes = res as unknown as HttpResponse
    await expect(generate(ctx, makeRequest({ character: CHARACTER, chatId, revision: 'x', mode: 'bogus' }) as unknown as HttpRequest, httpRes, store))
      .rejects.toThrow('unsupported generation mode: bogus')
    // trigger 只是 STscript 内部相位，不接受 HTTP 直传
    await expect(generate(ctx, makeRequest({ character: CHARACTER, chatId, revision: 'x', mode: 'trigger' }) as unknown as HttpRequest, httpRes, store))
      .rejects.toThrow('unsupported generation mode: trigger')
  })

  it('maps preset sampler keys onto the host request (direct keys win, openai_ prefix accepted)', async () => {
    await store.putPreset('fixture-sampler', {
      prompts: MINIMAL_PROMPTS,
      prompt_order: MINIMAL_ORDER,
      temperature: 0.7,
      openai_max_tokens: 256,
      top_p: 0.9,
      openai_top_k: 40,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      repetition_penalty: 1.15,
      min_p: 0.05,
      stop: ['END'],
      seed: 42,
      logit_bias: { '50256': -100 },
      unrelated_key: 'ignored',
    })
    await store.patchState({ activePreset: 'fixture-sampler' })

    const chatId = await makeChat([assistantMessage('next please')])
    await run(chatId, 'impersonate')
    const request = requests.at(-1)!
    expect(request.temperature).toBe(0.7)
    expect(request.maxTokens).toBe(256)
    expect(request['top_p']).toBe(0.9)
    expect(request['top_k']).toBe(40)
    expect(request['frequency_penalty']).toBe(0.2)
    expect(request['presence_penalty']).toBe(0.1)
    expect(request['repetition_penalty']).toBe(1.15)
    expect(request['min_p']).toBe(0.05)
    expect(request['stop']).toEqual(['END'])
    expect(request['seed']).toBe(42)
    expect(request['logit_bias']).toEqual({ '50256': -100 })
    expect('unrelated_key' in request).toBe(false)
  })

  it('omits sampler keys that are absent or mistyped instead of sending undefined', async () => {
    await store.putPreset('fixture-sampler-minimal', {
      prompts: MINIMAL_PROMPTS,
      prompt_order: MINIMAL_ORDER,
      temperature: 0.5,
      top_p: 'not-a-number',
    })
    await store.patchState({ activePreset: 'fixture-sampler-minimal' })
    const chatId = await makeChat([userMessage('hello')])
    await run(chatId, 'send')
    const request = requests.at(-1)!
    expect('top_p' in request).toBe(false)
    expect(request.temperature).toBe(0.5)
  })

  it('keeps is_hidden floors out of the generated history in both stored shapes', async () => {
    const chatId = await makeChat([
      userMessage('VISIBLE-USER'),
      assistantMessage('VISIBLE-REPLY'),
      { ...assistantMessage('HIDDEN-TOPLEVEL'), is_hidden: true },
      assistantMessage('HIDDEN-IN-EXTRA', { is_hidden: true }),
      userMessage('VISIBLE-TAIL'),
    ])
    // 末条是用户楼：trigger 不弹楼，两份隐藏楼层都留在历史里参与过滤断言。
    await run(chatId, 'trigger')
    const serialized = JSON.stringify(requests.at(-1)!.messages)
    expect(serialized).toContain('VISIBLE-USER')
    expect(serialized).toContain('VISIBLE-REPLY')
    expect(serialized).not.toContain('HIDDEN-TOPLEVEL')
    expect(serialized).not.toContain('HIDDEN-IN-EXTRA')
  })

  it("injects an in_prompt author's note into the system segment", async () => {
    const chatId = await makeChat([userMessage('hello')], {
      note_prompt: 'AN-INPROMPT',
      note_settings: { position: 'in_prompt' },
    })
    await run(chatId, 'trigger')
    const request = requests.at(-1)!
    expect(String(request.system)).toContain('AN-INPROMPT')
    expect(JSON.stringify(request.messages)).not.toContain('AN-INPROMPT')
  })

  it("injects an at_depth author's note as a user message outside the system segment", async () => {
    const chatId = await makeChat([userMessage('hello'), assistantMessage('reply')], {
      note_prompt: 'AN-DEPTH',
      note_settings: { position: 'at_depth', depth: 1, role: 'user' },
    })
    await run(chatId, 'trigger')
    const request = requests.at(-1)!
    expect(String(request.system ?? '')).not.toContain('AN-DEPTH')
    expect(JSON.stringify(request.messages)).toContain('AN-DEPTH')
    expect(messageRoles(request)).toContain('user')
  })

  it("honours the author's note interval (every N floors, modulo on the floor count)", async () => {
    // send 模式在组装前追加用户楼：1 条历史 → 2 楼命中，2 条历史 → 3 楼跳过。
    const evenChat = await makeChat([userMessage('a')], {
      note_prompt: 'AN-INTERVAL',
      note_settings: { position: 'in_prompt', interval: 2 },
    })
    await run(evenChat, 'send')
    expect(String(requests.at(-1)!.system)).toContain('AN-INTERVAL')

    const oddChat = await makeChat([userMessage('a'), assistantMessage('b')], {
      note_prompt: 'AN-INTERVAL',
      note_settings: { position: 'in_prompt', interval: 2 },
    })
    await run(oddChat, 'send')
    expect(String(requests.at(-1)!.system ?? '')).not.toContain('AN-INTERVAL')
  })

  it('injects chat_metadata.summary as a system block before the guides block', async () => {
    const chatId = await makeChat([userMessage('hello')], {
      summary: 'SUMMARY-TEXT',
      guides: [{ id: 'g1', text: 'GUIDE-TEXT', createdAt: '2026-01-01T00:00:00.000Z' }],
    })
    await run(chatId, 'trigger')
    const system = String(requests.at(-1)!.system)
    expect(system).toContain('SUMMARY-TEXT')
    expect(system).toContain('GUIDE-TEXT')
    expect(system.indexOf('SUMMARY-TEXT')).toBeLessThan(system.indexOf('GUIDE-TEXT'))
  })

  it('runs world-info automation quick replies during assembly and persists their variable writes', async () => {
    await store.importWorldFile('Fixture Automation Book', {
      entries: {
        '0': {
          uid: 0, key: ['AUTOMATION-MARKER'], keysecondary: [], comment: 'automation fixture',
          content: 'automation fixture content', constant: true,
          selective: false, order: 100, position: 0, disable: false,
          automationId: 'fixture-automation',
        },
      },
    })
    await store.patchState({ activeWorlds: ['Fixture Automation Book'] })
    await store.patchState({
      quickReplies: [
        {
          id: 'fixture-set', name: 'fixture-auto', enabled: true, isGlobal: false,
          automationId: 'fixture-automation', commands: ['/setvar autoFlag=yes'],
        },
        {
          id: 'fixture-set-mutating', name: 'fixture-auto-mutating', enabled: true, isGlobal: false,
          automationId: 'fixture-automation', commands: ['/send should-not-land'],
        },
      ],
    })
    try {
      const chatId = await makeChat([userMessage('hello')])
      const result = await run(chatId, 'trigger')
      expect(result.chat.header.chat_metadata.variables).toMatchObject({ autoFlag: 'yes' })
      // 自动化里不可用的命令（改楼层）只记日志，不中断生成、不落楼
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('world info automation')
      expect(warnings[0]).toContain('/send is not available')
      expect(result.chat.messages.some((message) => message.mes === 'should-not-land')).toBe(false)
    } finally {
      await store.patchState({ activeWorlds: [], quickReplies: [] })
    }
  })
})
