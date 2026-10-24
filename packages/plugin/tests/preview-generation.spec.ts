import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { generationHooks } from '../src/generation-hooks.js'
import { listPromptViews } from '../src/prompt-viewer.js'
import { modEvents } from '../src/mods/events.js'
import { TavernStore } from '../../tavern-store/src/index.js'

/**
 * 试写预览（D-4 生成不入楼，决策 2026-10-11-preview-generation.md）：
 * - 零副作用逐项：DSH_HOME 全树逐字节不变、聊天 revision/楼层/swipe 不变、
 *   五相位 hook 零调用、chat-saved/stream-delta 零发射、prompt-viewer 零记录；
 * - 装配正确性：preset main / persona / 世界书激活内容进 llm 请求、userText
 *   在末位 user 消息、{{char}} 宏展开生效（与 runGeneration 同一装配助手）；
 * - 模型选择：绑定该聊天的 ST 会话选择优先、agent-tavern 绑定不参与、
 *   无选择回落部署默认；
 * - 404/400；abort 中途停（signal 透传给 llm.stream）；usage/finish 透传；
 * - 客户端：工作台分区试写入口与 zh/en 文案 marker。
 */
const CHARACTER = '灯守'
const USER_TEXT = '风暴灯还亮着吗？'
const LORE_CONTENT = '灯塔的风暴灯由三位守夜人轮值看守。'

function makeRequest(body: unknown, url = '/api/dsh-soulmojito/preview') {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  return {
    method: 'POST',
    url,
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
    /** 手动触发 aborted（preview 的中止透传挂在 req 'aborted' 上）。 */
    emitAborted: () => { for (const listener of listeners.get('aborted') ?? []) listener() },
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

/** DSH_HOME 全树指纹（相对路径 → 内容 sha256）：任何落盘副作用都会改变它。 */
function hashTree(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(full).isDirectory()) Object.assign(out, hashTree(full, rel))
    else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
  }
  return out
}

