/**
 * IM 对话在 Tavern 聊天里的投影解析（决策 2026-10-31-im-chat-projection）。
 *
 * 纯函数模块：只做 relay 正文/工具调用的解析、身份键与楼层 extra 的拼装，不碰
 * 会话事件日志、不做 IO。投影器（`projector.ts`）在 `sessionEvents()` 之上按序
 * 调用这些函数，把 IM 入站（`agent/inbox/spliced` 的 relay 插入、以及宿主物化
 * 出的 `user/message`）和成功出站（`im_send` 的 tool result）投影成普通楼层。
 *
 * 这里没有任何写宿主事件的能力：投影是只读折叠，宿主日志永远保持原样。
 */

import { isHostPluginMessageSource, type HostSessionLog } from '../../../bind/src/index.js'
import { RegexPlacement, type ChatMessage, type RegexScriptIR } from '../../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../../tavern-script/src/index.js'
import { isBodyMergedAssistant } from './body-projector.js'
import { isTavernSessionMarker } from './body-session.js'
import { imPeerAlias, imPeerKeyParts } from '../im/types.js'

/** 出站媒体种类（与 `im_send` 的 `mediaKind` 参数同集）。 */
export type ImMediaKind = 'image' | 'voice' | 'video' | 'file'

/** 楼层方向：入站消息或出站回复。 */
export type ImDirection = 'in' | 'out'

/** IM 楼层的产生路径。 */
export type ImVia = 'im-relay' | 'im-send'

/** 解析后的 relay 正文。 */
export interface ImRelayParse {
  /** 落库正文：单条为去头去尾的正文，合流为逐行正文（保留群昵称前缀）。 */
  text: string
  /** 消息头里的 peer alias；解析失败时尽力从摘要/唯绑定推断，仍未知则为空串。 */
  peerAlias: string
  /** 消息头里的 `msg=` 引用（`imMessageRef` 的产物）；合流头不带引用。 */
  ref?: string
  /** 头部/尾部不符合 `router.ts` 的格式：此时 `text` 是完整原文。 */
  fallback: boolean
}

/** 一条 `im_send` 工具调用的可投影部分。 */
export interface ImSendCall {
  callId: string
  text: string
  peerAlias: string
  mediaKind?: ImMediaKind
}

/** `tool/result` 的判定结果：只关心调用 id 与成功与否。 */
export interface ImToolResultOutcome {
  callId?: string
  ok: boolean
}

/** 投影楼层身份：写入 `extra.agentTavern.projectionKey`。 */
export interface ProjectionIdentity {
  sessionId: string
  eventSeq: number
}

/** IM 楼层构造用的最小事件上下文（由投影器传入）。 */
export interface ImFloorContext {
  sessionId: string
  contextMode: string
  character: string
  eventSeq: number
  eventTime: number
  eventType: string
}

/** 一次 `im_send` 调用 + 宿主坐标：assistant 事件记录，`tool/result` 取用。 */
export interface ImPendingSend {
  call: ImSendCall
  turn?: number
  step?: number
  messageId?: string
}

/** `projectionExtra` 的可选成员；缺省成员不写入 extra。 */
export interface AgentTavernExtraInput {
  sessionId: string
  eventSeq: number
  contextMode: string
  projectionKey: string
  messageId?: unknown
  turn?: unknown
  step?: unknown
  via?: ImVia
  parse?: 'fallback'
  im?: Record<string, unknown>
}

const MEDIA_LABELS: Record<ImMediaKind, string> = {
  image: '（图片）',
  voice: '（语音）',
  video: '（视频）',
  file: '（文件）',
}

const RELAY_HEADER = /^\[IM ([^/\]]+)\/(私聊|群聊) peer=([^\]\s]+)(?: msg=(msg-[^\s\]]+))?(?: time=[^\]\s]+)?\](?:\s*（连续 \d+ 条消息）)?$/
const RELAY_FOOTER = /^（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 .+。）$/
const RELAY_REF = /^msg-[0-9a-f]{10}$/
const MERGED_LINE_REF = /^\[msg-[0-9a-f]{10}\]\s*/

