/**
 * 微信媒体（提案 0024 M5）：AES-128-ECB 密钥解码、CDN 下载/上传、出站媒体载荷、
 * 入站附件落盘与 typing ticket 缓存。全程不联网：请求打到 `node:http` 本地桩。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openImMediaStore, type ImMediaStore } from '../src/im/media-store.js'
import type { ImInbound, ImTarget, OutboundMediaPart } from '../src/im/types.js'
import { WeixinChannel, WEIXIN_REAL_CLOCK } from '../src/im/weixin/channel.js'
import type { WeixinClock } from '../src/im/weixin/clock.js'
import {
  aesEcbPaddedSize,
  cdnDownloadUrl,
  cdnUploadUrl,
  decryptAesEcb,
  downloadAndDecrypt,
  encryptAesEcb,
  parseAesKey,
  parseImageAesKey,
  WEIXIN_MEDIA_MAX_BYTES,
} from '../src/im/weixin/media.js'

const ACCOUNT_ID = 'weixin-media-account'
const TOKEN = 'synthetic-weixin-token'
const PEER_ID = 'wx-user-1'
const NOW = 1_760_000_000_000

/** 16 字节 AES-128 密钥与它的 hex 形态（协议里两种都出现）。 */
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const KEY_HEX = KEY.toString('hex')
const PLAINTEXT = Buffer.from('weixin media payload', 'utf8')

// ---- 本地 HTTP 桩（真实 socket，绝不联网）----

interface StubRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Buffer
  /** 只有 `content-type: application/json` 的请求才有。 */
  json: Record<string, unknown> | undefined
}

interface StubReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  body?: Uint8Array
}

type StubHandler = (request: StubRequest) => StubReply | Promise<StubReply>

interface Stub {
  readonly baseUrl: string
  readonly port: number
  readonly requests: StubRequest[]
  setHandler(handler: StubHandler): void
  close(): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function readRequest(req: IncomingMessage): Promise<StubRequest> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const body = Buffer.concat(chunks)
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const contentType = String(req.headers['content-type'] ?? '')
  let json: Record<string, unknown> | undefined
  if (body.length > 0 && contentType.includes('application/json')) {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the synthetic request body must be a JSON object')
    }
    json = parsed as Record<string, unknown>
  }
  return { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, json }
}

/**
 * 桩端口必须避开 Node fetch（undici）的 bad-port 黑名单（最高 10080）：
 * 50000-59999 全部可用；撞车就换一个重试。
 */
async function startStub(handler: StubHandler): Promise<Stub> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await listenStub(handler, 50_000 + Math.floor(Math.random() * 10_000))
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`the synthetic stub could not bind a usable port: ${messageOf(lastError)}`)
}

async function listenStub(handler: StubHandler, port: number): Promise<Stub> {
  const requests: StubRequest[] = []
  let current = handler
  const server = createServer((req, res) => {
    void (async () => {
      const request = await readRequest(req)
      requests.push(request)
      // 5ms 的「长轮询」延迟：桩不该被通道打成忙循环。
      await delay(5)
      const reply = await current(request)
      const body = reply.body ?? (reply.json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reply.json), 'utf8'))
      res.writeHead(reply.status ?? 200, {
        'content-type': reply.json === undefined ? 'application/octet-stream' : 'application/json',
        ...(reply.headers ?? {}),
      })
      res.end(body)
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: messageOf(error) }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { resolve() })
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (next) => { current = next },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    }),
  }
}

function defaultReply(request: StubRequest): StubReply {
  switch (request.path) {
    case '/ilink/bot/getupdates':
      return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
    case '/ilink/bot/sendmessage':
      return { json: { ret: 0, message_id: 'synthetic-server-message' } }
    case '/ilink/bot/getconfig':
      return { json: { ret: 0 } }
    case '/ilink/bot/sendtyping':
      return { json: { ret: 0 } }
    default:
      return { status: 404, json: { error: `unknown path ${request.path}` } }
  }
}

function requestsOf(stub: Stub, path: string): StubRequest[] {
  return stub.requests.filter((request) => request.path === path)
}

