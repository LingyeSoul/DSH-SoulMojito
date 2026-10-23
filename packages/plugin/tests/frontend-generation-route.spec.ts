/**
 * Frontend generation route e2e (2026-10-23).
 *
 * Exercises the real helper `generate` case: a scan-only JSR inject must be
 * resolved against the chat's session world-book copy before the outbound
 * OpenAI-compatible request. All fixtures are synthetic; no third-party card
 * text, remote frontend URL or real user data is stored in this repository.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeEntry } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { handleHelperApi } from '../src/helper.js'

const CHARACTER = 'ExampleCard'
const WORLD = 'Example World'
const CHAT_HEADER = { user_name: 'User', character_name: CHARACTER, chat_metadata: {} }

function makeRequest(body: unknown) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url: '/api/dsh-soulmojito/helper',
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
    headersSent: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); response.writableEnded = true },
    on: () => {},
  }
  return response
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

describe('frontend generation helper route', () => {
  let home: string
  let store: TavernStore
  let chatId: string
  let server: Server
  let baseUrl = ''
  let lastChatRequest: unknown = null

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-generation-route-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    const baseEntry = normalizeEntry({
      uid: 0,
      key: ['[TAG:EXAMPLE]'],
      comment: 'example contract',
      content: '<example_contract>BASE_ONLY</example_contract>',
    })
    await store.importWorldFile(WORLD, { entries: { '0': { ...baseEntry } } })
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: { world: WORLD },
      },
    })
    chatId = await store.createChat(CHARACTER, CHAT_HEADER)
    const sessionEntry = normalizeEntry({
      uid: 0,
      key: ['[TAG:EXAMPLE]'],
      comment: 'example contract',
      content: '<example_contract>SESSION_ONLY</example_contract>',
    })
    await store.putChatWorld(CHARACTER, chatId, { name: WORLD, entries: [sessionEntry] })

    server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        lastChatRequest = JSON.parse(await readBody(req)) as unknown
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: 'generated text' } }] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server has no port')
    baseUrl = `http://127.0.0.1:${address.port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves a scan-only inject from the session copy before the API call', async () => {
    const response = makeResponse()
    await handleHelperApi(makeRequest({
      op: 'generate',
      character: CHARACTER,
      chatId,
      config: {
        custom_api: { apiurl: baseUrl, model: 'example-model' },
        user_input: 'Generate the example payload.',
        injects: [
          { role: 'system', content: '<user_input>Example instruction</user_input>', position: 'in_chat', depth: 0 },
          { role: 'system', content: '[TAG:EXAMPLE]', position: 'none', depth: 0, should_scan: true },
        ],
        overrides: { chat_history: { prompts: [{ role: 'user', content: '' }] } },
      },
    }), response, store)
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.chunks.join(''))).toMatchObject({ ok: true, value: { text: 'generated text' } })

    const request = lastChatRequest as { messages: Array<{ role: string; content: string }> }
    expect(request.messages[0]).toMatchObject({ role: 'system' })
    expect(request.messages[0]?.content).toContain('SESSION_ONLY')
    expect(request.messages[0]?.content).not.toContain('BASE_ONLY')
    expect(request.messages.some((message) => message.content === '[TAG:EXAMPLE]')).toBe(false)
    expect(request.messages.some((message) => message.content.includes('<user_input>Example instruction'))).toBe(true)

    // The shared asset and the session copy keep their own contents.
    expect((await store.getWorld(WORLD))?.entries[0]?.content).toBe('<example_contract>BASE_ONLY</example_contract>')
    expect((await store.getChatWorld(CHARACTER, chatId, WORLD))?.entries[0]?.content).toBe('<example_contract>SESSION_ONLY</example_contract>')
  })
})
