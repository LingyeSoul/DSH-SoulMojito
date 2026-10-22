/**
 * Frontend generation bridge: real HTTP integration (2026-10-22).
 *
 * JSR cards own an OpenAI-compatible endpoint and call TavernHelper.generate /
 * getModelList. The bridge must forward the model list and a non-streaming
 * chat-completion request, keep the API key out of logs/errors, and reject
 * non-loopback plain HTTP. A local server keeps this a real integration test
 * (no fetch mocks).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FrontendGenerationError,
  generateWithCustomApi,
  listCustomApiModels,
} from '../src/frontend-generation.js'

const API_KEY = 'test-key-6b0f'
let server: Server
let baseUrl = ''
let lastChatRequest: unknown = null

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        sendJson(res, 401, { error: { message: 'bad key' } })
        return
      }
      sendJson(res, 200, { data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] })
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        sendJson(res, 401, { error: { message: `rejected ${API_KEY}` } })
        return
      }
      lastChatRequest = JSON.parse(await readBody(req)) as unknown
      sendJson(res, 200, { choices: [{ message: { content: 'generated text' } }] })
      return
    }
    sendJson(res, 404, { error: { message: 'not found' } })
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
})

describe('frontend generation bridge', () => {
  it('lists model ids through GET /models and dedups/sorts them', async () => {
    await expect(listCustomApiModels({ apiurl: baseUrl, key: API_KEY })).resolves.toEqual(['model-a', 'model-b'])
  })

  it('forwards injects + history + user_input as one non-streaming request', async () => {
    lastChatRequest = null
    const text = await generateWithCustomApi({
      custom_api: { apiurl: baseUrl, key: API_KEY, model: 'model-a' },
      user_input: 'main instruction',
      should_stream: false,
      generation_id: 'gen-1',
      injects: [
        { role: 'system', content: 'style guide', position: 'in_chat', depth: 0 },
        { role: 'system', content: 'scan only', position: 'none' },
      ],
      overrides: { chat_history: { prompts: [{ role: 'user', content: 'history' }] } },
    })
    expect(text).toBe('generated text')
    expect(lastChatRequest).toMatchObject({
      model: 'model-a',
      stream: false,
      messages: [
        { role: 'system', content: 'style guide' },
        { role: 'user', content: 'history' },
        { role: 'user', content: 'main instruction' },
      ],
    })
  })

  it('redacts the API key from upstream error bodies', async () => {
    const wrong = 'wrong-key-9d2e'
    let caught: unknown = null
    try {
      await listCustomApiModels({ apiurl: baseUrl, key: wrong })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FrontendGenerationError)
    const message = (caught as Error).message
    expect(message).toContain('HTTP 401')
    expect(message).not.toContain(wrong)
  })

  it('rejects non-loopback plain HTTP and credentials in the URL', async () => {
    await expect(listCustomApiModels({ apiurl: 'http://example.com/v1', key: API_KEY })).rejects.toThrow('https://')
    await expect(listCustomApiModels({ apiurl: 'https://user:pass@example.com/v1', key: API_KEY })).rejects.toThrow('credentials')
  })

  it('rejects an empty prompt instead of sending an empty request', async () => {
    await expect(generateWithCustomApi({
      custom_api: { apiurl: baseUrl, key: API_KEY, model: 'model-a' },
    })).rejects.toThrow('user_input or chat history prompts')
  })
})
