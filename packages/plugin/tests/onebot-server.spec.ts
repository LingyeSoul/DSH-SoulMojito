import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ImInbound, ImTarget } from '../src/im/types.js'
import { createOneBotUpgradeHandler, OneBotChannel, type OneBotRouterSink } from '../src/im/onebot/server.js'

const WS_PATH = '/api/dsh-soulmojito/im/onebot/ws'
const WEBHOOK_PATH = '/api/dsh-soulmojito/im/onebot/webhook'
const ACCOUNT_ID = 'qq-main'
const TOKEN = 'test-token-123'
const SELF_ID = '10001'

const PRIVATE_TARGET: ImTarget = { channel: 'onebot', accountId: ACCOUNT_ID, scope: 'private', peerId: '10031' }

interface Harness {
  channel: OneBotChannel
  inbound: ImInbound[]
  port: number
  sockets: Socket[]
  connect(headers: Record<string, string>): Promise<WebSocket>
  openRaw(): Promise<{ socket: Socket; head: Buffer }>
  dispose(): Promise<void>
}

async function startHarness(options: {
  groupRequireMention?: boolean
  router?: OneBotRouterSink
  mentionGate?: () => Promise<boolean>
}): Promise<Harness> {
  const inbound: ImInbound[] = []
  const channel = new OneBotChannel({
    accountId: ACCOUNT_ID,
    secret: { token: TOKEN },
    router: options.router ?? { handle: async (message) => { inbound.push(message) } },
    // 缺省视为开启 @ 门控；显式传 false 的用例才关闭。
    groupRequireMention: options.mentionGate ?? (async () => options.groupRequireMention !== false),
    now: () => Date.now(),
  })
  await channel.start(new AbortController().signal)

  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && pathname === WEBHOOK_PATH) {
      void channel.handleWebhook(req, res)
      return
    }
    res.statusCode = 404
    res.end()
  })
  const upgrade = createOneBotUpgradeHandler({ channels: () => [channel] })
  server.on('upgrade', (req, socket, head) => { upgrade(req, socket as Duplex, head) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a bound IP address')
  const port = address.port
  const sockets: Socket[] = []

  return {
    channel,
    inbound,
    port,
    sockets,
    connect: async (headers) => opened(new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { 'X-Self-ID': SELF_ID, 'X-Client-Role': 'Universal', ...headers },
    })),
    openRaw: async () => {
      const opened = await rawUpgrade(port)
      sockets.push(opened.socket)
      return opened
    },
    dispose: async () => {
      await channel.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

function opened(ws: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('websocket did not open within 3000ms')) }, 3_000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket handshake failed'))
    }
  })
}

function rawUpgrade(port: number): Promise<{ socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: WS_PATH,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'X-Self-ID': SELF_ID,
        'X-Client-Role': 'Universal',
        Authorization: `Bearer ${TOKEN}`,
      },
    })
    req.on('upgrade', (_res, socket, head) => resolve({ socket, head }))
    req.on('response', (res) => reject(new Error(`expected a websocket upgrade, got HTTP ${res.statusCode ?? 0}`)))
    req.on('error', reject)
    req.end()
  })
}

function httpUpgrade(port: number, token: string): Promise<{ statusCode: number; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: WS_PATH,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'X-Self-ID': SELF_ID,
        'X-Client-Role': 'Universal',
        Authorization: `Bearer ${token}`,
      },
    })
    req.on('upgrade', () => reject(new Error('an unauthorized upgrade must not be accepted')))
    req.on('response', (res) => {
      res.resume()
      resolve({ statusCode: res.statusCode ?? 0, connection: res.headers.connection })
    })
    req.on('error', reject)
    req.end()
  })
}

function postWebhook(port: number, headers: Record<string, string>, body: unknown): Promise<{ statusCode: number; body: string }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: WEBHOOK_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function privateEvent(messageId: number, text: string): Record<string, unknown> {
  return {
    time: 1_730_000_000,
    self_id: Number(SELF_ID),
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageId,
    user_id: 10_031,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: 10_031, nickname: 'Alice' },
  }
}

function groupEvent(messageId: number, segments: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    time: 1_730_000_000,
    self_id: Number(SELF_ID),
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: 20_032,
    user_id: 10_032,
    message: segments,
    sender: { user_id: 10_032, nickname: 'Bob', card: '小B' },
  }
}

