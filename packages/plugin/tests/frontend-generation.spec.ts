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
  FrontendTargetBlockedError,
  generateWithCustomApi,
  generateWithCustomApiStream,
  listCustomApiModels,
} from '../src/frontend-generation.js'
import { decideCustomApiTarget } from '../src/frontend-target-policy.js'

const API_KEY = 'test-key-6b0f'
let server: Server
let baseUrl = ''
let lastChatRequest: unknown = null
let chatResponse: unknown = { choices: [{ message: { content: 'generated text' } }] }

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
      const streamed = lastChatRequest !== null
        && typeof lastChatRequest === 'object'
        && (lastChatRequest as { stream?: unknown }).stream === true
      if (streamed) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream')
        res.write('data: {"choices":[{"delta":{"content":"streamed "}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":"text"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      sendJson(res, 200, chatResponse)
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

  it('streams text deltas and returns the final concatenated text', async () => {
    const deltas: string[] = []
    const text = await generateWithCustomApiStream({
      custom_api: { apiurl: baseUrl, key: API_KEY, model: 'model-a' },
      user_input: 'stream this',
      should_stream: true,
      generation_id: 'gen-stream',
    }, (delta) => { deltas.push(delta) }, new AbortController().signal)
    expect(text).toBe('streamed text')
    expect(deltas.join('')).toBe('streamed text')
    expect(lastChatRequest).toMatchObject({ stream: true })
  })

  it('returns tool-call arguments when the provider sends content: null', async () => {
    const previous = chatResponse
    chatResponse = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{
            type: 'function',
            function: { name: 'decree_signing', arguments: '{"directions":[]}' },
          }],
        },
      }],
    }
    try {
      const text = await generateWithCustomApi({
        custom_api: { apiurl: baseUrl, key: API_KEY, model: 'model-a' },
        user_input: 'plan the decree',
      })
      expect(text).toBe('{"directions":[]}')
    } finally {
      chatResponse = previous
    }
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

describe('custom API destination policy', () => {
  it('allows public HTTPS hosts and explicit loopback proxies', () => {
    for (const raw of ['https://api.example.com/v1', 'https://example.test/v1']) {
      expect(decideCustomApiTarget(new URL(raw))).toEqual({
        allowed: true,
        hostname: new URL(raw).hostname,
        loopback: false,
      })
    }
    for (const raw of [
      'http://localhost:8181/v1',
      'http://127.0.0.1:8181/v1',
      'http://[::1]:8181/v1',
      'https://localhost/v1',
    ]) {
      expect(decideCustomApiTarget(new URL(raw))).toMatchObject({ allowed: true, loopback: true })
    }
  })

  it('lets a public HTTPS target pass the policy into request validation', async () => {
    // The empty prompt is rejected after the target check, before any fetch, so
    // this proves the public endpoint is accepted without touching the network.
    await expect(generateWithCustomApi({
      custom_api: { apiurl: 'https://api.example.com/v1', model: 'model-a' },
    })).rejects.toThrow('user_input or chat history prompts')
  })

  it('blocks private, link-local, unique-local, unspecified and metadata literals', () => {
    const blocked: Array<[string, string]> = [
      ['https://10.1.2.3/v1', 'private-address'],
      ['https://172.16.0.1/v1', 'private-address'],
      ['https://172.31.255.254/v1', 'private-address'],
      ['https://192.168.1.1/v1', 'private-address'],
      ['https://127.0.0.2/v1', 'private-address'],
      ['https://169.254.169.254/latest/meta-data', 'private-address'],
      ['https://0.0.0.0/v1', 'private-address'],
      ['https://100.100.100.200/v1', 'private-address'],
      ['https://[fe80::1]/v1', 'private-address'],
      ['https://[fd00::1]/v1', 'private-address'],
      ['https://[::]/v1', 'private-address'],
      ['https://[::ffff:10.0.0.1]/v1', 'private-address'],
      ['https://[64:ff9b::10.0.0.1]/v1', 'private-address'],
      ['https://[2001:db8::1]/v1', 'private-address'],
    ]
    for (const [raw, reason] of blocked) {
      expect(decideCustomApiTarget(new URL(raw))).toMatchObject({ allowed: false, reason })
    }
  })

  it('blocks metadata, private-use and single-label hostnames', () => {
    const blocked: Array<[string, string]> = [
      ['https://metadata.google.internal/v1', 'metadata-host'],
      ['https://metadata.goog/v1', 'metadata-host'],
      ['https://instance-data/v1', 'metadata-host'],
      ['https://printer/v1', 'private-hostname'],
      ['https://gateway.internal/v1', 'private-hostname'],
      ['https://gateway.local/v1', 'private-hostname'],
      ['https://gateway.localhost/v1', 'private-hostname'],
    ]
    for (const [raw, reason] of blocked) {
      expect(decideCustomApiTarget(new URL(raw))).toMatchObject({ allowed: false, reason })
    }
  })

  it('rejects a private endpoint with a structured error before fetching', async () => {
    let caught: unknown = null
    try {
      await listCustomApiModels({ apiurl: 'https://192.168.10.20/v1', key: API_KEY })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(FrontendTargetBlockedError)
    expect(caught).toBeInstanceOf(FrontendGenerationError)
    expect(caught).toMatchObject({
      code: 'TAVERN_FRONTEND_TARGET_BLOCKED',
      reason: 'private-address',
      host: '192.168.10.20',
    })
  })

  it('rejects a metadata hostname during generation without redirecting', async () => {
    await expect(generateWithCustomApi({
      custom_api: { apiurl: 'https://metadata.google.internal/v1', model: 'model-a' },
      user_input: 'probe',
    })).rejects.toMatchObject({
      code: 'TAVERN_FRONTEND_TARGET_BLOCKED',
      reason: 'metadata-host',
      host: 'metadata.google.internal',
    })
  })
})
