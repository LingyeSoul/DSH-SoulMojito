// OneBot 11 消息编解码（proposal 0024）。
//
// 只做纯转换：事件 JSON -> ImInbound、CQ 码与消息段互转、出站 API 参数。
// 事件来自网络，字段类型一律运行时校验；自称消息事件却结构坏掉的输入抛
// OneBotCodecError，而不是悄悄返回 undefined。
// 账号身份只认调用方给的 accountId（反向 WS 的 X-Self-ID 由调用方验签），
// 绝不被事件里的 self_id 覆盖：同一个机器人可以挂多个账号。
//
// 协议参考：OneBot 11 event/message、message/segment、message/string、api/public。

import { imDedupeKey, type ImInbound, type ImMediaRef, type ImTarget, type OutboundPart } from '../types.js'

/** 收侧消息段；未识别的类型统一落到 unknown，正文里直接丢弃。 */
export type OneBotSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'image'; data: { file?: string; url?: string; summary?: string } }
  | { type: 'record'; data: { file?: string; url?: string } }
  | { type: 'video'; data: { file?: string; url?: string } }
  | { type: 'file'; data: { file?: string; name?: string; size?: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'face'; data: { id: string } }
  | { type: 'unknown'; data: Record<string, unknown> }

/** code 区分坏事件、坏出站目标、坏消息段，调用方据此决定重试还是丢弃。 */
export class OneBotCodecError extends Error {
  readonly code: 'BAD_EVENT' | 'BAD_TARGET' | 'BAD_SEGMENT'

  constructor(code: 'BAD_EVENT' | 'BAD_TARGET' | 'BAD_SEGMENT', message: string) {
    super(message)
    this.name = 'OneBotCodecError'
    this.code = code
  }
}

/** 一次 OneBot API 调用（反向 WS 发响应体，HTTP 发 POST body）。 */
export interface OneBotCall {
  action: 'send_private_msg' | 'send_group_msg'
  params: Record<string, unknown>
}

type JsonObject = Record<string, unknown>

/** 带媒体的消息段；只有这四种要额外产出 ImMediaRef。 */
type OneBotMediaSegment = Extract<OneBotSegment, { type: 'image' | 'record' | 'video' | 'file' }>

// 文本占位：路由器只消费文本，媒体本体走 media 字段，正文里留个可读标记。
const SEGMENT_LABEL = {
  face: '[表情]',
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
} as const

// 只认标准里的四个实体；&amp; 是浏览器写法，OneBot 用 &#38;，多解会把原文改坏。
const CQ_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&#38;',
  '[': '&#91;',
  ']': '&#93;',
  ',': '&#44;',
}

const CQ_UNESCAPES: Readonly<Record<string, string>> = {
  '38': '&',
  '91': '[',
  '93': ']',
  '44': ',',
}