function jsonOf(request: StubRequest | undefined): Record<string, unknown> {
  if (request === undefined) throw new Error('expected a request, got none')
  if (request.json === undefined) throw new Error(`${request.path} carried no JSON body`)
  return request.json
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

function messageOfSend(request: StubRequest): Record<string, unknown> {
  return recordOf(jsonOf(request)['msg'], `${request.path}.msg`)
}

function itemsOfSend(request: StubRequest): Array<Record<string, unknown>> {
  const items = messageOfSend(request)['item_list']
  if (!Array.isArray(items)) throw new Error('sendmessage item_list is not an array')
  return items.map((item, index) => recordOf(item, `item_list[${index}]`))
}

function mediaOfItem(item: Record<string, unknown>, key: string): Record<string, unknown> {
  return recordOf(recordOf(item[key], key)['media'], `${key}.media`)
}

function imageBytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

async function waitFor(condition: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(5)
  }
}

function fixedClock(at: number): WeixinClock {
  return {
    now: () => at,
    sleep: (ms, signal) => WEIXIN_REAL_CLOCK.sleep(ms, signal),
  }
}

function privateTarget(): ImTarget {
  return { channel: 'weixin', accountId: ACCOUNT_ID, scope: 'private', peerId: PEER_ID }
}

interface Harness {
  channel: WeixinChannel
  readonly delivered: ImInbound[]
  /** 每次 `router.handle` 给的惰性媒体物化器（与 delivered 逐条对齐）。 */
  readonly loads: Array<() => Promise<readonly ImMediaRef[]>>
  readonly signal: AbortSignal
  stop(): Promise<void>
}

interface HarnessOptions {
  stub: Stub
  clock: WeixinClock
  typingEnabled?: boolean
  media?: ImMediaStore
}