/**
 * 解析 `router.ts` 写出的 relay 正文。
 *
 * 单条正文形如 `[IM <channel>/<私聊|群聊> peer=<alias> msg=<ref> time=<iso>]` +
 * 正文 + `（这是从 IM 转发给你的消息…）`；合流正文的头部标注`（连续 N 条消息）`，
 * 正文逐行带 `[msg-…] ` 引用。落库只保留正文：头部、尾部与逐行引用都是传输
 * 元数据，不属于聊天内容；群聊的 `[昵称]` 前缀属于正文，原样保留。
 *
 * 头部/尾部任一不匹配就把完整原文落库并标记 fallback——宁可楼层带噪，也绝不
 * 丢掉用户真的发来的消息。
 */
export function parseImRelayText(raw: string, summary: unknown, boundAliases: readonly string[]): ImRelayParse {
  const lines = raw.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ''
  const lastIndex = lastNonBlankIndex(lines)
  const header = RELAY_HEADER.exec(first)
  const footer = lastIndex > 0 && RELAY_FOOTER.test(lines[lastIndex]?.trim() ?? '')
  if (header !== null && footer) {
    const body = lines
      .slice(1, lastIndex)
      .map((line) => line.replace(MERGED_LINE_REF, ''))
      .join('\n')
      .trim()
    if (body !== '') {
      const ref = header[4]
      return {
        text: body,
        peerAlias: header[3] ?? '',
        ...(ref !== undefined && RELAY_REF.test(ref) ? { ref } : {}),
        fallback: false,
      }
    }
  }
  return {
    text: raw.trim(),
    peerAlias: aliasHintOf(raw, summary, boundAliases),
    fallback: true,
  }
}

/**
 * 本会话绑定的 IM peer alias（去重排序）。
 *
 * 入参是持久化 state 的未知形状：`imPeers` 的读取按运行时校验处理（键被手改坏
 * 的记录跳过，与工具面的容错同款），一条坏 key 不能让整个会话的投影失效。
 * 返回值长度 > 1 即多对端会话，楼层正文需要 alias 前缀。
 */
export function boundImPeerAliases(state: unknown, sessionId: string): string[] {
  const peers = recordOf(recordOf(state)?.['imPeers'])
  if (peers === undefined) return []
  const aliases = new Set<string>()
  for (const [peerKey, value] of Object.entries(peers)) {
    const binding = recordOf(value)
    if (binding?.['sessionId'] !== sessionId) continue
    const parts = imPeerKeyParts(peerKey)
    if (parts === undefined) continue
    if (parts.scope !== 'private' && parts.scope !== 'group') continue
    aliases.add(imPeerAlias(parts.channel, parts.scope, peerKey))
  }
  return [...aliases].sort()
}

/** 多对端会话的楼层前缀；单对端与未知 alias 保持正文干净。 */
export function imPeerPrefix(peerAlias: string, boundAliases: readonly string[]): string {
  if (peerAlias === '' || boundAliases.length <= 1) return ''
  return `[${peerAlias}] `
}

/** 事件 source 是否是本插件写出的 relay 消息（v4 producer kind 与 v0-v3 形状双认）。 */
export function isImRelaySource(source: unknown): boolean {
  const record = recordOf(source)
  return record?.['form'] === 'relay' && isHostPluginMessageSource(record)
}

/**
 * 一条 assistant 消息里的 `im_send` 调用（按内容块顺序）。
 *
 * `arguments` 在宿主里是 JSON 字符串，测试/旧宿主也可能是已解析对象。参数缺失、
 * 既无文本又无媒体、或 mediaKind 没有对应媒体来源的调用直接跳过：它们不可能
 * 被工具接受，也不会有成功回执。
 */
export function imSendCallsOf(content: unknown): ImSendCall[] {
  if (!Array.isArray(content)) return []
  const calls: ImSendCall[] = []
  for (const block of content) {
    const record = recordOf(block)
    if (record === undefined || record['type'] !== 'tool-call' || record['name'] !== 'im_send') continue
    const callId = textOf(record['id']) ?? textOf(record['callId'])
    if (callId === undefined) continue
    const args = argumentsOf(record['arguments'])
    if (args === undefined) continue
    const text = typeof args['text'] === 'string' ? args['text'].trim() : ''
    const mediaKind = mediaKindOf(args)
    if (text === '' && mediaKind === undefined) continue
    calls.push({
      callId,
      text,
      peerAlias: typeof args['peer'] === 'string' ? args['peer'].trim() : '',
      ...(mediaKind === undefined ? {} : { mediaKind }),
    })
  }
  return calls
}