/** 把一条 OneBot 事件归一成 ImInbound；非消息事件返回 undefined。 */
export function parseOneBotMessage(
  event: unknown,
  accountId: string,
  receivedAt: number,
): ImInbound | undefined {
  if (!isJsonObject(event)) {
    throw new OneBotCodecError('BAD_EVENT', `onebot event must be a JSON object, got ${describeValue(event)}`)
  }
  // meta_event/notice/request 由别的处理器消费，这里必须放行而不是报错
  if (event.post_type !== 'message') return undefined
  const messageType = event.message_type
  if (messageType !== 'private' && messageType !== 'group') return undefined
  // 群里的 sub_type=notice 是系统提示（如「管理员已禁止群内匿名聊天」），不是人说的话
  if (messageType === 'group' && event.sub_type === 'notice') return undefined

  const messageId = requireInteger(event, 'message_id')
  const userId = requireInteger(event, 'user_id')
  const peerId = messageType === 'group' ? String(requireInteger(event, 'group_id')) : String(userId)

  const sender = isJsonObject(event.sender) ? event.sender : {}
  const segments = readSegments(event.message)

  let text = ''
  let replyTo: string | undefined
  const media: ImMediaRef[] = []
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        // 原样拼接：空格、换行都是发送方意图，不做合并
        text += segment.data.text
        break
      case 'at':
        text += segment.data.qq === 'all' ? '@全体成员' : `@${segment.data.qq}`
        break
      case 'face':
        text += SEGMENT_LABEL.face
        break
      case 'image':
      case 'record':
      case 'video':
      case 'file':
        text += SEGMENT_LABEL[segment.type]
        media.push(toMediaRef(segment))
        break
      case 'reply':
        // 只取第一个引用锚点；重复的 reply 段不覆盖已定下的回复目标
        if (replyTo === undefined && segment.data.id !== '') replyTo = segment.data.id
        break
      case 'unknown':
        break
    }
  }
  // 纯空白和纯未知段一样等于没说话；空转一次会话没有意义
  if (text.trim() === '' && media.length === 0) return undefined

  const platformAt = platformAtOf(event.time)
  return {
    channel: 'onebot',
    accountId,
    scope: messageType,
    peerId,
    senderId: String(userId),
    senderName: senderNameFor(messageType, sender, userId),
    text,
    media,
    ...(replyTo === undefined ? {} : { replyTo }),
    dedupeKey: imDedupeKey('onebot', accountId, messageType, peerId, String(messageId)),
    receivedAt,
    ...(platformAt === undefined ? {} : { platformAt }),
  }
}

/** 群消息是否 @ 了机器人；非群消息一律 false，坏消息段也当作没提到。 */
export function oneBotMentioned(event: unknown, selfId: string): boolean {
  if (selfId === '' || !isJsonObject(event)) return false
  if (event.post_type !== 'message' || event.message_type !== 'group') return false
  let segments: OneBotSegment[]
  try {
    segments = readSegments(event.message)
  } catch (error) {
    // 这个谓词只决定投递与否；真正的诊断由 parseOneBotMessage 抛出，不在此吞掉
    if (error instanceof OneBotCodecError) return false
    throw error
  }
  return segments.some((segment) => segment.type === 'at' && segment.data.qq === selfId)
}

/** 一段文本的出站调用；私聊走 send_private_msg，群聊走 send_group_msg。 */
export function oneBotSendCall(target: ImTarget, part: OutboundPart): OneBotCall {
  const peerId = parsePeerId(target.peerId)
  if (part.kind !== 'text') {
    throw new OneBotCodecError('BAD_TARGET', `onebot cannot send a ${part.kind} part: media parts are not implemented in this build`)
  }
  const message = [{ type: 'text', data: { text: part.text } }]
  if (target.scope === 'private') {
    return { action: 'send_private_msg', params: { user_id: peerId, message, auto_escape: false } }
  }
  return { action: 'send_group_msg', params: { group_id: peerId, message, auto_escape: false } }
}

/** CQ 码转义：一次扫描完成，避免先换 & 再把新生成的实体二次转义。 */
export function cqEscape(text: string): string {
  return text.replace(/[&[\],]/g, (char) => CQ_ESCAPES[char] ?? char)
}

/** CQ 码反转义：只还原这四个实体，未知实体（含 &amp;）原样保留。 */
export function cqUnescape(text: string): string {
  // 实体形如 &#91;（带井号），漏掉 # 会让所有反转义静默失效
  return text.replace(/&#(38|91|93|44);/g, (entity, code: string) => CQ_UNESCAPES[code] ?? entity)
}

/** 解析字符串格式的 message；未闭合的 [CQ: 当作普通文本。 */
export function parseCqString(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const start = raw.indexOf('[CQ:', cursor)
    if (start < 0) {
      appendText(segments, raw.slice(cursor))
      break
    }
    if (start > cursor) appendText(segments, raw.slice(cursor, start))
    const end = raw.indexOf(']', start)
    if (end < 0) {
      appendText(segments, raw.slice(start))
      break
    }
    segments.push(parseCqCode(raw.slice(start + 4, end)))
    cursor = end + 1
  }
  return segments
}