function channelHarness(options: HarnessOptions): Harness {
  const delivered: ImInbound[] = []
  const loads: Array<() => Promise<readonly ImMediaRef[]>> = []
  const controller = new AbortController()
  const channel = new WeixinChannel({
    accountId: ACCOUNT_ID,
    token: TOKEN,
    baseUrl: options.stub.baseUrl,
    cdnBaseUrl: `${options.stub.baseUrl}/cdn`,
    router: {
      handle: async (inbound, handleOptions) => {
        delivered.push(inbound)
        if (handleOptions?.loadMedia !== undefined) loads.push(handleOptions.loadMedia)
      },
    },
    loadCursor: async () => undefined,
    saveCursor: async () => {},
    loadContextTokens: async () => ({}),
    saveContextTokens: async () => {},
    clock: options.clock,
    longPollTimeoutMs: 50,
    typingEnabled: options.typingEnabled ?? false,
    ...(options.media === undefined ? {} : { media: options.media }),
  })
  return {
    channel,
    delivered,
    loads,
    signal: controller.signal,
    stop: async () => {
      controller.abort()
      await channel.stop()
    },
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weixin-media-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function testMediaStore(): ImMediaStore {
  return openImMediaStore({
    workspaceRoot: async () => root,
    now: () => NOW,
    maxBytes: WEIXIN_MEDIA_MAX_BYTES,
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- 密钥解码 ----

describe('weixin aes keys', () => {
  it('decodes base64 of 16 raw bytes, base64 of a hex string, and an image hex key', () => {
    expect(parseAesKey(KEY.toString('base64'), 'media.aes_key')).toEqual(KEY)
    const hexAsBase64 = Buffer.from(KEY_HEX, 'utf8').toString('base64')
    expect(parseAesKey(hexAsBase64, 'media.aes_key')).toEqual(KEY)
    expect(parseImageAesKey(KEY_HEX)).toEqual(KEY)
    expect(parseImageAesKey(` ${KEY_HEX.toUpperCase()} `)).toEqual(KEY)
  })

  it('rejects keys that decode to neither 16 bytes nor a 32-character hex string', () => {
    expect(() => parseAesKey('not a key', 'media.aes_key')).toThrowError(/media\.aes_key/)
    expect(() => parseAesKey('', 'media.aes_key')).toThrowError(/empty AES key/)
    // 32 字节但不是 hex：说明形状变了，不能猜。
    const notHex = Buffer.alloc(32, 0x7a).toString('base64')
    expect(() => parseAesKey(notHex, 'media.aes_key')).toThrowError(/32-character hex key/)
    expect(() => parseImageAesKey('abcd')).toThrowError(/32 hex characters/)
    expect(() => parseImageAesKey('z'.repeat(32))).toThrowError(/32 hex characters/)
  })
})

// ---- AES-128-ECB ----

describe('weixin aes ecb', () => {
  it('pads to the next block and round-trips through encrypt/decrypt', () => {
    expect(aesEcbPaddedSize(0)).toBe(16)
    expect(aesEcbPaddedSize(1)).toBe(16)
    expect(aesEcbPaddedSize(16)).toBe(32)
    expect(aesEcbPaddedSize(1_000)).toBe(1_008)

    const ciphertext = encryptAesEcb(PLAINTEXT, KEY)
    expect(ciphertext.byteLength).toBe(aesEcbPaddedSize(PLAINTEXT.byteLength))
    expect(decryptAesEcb(ciphertext, KEY)).toEqual(PLAINTEXT)
    // PKCS#7：尾部是补齐字节，不是明文。
    expect(ciphertext.equals(PLAINTEXT)).toBe(false)
  })

  it('refuses ciphertext that is not a whole number of blocks', () => {
    expect(() => decryptAesEcb(Buffer.alloc(15), KEY)).toThrowError(/multiple of 16/)
  })
})

// ---- CDN 地址 ----

describe('weixin cdn urls', () => {
  it('encodes the opaque params and keeps the cdn base path', () => {
    expect(cdnDownloadUrl('https://cdn.example/c2c/', 'a+b/c=')).toBe(
      'https://cdn.example/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D',
    )
    expect(cdnUploadUrl('https://cdn.example/c2c', 'p&=', 'fk-1')).toBe(
      'https://cdn.example/c2c/upload?encrypted_query_param=p%26%3D&filekey=fk-1',
    )
  })
})

// ---- 下载 + 解密 ----

describe('weixin media download', () => {
  it('prefers full_url over the constructed download url and decrypts the payload', async () => {
    const ciphertext = encryptAesEcb(PLAINTEXT, KEY)
    const stub = await startStub((request) => {
      if (request.path === '/full/image.bin') return { body: ciphertext }
      if (request.path === '/cdn/download') return { body: imageBytes('the constructed url must not be used') }
      return defaultReply(request)
    })
    try {
      const bytes = await downloadAndDecrypt(
        { cdnBaseUrl: `${stub.baseUrl}/cdn`, timeoutMs: 2_000 },
        {
          fullUrl: `${stub.baseUrl}/full/image.bin`,
          encryptQueryParam: 'ignored-param',
          aesKey: KEY,
          maxBytes: WEIXIN_MEDIA_MAX_BYTES,
          label: 'test image',
        },
      )
      expect(bytes).toEqual(PLAINTEXT)
      expect(requestsOf(stub, '/full/image.bin')).toHaveLength(1)
      expect(requestsOf(stub, '/cdn/download')).toHaveLength(0)
    } finally {
      await stub.close()
    }
  })

  it('uses encrypt_query_param when full_url is absent and leaves plaintext untouched', async () => {
    const stub = await startStub((request) => {
      if (request.path === '/cdn/download') {
        expect(request.query.get('encrypted_query_param')).toBe('opaque+/=')
        return { body: imageBytes('plain bytes') }
      }
      return defaultReply(request)
    })
    try {
      const bytes = await downloadAndDecrypt(
        { cdnBaseUrl: `${stub.baseUrl}/cdn`, timeoutMs: 2_000 },
        { encryptQueryParam: 'opaque+/=', maxBytes: WEIXIN_MEDIA_MAX_BYTES, label: 'test image' },
      )
      expect(bytes).toEqual(imageBytes('plain bytes'))
    } finally {
      await stub.close()
    }
  })
})

// ---- 上传 + 出站 ----

describe('weixin media upload', () => {
  it('uploads an image to upload_full_url and sends image_item referencing the upload', async () => {
    const plaintext = imageBytes('image bytes')
    const localPath = join(root, 'cat.png')
    await writeFile(localPath, plaintext)
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getuploadurl') {
        return { json: { upload_full_url: `${stub.baseUrl}/cdn/custom-upload` } }
      }
      if (request.path === '/cdn/custom-upload') {
        return { status: 200, headers: { 'x-encrypted-param': 'enc-param-1' } }
      }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      const part: OutboundMediaPart = { kind: 'image', localPath, caption: '看图', index: 0, total: 1 }
      const receipt = await harness.channel.send(privateTarget(), [part])
      expect(receipt).toEqual({ parts: 1, at: NOW, messageId: 'synthetic-server-message' })

      const uploadRequest = requestsOf(stub, '/ilink/bot/getuploadurl')[0]
      const upload = jsonOf(uploadRequest)
      expect(upload).toMatchObject({
        media_type: 1,
        to_user_id: PEER_ID,
        rawsize: plaintext.byteLength,
        rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
        filesize: aesEcbPaddedSize(plaintext.byteLength),
        no_need_thumb: true,
      })
      const aeskeyHex = upload['aeskey']
      expect(typeof aeskeyHex).toBe('string')
      expect(aeskeyHex).toMatch(/^[0-9a-f]{32}$/)
      const filekey = upload['filekey']
      expect(typeof filekey).toBe('string')

      const cdnRequest = requestsOf(stub, '/cdn/custom-upload')[0]
      expect(cdnRequest?.headers['content-type']).toBe('application/octet-stream')
      expect(cdnRequest?.body.byteLength).toBe(aesEcbPaddedSize(plaintext.byteLength))
      expect(decryptAesEcb(cdnRequest?.body ?? Buffer.alloc(0), Buffer.from(String(aeskeyHex), 'hex'))).toEqual(plaintext)

      const sends = requestsOf(stub, '/ilink/bot/sendmessage')
      expect(sends).toHaveLength(2)
      // 说明文字单独一条、先到；媒体项在它之后。
      expect(itemsOfSend(sends[0] as StubRequest)).toEqual([{ type: 1, text_item: { text: '看图' } }])
      const items = itemsOfSend(sends[1] as StubRequest)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ type: 2 })
      const image = recordOf(items[0]?.['image_item'], 'image_item')
      expect(image['mid_size']).toBe(aesEcbPaddedSize(plaintext.byteLength))
      const media = recordOf(image['media'], 'image_item.media')
      expect(media['encrypt_query_param']).toBe('enc-param-1')
      expect(media['encrypt_type']).toBe(1)
      // aes_key 是 hex 字符串的 base64，不是密钥本身的 base64。
      const keyText = Buffer.from(String(media['aes_key']), 'base64').toString('utf8')
      expect(keyText).toBe(aeskeyHex)
      expect(Buffer.from(keyText, 'hex')).toHaveLength(16)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('builds the upload url from upload_param, sends the caption first, then the file item', async () => {
    const plaintext = Buffer.from('file bytes for weixin', 'utf8')
    const localPath = join(root, 'notes.txt')
    await writeFile(localPath, plaintext)
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getuploadurl') return { json: { ret: 0, upload_param: 'param+/=' } }
      if (request.path === '/cdn/upload') {
        return { status: 200, headers: { 'x-encrypted-param': 'enc-param-2' } }
      }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      const part: OutboundMediaPart = {
        kind: 'file',
        localPath,
        name: 'notes.txt',
        caption: '这是说明文字',
        index: 0,
        total: 1,
      }
      await harness.channel.send(privateTarget(), [part])

      const upload = jsonOf(requestsOf(stub, '/ilink/bot/getuploadurl')[0])
      expect(upload).toMatchObject({ media_type: 3, to_user_id: PEER_ID, rawsize: plaintext.byteLength })
      const cdnRequests = requestsOf(stub, '/cdn/upload')
      expect(cdnRequests).toHaveLength(1)
      expect(cdnRequests[0]?.query.get('encrypted_query_param')).toBe('param+/=')
      expect(cdnRequests[0]?.query.get('filekey')).toBe(upload['filekey'])
      expect(
        decryptAesEcb(cdnRequests[0]?.body ?? Buffer.alloc(0), Buffer.from(String(upload['aeskey']), 'hex')),
      ).toEqual(plaintext)

      const sends = requestsOf(stub, '/ilink/bot/sendmessage')
      expect(sends).toHaveLength(2)
      expect(itemsOfSend(sends[0] as StubRequest)).toEqual([{ type: 1, text_item: { text: '这是说明文字' } }])
      const items = itemsOfSend(sends[1] as StubRequest)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ type: 4 })
      const file = recordOf(items[0]?.['file_item'], 'file_item')
      expect(file).toMatchObject({ file_name: 'notes.txt', len: String(plaintext.byteLength) })
      expect(mediaOfItem(items[0] as Record<string, unknown>, 'file_item')['encrypt_query_param']).toBe('enc-param-2')
      // 说明文字必须在媒体之前到达：顺序就是用户看到的顺序。
      expect(stub.requests.indexOf(sends[0] as StubRequest)).toBeLessThan(stub.requests.indexOf(sends[1] as StubRequest))
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('fails when the CDN answers 200 without x-encrypted-param and retries three times', async () => {
    const localPath = join(root, 'cat.png')
    await writeFile(localPath, imageBytes('image bytes'))
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getuploadurl') {
        return { json: { upload_full_url: `${stub.baseUrl}/cdn/upload` } }
      }
      if (request.path === '/cdn/upload') return { status: 200 }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await expect(
        harness.channel.send(privateTarget(), [{ kind: 'image', localPath, index: 0, total: 1 }]),
      ).rejects.toMatchObject({
        code: 'WEIXIN_SEND_FAILED',
        message: expect.stringContaining('x-encrypted-param'),
      })
      expect(requestsOf(stub, '/cdn/upload')).toHaveLength(3)
      expect(requestsOf(stub, '/ilink/bot/sendmessage')).toHaveLength(0)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('aborts the upload immediately on a 4xx without retrying', async () => {
    const localPath = join(root, 'cat.png')
    await writeFile(localPath, imageBytes('image bytes'))
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getuploadurl') {
        return { json: { upload_full_url: `${stub.baseUrl}/cdn/upload` } }
      }
      if (request.path === '/cdn/upload') return { status: 404, body: imageBytes('no such upload') }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await expect(
        harness.channel.send(privateTarget(), [{ kind: 'image', localPath, index: 0, total: 1 }]),
      ).rejects.toMatchObject({ code: 'WEIXIN_SEND_FAILED' })
      expect(requestsOf(stub, '/cdn/upload')).toHaveLength(1)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('rejects a url-only media part and an outbound voice part', async () => {
    const stub = await startStub(defaultReply)
    const harness = channelHarness({ stub, clock: fixedClock(NOW) })
    try {
      await harness.channel.start(harness.signal)
      await expect(
        harness.channel.send(privateTarget(), [
          { kind: 'image', url: 'https://example.invalid/cat.png', index: 0, total: 1 },
        ]),
      ).rejects.toMatchObject({ code: 'WEIXIN_BAD_TARGET', message: expect.stringContaining('localPath') })
      await expect(
        harness.channel.send(privateTarget(), [
          { kind: 'voice', localPath: join(root, 'voice.silk'), index: 0, total: 1 },
        ]),
      ).rejects.toMatchObject({ code: 'WEIXIN_BAD_TARGET', message: expect.stringContaining('voice') })
      // 出站同样守 20MB：先 stat 再读，绝不为一条消息把任意大文件读进内存。
      const huge = join(root, 'huge.png')
      await writeFile(huge, Buffer.alloc(WEIXIN_MEDIA_MAX_BYTES + 1))
      await expect(
        harness.channel.send(privateTarget(), [{ kind: 'image', localPath: huge, index: 0, total: 1 }]),
      ).rejects.toMatchObject({ code: 'WEIXIN_SEND_FAILED', message: expect.stringContaining('cap is') })
      expect(requestsOf(stub, '/ilink/bot/sendmessage')).toHaveLength(0)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 入站附件落盘 ----

describe('weixin inbound media', () => {
  it('downloads, decrypts and saves an inbound image before the inbound is routed', async () => {
    const ciphertext = encryptAesEcb(PLAINTEXT, KEY)
    const fullUrl = (stub: Stub) => `${stub.baseUrl}/cdn/download?encrypted_query_param=opaque`
    let served = false
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getupdates') {
        if (served) return { json: { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 1_000 } }
        served = true
        return {
          json: {
            ret: 0,
            get_updates_buf: 'cursor-media',
            msgs: [{
              message_id: 7001,
              from_user_id: PEER_ID,
              message_type: 1,
              context_token: 'ctx-7001',
              item_list: [{
                type: 2,
                image_item: {
                  aeskey: KEY_HEX,
                  mid_size: ciphertext.byteLength,
                  media: { full_url: fullUrl(stub) },
                },
              }],
            }],
          },
        }
      }
      if (request.path === '/cdn/download') return { body: ciphertext }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW), media: testMediaStore() })
    try {
      await harness.channel.start(harness.signal)
      await waitFor(() => harness.delivered.length === 1, 'the inbound image', 5_000)
      // 媒体在路由通过访问控制后才物化：调用通道给的 loadMedia 取回带 localPath 的 ref。
      expect(harness.delivered[0]?.media).toEqual([{ kind: 'image' }])
      const refs = await harness.loads[0]!()
      expect(refs).toHaveLength(1)
      const ref = refs[0]
      expect(ref).toMatchObject({ kind: 'image', url: fullUrl(stub) })
      expect(ref?.localPath).toBeDefined()
      const localPath = ref?.localPath ?? ''
      expect(localPath.startsWith(join(root, 'im-media', `weixin-${ACCOUNT_ID}`))).toBe(true)
      expect(await readFile(localPath)).toEqual(PLAINTEXT)
      expect(requestsOf(stub, '/cdn/download')).toHaveLength(1)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- typing ticket 缓存 ----

describe('weixin typing cache', () => {
  it('asks getconfig once for two setTyping calls and reuses the ticket', async () => {
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getconfig') return { json: { ret: 0, typing_ticket: 'ticket-1' } }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW), typingEnabled: true })
    try {
      await harness.channel.start(harness.signal)
      await harness.channel.setTyping(PEER_ID, 1)
      await harness.channel.setTyping(PEER_ID, 1)

      expect(requestsOf(stub, '/ilink/bot/getconfig')).toHaveLength(1)
      const typings = requestsOf(stub, '/ilink/bot/sendtyping')
      expect(typings).toHaveLength(2)
      for (const request of typings) {
        expect(jsonOf(request)).toMatchObject({ typing_ticket: 'ticket-1', status: 1 })
      }
    } finally {
      await harness.stop()
      await stub.close()
    }
  })

  it('evicts a failed ticket and retries once with a fresh getconfig', async () => {
    let configCalls = 0
    let typingCalls = 0
    const stub = await startStub((request) => {
      if (request.path === '/ilink/bot/getconfig') {
        configCalls += 1
        return { json: { ret: 0, typing_ticket: `ticket-${configCalls}` } }
      }
      if (request.path === '/ilink/bot/sendtyping') {
        typingCalls += 1
        if (typingCalls === 1) return { status: 500, body: Buffer.from('synthetic typing failure') }
        return { json: { ret: 0 } }
      }
      return defaultReply(request)
    })
    const harness = channelHarness({ stub, clock: fixedClock(NOW), typingEnabled: true })
    try {
      await harness.channel.start(harness.signal)
      await harness.channel.setTyping(PEER_ID, 1)

      expect(configCalls).toBe(2)
      expect(typingCalls).toBe(2)
      const typings = requestsOf(stub, '/ilink/bot/sendtyping')
      expect(jsonOf(typings[0])).toMatchObject({ typing_ticket: 'ticket-1' })
      // 第二次一定在重新 getconfig 之后，用的是新 ticket。
      expect(jsonOf(typings[1])).toMatchObject({ typing_ticket: 'ticket-2' })
      const firstConfig = stub.requests.indexOf(requestsOf(stub, '/ilink/bot/getconfig')[0] as StubRequest)
      const secondConfig = stub.requests.indexOf(requestsOf(stub, '/ilink/bot/getconfig')[1] as StubRequest)
      const secondTyping = stub.requests.indexOf(typings[1] as StubRequest)
      expect(secondConfig).toBeLessThan(secondTyping)
      expect(firstConfig).toBeLessThan(secondConfig)
    } finally {
      await harness.stop()
      await stub.close()
    }
  })
})

// ---- 落盘策略 ----

describe('im media store', () => {
  it('rejects extensions outside the allowlist and path separators in the account id', async () => {
    const store = testMediaStore()
    await expect(
      store.save({ channel: 'weixin', accountId: ACCOUNT_ID, bytes: PLAINTEXT, extension: 'exe' }),
    ).rejects.toMatchObject({ code: 'IM_MEDIA_BAD_EXTENSION' })
    await expect(
      store.save({ channel: 'weixin', accountId: '../escape', bytes: PLAINTEXT, extension: 'png' }),
    ).rejects.toMatchObject({ code: 'IM_MEDIA_BAD_OWNER' })
  })

  it('removes one account directory on unbind and reports whether it existed', async () => {
    const store = testMediaStore()
    const saved = await store.save({ channel: 'weixin', accountId: ACCOUNT_ID, bytes: PLAINTEXT, extension: 'png' })
    expect(await store.remove('weixin', ACCOUNT_ID)).toBe(true)
    await expect(readFile(saved)).rejects.toMatchObject({ code: 'ENOENT' })
    // 幂等：目录已经不在时如实回 false。
    expect(await store.remove('weixin', ACCOUNT_ID)).toBe(false)
  })
})
