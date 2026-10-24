/**
 * `GET display` is the AgentTavern native-conversation display lookup: the host
 * owns assistant rows, so the browser asks the server for one projected
 * message's display text (save-layer text + markdownOnly scripts) instead of
 * transferring the whole chat. Covers the messageId mapping, the missing row,
 * the 404 chat, and the required query parameters.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Display Probe'
const GREETING_CHARACTER = 'Greeting Probe'
const HEADER = { user_name: 'unused', character_name: 'unused', chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} } }

describe('display route e2e through the real HTTP surface', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string

  function makeRequest(url: string, method = 'GET', body?: unknown) {
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
      headersSent: false,
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

  async function call(url: string, method = 'GET', body?: unknown) {
    const res = makeResponse()
    await apiHandler(makeRequest(url, method, body), res)
    return { status: res.statusCode, body: res.chunks.length > 0 ? JSON.parse(res.chunks.join('')) as Record<string, unknown> : null }
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-display-e2e-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: GREETING_CHARACTER, description: '', personality: '', scenario: '', first_mes: 'Default greeting',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: ['Alternate one', 'Alternate two'], tags: [], creator: '', character_version: '',
        extensions: {},
      },
    })
    chatId = await store.createChat(CHARACTER, HEADER, [
      { name: 'User', is_user: true, is_system: false, send_date: '', mes: 'hello' },
      {
        name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'The door opens.',
        extra: { agentTavern: { messageId: 'assistant-live-1' } },
      },
      {
        name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'The gate opens.',
        extra: { agentTavern: { messageId: 'assistant-live-2' } },
      },
    ])
    await store.patchState({
      regexScripts: [{
        id: 'display-1', scriptName: 'Unlock display', findRegex: 'opens', replaceString: 'unlocks',
        trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
        runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null,
      }],
    })
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def: { handler: (req: unknown, res: unknown) => Promise<void> }) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('returns the display text for one projected message id', async () => {
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(chatId)}&messageId=assistant-live-1`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, text: 'The door unlocks.' })
  })

  it('applies markdownOnly scripts to the stored text (latest message depth included)', async () => {
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(chatId)}&messageId=assistant-live-2`)
    expect(result.status).toBe(200)
    expect(result.body?.text).toBe('The gate unlocks.')
  })

  it('applies markdownOnly scripts from the chat session regex overlay', async () => {
    const sessionChatId = await store.createChat(CHARACTER, HEADER, [{
      name: CHARACTER, is_user: false, is_system: false, send_date: '', mes: 'The latch releases.',
      extra: { agentTavern: { messageId: 'assistant-session-1' } },
    }])
    await store.putChatJsrOverlay(CHARACTER, sessionChatId, (current) => ({
      version: 1,
      scriptTrees: current?.scriptTrees ?? [],
      regexScripts: {
        global: [{
          id: 'session-display', scriptName: 'Session display', findRegex: 'latch', replaceString: 'hatch',
          trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false,
          runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null,
        }],
      },
    }))
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(sessionChatId)}&messageId=assistant-session-1`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, text: 'The hatch releases.' })
  })

  it('answers text null for an unknown message id instead of failing the row', async () => {
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(chatId)}&messageId=missing`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, text: null })
  })

  it('answers 404 for an unknown chat', async () => {
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=missing.jsonl&messageId=x`)
    expect(result.status).toBe(404)
    expect(result.body).toMatchObject({ ok: false, message: 'chat not found' })
  })

  it('rejects a request without a message id', async () => {
    const result = await call(`/api/dsh-soulmojito/display?character=${encodeURIComponent(CHARACTER)}&chatId=${encodeURIComponent(chatId)}`)
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false, message: 'character, chatId and messageId are required' })
  })

  it('creates a chat from a chosen alternate greeting (AgentTavern has no swipe UI)', async () => {
    const result = await call('/api/dsh-soulmojito/chats', 'POST', {
      character: GREETING_CHARACTER,
      greetingIndex: 2,
    })
    expect(result.status).toBe(200)
    expect(result.body?.ok).toBe(true)
    const chat = result.body?.chat as { messages?: Array<Record<string, unknown>> }
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages?.[0]).toMatchObject({
      mes: 'Alternate two',
      swipe_id: 2,
      swipes: ['Default greeting', 'Alternate one', 'Alternate two'],
    })
  })

  it('defaults to the first greeting and rejects an out-of-range index', async () => {
    const created = await call('/api/dsh-soulmojito/chats', 'POST', { character: GREETING_CHARACTER })
    expect(created.status).toBe(200)
    expect((created.body?.chat as { messages?: Array<Record<string, unknown>> }).messages?.[0]).toMatchObject({
      mes: 'Default greeting', swipe_id: 0,
    })
    const rejected = await call('/api/dsh-soulmojito/chats', 'POST', {
      character: GREETING_CHARACTER,
      greetingIndex: 3,
    })
    expect(rejected.status).toBe(500)
    expect(rejected.body).toMatchObject({ ok: false, message: 'greetingIndex must be an integer in [0, 2]' })
  })
})