describe('preview generation (D-4)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<Record<string, unknown> & { signal?: AbortSignal }>
  let hangMode: boolean
  let chatId: string
  const hookSpies: string[] = []
  const offs: Array<() => void> = []
  const modEventSpies: string[] = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-preview-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: '{{char}}是风暴之崖的灯塔看守人。',
        personality: '沉静',
        scenario: '风暴之夜的灯塔',
        first_mes: '欢迎光临灯室。',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
      },
    })
    await store.importWorldFile('Lighthouse Lore', {
      entries: {
        '0': {
          uid: 0, key: ['风暴灯'], keysecondary: [], comment: 'Storm lantern',
          content: LORE_CONTENT, constant: false,
          selective: false, order: 100, position: 0, disable: false,
        },
      },
    })
    await store.putPersona({ name: '掌灯人', description: '灯塔档案：掌灯人的自述。', position: 0 })
    await store.putPreset('preview-preset', {
      prompts: [
        { identifier: 'main', role: 'system', content: 'PRESET-MAIN: 风暴预警协议。' },
        { identifier: 'worldInfoBefore', marker: true },
        { identifier: 'charDescription', marker: true },
        { identifier: 'personaDescription', marker: true },
        { identifier: 'chatHistory', marker: true },
      ],
      prompt_order: [{ character_id: 100001, order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ] }],
    })
    await store.patchState({
      activePreset: 'preview-preset',
      activePersona: '掌灯人',
      activeWorlds: ['Lighthouse Lore'],
    })
    const now = new Date().toISOString()
    chatId = await store.createChat(CHARACTER, {
      user_name: 'User', character_name: CHARACTER,
      chat_metadata: { createdAt: now, timedWorldInfo: {} },
    }, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '灯还亮着，进来避风吧。' },
    ])

    llmRequests = []
    hangMode = false
    await apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async () => ({ id: 'agent-tavern' }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: Record<string, unknown> & { signal?: AbortSignal }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: '预览回复：灯还亮着，风暴快过去了。' }
          // abort 用例：挂起直到 signal abort（llm 收到 signal 是本用例的断言对象）
          if (hangMode) {
            await new Promise((resolve, reject) => {
              const signal = request.signal
              if (signal === undefined || signal.aborted) { reject(new Error('llm stream aborted')); return }
              signal.addEventListener('abort', () => reject(new Error('llm stream aborted')), { once: true })
            })
          }
          yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 } }
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

  afterEach(() => {
    hangMode = false
    hookSpies.length = 0
    modEventSpies.length = 0
    for (const off of offs.splice(0)) off()
  })

  /** 挂五相位 hook 探针 + chat-saved/stream-delta 监听，返回零副作用断言前的就绪状态。 */
  function armSideEffectProbes() {
    for (const phase of ['user-input', 'pre-assemble', 'pre-llm', 'post-output', 'post-save'] as const) {
      offs.push(generationHooks.register(phase, (payload) => {
        hookSpies.push(phase)
        return payload
      }))
    }
    offs.push(modEvents.on('chat-saved', () => { modEventSpies.push('chat-saved') }))
    offs.push(modEvents.on('stream-delta', () => { modEventSpies.push('stream-delta') }))
    offs.push(modEvents.on('assets-saved', () => { modEventSpies.push('assets-saved') }))
  }

  async function preview(userText = USER_TEXT) {
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, userText }), res)
    return { res, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) : undefined }
  }

  it('assembles the real prompt stack and collects text/usage/finish with the default model', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    const treeBefore = hashTree(home)
    armSideEffectProbes()

    const { res, body } = await preview()
    expect(res.statusCode).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.text).toContain('预览回复：灯还亮着')
    expect(body.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(body.finish).toBe('stop')
    // 无会话选择：回落部署默认（与 composer 未选时同款）
    expect(body.provider).toBe('test-provider')
    expect(body.model).toBe('test-model')

    // ---- 装配正确性：进 llm 的请求形状 ----
    const request = llmRequests.at(-1)!
    expect(request.provider).toBe('test-provider')
    expect(request.model).toBe('test-model')
    const serialized = JSON.stringify(request.messages) + String(request.system ?? '')
    // preset main / persona / 世界书激活内容都在
    expect(serialized).toContain('PRESET-MAIN: 风暴预警协议。')
    expect(serialized).toContain('灯塔档案：掌灯人的自述。')
    expect(serialized).toContain(LORE_CONTENT)
    // 宏展开：{{char}} 已替换为角色名，原样宏不出现
    expect(serialized).toContain('灯守是风暴之崖的灯塔看守人。')
    expect(serialized).not.toContain('{{char}}')
    // userText 在末位 user 消息
    const messages = request.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    const last = messages.at(-1)!
    expect(last.role).toBe('user')
    expect(last.content[0]!.text).toBe(USER_TEXT)

    // ---- 零副作用逐项 ----
    // 1. DSH_HOME 全树逐字节不变（聊天文件、state.json、回执、变量……一网打尽）
    expect(hashTree(home)).toEqual(treeBefore)
    // 2. 聊天快照 revision 与楼层逐项一致（无落楼、无 swipe、楼层零变化）
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(before!.revision)
    expect(after!.chat.messages).toEqual(before!.chat.messages)
    expect(after!.chat.messages.some((m) => m.mes.includes('预览回复'))).toBe(false)
    // 3. 五相位 hook 零调用
    expect(hookSpies).toEqual([])
    // 4. chat-saved / stream-delta / assets-saved 零发射
    expect(modEventSpies).toEqual([])
    // 5. prompt-viewer 零记录（只记真实生成）
    expect(listPromptViews({ chatId })).toHaveLength(0)
  })

  it('applies the chat regex overlay to preview USER_INPUT', async () => {
    await store.putChatJsrOverlay(CHARACTER, chatId, (current) => ({
      version: 1,
      scriptTrees: current?.scriptTrees ?? [],
      regexScripts: {
        global: [{
          id: 'preview-session-input', scriptName: 'Preview Session Input', findRegex: '原始输入',
          replaceString: '改写后的输入', trimStrings: [], placement: [1], disabled: false,
          markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false,
          minDepth: null, maxDepth: null,
        }],
      },
    }))
    try {
      const { res, body } = await preview('原始输入')
      expect(res.statusCode).toBe(200)
      expect(body.ok).toBe(true)
      const messages = llmRequests.at(-1)!.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
      const last = messages.at(-1)!
      expect(last.role).toBe('user')
      expect(last.content[0]!.text).toBe('改写后的输入')
    } finally {
      await store.deleteChatScripts(CHARACTER, chatId)
    }
  })

  it('prefers the ST session model selection bound to this chat; agent-tavern bindings do not participate', async () => {
    await store.updateState(() => ({
      sessionBindings: {
        'at-1': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
        'st-1': { architecture: 'st', character: CHARACTER, chatId },
      },
      modelSelections: {
        'at-1': { provider: 'at-provider', model: 'at-model' },
        'st-1': { provider: 'session-provider', model: 'session-model' },
      },
    }))
    const { body } = await preview('再试一句')
    expect(body.provider).toBe('session-provider')
    expect(llmRequests.at(-1)!.provider).toBe('session-provider')
    expect(llmRequests.at(-1)!.model).toBe('session-model')

    // ST 绑定没有会话级选择时回落部署默认（agent-tavern 绑定的选择不得越权顶替）
    await store.updateState(() => ({
      sessionBindings: {
        'at-1': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
      },
      modelSelections: {
        'at-1': { provider: 'at-provider', model: 'at-model' },
      },
    }))
    const fallback = await preview('又一句')
    expect(fallback.body.provider).toBe('test-provider')
    expect(fallback.body.model).toBe('test-model')
  })

  it('rejects empty/whitespace userText with 400 and unknown chats with 404', async () => {
    const llmCallsBefore = llmRequests.length
    const empty = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId, userText: '   ' }), empty)
    expect(empty.statusCode).toBe(400)
    expect(JSON.parse(empty.chunks.join('')).message).toBe('userText is empty')

    const missingChat = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, chatId: 'no-such.jsonl', userText: '你好' }), missingChat)
    expect(missingChat.statusCode).toBe(404)

    const missingFields = makeResponse()
    await apiHandler(makeRequest({ character: CHARACTER, userText: '你好' }), missingFields)
    expect(missingFields.statusCode).toBe(400)

    // 400/404 不触发任何 llm 请求
    expect(llmRequests.length).toBe(llmCallsBefore)
  })

  it('aborts mid-stream: the client disconnect propagates to llm.stream and nothing is written', async () => {
    const before = await store.getChatSnapshot(CHARACTER, chatId)
    hangMode = true
    const res = makeResponse()
    const request = makeRequest({ character: CHARACTER, chatId, userText: '慢一点生成' })
    const pending = apiHandler(request, res)
    await new Promise((resolve) => setTimeout(resolve, 30))
    request.emitAborted()
    await pending

    // llm 收到 signal 且已中止（及时停）
    const last = llmRequests.at(-1)!
    expect(last.signal).toBeInstanceOf(AbortSignal)
    expect(last.signal!.aborted).toBe(true)
    // 中止以错误面浮出；聊天零变化
    expect(res.statusCode).toBe(500)
    expect(res.chunks.join('')).toContain('aborted')
    const after = await store.getChatSnapshot(CHARACTER, chatId)
    expect(after!.revision).toBe(before!.revision)
  })

  it('client workbench band wires the preview entry with zh/en copy', async () => {
    const source = readFileSync(fileURLToPath(new URL('../client/main.js', import.meta.url)), 'utf8')
    // POST preview 接线 + 工作台分区挂载
    expect(source).toContain("api('preview', {")
    expect(source).toContain('h(WorkbenchPreviewBand)')
    // zh/en 文案 marker（带闭合引号；负样本：不同 key 不得误命中）
    for (const key of ['workbench.preview.title', 'workbench.preview.run', 'workbench.preview.cancel', 'workbench.preview.usage']) {
      expect(source.match(new RegExp(`'${key}':`, 'g'))?.length).toBe(2)
    }
    expect(source).toContain("'workbench.preview.title': '试写'")
    expect(source).toContain("'workbench.preview.title': 'Trial generation'")
  })
})