/** 出站楼层正文：文本、媒体标记，或两者（文本在前）。 */
export function imSendFloorText(call: ImSendCall): string {
  const marker = call.mediaKind === undefined ? '' : MEDIA_LABELS[call.mediaKind]
  if (marker === '') return call.text
  return call.text === '' ? marker : `${call.text}\n${marker}`
}

/**
 * 解析 `tool/result` 事件。
 *
 * 真实 v4 形状（2026-10-31 从 `~/.dsh/sessions` 的 IM 会话解压取证）：
 * `data.message = { id, role: 'tool', toolCallId, isError, content, source: { kind: 'tool', callId } }`。
 * 调用 id 依次读 `message.toolCallId` → `message.source.callId` → `data.callId`；
 * 失败除 `isError` 外还看 JSON 正文里的 `error` 成员（传输失败的兜底标记）。
 */
export function imToolResultOf(data: unknown): ImToolResultOutcome | undefined {
  const record = recordOf(data)
  if (record === undefined) return undefined
  const message = recordOf(record['message'])
  const source = recordOf(message?.['source'])
  const callId = textOf(message?.['toolCallId'])
    ?? textOf(source?.['callId'])
    ?? textOf(record['callId'])
    ?? textOf(record['toolCallId'])
  const isError = message?.['isError'] === true || record['isError'] === true
  const payload = message?.['content'] ?? record['content'] ?? record['result']
  return {
    ...(callId === undefined ? {} : { callId }),
    ok: !isError && !errorPayloadOf(payload),
  }
}

/**
 * 楼层 extra 的 `agentTavern` 段。
 *
 * `projectionKey` 是稳定的投影身份：普通楼层为 `<sessionId>:<eventSeq>`，IM 楼层
 * 在事件粒度上再带消息 id / 调用 id。messageId/turn/step/via/im 只在有值时写入，
 * 保持非 IM 楼层的 extra 形状最小。
 */
export function projectionExtra(input: AgentTavernExtraInput): Record<string, unknown> {
  return {
    agentTavern: {
      architecture: 'agent-tavern',
      contextMode: input.contextMode,
      sessionId: input.sessionId,
      eventSeq: input.eventSeq,
      projectionKey: input.projectionKey,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(typeof input.turn === 'number' && Number.isSafeInteger(input.turn) ? { turn: input.turn } : {}),
      ...(typeof input.step === 'number' && Number.isSafeInteger(input.step) ? { step: input.step } : {}),
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.parse === undefined ? {} : { parse: input.parse }),
      ...(input.im === undefined ? {} : { im: input.im }),
    },
  }
}

/**
 * 聊天里是否已经有这一层。
 *
 * 1. `projectionKey` 相同 → 已投影（新楼层的常规路径，重放幂等）。
 * 2. 老楼层没有 key → 退回旧的 `<sessionId>:<eventSeq>` 判定（升级不重复）。
 * 3. 同一条入站消息先以 splice 插入、随后物化成 `user/message`：两个事件共享
 *    消息 id，seq 不同也只能留一层。
 * 4. 同一次 `im_send` 的 assistant 事件与 result 事件 seq 不同：按 callId 去重。
 */
export function projectionIdentity(
  candidate: ChatMessage,
  incoming: ChatMessage,
  identity: ProjectionIdentity,
): boolean {
  const stored = recordOf(candidate.extra?.['agentTavern'])
  const next = recordOf(incoming.extra?.['agentTavern'])
  if (stored === undefined || next === undefined) return false
  const storedKey = textOf(stored['projectionKey'])
  const nextKey = textOf(next['projectionKey'])
  if (storedKey !== undefined && storedKey === nextKey) return true
  if (storedKey === undefined && stored['sessionId'] === identity.sessionId && stored['eventSeq'] === identity.eventSeq) return true
  const storedIm = recordOf(stored['im'])
  const nextIm = recordOf(next['im'])
  if (next['via'] === 'im-relay' && stored['via'] === 'im-relay'
    && textOf(stored['messageId']) !== undefined && stored['messageId'] === next['messageId']) return true
  if (next['via'] === 'im-send' && stored['via'] === 'im-send'
    && textOf(storedIm?.['callId']) !== undefined && storedIm?.['callId'] === nextIm?.['callId']) return true
  return false
}