/** 解析 `type,key=value,...`；type 小写化，未知类型保留原始参数。 */
function parseCqCode(body: string): OneBotSegment {
  const parts = body.split(',')
  const type = (parts[0] ?? '').toLowerCase()
  const fields: Record<string, string> = {}
  for (const part of parts.slice(1)) {
    if (part === '') continue
    const assignAt = part.indexOf('=')
    const key = assignAt < 0 ? part : part.slice(0, assignAt)
    if (key === '') continue
    // 参数值里的逗号、方括号、& 都是转义过的，按实体还原后再存
    fields[key] = cqUnescape(assignAt < 0 ? '' : part.slice(assignAt + 1))
  }
  return knownSegment(type, fields) ?? { type: 'unknown', data: fields }
}

/** 数组格式的 message 字段：字符串按 CQ 码解，数组逐段校验。 */
function readSegments(message: unknown): OneBotSegment[] {
  if (message === undefined || message === null) return []
  if (typeof message === 'string') return parseCqString(message)
  if (Array.isArray(message)) return message.map((entry, index) => segmentFromArray(entry, index))
  throw new OneBotCodecError(
    'BAD_SEGMENT',
    `onebot 'message' must be a CQ string or a segment array, got ${describeValue(message)}`,
  )
}

function segmentFromArray(entry: unknown, index: number): OneBotSegment {
  if (!isJsonObject(entry)) {
    throw new OneBotCodecError(
      'BAD_SEGMENT',
      `onebot message[${index}] must be a segment object, got ${describeValue(entry)}`,
    )
  }
  const type = entry.type
  if (typeof type !== 'string' || type === '') {
    throw new OneBotCodecError(
      'BAD_SEGMENT',
      `onebot message[${index}].type must be a non-empty string, got ${describeValue(type)}`,
    )
  }
  const data = entry.data
  // 标准允许 data 为 null（如 rps/dice），此时等价于空参数
  if (data !== undefined && data !== null && !isJsonObject(data)) {
    throw new OneBotCodecError(
      'BAD_SEGMENT',
      `onebot message[${index}].data must be an object or null, got ${describeValue(data)}`,
    )
  }
  const fields = data === undefined || data === null ? {} : data
  // 数组格式的未知段保留原始值，调用方还能看到平台扩展字段
  return knownSegment(type, stringFields(fields)) ?? { type: 'unknown', data: { ...fields } }
}

/** 已知类型按参数建成有类型的段；未知类型返回 undefined 交给调用方兜底。 */
function knownSegment(type: string, fields: Record<string, string>): OneBotSegment | undefined {
  switch (type) {
    case 'text':
      return { type: 'text', data: { text: fields.text ?? '' } }
    case 'at':
      return { type: 'at', data: { qq: fields.qq ?? '' } }
    case 'image':
      return { type: 'image', data: presentFields(fields, ['file', 'url', 'summary'] as const) }
    case 'record':
      return { type: 'record', data: presentFields(fields, ['file', 'url'] as const) }
    case 'video':
      return { type: 'video', data: presentFields(fields, ['file', 'url'] as const) }
    case 'file':
      return { type: 'file', data: presentFields(fields, ['file', 'name', 'size'] as const) }
    case 'reply':
      return { type: 'reply', data: { id: fields.id ?? '' } }
    case 'face':
      return { type: 'face', data: { id: fields.id ?? '' } }
    default:
      return undefined
  }
}

/** 只挑出存在的键，缺省字段不写成 undefined，便于深比较和日志。 */
function presentFields<K extends string>(
  fields: Record<string, string>,
  names: readonly K[],
): { [P in K]?: string } {
  const picked: { [P in K]?: string } = {}
  for (const name of names) {
    const value = fields[name]
    if (value !== undefined && value !== '') picked[name] = value
  }
  return picked
}

/** 数组格式的 data 可能混入数字（QQ 号、size），统一收敛成字符串。 */
function stringFields(data: JsonObject): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    const text = optionalString(value)
    if (text !== undefined) fields[key] = text
  }
  return fields
}