function maskedFrame(opcode: number, fin: boolean, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const header: Buffer = payload.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
    : Buffer.from([
      (fin ? 0x80 : 0) | opcode,
      0x80 | 126,
      payload.length >> 8,
      payload.length & 0xff,
    ])
  const masked = Buffer.allocUnsafe(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index & 3]!
  }
  return Buffer.concat([header, mask, masked])
}

function parseServerFrames(buffer: Buffer): Array<{ opcode: number; payload: Buffer }> {
  const frames: Array<{ opcode: number; payload: Buffer }> = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!
    const second = buffer[offset + 1]!
    let length = second & 0x7f
    let header = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      header = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(offset + 2))
      header = 10
    }
    if (offset + header + length > buffer.length) break
    frames.push({ opcode: first & 0x0f, payload: buffer.subarray(offset + header, offset + header + length) })
    offset += header + length
  }
  return frames
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await delay(10)
  }
}

interface Gate {
  wait: Promise<void>
  open(): void
}

function createGate(): Gate {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

/** 等一拍事件循环，让已排队的微任务（入站链推进）先跑完。 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

interface GatedRouter {
  router: OneBotRouterSink
  /** 已进入 router.handle 的消息文本，按进入顺序。 */
  started: string[]
  /** 每次 handle 的放行闸门，按进入顺序。 */
  gates: Gate[]
  /** 同时在 router.handle 内的最大条数。 */
  peakConcurrency(): number
}

/** 受闸门控制的 router：handle 进入后记录并卡住，直到测试放行，并发计数器能直接看见交错。 */
function gatedRouter(): GatedRouter {
  const started: string[] = []
  const gates: Gate[] = []
  let active = 0
  let peak = 0
  return {
    router: {
      handle: async (message) => {
        active += 1
        peak = Math.max(peak, active)
        started.push(message.text)
        const gate = createGate()
        gates.push(gate)
        await gate.wait
        active -= 1
      },
    },
    started,
    gates,
    peakConcurrency: () => peak,
  }
}

/** 可控的 @ 门控：每次调用发一个闸门，测试据此确认请求已到达入队前一步。 */
function gatedMentionGate(): { mentionGate: () => Promise<boolean>; gates: Gate[] } {
  const gates: Gate[] = []
  return {
    gates,
    mentionGate: () => {
      const gate = createGate()
      gates.push(gate)
      return gate.wait.then(() => true)
    },
  }
}

function mentionedGroupEvent(messageId: number, text: string): Record<string, unknown> {
  return groupEvent(messageId, [
    { type: 'at', data: { qq: SELF_ID } },
    { type: 'text', data: { text: ` ${text}` } },
  ])
}

let harness: Harness | undefined

beforeEach(() => { harness = undefined })

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('onebot reverse websocket handshake', () => {
  it('accepts a Universal handshake and reports the channel online', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await waitFor(() => harness?.channel.status().state === 'online', 3_000)
    expect(harness.channel.status()).toMatchObject({ state: 'online' })
    ws.close()
  })

  it('rejects a wrong token with 401 before the websocket upgrade', async () => {
    harness = await startHarness({})
    const result = await httpUpgrade(harness.port, 'wrong-token')
    expect(result.statusCode).toBe(401)
    expect(harness.channel.status().state).toBe('idle')
  })

  it('rejects a handshake that omits X-Self-ID', async () => {
    harness = await startHarness({})
    const result = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: harness!.port,
        path: WS_PATH,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'X-Client-Role': 'Universal',
          Authorization: `Bearer ${TOKEN}`,
        },
      })
      req.on('upgrade', () => reject(new Error('a handshake without X-Self-ID must not be accepted')))
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(result).toBe(401)
  })

  it('rejects an unsupported websocket version with 400 and records the error', async () => {
    harness = await startHarness({})
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: harness!.port,
        path: WS_PATH,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '8',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'X-Self-ID': SELF_ID,
          'X-Client-Role': 'Universal',
          Authorization: `Bearer ${TOKEN}`,
        },
      })
      req.on('upgrade', () => reject(new Error('version 8 must not be upgraded')))
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
    expect(harness.channel.status()).toMatchObject({ state: 'error' })
  })
})

