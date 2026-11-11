import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openImMediaStore } from '../src/im/media-store.js'
import { OneBotChannel } from '../src/im/onebot/server.js'
import type { ImInbound, ImMediaRef } from '../src/im/types.js'

/**
 * OneBot images used to reach the model as `图片（未下载）` because the channel
 * never handed the router a `loadMedia`. These assertions pin the fixed seam:
 * the router gets a loader, an http(s) image is downloaded into the media store,
 * and anything that cannot be fetched stays a plain reference instead of failing
 * the inbound message.
 */

const WEBHOOK_PATH = '/api/dsh-soulmojito/im/onebot/webhook'
const TOKEN = 'test-onebot-token'
const ACCOUNT_ID = 'qq-main'
/** PNG signature plus a chunk header: enough bytes to prove the body round-trips. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

interface Delivered {
  inbound: ImInbound
  loadMedia?: () => Promise<readonly ImMediaRef[]>
}

interface Harness {
  mediaUrl: string
  delivered: Delivered[]
  mediaRequests: () => number
  post(body: unknown): Promise<number>
  dispose(): Promise<void>
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'onebot-inbound-media-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function listen(server: Server): Promise<number> {
  const listening = Promise.withResolvers<number>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      listening.reject(new Error('the stub server did not bind a TCP port'))
      return
    }
    listening.resolve(address.port)
  })
  return listening.promise
}

async function close(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>()
  server.close(() => closed.resolve())
  server.closeAllConnections()
  await closed.promise
}

function postWebhook(port: number, body: unknown): Promise<number> {
  const answered = Promise.withResolvers<number>()
  const payload = JSON.stringify(body)
  const req = request({
    host: '127.0.0.1',
    port,
    path: WEBHOOK_PATH,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      authorization: `Bearer ${TOKEN}`,
    },
  }, (res) => {
    res.resume()
    res.on('end', () => answered.resolve(res.statusCode ?? 0))
  })
  req.on('error', answered.reject)
  req.end(payload)
  return answered.promise
}

async function startHarness(): Promise<Harness> {
  const delivered: Delivered[] = []
  let mediaRequests = 0
  const mediaServer: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    mediaRequests += 1
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('content-length', String(PNG_BYTES.byteLength))
    res.end(PNG_BYTES)
  })
  const mediaPort = await listen(mediaServer)
  const mediaUrl = `http://127.0.0.1:${mediaPort}/cat.png`

  const channel = new OneBotChannel({
    accountId: ACCOUNT_ID,
    secret: { token: TOKEN },
    router: {
      handle: async (inbound, options) => {
        delivered.push({ inbound, ...(options?.loadMedia === undefined ? {} : { loadMedia: options.loadMedia }) })
      },
    },
    media: openImMediaStore({
      workspaceRoot: async () => root,
      now: () => Date.now(),
      maxBytes: 1024 * 1024,
    }),
    groupRequireMention: async () => false,
    now: () => Date.now(),
  })
  await channel.start(new AbortController().signal)

  const appServer: Server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && pathname === WEBHOOK_PATH) {
      void channel.handleWebhook(req, res)
      return
    }
    res.statusCode = 404
    res.end()
  })
  const appPort = await listen(appServer)

  return {
    mediaUrl,
    delivered,
    mediaRequests: () => mediaRequests,
    post: (body) => postWebhook(appPort, body),
    dispose: async () => {
      await channel.stop()
      await close(appServer)
      await close(mediaServer)
    },
  }
}

function messageEvent(messageId: number, segments: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    time: 1_730_000_000,
    self_id: 10_001,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 10_031,
    message: segments,
    sender: { user_id: 10_031, nickname: 'Alice' },
  }
}

describe('OneBot inbound image download', () => {
  it('downloads an http image into the media store and exposes the local path', async () => {
    const harness = await startHarness()
    try {
      const status = await harness.post(messageEvent(1, [
        { type: 'image', data: { file: 'cat.png', url: harness.mediaUrl } },
      ]))
      expect(status).toBe(200)
      expect(harness.delivered).toHaveLength(1)
      const loader = harness.delivered[0]!.loadMedia
      expect(loader).toBeDefined()
      const refs = await loader!()
      expect(refs).toHaveLength(1)
      expect(refs[0]!.kind).toBe('image')
      expect(refs[0]!.url).toBe(harness.mediaUrl)
      const localPath = refs[0]!.localPath
      expect(localPath).toBeDefined()
      expect(localPath!.startsWith(root)).toBe(true)
      expect((await readFile(localPath!)).equals(PNG_BYTES)).toBe(true)
      expect(harness.mediaRequests()).toBe(1)
    } finally {
      await harness.dispose()
    }
  })

  it('keeps an unfetchable reference intact instead of failing the message', async () => {
    const harness = await startHarness()
    try {
      const status = await harness.post(messageEvent(2, [
        { type: 'image', data: { file: 'cat.png', url: 'base64://iVBORw0KGgo=' } },
        { type: 'record', data: { file: 'voice.amr', url: harness.mediaUrl } },
      ]))
      expect(status).toBe(200)
      const refs = await harness.delivered[0]!.loadMedia!()
      expect(refs.map((ref) => ref.kind)).toEqual(['image', 'voice'])
      // base64:// is not a fetchable address, and non-image kinds have no reader in this build.
      expect(refs.every((ref) => ref.localPath === undefined)).toBe(true)
      expect(harness.mediaRequests()).toBe(0)
    } finally {
      await harness.dispose()
    }
  })
})
