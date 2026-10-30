/**
 * 最小 RFC 6455 服务端（提案 0024 §2.3）：只够 OneBot 反向 WS 用。
 *
 * 只做服务端、只做文本消息：握手校验、掩码帧解析、分片累积、ping/pong、close。
 * 不做扩展（RSV 必须为 0）、不做子协议协商、不主动发 ping——OneBot 上游自己带
 * 心跳事件，服务端再开一个定时器只会制造两套存活判断。
 *
 * 错误边界：协议违规一律用 close 帧带码断开（1002 协议错误、1003 二进制、
 * 1007 UTF-8 损坏、1009 超限），不把坏帧当普通消息交给上层。单帧与单条分片
 * 消息都限制在 1 MiB；超限说明对端在发别的东西，继续读只会吃内存。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** 一条已握手的服务端连接；同一 socket 的写入由实现自己串行化。 */
export interface WsConnection {
  readonly id: string
  send(text: string): void
  close(code?: number, reason?: string): void
  onText(listener: (text: string) => void): void
  onClose(listener: () => void): void
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE_BYTES = 1024 * 1024
const CONTROL_PAYLOAD_LIMIT = 125
const CLOSE_NORMAL = 1000
/** 服务端主动关闭统一用 1001；客户端仍会收到 close 帧而不是被直接掐线。 */
const CLOSE_GOING_AWAY = 1001
const CLOSE_PROTOCOL_ERROR = 1002
const CLOSE_UNSUPPORTED_DATA = 1003
const CLOSE_INVALID_PAYLOAD = 1007
const CLOSE_TOO_BIG = 1009
const CLOSE_INTERNAL_ERROR = 1011
/** close 帧发完后给对端回 FIN 的窗口；到点直接销毁，避免半开连接长期占用。 */
const CLOSE_LINGER_MS = 1_000

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** 协议层错误；调用方据此发对应 close code 而不是继续解析。 */
class WsProtocolError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'WsProtocolError'
    this.code = code
  }
}

