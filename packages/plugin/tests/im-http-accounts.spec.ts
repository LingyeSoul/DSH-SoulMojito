import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { tavernDataRoot } from '../src/dsh-home.js'
import { handleImApi } from '../src/http/im.js'
import type { HttpRequest, HttpResponse } from '../src/http/io.js'
import { ImStore } from '../src/im/store.js'
import type { ImRuntime } from '../src/im/runtime.js'
import type { ImAccountRef } from '../src/im/types.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-http-'))
  process.env.DSH_HOME = root
  db = await TavernStore.open(root)
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface FakeResponse {
  statusCode: number
  writableEnded: boolean
  chunks: string[]
  setHeader: () => void
  end: (chunk?: string) => void
}

function makeRequest(body: unknown, url: string, method: string): HttpRequest {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  } as unknown as HttpRequest
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: 0,
    writableEnded: false,
    chunks: [],
    setHeader: () => {},
    end: (chunk?: string) => {
      if (chunk !== undefined) response.chunks.push(chunk)
      response.writableEnded = true
    },
  }
  return response
}

function runtimeOf(): ImRuntime {
  return {
    capabilities: { available: true, reasons: [] },
    views: () => [],
    upsertAccount: async (account: ImAccountRef, secret: Record<string, string>) => {
      await ImStore.open(tavernDataRoot('im')).putAccount(account, { token: secret.token ?? '' })
    },
    removeAccount: async (channel, accountId) => ImStore.open(tavernDataRoot('im')).deleteAccount(channel, accountId),
    handleOneBotWebhook: async () => false,
    bindChat: async () => { throw new Error('bindChat is not part of this test') },
    handleSessionEvent: () => {},
    dispose: async () => {},
    router: { sendText: async () => { throw new Error('sendText is not part of this test') } },
  }
}

async function call(
  body: unknown,
  url: string,
  route: string,
  method: string,
  runtime: ImRuntime,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = makeResponse()
  await handleImApi(
    makeRequest(body, url, method),
    response as unknown as HttpResponse,
    new URL(url, 'http://localhost'),
    route,
    method,
    db,
    runtime,
  )
  return { statusCode: response.statusCode, body: JSON.parse(response.chunks.join('')) as Record<string, unknown> }
}

describe('im account routes', () => {
  it('creates an account, projects it from the store, and deletes it', async () => {
    const runtime = runtimeOf()
    const path = '/api/dsh-soulmojito/im/accounts'
    const accountBody = {
      channel: 'onebot',
      accountId: '10001',
      label: 'primary bot',
      secret: { token: 'secret-token' },
    }
    const created = await call(accountBody, path, 'im/accounts', 'POST', runtime)
    expect(created.statusCode).toBe(200)
    expect(await ImStore.open(tavernDataRoot('im')).accounts()).toMatchObject([
      { channel: 'onebot', accountId: '10001', label: 'primary bot' },
    ])

    const listed = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(listed.body['channels']).toMatchObject([
      { channel: 'onebot', accountId: '10001', label: 'primary bot', status: { state: 'idle' }, peers: 0 },
    ])

    const removed = await call(undefined, `${path}?channel=onebot&accountId=10001`, 'im/accounts', 'DELETE', runtime)
    expect(removed.statusCode).toBe(200)
    const after = await call(undefined, '/api/dsh-soulmojito/im', 'im', 'GET', runtime)
    expect(after.body['channels']).toEqual([])
  })

  it('answers 401 for a webhook that no account accepts', async () => {
    const path = '/api/dsh-soulmojito/im/onebot/webhook'
    const result = await call({ post_type: 'message' }, path, 'im/onebot/webhook', 'POST', runtimeOf())
    expect(result.statusCode).toBe(401)
  })
})
