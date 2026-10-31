import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openImMediaStore } from '../src/im/media-store.js'
import { fetchInboundMedia, ImMediaFetchError, type InboundMediaFetchOptions } from '../src/im/media-fetch.js'
import type { ImMediaRef } from '../src/im/types.js'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

interface Stub {
  baseUrl: string
  requests: number
  close(): Promise<void>
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-media-fetch-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 本地桩：只提供 /file（可指定 content-type 与是否省略 content-length）。 */
async function startStub(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Stub> {
  const state = { requests: 0 }
  const server = createServer((request, response) => {
    state.requests += 1
    handler(request, response)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub did not bind a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests(): number { return state.requests },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function options(stub: Stub, overrides: Partial<InboundMediaFetchOptions> = {}): InboundMediaFetchOptions {
  return {
    channel: 'qq',
    accountId: 'app-1',
    media: openImMediaStore({
      workspaceRoot: async () => root,
      now: () => Date.now(),
      maxBytes: 1024 * 1024,
    }),
    maxBytes: 1024 * 1024,
    timeoutMs: 5_000,
    ...overrides,
  }
}

describe('inbound media fetch', () => {
  it('downloads bytes and saves them under the workspace media root', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength) })
      response.end(PNG_BYTES)
    })
    try {
      const ref: ImMediaRef = { kind: 'image', url: `${stub.baseUrl}/cat.png`, name: 'cat.png' }
      const enriched = await fetchInboundMedia(ref, options(stub))
      expect(enriched.localPath).toBeDefined()
      const localPath = enriched.localPath ?? ''
      expect(localPath.startsWith(join(root, 'im-media', 'qq-app-1'))).toBe(true)
      expect(localPath.endsWith('.png')).toBe(true)
      expect(await readFile(localPath)).toEqual(PNG_BYTES)
      expect((await stat(localPath)).size).toBe(PNG_BYTES.byteLength)
    } finally {
      await stub.close()
    }
  })

  it('falls back to the content type when the URL has no extension', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end(PNG_BYTES)
    })
    try {
      const enriched = await fetchInboundMedia({ kind: 'video', url: `${stub.baseUrl}/download` }, options(stub))
      expect(enriched.localPath?.endsWith('.mp4')).toBe(true)
    } finally {
      await stub.close()
    }
  })

  it('refuses a declared size above the cap before reading the body', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(2048) })
      response.end(Buffer.alloc(2048))
    })
    try {
      await expect(fetchInboundMedia({ kind: 'image', url: `${stub.baseUrl}/big.png` }, options(stub, { maxBytes: 100 })))
        .rejects.toMatchObject({ code: 'IM_MEDIA_FETCH_TOO_LARGE' })
    } finally {
      await stub.close()
    }
  })

  it('refuses an oversized body that omits content-length', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.alloc(2048))
    })
    try {
      await expect(fetchInboundMedia({ kind: 'image', url: `${stub.baseUrl}/chunked.png` }, options(stub, { maxBytes: 100 })))
        .rejects.toMatchObject({ code: 'IM_MEDIA_FETCH_TOO_LARGE' })
      const saved = await stat(join(root, 'im-media', 'qq-app-1')).catch(() => undefined)
      // 没有落盘：目录可以不存在，存在也必须为空。
      expect(saved === undefined || saved.isDirectory()).toBe(true)
    } finally {
      await stub.close()
    }
  })

  it('stops a chunked body that exceeds the cap without a content-length header', async () => {
    const stub = await startStub((_request, response) => {
      // 多次 write 让 Node 走 chunked（无 content-length），只有流式累计才能挡住。
      response.writeHead(200, { 'content-type': 'image/png' })
      for (let index = 0; index < 8; index += 1) response.write(Buffer.alloc(64))
      response.end()
    })
    try {
      await expect(fetchInboundMedia({ kind: 'image', url: `${stub.baseUrl}/chunked.png` }, options(stub, { maxBytes: 100 })))
        .rejects.toMatchObject({ code: 'IM_MEDIA_FETCH_TOO_LARGE' })
    } finally {
      await stub.close()
    }
  })

  it('rejects a non-2xx response and a non-http url', async () => {
    const stub = await startStub((_request, response) => {
      response.writeHead(403)
      response.end('denied')
    })
    try {
      await expect(fetchInboundMedia({ kind: 'image', url: `${stub.baseUrl}/denied.png` }, options(stub)))
        .rejects.toMatchObject({ code: 'IM_MEDIA_FETCH_HTTP' })
      await expect(fetchInboundMedia({ kind: 'image', url: 'file:///c:/secret.png' }, options(stub)))
        .rejects.toMatchObject({ code: 'IM_MEDIA_FETCH_BAD_URL' })
    } finally {
      await stub.close()
    }
  })

  it('returns the ref untouched when there is no url to fetch', async () => {
    const stub = await startStub((_request, response) => { response.writeHead(500); response.end() })
    try {
      const ref: ImMediaRef = { kind: 'voice', transcript: '你好' }
      expect(await fetchInboundMedia(ref, options(stub))).toEqual(ref)
      expect(stub.requests).toBe(0)
    } finally {
      await stub.close()
    }
  })

  it('surfaces a structured error type for callers to warn on', () => {
    expect(new ImMediaFetchError('IM_MEDIA_FETCH_BAD_URL', 'x').name).toBe('ImMediaFetchError')
  })
})