describe('onebot inbound over websocket', () => {
  it('delivers a private message with a stable dedupe key', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    ws.send(JSON.stringify(privateEvent(4_001, '在吗')))
    await waitFor(() => harness!.inbound.length === 1, 3_000)
    expect(harness.inbound[0]).toMatchObject({
      channel: 'onebot',
      accountId: ACCOUNT_ID,
      scope: 'private',
      peerId: '10031',
      senderId: '10031',
      senderName: 'Alice',
      text: '在吗',
      dedupeKey: `onebot:${ACCOUNT_ID}:private:10031:4001`,
    })
    expect(typeof harness.inbound[0]?.receivedAt).toBe('number')
    ws.close()
  })

  it('drops an unmentioned group message and delivers a mentioned one', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    ws.send(JSON.stringify(groupEvent(4_101, [{ type: 'text', data: { text: '大家好' } }])))
    ws.send(JSON.stringify(groupEvent(4_102, [
      { type: 'at', data: { qq: SELF_ID } },
      { type: 'text', data: { text: ' 在吗' } },
    ])))
    await waitFor(() => harness!.inbound.length === 1, 3_000)
    await delay(100)
    expect(harness.inbound).toHaveLength(1)
    expect(harness.inbound[0]).toMatchObject({
      scope: 'group',
      peerId: '20032',
      senderId: '10032',
      senderName: '小B',
      dedupeKey: `onebot:${ACCOUNT_ID}:group:20032:4102`,
    })
    ws.close()
  })

  it('delivers an unmentioned group message when the mention gate is off', async () => {
    harness = await startHarness({ groupRequireMention: false })
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    ws.send(JSON.stringify(groupEvent(4_201, [{ type: 'text', data: { text: '不 @ 也能进' } }])))
    await waitFor(() => harness!.inbound.length === 1, 3_000)
    expect(harness.inbound[0]?.text).toBe('不 @ 也能进')
    ws.close()
  })

  it('reassembles a fragmented text message and answers ping with pong', async () => {
    harness = await startHarness({})
    const { socket, head } = await harness.openRaw()
    const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    const event = Buffer.from(JSON.stringify(privateEvent(6_001, '你好')), 'utf8')
    // 在字节中间切一刀：分片按字节累积，解码只在整条消息完成时做一次。
    const splitAt = event.length - 3
    socket.write(maskedFrame(0x1, false, event.subarray(0, splitAt)))
    socket.write(maskedFrame(0x9, true, Buffer.from('p')))
    socket.write(maskedFrame(0x0, true, event.subarray(splitAt)))
    await waitFor(() => harness!.inbound.length === 1, 3_000)
    expect(harness.inbound[0]?.text).toBe('你好')
    await delay(100)
    const frames = parseServerFrames(Buffer.concat(chunks))
    expect(frames.some((frame) => frame.opcode === 0xa && frame.payload.toString('utf8') === 'p')).toBe(true)
  })

  it('closes with 1003 when the upstream sends a binary frame', async () => {
    harness = await startHarness({})
    const { socket, head } = await harness.openRaw()
    const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.write(maskedFrame(0x2, true, Buffer.from([1, 2, 3])))
    await waitFor(() => parseServerFrames(Buffer.concat(chunks)).some((frame) => frame.opcode === 0x8), 3_000)
    const close = parseServerFrames(Buffer.concat(chunks)).find((frame) => frame.opcode === 0x8)
    expect(close?.payload.readUInt16BE(0)).toBe(1003)
    expect(harness.inbound).toHaveLength(0)
  })

  it('closes with 1009 when a frame declares more than 1 MiB', async () => {
    harness = await startHarness({})
    const { socket, head } = await harness.openRaw()
    const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    // FIN + text + masked + 64 位长度 0x200000：头部就足够判定超限，不需要真发 2 MiB。
    socket.write(Buffer.from([0x81, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00]))
    await waitFor(() => parseServerFrames(Buffer.concat(chunks)).some((frame) => frame.opcode === 0x8), 3_000)
    const close = parseServerFrames(Buffer.concat(chunks)).find((frame) => frame.opcode === 0x8)
    expect(close?.payload.readUInt16BE(0)).toBe(1009)
    expect(harness.inbound).toHaveLength(0)
  })
  it('closes with 1002 when a client frame is not masked', async () => {
    harness = await startHarness({})
    const { socket, head } = await harness.openRaw()
    const chunks: Buffer[] = [head]
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    // RFC 6455 §5.1：客户端帧必须掩码。未掩码帧如果被接受，等于允许任意进程
    // 伪造上游流量（审查变异 C 指出这条原本没有回归保护）。
    const payload = Buffer.from('{"post_type":"meta_event"}', 'utf8')
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    await waitFor(() => parseServerFrames(Buffer.concat(chunks)).some((frame) => frame.opcode === 0x8), 3_000)
    const close = parseServerFrames(Buffer.concat(chunks)).find((frame) => frame.opcode === 0x8)
    expect(close?.payload.readUInt16BE(0)).toBe(1002)
    expect(harness.inbound).toHaveLength(0)
  })
})