interface ParsedFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/**
 * 完成握手并接管 socket。握手失败时先写 HTTP 错误响应再抛错：调用方只需要
 * 记录原因，不需要再拼一次响应。
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection {
  const key = requireHandshakeKey(req, socket)
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'))
  return openConnection(socket, head)
}

function openConnection(socket: Duplex, head: Buffer): WsConnection {
  const id = randomUUID()
  const textListeners: Array<(text: string) => void> = []
  const closeListeners: Array<() => void> = []
  /** 监听器注册前的文本先排队：upgrade 的 `head` 可能已经含完整帧。 */
  const queuedTexts: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })

  let closed = false
  let input: Buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentedBytes = 0
  let fragmented = false
  let writeTail: Promise<void> = Promise.resolve()

  function finish(): void {
    if (closed) return
    closed = true
    queuedTexts.length = 0
    fragments = []
    fragmented = false
    for (const listener of closeListeners) {
      try {
        listener()
      } catch {
        // socket 已经不可用，关闭回调里的异常没有上报通道；不让它变成未捕获异常。
      }
    }
    closeListeners.length = 0
  }

  function fail(code: number, reason: string): void {
    shutdown(code, reason)
  }

  function shutdown(code: number, reason: string): void {
    if (closed) return
    finish()
    const frame = encodeCloseFrame(code, reason)
    writeTail = writeTail
      .then(() => writeFrame(frame))
      .then(() => {
        socket.end()
        const linger = setTimeout(() => { socket.destroy() }, CLOSE_LINGER_MS)
        linger.unref?.()
      })
      .catch(() => { socket.destroy() })
  }

  function writeFrame(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (socket.destroyed || socket.writableEnded) {
        reject(new Error('websocket socket is closed'))
        return
      }
      socket.write(frame, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  function enqueueWrite(frame: Buffer): void {
    // 同一 socket 上的并发写会交错成半帧；串成一条链，失败就关连接。
    writeTail = writeTail
      .then(() => writeFrame(frame))
      .catch(() => {
        socket.destroy()
        finish()
      })
  }

  function send(text: string): void {
    if (closed) throw new Error(`websocket connection '${id}' is closed`)
    enqueueWrite(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')))
  }

  function close(code?: number, reason?: string): void {
    shutdown(normalizeCloseCode(code), reason ?? '')
  }

  function onText(listener: (text: string) => void): void {
    textListeners.push(listener)
    if (queuedTexts.length === 0) return
    const pending = queuedTexts.splice(0)
    for (const text of pending) listener(text)
  }

  function onClose(listener: () => void): void {
    if (closed) {
      listener()
      return
    }
    closeListeners.push(listener)
  }

  function emitText(text: string): void {
    if (textListeners.length === 0) {
      queuedTexts.push(text)
      return
    }
    for (const listener of textListeners) {
      try {
        listener(text)
      } catch {
        // 上层 listener 抛错说明状态已坏；断开比带着坏状态继续收消息安全。
        fail(CLOSE_INTERNAL_ERROR, 'text listener failed')
        return
      }
    }
  }

  function handleDataFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === OPCODE_BINARY) {
      throw new WsProtocolError(CLOSE_UNSUPPORTED_DATA, 'binary messages are not supported')
    }
    if (opcode === OPCODE_CONTINUATION) {
      if (!fragmented) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'continuation frame without a preceding data frame')
      fragmentedBytes += payload.length
      if (fragmentedBytes > MAX_MESSAGE_BYTES) {
        throw new WsProtocolError(CLOSE_TOO_BIG, `fragmented message exceeds ${MAX_MESSAGE_BYTES} bytes`)
      }
      fragments.push(payload)
      if (!fin) return
      const message = Buffer.concat(fragments, fragmentedBytes)
      fragments = []
      fragmentedBytes = 0
      fragmented = false
      emitText(decodeText(message))
      return
    }
    // OPCODE_TEXT
    if (fragmented) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'new data frame while a fragmented message is open')
    if (fin) {
      emitText(decodeText(payload))
      return
    }
    fragmented = true
    fragmentedBytes = payload.length
    fragments = [payload]
  }

  function handleClose(payload: Buffer): void {
    if (payload.length === 1) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'close frame payload of 1 byte is invalid')
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL
    if (!isValidReceivedCloseCode(code)) {
      throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, `close frame carries reserved code ${code}`)
    }
    shutdown(code, '')
  }

  function handleFrame(frame: ParsedFrame): void {
    if (frame.opcode >= OPCODE_CLOSE) {
      if (frame.opcode === OPCODE_CLOSE) {
        handleClose(frame.payload)
        return
      }
      if (frame.opcode === OPCODE_PING) {
        enqueueWrite(encodeFrame(OPCODE_PONG, frame.payload))
        return
      }
      if (frame.opcode === OPCODE_PONG) return
      throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, `unknown control opcode ${frame.opcode}`)
    }
    if (frame.opcode !== OPCODE_TEXT && frame.opcode !== OPCODE_BINARY && frame.opcode !== OPCODE_CONTINUATION) {
      throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, `unknown data opcode ${frame.opcode}`)
    }
    handleDataFrame(frame.opcode, frame.fin, frame.payload)
  }

  function decodeText(bytes: Buffer): string {
    try {
      return decoder.decode(bytes)
    } catch {
      throw new WsProtocolError(CLOSE_INVALID_PAYLOAD, 'text frame is not valid UTF-8')
    }
  }

  function takeFrame(): ParsedFrame | undefined {
    if (input.length < 2) return undefined
    const first = input[0]!
    const second = input[1]!
    if ((first & 0x70) !== 0) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'reserved bits are set without a negotiated extension')
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (input.length < 4) return undefined
      length = input.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (input.length < 10) return undefined
      const wide = input.readBigUInt64BE(2)
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        throw new WsProtocolError(CLOSE_TOO_BIG, `frame exceeds ${MAX_MESSAGE_BYTES} bytes`)
      }
      length = Number(wide)
      offset = 10
    }
    if (length > MAX_MESSAGE_BYTES) {
      throw new WsProtocolError(CLOSE_TOO_BIG, `frame exceeds ${MAX_MESSAGE_BYTES} bytes`)
    }
    const isControl = (opcode & 0x08) !== 0
    if (isControl) {
      if (!fin) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'control frames must not be fragmented')
      if (length > CONTROL_PAYLOAD_LIMIT) {
        throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'control frame payload exceeds 125 bytes')
      }
    }
    if (!masked) throw new WsProtocolError(CLOSE_PROTOCOL_ERROR, 'client frames must be masked')
    if (input.length < offset + 4 + length) return undefined
    const mask = input.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = input[offset + index]! ^ mask[index & 3]!
    }
    input = input.subarray(offset + length)
    return { fin, opcode, payload }
  }

  function onData(chunk: Buffer): void {
    if (closed) return
    input = input.length === 0 ? chunk : Buffer.concat([input, chunk])
    try {
      while (!closed) {
        const frame = takeFrame()
        if (frame === undefined) return
        handleFrame(frame)
      }
    } catch (error) {
      if (error instanceof WsProtocolError) {
        fail(error.code, error.message)
        return
      }
      // 非协议错误也要带出原始信息：只回一句「handling failed」等于把根因吞掉。
      fail(CLOSE_INTERNAL_ERROR, `websocket frame handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  socket.on('data', onData)
  socket.on('error', finish)
  socket.on('close', finish)
  socket.on('end', finish)

  const connection: WsConnection = { id, send, close, onText, onClose }
  // head 在监听器注册之后才喂：握手包里可能已经带了第一帧。
  if (head.length > 0) onData(head)
  return connection
}

function requireHandshakeKey(req: IncomingMessage, socket: Duplex): string {
  if (req.method !== 'GET') rejectHandshake(socket, 'the upgrade request must be GET')
  const upgrade = headerOf(req, 'upgrade')
  if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') {
    rejectHandshake(socket, "missing 'Upgrade: websocket'")
  }
  if (!connectionHeaderHasUpgrade(headerOf(req, 'connection'))) {
    rejectHandshake(socket, "missing 'Connection: Upgrade'")
  }
  if (headerOf(req, 'sec-websocket-version') !== '13') {
    rejectHandshake(socket, 'only Sec-WebSocket-Version 13 is supported')
  }
  const key = headerOf(req, 'sec-websocket-key')
  if (key === undefined || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    rejectHandshake(socket, 'Sec-WebSocket-Key must be the base64 of 16 random bytes')
  }
  return key
}

function rejectHandshake(socket: Duplex, reason: string): never {
  const body = `${reason}\n`
  if (!socket.destroyed && socket.writable) {
    socket.end([
      'HTTP/1.1 400 Bad Request',
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'))
  }
  throw new Error(`websocket handshake rejected: ${reason}`)
}

function connectionHeaderHasUpgrade(value: string | undefined): boolean {
  if (value === undefined) return false
  return value.split(',').some((token) => token.trim().toLowerCase() === 'upgrade')
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  // 服务端帧一律不掩码；FIN 恒为 1（我们只发单帧文本/控制帧）。
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

function encodeCloseFrame(code: number, reason: string): Buffer {
  const reasonBytes = truncateUtf8(Buffer.from(reason, 'utf8'), CONTROL_PAYLOAD_LIMIT - 2)
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  return encodeFrame(OPCODE_CLOSE, payload)
}

/** 截断点必须是 UTF-8 字符边界：切开多字节字符会让对端认为 close 原因非法。 */
function truncateUtf8(bytes: Buffer, max: number): Buffer {
  if (bytes.length <= max) return bytes
  let end = max
  while (end > 0) {
    const boundary = bytes[end]
    if (boundary === undefined || (boundary & 0xc0) !== 0x80) break
    end -= 1
  }
  return bytes.subarray(0, end)
}

/** 对外 close 只接受标准常态码与 3000-4999；非法码降级成 1000，不把错误码发给对端。 */
function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined) return CLOSE_NORMAL
  if (code === CLOSE_NORMAL || code === CLOSE_GOING_AWAY || code === CLOSE_INTERNAL_ERROR) return code
  if (code >= 3000 && code <= 4999) return code
  return CLOSE_NORMAL
}

function isValidReceivedCloseCode(code: number): boolean {
  if (code === CLOSE_NORMAL || code === CLOSE_GOING_AWAY) return true
  if (code >= 1002 && code <= 1011 && code !== 1004 && code !== 1005 && code !== 1006) return true
  return code >= 3000 && code <= 4999
}