/* --------------------------------- 楼层构造 -------------------------------- */

/** `assistant/message` 的最小事件形状；投影器传入的宿主事件结构上满足它。 */
export interface ImSessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: {
    message?: { id?: unknown; content?: unknown; source?: unknown }
    turn?: unknown
    step?: unknown
  }
}

/** IM 楼层构造用的最小事件上下文；事件时间只在真的要落层时才校验。 */
export function imFloorContextOf(
  sessionId: string,
  contextMode: string,
  character: string,
  event: { readonly seq: number; readonly time: number; readonly type: string },
): ImFloorContext {
  return { sessionId, contextMode, character, eventSeq: event.seq, eventTime: event.time, eventType: event.type }
}

/** 拼接消息内容块里的文本并 trim；IM 与普通楼层共用同一文本提取。 */
export function messageTextOf(content: unknown): string {
  return (textContentOf(content) ?? '').trim()
}

/**
 * assistant 事件里的 `im_send` 调用 + 宿主坐标。
 *
 * 镜像导入与 body 合并回合的消息不参与：它们的工具回执即使存在也不代表
 * 这一次真的把消息发给了对端。这里复用 body 模块的判定，投影器不再重复实现。
 */
export function imSendEntriesOf(session: HostSessionLog, event: ImSessionEventLike): ImPendingSend[] {
  if (event.type !== 'assistant/message'
    || isTavernSessionMarker(event.data?.message?.source)
    || isBodyMergedAssistant(session, event)) return []
  return imSendCallsOf(event.data?.message?.content).map((call) => ({
    call,
    ...(typeof event.data?.turn === 'number' ? { turn: event.data.turn } : {}),
    ...(typeof event.data?.step === 'number' ? { step: event.data.step } : {}),
    ...(typeof event.data?.message?.id === 'string' ? { messageId: event.data.message.id } : {}),
  }))
}

/**
 * 入站 relay → user 楼层。
 *
 * `inserted` 对 `agent/inbox/spliced` 是 `data.inserted`，对物化后的
 * `user/message` 是单元素数组：两种宿主形状共用同一段构造逻辑。每个插入消息
 * 一层；头部/尾部解析失败时落完整原文（`parse: 'fallback'`），绝不丢消息。
 */
export function projectImRelayFloors(
  context: ImFloorContext,
  inserted: readonly unknown[],
  scripts: RegexScriptIR[],
  peerAliases: readonly string[],
): ChatMessage[] {
  const floors: ChatMessage[] = []
  for (const [index, value] of inserted.entries()) {
    const message = recordOf(value)
    if (message === undefined || !isImRelaySource(message['source'])) continue
    const text = messageTextOf(message['content'])
    if (text === '') continue
    const messageId = message['id']
    const parsed = parseImRelayText(text, recordOf(message['source'])?.['summary'], peerAliases)
    floors.push({
      name: 'User',
      is_user: true,
      is_system: false,
      send_date: sessionEventDate(context.eventTime, context.eventSeq, context.eventType),
      mes: `${imPeerPrefix(parsed.peerAlias, peerAliases)}${applyRegexScripts(parsed.text, scripts, RegexPlacement.USER_INPUT)}`,
      extra: projectionExtra({
        sessionId: context.sessionId,
        eventSeq: context.eventSeq,
        contextMode: context.contextMode,
        projectionKey: `${context.sessionId}:${context.eventSeq}:im:${typeof messageId === 'string' && messageId !== '' ? messageId : String(index)}`,
        messageId,
        via: 'im-relay',
        ...(parsed.fallback ? { parse: 'fallback' as const } : {}),
        im: {
          direction: 'in',
          peerAlias: parsed.peerAlias,
          ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        },
      }),
    })
  }
  return floors
}

/**
 * 成功的 `im_send` 回执 → 一层 assistant 楼层。
 *
 * 失败回执、传输错误与「没有 matching assistant 调用」一律不产生楼层：对端
 * 没收到的东西不属于聊天历史。
 */