function toMediaRef(segment: OneBotMediaSegment): ImMediaRef {
  switch (segment.type) {
    case 'image':
      return buildMediaRef('image', { url: segment.data.url, name: segment.data.file })
    case 'record':
      return buildMediaRef('voice', { url: segment.data.url, name: segment.data.file })
    case 'video':
      return buildMediaRef('video', { url: segment.data.url, name: segment.data.file })
    case 'file':
      // file 段的 name 是展示名，file 是取件标识，展示名优先
      return buildMediaRef('file', {
        name: segment.data.name ?? segment.data.file,
        size: segment.data.size,
      })
  }
}

interface MediaRefFields {
  url?: string
  name?: string
  size?: string
}

function buildMediaRef(kind: ImMediaRef['kind'], fields: MediaRefFields): ImMediaRef {
  const ref: ImMediaRef = { kind }
  // url 只取协议给的 url 字段：file 常是本地缓存名，不能当远程地址抓
  const url = nonEmptyString(fields.url)
  if (url !== undefined) ref.url = url
  const name = nonEmptyString(fields.name)
  if (name !== undefined) ref.name = name
  const size = nonEmptyString(fields.size)
  if (size !== undefined) {
    const bytes = Number(size)
    if (Number.isFinite(bytes)) ref.size = bytes
  }
  return ref
}

function senderNameFor(scope: 'private' | 'group', sender: JsonObject, userId: number): string {
  if (scope === 'group') {
    // 群名片是群里认人的第一标识，其次昵称，最后兜底成群成员编号
    return nonEmptyString(sender.card) ?? nonEmptyString(sender.nickname) ?? `群成员(${userId})`
  }
  return nonEmptyString(sender.nickname) ?? `(${userId})`
}

/** 事件字段必须是整数；标准把 id 声明为 number，字符串形式直接判坏。 */
function requireInteger(event: JsonObject, field: string): number {
  const value = event[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OneBotCodecError(
      'BAD_EVENT',
      `onebot event field '${field}' must be an integer, got ${describeValue(value)}`,
    )
  }
  return value
}

/**
 * OneBot 事件的 `time` 是 UNIX 秒；与 QQ 侧同一口径归一成毫秒：数值
 * `n > 0 && n < 1e11` 视为秒并乘 1000，否则按已是毫秒原样用。缺失、非有限或
 * <= 0 时省略。`platformAt` 只用于同一 peer 批次内的排序，不参与去重键。
 */
function platformAtOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  if (value < 1e11) return Math.round(value * 1000)
  return value
}

/** QQ 号是十进制正整数；'12abc' 会被 Number 截成 12，必须先验形状。 */
function parsePeerId(peerId: string): number {
  if (!/^\d+$/.test(peerId)) {
    throw new OneBotCodecError('BAD_TARGET', `onebot peerId '${peerId}' is not a decimal id`)
  }
  const value = Number(peerId)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OneBotCodecError('BAD_TARGET', `onebot peerId '${peerId}' is not a positive safe integer`)
  }
  return value
}

function appendText(segments: OneBotSegment[], raw: string): void {
  if (raw === '') return
  const text = cqUnescape(raw)
  // 未闭合 CQ 码会把一段话拆成两次 append，合并成一段更接近原文
  const last = segments[segments.length - 1]
  if (last !== undefined && last.type === 'text') {
    segments[segments.length - 1] = { type: 'text', data: { text: last.data.text + text } }
    return
  }
  segments.push({ type: 'text', data: { text } })
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  const text = optionalString(value)
  return text === undefined || text.trim() === '' ? undefined : text
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 错误信息里只放类型和短值，避免把整段事件 JSON 写进日志。 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return `string '${value.length > 32 ? `${value.slice(0, 32)}...` : value}'`
  if (typeof value === 'number' || typeof value === 'boolean') return `${typeof value} ${String(value)}`
  if (Array.isArray(value)) return `array of ${value.length}`
  return typeof value
}