describe('onebot outbound over websocket', () => {
  it('serialises concurrent sends so parts never interleave', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    const texts: string[] = []
    ws.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as Record<string, unknown>
      const params = payload['params'] as { message?: Array<{ data?: { text?: string } }> } | undefined
      const text = params?.message?.[0]?.data?.text
      if (typeof text === 'string') texts.push(text)
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: payload['echo'] }))
    }
    await waitFor(() => harness!.channel.status().state === 'online', 3_000)
    const parts = (prefix: string) => [0, 1, 2].map((index) => ({ kind: 'text' as const, text: `${prefix}${index}`, index, total: 3 }))
    // 两轮回复并发：分片必须整轮发完再发下一轮，否则用户看到 A0,B0,A1,B1…
    await Promise.all([
      harness.channel.send(PRIVATE_TARGET, parts('A')),
      harness.channel.send(PRIVATE_TARGET, parts('B')),
    ])
    expect(texts).toEqual(['A0', 'A1', 'A2', 'B0', 'B1', 'B2'])
    ws.close()
  })

  it('reports paused, not online, when only an Event client is attached', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}`, 'X-Client-Role': 'Event' })
    await waitFor(() => harness!.channel.status().state === 'paused', 3_000)
    const status = harness.channel.status()
    expect(status.state).toBe('paused')
    expect(status.state === 'paused' ? status.reason : '').toContain('outbound')
    await expect(harness.channel.send(PRIVATE_TARGET, [{ kind: 'text', text: 'hi', index: 0, total: 1 }]))
      .rejects.toThrow(/no onebot connection/)
    ws.close()
  })

  it('sends send_private_msg, matches the echo, and surfaces a failed status', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    const calls: Array<Record<string, unknown>> = []
    let failNext = false
    ws.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as Record<string, unknown>
      calls.push(payload)
      ws.send(JSON.stringify(failNext
        ? { status: 'failed', retcode: 1200, echo: payload.echo }
        : { status: 'ok', retcode: 0, data: { message_id: 9_001 }, echo: payload.echo }))
      failNext = false
    }
    await waitFor(() => harness!.channel.status().state === 'online', 3_000)

    const receipt = await harness.channel.send(PRIVATE_TARGET, [{ kind: 'text', text: '你好', index: 0, total: 1 }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      action: 'send_private_msg',
      params: {
        user_id: 10_031,
        message: [{ type: 'text', data: { text: '你好' } }],
        auto_escape: false,
      },
    })
    expect(typeof calls[0]?.echo).toBe('string')
    expect(receipt).toMatchObject({ parts: 1, messageId: '9001' })

    failNext = true
    await expect(harness.channel.send(PRIVATE_TARGET, [{ kind: 'text', text: '再试', index: 0, total: 1 }]))
      .rejects.toThrow(/status='failed'.*retcode=1200/)
    ws.close()
  })

  it('throws no onebot connection after the upstream closes the socket', async () => {
    harness = await startHarness({})
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })
    await waitFor(() => harness!.channel.status().state === 'online', 3_000)
    ws.close()
    await waitFor(() => harness!.channel.status().state !== 'online', 3_000)
    await expect(harness.channel.send(PRIVATE_TARGET, [{ kind: 'text', text: 'hi', index: 0, total: 1 }]))
      .rejects.toThrow(/no onebot connection/)
  })
})

describe('onebot http post webhook', () => {
  it('accepts a bearer-token event, the X-OneBot-Token header, and rejects a bad token', async () => {
    harness = await startHarness({})
    const bearer = await postWebhook(harness.port, { Authorization: `Bearer ${TOKEN}` }, privateEvent(5_001, '来自 webhook'))
    expect(bearer.statusCode).toBe(200)
    expect(bearer.body).toBe('{}')
    await waitFor(() => harness!.inbound.length === 1, 3_000)
    expect(harness.inbound[0]?.text).toBe('来自 webhook')

    const header = await postWebhook(harness.port, { 'X-OneBot-Token': TOKEN }, privateEvent(5_002, '头部 token'))
    expect(header.statusCode).toBe(200)
    await waitFor(() => harness!.inbound.length === 2, 3_000)

    const bad = await postWebhook(harness.port, { Authorization: 'Bearer nope' }, privateEvent(5_003, '坏人'))
    expect(bad.statusCode).toBe(401)
    await delay(100)
    expect(harness.inbound).toHaveLength(2)
  })

  it('rejects a query-string token: credentials must ride a header', async () => {
    harness = await startHarness({})
    const result = await new Promise<number>((resolve, reject) => {
      const payload = JSON.stringify(privateEvent(5_101, 'query token'))
      const req = request({
        host: '127.0.0.1',
        port: harness!.port,
        path: `${WEBHOOK_PATH}?access_token=${encodeURIComponent(TOKEN)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(payload)
    })
    // 查询串会进访问日志，且 URLSearchParams 会把 token 里的 `+` 吃成空格；
    // 只认 Authorization / X-OneBot-Token 两条头（审查 P2-1）。
    expect(result).toBe(401)
    expect(harness.inbound).toHaveLength(0)
  })
})