export function projectImSendFloors(
  context: ImFloorContext,
  resultData: unknown,
  pending: ImPendingSend | undefined,
  scripts: RegexScriptIR[],
  peerAliases: readonly string[],
): ChatMessage[] {
  if (pending === undefined) return []
  const outcome = imToolResultOf(resultData)
  if (outcome === undefined || !outcome.ok) return []
  const call = pending.call
  const text = imSendFloorText(call)
  if (text === '') return []
  const peerAlias = call.peerAlias !== '' ? call.peerAlias : (peerAliases.length === 1 ? peerAliases[0] ?? '' : '')
  const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
  const transformed = saveScripts.length > 0 ? applyRegexScripts(text, saveScripts, RegexPlacement.AI_OUTPUT) : text
  return [{
    name: context.character,
    is_user: false,
    is_system: false,
    send_date: sessionEventDate(context.eventTime, context.eventSeq, context.eventType),
    mes: `${imPeerPrefix(peerAlias, peerAliases)}${transformed}`,
    extra: projectionExtra({
      sessionId: context.sessionId,
      eventSeq: context.eventSeq,
      contextMode: context.contextMode,
      projectionKey: `${context.sessionId}:${context.eventSeq}:im:${call.callId}`,
      messageId: pending.messageId,
      turn: pending.turn,
      step: pending.step,
      via: 'im-send',
      im: {
        direction: 'out',
        peerAlias,
        callId: call.callId,
        ...(call.mediaKind === undefined ? {} : { mediaKind: call.mediaKind }),
      },
    }),
  }]
}

/** Largest millisecond value a `Date` can represent (±100,000,000 days). */
const MAX_DATE_MILLISECONDS = 8.64e15

/**
 * ISO timestamp of a session event.
 *
 * A wall-clock fallback would make replay non-reproducible, so an unusable
 * event time is a hard error instead. `time` is required by the host event
 * contract; a historical or damaged event without it reaches this check as
 * `undefined` and is rejected rather than silently dated at read time.
 */
export function sessionEventDate(time: number, seq: number, type: string): string {
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_DATE_MILLISECONDS) {
    throw new Error(
      `session event '${type}' at seq ${seq} has unusable time ${String(time)}; expected a non-negative safe integer within the Date range`,
    )
  }
  return new Date(time).toISOString()
}

/* --------------------------------- 内部工具 -------------------------------- */

function lastNonBlankIndex(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim() !== '') return index
  }
  return -1
}

/** 解析失败时的 alias 线索：先看原文里的 `peer=`，再看 source.summary 的尾巴。 */
function aliasHintOf(raw: string, summary: unknown, boundAliases: readonly string[]): string {
  const header = /\bpeer=([^\]\s]+)/.exec(raw)
  if (header?.[1] !== undefined) return header[1]
  const summaryText = typeof summary === 'string' ? summary.trim() : ''
  const tail = /(?:^|\s)from (\S+)$/.exec(summaryText)
  if (tail?.[1] !== undefined) return tail[1]
  return boundAliases.length === 1 ? boundAliases[0] ?? '' : ''
}

function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return recordOf(JSON.parse(value))
    } catch {
      // 坏 JSON 的调用不可能成功；投影端跳过即可，工具面的错误已由宿主记录。
      return undefined
    }
  }
  return recordOf(value)
}

function mediaKindOf(args: Record<string, unknown>): ImMediaKind | undefined {
  const kind = args['mediaKind']
  if (kind !== 'image' && kind !== 'voice' && kind !== 'video' && kind !== 'file') return undefined
  const hasPath = typeof args['mediaPath'] === 'string' && args['mediaPath'].trim() !== ''
  const hasUrl = typeof args['mediaUrl'] === 'string' && args['mediaUrl'].trim() !== ''
  return hasPath || hasUrl ? kind : undefined
}

function errorPayloadOf(payload: unknown): boolean {
  const text = textContentOf(payload)?.trim() ?? ''
  if (text === '') return false
  try {
    const record = recordOf(JSON.parse(text))
    if (record === undefined) return false
    const error = record['error']
    return typeof error === 'string' ? error.trim() !== '' : error !== undefined && error !== null && error !== false
  } catch {
    // 非 JSON 正文没有结构化 error 成员，成功与否以 isError 为准。
    return false
  }
}

function textContentOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const block of value) {
    const record = recordOf(block)
    if (record?.['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