describe('onebot inbound serialisation', () => {
  it('never overlaps two concurrent webhook posts and keeps request order', async () => {
    const gated = gatedRouter()
    const mention = gatedMentionGate()
    harness = await startHarness({ router: gated.router, mentionGate: mention.mentionGate })
    const headers = { Authorization: `Bearer ${TOKEN}` }

    const first = postWebhook(harness.port, headers, mentionedGroupEvent(7_001, '第一条'))
    await waitFor(() => mention.gates.length === 1, 3_000)
    mention.gates[0]!.open()
    await waitFor(() => gated.started.length === 1, 3_000)

    const second = postWebhook(harness.port, headers, mentionedGroupEvent(7_002, '第二条'))
    await waitFor(() => mention.gates.length === 2, 3_000)
    mention.gates[1]!.open()
    await nextTurn()
    // 第一条还卡在 router.handle 里：第二条必须仍在账号链上排队，而不是并发进入。
    expect(gated.started).toEqual([`@${SELF_ID} 第一条`])

    gated.gates[0]!.open()
    await waitFor(() => gated.started.length === 2, 3_000)
    expect(gated.started).toEqual([`@${SELF_ID} 第一条`, `@${SELF_ID} 第二条`])
    gated.gates[1]!.open()

    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(gated.peakConcurrency()).toBe(1)
  })

  it('never overlaps a websocket event with a webhook event', async () => {
    const gated = gatedRouter()
    const mention = gatedMentionGate()
    harness = await startHarness({ router: gated.router, mentionGate: mention.mentionGate })
    const ws = await harness.connect({ Authorization: `Bearer ${TOKEN}` })

    ws.send(JSON.stringify(privateEvent(7_101, '来自 WS')))
    await waitFor(() => gated.started.length === 1, 3_000)

    const webhook = postWebhook(harness.port, { Authorization: `Bearer ${TOKEN}` }, mentionedGroupEvent(7_102, '来自 webhook'))
    await waitFor(() => mention.gates.length === 1, 3_000)
    mention.gates[0]!.open()
    await nextTurn()
    // WS 事件还没放行，webhook 事件必须等在链尾。
    expect(gated.started).toEqual(['来自 WS'])

    gated.gates[0]!.open()
    await waitFor(() => gated.started.length === 2, 3_000)
    expect(gated.started).toEqual(['来自 WS', `@${SELF_ID} 来自 webhook`])
    gated.gates[1]!.open()
    const response = await webhook
    expect(response.statusCode).toBe(200)
    expect(gated.peakConcurrency()).toBe(1)
    ws.close()
  })

  it('keeps the chain alive after a rejected inbound task', async () => {
    const delivered: ImInbound[] = []
    harness = await startHarness({
      router: {
        handle: async (message) => {
          if (message.text === '会失败') throw new Error('router rejected this inbound')
          delivered.push(message)
        },
      },
    })

    const failed = await postWebhook(harness.port, { Authorization: `Bearer ${TOKEN}` }, privateEvent(7_201, '会失败'))
    expect(failed.statusCode).toBe(500)
    expect(failed.body).toContain('onebot inbound handling failed')

    const ok = await postWebhook(harness.port, { Authorization: `Bearer ${TOKEN}` }, privateEvent(7_202, '恢复'))
    expect(ok.statusCode).toBe(200)
    expect(delivered.map((message) => message.text)).toEqual(['恢复'])
  })
})
