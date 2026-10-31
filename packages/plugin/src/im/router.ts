/**
 * 入站路由（提案 0024 §3.8 / 决策 2026-10-31-im-native-session-binding /
 * 决策 2026-10-31-im-inbound-coalescing / 决策 2026-10-31-im-message-refs）：
 * 短窗合流 → 去重 → 白名单 → 绑定 → 媒体物化 → 插进绑定的原生 DSH 会话。
 *
 * 每个 peer 一条 600ms 的短窗（`im/coalesce.ts`）：窗口内的文本连发合并成一条
 * 消息插入，同 peer 的平台时间乱序消息在合并前按 `platformAt ?? receivedAt` 重排。
 * 缓冲有硬上限（条数与字符数），超过立即冲刷；含媒体的批次不合并，逐条投递。
 * 这逆转了 2026-10-31-im-native-session-binding 里「插件不排队」的取舍：连发碎句
 * 会把宿主会话刷成一串独立轮，窗口把一次对话收成一条；代价与边界见决策文档。
 *
 * 每条成功投递的消息在 `im/refs.ts` 的进程内表里记一个 `msg-<hash>` 引用：relay
 * 头部带 `msg=`/`time=`，合流正文逐行带自己的 `[msg-…]`。模型可用 `im_send` 的
 * `replyTo` 指回某一条，路由据此锚定触发消息（QQ 被动回复）与对端。
 *
 * 绑定缺失时：把 peer 记进 `imPendingPeers`（面板「未绑定对端」待办）并回一条
 * 提示，**不代建会话**。回复也不由插件自动发——入站消息以插件来源插入会话后，
 * 由模型调用 `im_send` 自己回复。
 *
 * 所有宿主能力都从 deps 进来，路由本身不认识 ctx、不认识协议。
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { HostLogger } from '../host-contract.js'
import { IM_COALESCE_MAX_CHARS, IM_COALESCE_MAX_MESSAGES, IM_COALESCE_WINDOW_MS, mergedRelayTextOf, orderInboundEntries, type ImCoalesceEntry } from './coalesce.js'
import { IM_MESSAGE_REF_MAX_ENTRIES, IM_MESSAGE_REF_TTL_MS, createImMessageRefStore, imMessageRef, type ImMessageRefEntry } from './refs.js'
import { projectImText } from './project.js'
import { imAccessAllows, imChunkLimit } from './settings.js'
import type { ImLogSink } from './log.js'
import type { ImChannelId, ImInbound, ImMediaRef, ImOutboundMedia, ImScope, ImSendReceipt, ImSettings, ImTarget, OutboundPart } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey, imPeerKeyParts } from './types.js'

/** 未绑定提示：对端只知道「没绑上」，具体绑定发生在 DSH 面板。 */
export const IM_UNBOUND_NOTICE = '（消息已收到，但这个对端还没有绑定 DSH 会话；请在 dsh-soulmojito 的 IM 面板把它绑到一个会话）'

/** 会话不在线时的提示：不装作插入成功，也不反复重试。 */
export const IM_SESSION_NOT_LIVE = '（消息已收到，但绑定的 DSH 会话当前不可投递（未打开或不是 AgentLoop 会话）；请打开它或改绑后再发一次）'

/** 其它插入失败（inbox/日志写入等）：别让对端按「未打开」的提示做无效重试。 */
export const IM_DELIVERY_FAILED = '（消息已收到，但插入绑定的 DSH 会话失败；请稍后再发一次）'

/**
 * 主动发送的结构化失败（提案 0024 §3.6 的 `im_send`）：绑定缺失、目标非法与
 * 传输失败必须能区分，工具面据此如实点名原因，而不是一句通用异常。
 */
export class ImSendError extends Error {
  readonly code: 'IM_SEND_INVALID' | 'IM_SEND_INVALID_TARGET' | 'IM_SEND_UNBOUND' | 'IM_SEND_FAILED'
  constructor(
    code: ImSendError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ImSendError'
    this.code = code
  }
}


/** 未绑定提示的抑制窗口：同一个 peer 十分钟内只被提醒一次。 */
const UNBOUND_NOTICE_TTL_MS = 10 * 60_000

/** 被动回复锚点的有效期：平台消息的被动回复窗口远短于此，过期就不带。 */
const REPLY_ANCHOR_TTL_MS = 5 * 60_000

/** 面板待办上限：只留最近 50 个未绑定对端，防止陌生人群刷爆 state。 */
const MAX_PENDING_PEERS = 50

/**
 * `flushPending()` 的保护上限：冲刷期间持续入站会让「冲到没有待处理项」永不
 * 满足，dispose 因此可能被无限拖延。最多 50 轮或 2 秒（先到者）就放弃，
 * 剩余缓冲交给各自的窗口定时器继续冲刷。
 */
export const IM_FLUSH_PENDING_MAX_PASSES = 50
export const IM_FLUSH_PENDING_MAX_MS = 2_000

export interface ImAgentMessage {
  id: string
  text: string
  /** 宿主消息来源的一行摘要（`source.summary`），不含正文与平台身份。 */
  summary: string
}

/** 冲刷时确认可投递的一条入站消息：正文已按群聊/附件规则拼好。 */
interface DeliverableInbound {
  message: ImInbound
  body: string
}

export interface ImRouterDeps {
  db: TavernStore
  now: () => number
  /** true = 这条消息已经投递过（平台重连会补发同一条）。 */
  seenDedupe: (dedupeKey: string, now: number) => Promise<boolean>
  /**
   * 把一条插件来源的消息立即插进绑定会话的 inbox：运行中的会话用插话
   * （`agent.steer`），空闲会话用 `followup`。会话不在线时必须抛错
   * （路由据此回 `IM_SESSION_NOT_LIVE`，不假装成功）。
   */
  insert: (sessionId: string, message: ImAgentMessage) => Promise<void>
  send: (target: ImTarget, parts: readonly OutboundPart[]) => Promise<void>
  /**
   * 媒体文件的合法根（内部工作区）。给定时 `sendMedia` 拒绝根目录之外的文件：
   * 模型不能被诱导把密钥/聊天记录当附件发出去。缺省（测试假件）不启用。
   */
  workspaceRoot?: () => Promise<string>
  logger?: HostLogger
  /** 面板「IM 运行日志」的落点；缺省时只写宿主日志。 */
  log?: ImLogSink
  /**
   * 同一 peer 的合流窗口（毫秒）；缺省 `IM_COALESCE_WINDOW_MS`。测试注入假调度器
   * 保持确定性，生产不做面板配置。
   */
  coalesceWindowMs?: number
  /**
   * 窗口定时器接缝：`scheduleFlush(delayMs, run)` 返回取消函数。缺省
   * setTimeout/clearTimeout；测试注入手动调度器，不真等 600ms。
   */
  scheduleFlush?: (delayMs: number, run: () => void) => () => void
}

export interface ImRouter {
  /**
   * 一条入站消息：正常路径只入缓冲，不阻塞调用方——通道的事件循环可以继续
   * 收消息；缓冲触到硬上限（条数/字符数）时当场冲刷并等待插入完成。
   *
   * 去重、访问控制、绑定与插入都在合流窗口结束后的冲刷里按序执行。
   * `loadMedia` 是惰性媒体物化：只有通过去重与访问控制、已绑定，且批次里确实
   * 要投递时才调用它下载/解密；被拒绝的 peer 与重复投递不会触发任何落盘或网络请求。
   */
  inbound(inbound: ImInbound, options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> }): Promise<void>
  /**
   * 强制冲刷所有 peer 的缓冲批次并等待插入完成。测试用它替代真等窗口；
   * `runtime.dispose()` 用它落盘最后一窗消息。冲刷期间新到的消息会重新入缓冲，
   * 反复冲刷到没有待处理项为止；持续入站超过上限时记 warn 并返回，剩余缓冲
   * 由各自的窗口定时器兜底（保护 dispose 不被无限拖延）。
   */
  flushPending(): Promise<void>
  /**
   * 主动发一条文本给已绑定的 peer（`im_send` 的落点）。绑定存在性在这里再验
   * 一次：工具面只保证「绑到本会话」，路由保证「peer 真的有绑定」。
   * `options.passiveReplyTo` 给定时用它替代该 peer 的自动锚点（消息引用回复）。
   */
  sendText(peerKey: string, text: string, options?: { passiveReplyTo?: string }): Promise<ImSendReceipt>
  /** 主动发一条媒体（可选配文）；目标校验与 `sendText` 同一套。 */
  sendMedia(peerKey: string, media: ImOutboundMedia, options?: { passiveReplyTo?: string }): Promise<ImSendReceipt>
  /**
   * 解析 relay 头部的 `msg=` 引用 → 该消息投递时的 peer、会话与被动锚点。
   * 只认本进程已投递且未过期的条目；未知/过期返回 undefined，绝不猜。
   */
  resolveMessageRef(ref: string): ImMessageRefEntry | undefined
}

export function createImRouter(deps: ImRouterDeps): ImRouter {
  const noticed = new Map<string, number>()
  /**
   * 被动回复锚点：QQ 的被动回复必须带回触发消息的 `msg_id`，否则只能走主动推送
   * （官方机器人对主动消息有权限/时效限制）。模型只看到 alias，不需要知道平台
   * 消息 id；路由在入站时记下最近一条，`im_send` 出站时自动带上。
   */
  const replyAnchors = new Map<string, { replyTo: string; at: number }>()
  /**
   * 已投递消息的引用表（`im/refs.ts`）：`im_send` 的 `replyTo` 据此解析触发消息的
   * peer 与被动锚点。TTL/容量是常量，进程内失效，不落盘。
   */
  const messageRefs = createImMessageRefStore({
    now: deps.now,
    ttlMs: IM_MESSAGE_REF_TTL_MS,
    maxEntries: IM_MESSAGE_REF_MAX_ENTRIES,
  })

  const coalesceWindowMs = deps.coalesceWindowMs ?? IM_COALESCE_WINDOW_MS
  /** 窗口定时器接缝；缺省真定时器，测试注入手动调度器。 */
  const scheduleFlush = deps.scheduleFlush ?? ((delayMs: number, run: () => void): (() => void) => {
    const timer = setTimeout(run, delayMs)
    return () => { clearTimeout(timer) }
  })
  /** 每个 peer 的待冲刷批次：`inbound` 只追加，冲刷时整批按平台时间排序处理。 */
  const buffers = new Map<string, ImCoalesceEntry[]>()
  /** 每个 peer 至多一个待触发的窗口定时器：值是取消函数。 */
  const flushTimers = new Map<string, () => void>()
  /**
   * 每个 peer 的冲刷链尾。`flushPending` 等的是「插入真的完成」，不是「缓冲被取走」：
   * 冲刷进行中新到的消息会另起一轮，链式接在后面。
   */
  const flushing = new Map<string, Promise<void>>()
  /** 本地到达序号：平台时间缺失或相同时的稳定排序键。 */
  let nextSeq = 0

  async function settingsOf(): Promise<ImSettings> {
    const state = await deps.db.getState()
    return state.imSettings ?? DEFAULT_IM_SETTINGS
  }

  /**
   * 一条入站消息：正常路径只追加进该 peer 的合流批次并立即返回；触到条数/字符
   * 硬上限时不等窗口，当场 `await` 完整冲刷（这一次调用会等到插入完成）。
   * 去重/访问控制/绑定/插入都推迟到冲刷里做——这正是「一条连发 = 一条消息」的
   * 前提，窗口内的重放也会在冲刷时被去重表挡住。
   */
  async function inbound(
    inboundMessage: ImInbound,
    options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> },
  ): Promise<void> {
    const peerKey = imPeerKey(inboundMessage.channel, inboundMessage.accountId, inboundMessage.scope, inboundMessage.peerId)
    const entry: ImCoalesceEntry = {
      inbound: inboundMessage,
      ...(options?.loadMedia === undefined ? {} : { loadMedia: options.loadMedia }),
      seq: nextSeq,
      at: deps.now(),
    }
    nextSeq += 1
    const buffered = buffers.get(peerKey)
    if (buffered === undefined) buffers.set(peerKey, [entry])
    else buffered.push(entry)
    const batch = buffered ?? [entry]
    if (bufferExceedsLimits(batch)) {
      // 触到条数/字符上限：不等窗口，立即冲刷这一批；窗口上限保持是硬的。
      cancelFlushTimer(peerKey)
      await startFlush(peerKey)
      return
    }
    scheduleFlushFor(peerKey)
  }

  /** 缓冲触限判定：条数达到上限或正文合计超过字符上限。 */
  function bufferExceedsLimits(entries: readonly ImCoalesceEntry[]): boolean {
    if (entries.length >= IM_COALESCE_MAX_MESSAGES) return true
    let chars = 0
    for (const entry of entries) chars += entry.inbound.text.length
    return chars > IM_COALESCE_MAX_CHARS
  }

  function cancelFlushTimer(peerKey: string): void {
    const cancel = flushTimers.get(peerKey)
    if (cancel === undefined) return
    flushTimers.delete(peerKey)
    cancel()
  }

  /** 起一轮冲刷；已有在飞的批次时接在它后面，保证缓冲里当前的批次也被覆盖。 */
  function startFlush(peerKey: string): Promise<void> {
    const previous = flushing.get(peerKey)
    const run = previous === undefined ? flushPeer(peerKey) : previous.then(() => flushPeer(peerKey))
    flushing.set(peerKey, run)
    const done = (): void => {
      if (flushing.get(peerKey) === run) flushing.delete(peerKey)
    }
    void run.then(done, done)
    return run
  }

  function scheduleFlushFor(peerKey: string): void {
    if (flushTimers.has(peerKey)) return
    let fired = false
    let registering = true
    const cancel = scheduleFlush(coalesceWindowMs, () => {
      fired = true
      // 同步调度器（测试）会在登记完成前调回：交给 scheduleFlushFor 收尾。
      if (registering) return
      flushTimers.delete(peerKey)
      void startFlush(peerKey)
    })
    registering = false
    if (fired) {
      // 回调已经同步跑过：这个定时器永远不会触发，取消并立即冲刷。
      cancel()
      void startFlush(peerKey)
      return
    }
    flushTimers.set(peerKey, cancel)
  }

  /** 冲刷一个 peer 的批次；按契约永远不 reject（单条失败已在批次内隔离）。 */
  async function flushPeer(peerKey: string): Promise<void> {
    cancelFlushTimer(peerKey)
    const buffered = buffers.get(peerKey)
    if (buffered === undefined) return
    buffers.delete(peerKey)
    const first = buffered[0]
    if (first === undefined) return
    const alias = imPeerAlias(first.inbound.channel, first.inbound.scope, peerKey)
    try {
      await deliverBatch(peerKey, alias, orderInboundEntries(buffered))
    } catch (error) {
      deps.log?.note('error', `flushing the buffered messages from ${alias} failed: ${messageOf(error)}`)
    }
  }

  async function flushPending(): Promise<void> {
    // 反复检查：冲刷是异步的，期间新到的消息会重新入缓冲，直到缓冲、定时器、
    // 在飞批次三者都空为止。持续入站时这个循环不会自然结束，因此用轮数/时长
    // 上限兜底：超限只 warn 并返回，剩余缓冲仍有各自的窗口定时器。
    const startedAt = deps.now()
    let passes = 0
    for (;;) {
      if (passes >= IM_FLUSH_PENDING_MAX_PASSES || deps.now() - startedAt >= IM_FLUSH_PENDING_MAX_MS) {
        // 退出前只统计「还有事的 peer」：buffers 与 flushTimers 常常指同一个 peer，
        // 直接相加会把一个批次算成两份。剩余批次仍有各自的窗口定时器兜底。
        const pendingPeers = new Set([...buffers.keys(), ...flushTimers.keys(), ...flushing.keys()])
        if (pendingPeers.size === 0) return
        deps.log?.note(
          'warn',
          `flushPending stopped after ${passes} pass(es): ${pendingPeers.size} peer batch(es) are still pending; the per-peer window timers keep flushing them`,
        )
        return
      }
      passes += 1
      for (const peerKey of [...flushTimers.keys()]) {
        cancelFlushTimer(peerKey)
        startFlush(peerKey)
      }
      for (const peerKey of [...buffers.keys()]) startFlush(peerKey)
      const pending = [...flushing.values()]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  /**
   * 冲刷一批（同 peer）入站消息：整批共用一次设置读取与绑定查询，逐条走
   * 去重 → 访问控制 → 未绑定待办 → 媒体物化，把可投递的收进 `deliverables`。
   * 单条失败只跳过该条（已记错误日志），不拖垮批次里其它消息。
   */
  async function deliverBatch(peerKey: string, alias: string, entries: readonly ImCoalesceEntry[]): Promise<void> {
    const settings = await settingsOf()
    const binding = await boundSessionOf(peerKey)
    const deliverables: DeliverableInbound[] = []
    for (const entry of entries) {
      try {
        const deliverable = await consumeEntry(peerKey, alias, entry, settings, binding)
        if (deliverable !== undefined) deliverables.push(deliverable)
      } catch (error) {
        deps.log?.note('error', `processing a buffered message from ${alias} failed: ${messageOf(error)}`)
      }
    }
    if (binding === undefined || deliverables.length === 0) return
    if (deliverables.length > 1 && deliverables.every((item) => item.message.media.length === 0)) {
      await deliverMerged(alias, binding.sessionId, deliverables)
      return
    }
    // 单条批次与含媒体的批次都不合并：逐条投递，单条正文与日志保持原样。
    for (const item of deliverables) await deliverOne(alias, binding.sessionId, item)
  }

  /**
   * 批次里的一条：去重与访问控制先行，绑定缺失时记待办 + 提示；通过后才物化媒体。
   * 返回可投递项（正文已拼好）；被过滤的返回 undefined。
   */
  async function consumeEntry(
    peerKey: string,
    alias: string,
    entry: ImCoalesceEntry,
    settings: ImSettings,
    binding: { sessionId: string } | undefined,
  ): Promise<DeliverableInbound | undefined> {
    const inboundMessage = entry.inbound
    if (await deps.seenDedupe(inboundMessage.dedupeKey, entry.at)) {
      deps.log?.note('debug', `ignored a duplicate ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias} (dedupe)`)
      return undefined
    }
    if (!imAccessAllows(settings, inboundMessage.scope, inboundMessage.peerId)) {
      deps.log?.note(
        'warn',
        `dropped a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias}: the access policy does not allow this peer (mode is allowlist and the peer is not listed, or the scope is disabled)`,
      )
      return undefined
    }
    if (binding === undefined) {
      // 未绑定：不代建会话，也不为陌生人下载/解密/落盘附件。用占位 ref 生成摘要，
      // 记进面板待办并回一条固定提示；正文不落 state。
      const unboundBody = imUserTextOf(inboundMessage)
      if (unboundBody === undefined) {
        deps.log?.note('debug', `ignored a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias}: no text and no attachments`)
        return undefined
      }
      await rememberPendingPeer(peerKey, inboundMessage, alias, entry.at)
      await notifyUnbound(imTargetOf(inboundMessage), peerKey, alias, entry.at)
      return undefined
    }
    // 媒体只在通过访问控制**且已绑定**之后才物化：白名单外的人与未绑定对端
    // 都不能靠附件让进程下载/解密/写盘。物化失败不拖垮正文——去重条目已经记下，
    // 抛错等于让这条消息永远不再重投。
    let media: readonly ImMediaRef[] = inboundMessage.media
    if (entry.loadMedia !== undefined) {
      try {
        media = await entry.loadMedia()
      } catch (error) {
        deps.log?.note(
          'warn',
          `media for a ${inboundMessage.channel}/${inboundMessage.scope} message from ${alias} failed to load; delivering it without local copies: ${messageOf(error)}`,
        )
      }
    }
    const message: ImInbound = media === inboundMessage.media ? inboundMessage : { ...inboundMessage, media }
    // 记下被动回复锚点：模型随后调用 im_send 时，QQ 才能把回复挂到这条消息上。
    // 批次按序处理，排序后最后一条投递的消息自然覆盖前面的锚点。
    if (message.replyTo !== undefined) replyAnchors.set(peerKey, { replyTo: message.replyTo, at: entry.at })
    const body = imUserTextOf(message)
    if (body === undefined) {
      deps.log?.note('debug', `ignored a ${message.channel}/${message.scope} message from ${alias}: no text and no attachments`)
      return undefined
    }
    return { message, body }
  }

  /** 单条投递：正文与日志与合流上线前逐字节一致；摘要与引用表带 `msg=`。 */
  async function deliverOne(alias: string, sessionId: string, item: DeliverableInbound): Promise<void> {
    const message = item.message
    const body = item.body
    const ref = imMessageRef(message.dedupeKey)
    const text = relayTextOf(message, body, alias)
    deps.log?.note('info', `accepted a ${message.channel}/${message.scope} message from ${alias} (${body.length} chars) for session ${sessionId}`)
    const messageId = `im-${randomUUID()}`
    try {
      // 插件来源消息投进宿主 inbox：运行中插话、空闲开新轮，宿主 loop 自己排轮。
      await deps.insert(sessionId, {
        id: messageId,
        text,
        summary: `IM ${message.channel}/${message.scope} message msg=${ref} from ${alias}`,
      })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      deps.log?.note('error', `could not insert a message from ${alias} into session ${sessionId}: ${messageOf(error)}`)
      deps.logger?.warn?.(`dsh-soulmojito im: inserting into ${sessionId} failed: ${messageOf(error)}`)
      await sendNotice(imTargetOf(message), code === 'IM_SESSION_NOT_LIVE' ? IM_SESSION_NOT_LIVE : IM_DELIVERY_FAILED, alias)
      return
    }
    rememberDeliveredMessage(ref, sessionId, message)
    deps.log?.note('debug', `inserted an IM message from ${alias} into session ${sessionId} (${messageId})`)
  }

  /**
   * 合流投递：整批拼成一条 `im-` 消息，头部标注连续条数，正文逐条换行——每条
   * 前缀自己的 `[msg-…]` 引用（头是复数，不挂单个 msg）。摘要与失败提示取批次
   * 最后一条（排序后），与「最后收到的那句话」一致；引用逐条记进引用表。
   */
  async function deliverMerged(alias: string, sessionId: string, items: readonly DeliverableInbound[]): Promise<void> {
    const first = items[0]
    const last = items[items.length - 1]
    if (first === undefined || last === undefined) return
    const channel = first.message.channel
    const scope = first.message.scope
    const relayItems = items.map((item) => ({
      message: item.message,
      body: item.body,
      ref: imMessageRef(item.message.dedupeKey),
    }))
    const text = mergedRelayTextOf(relayItems, alias, channel, scope)
    const chars = relayItems.reduce((total, entry) => total + entry.body.length, 0)
    deps.log?.note('info', `accepted ${relayItems.length} ${channel}/${scope} messages from ${alias} (${chars} chars) for session ${sessionId}`)
    const messageId = `im-${randomUUID()}`
    try {
      await deps.insert(sessionId, {
        id: messageId,
        text,
        summary: `IM ${channel}/${scope} ${relayItems.length} messages from ${alias}`,
      })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      deps.log?.note('error', `could not insert a merged message from ${alias} into session ${sessionId}: ${messageOf(error)}`)
      deps.logger?.warn?.(`dsh-soulmojito im: inserting into ${sessionId} failed: ${messageOf(error)}`)
      await sendNotice(imTargetOf(last.message), code === 'IM_SESSION_NOT_LIVE' ? IM_SESSION_NOT_LIVE : IM_DELIVERY_FAILED, alias)
      return
    }
    for (const relayItem of relayItems) rememberDeliveredMessage(relayItem.ref, sessionId, relayItem.message)
    deps.log?.note('debug', `inserted a merged IM message from ${alias} into session ${sessionId} (${messageId})`)
  }

  /**
   * 记录一条已投递消息的引用：`im_send` 的 `replyTo` 用它在事后解析出 peer、
   * 会话与被动锚点。插入失败不记——没进上下文的消息不该被 replyTo 指回。
   */
  function rememberDeliveredMessage(ref: string, sessionId: string, inboundMessage: ImInbound): void {
    messageRefs.record(ref, {
      peerKey: imPeerKey(inboundMessage.channel, inboundMessage.accountId, inboundMessage.scope, inboundMessage.peerId),
      sessionId,
      ...(inboundMessage.replyTo === undefined ? {} : { replyTo: inboundMessage.replyTo }),
      at: deps.now(),
    })
  }

  function imTargetOf(inbound: ImInbound): ImTarget {
    return {
      channel: inbound.channel,
      accountId: inbound.accountId,
      scope: inbound.scope,
      peerId: inbound.peerId,
      ...(inbound.replyTo === undefined ? {} : { replyTo: inbound.replyTo }),
    }
  }

  /**
   * 绑定只按原生会话 id 解析；没有自动绑定。旧版 `character/chatId` 绑定
   * 在 store 归一化时已降级成 sessionId，行为与手动绑定一致。
   */
  async function boundSessionOf(peerKey: string): Promise<{ sessionId: string } | undefined> {
    const state = await deps.db.getState()
    const binding = state.imPeers?.[peerKey]
    return binding === undefined ? undefined : { sessionId: binding.sessionId }
  }

  /**
   * 未绑定待办：只记时间与平台显示名（绝不把 openid 前缀当名字）。
   * 每次写入按 lastAt 裁剪到最近 50 条，陌生人群刷不爆 state。
   */
  async function rememberPendingPeer(
    peerKey: string,
    message: ImInbound,
    alias: string,
    now: number,
  ): Promise<void> {
    const senderName = message.scope === 'group' ? displaySenderNameOf(message) : undefined
    const next = await deps.db.updateState((current) => {
      // 绑定可能在本条入站读到「没有绑定」之后、写 pending 之前完成；此时以绑定为准，
      // 不再长出一条同 key 的待办。
      if (current.imPeers?.[peerKey] !== undefined) return {}
      const pending = { ...(current.imPendingPeers ?? {}) }
      pending[peerKey] = {
        lastAt: now,
        ...(senderName === undefined ? {} : { senderName }),
      }
      const recent = Object.entries(pending)
        .sort((left, right) => right[1].lastAt - left[1].lastAt)
        .slice(0, MAX_PENDING_PEERS)
      return { imPendingPeers: Object.fromEntries(recent) }
    })
    if (next.imPeers?.[peerKey] !== undefined) {
      deps.log?.note('debug', `binding for ${alias} appeared before the pending write; pending not recorded`)
      return
    }
    deps.log?.note('info', `no binding for ${alias}; recorded it in the IM panel pending peers`)
  }

  async function sendText(peerKey: string, text: string, options?: { passiveReplyTo?: string }): Promise<ImSendReceipt> {
    const body = text.trim()
    if (body === '') {
      throw new ImSendError('IM_SEND_INVALID', 'IM text is empty after trimming whitespace')
    }
    const { target, channel, scope, settings } = await sendTargetOf(peerKey, options?.passiveReplyTo)
    const chunks = projectImText(body, channel, imChunkLimit(channel, settings))
    try {
      await deps.send(target, chunks.map((chunk, index) => ({
        kind: 'text' as const,
        text: chunk,
        index,
        total: chunks.length,
      })))
    } catch (error) {
      // 主动发送失败必须上抛：工具层要如实告诉模型这条消息没出去。
      deps.log?.note('error', `im_send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`)
      throw new ImSendError('IM_SEND_FAILED', `IM send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`, { cause: error })
    }
    deps.log?.note('info', `im_send delivered ${chunks.length} part(s) to ${imPeerAlias(channel, scope, peerKey)}`)
    return { parts: chunks.length, at: deps.now() }
  }

  async function sendMedia(peerKey: string, media: ImOutboundMedia, options?: { passiveReplyTo?: string }): Promise<ImSendReceipt> {
    if (media.localPath === undefined && media.url === undefined) {
      throw new ImSendError('IM_SEND_INVALID', 'media needs a localPath (preferred) or a url')
    }
    if (media.localPath !== undefined && media.localPath.trim() === '') {
      throw new ImSendError('IM_SEND_INVALID', 'media.localPath is blank; pass an absolute file path or omit it')
    }
    if (media.localPath !== undefined) await assertInsideWorkspace(media.localPath)
    const { target, channel, scope, settings } = await sendTargetOf(peerKey, options?.passiveReplyTo)
    const caption = media.caption?.trim() ?? ''
    // 配文也走按渠道的切分：微信 1800 的上限对 4000 字配文同样成立。
    const captionChunks = caption === ''
      ? []
      : projectImText(caption, channel, imChunkLimit(channel, settings))
    const parts: OutboundPart[] = captionChunks.map((text, index) => ({
      kind: 'text' as const,
      text,
      index,
      total: 1,
    }))
    parts.push({
      kind: media.kind,
      ...(media.localPath === undefined ? {} : { localPath: media.localPath }),
      ...(media.url === undefined ? {} : { url: media.url }),
      ...(media.name === undefined ? {} : { name: media.name }),
      index: parts.length,
      total: 1,
    })
    // total 必须先定下来再发：通道用 index/total 加序号，事后改不了。
    for (const part of parts) part.total = parts.length
    try {
      await deps.send(target, parts)
    } catch (error) {
      deps.log?.note('error', `im_send media to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`)
      throw new ImSendError('IM_SEND_FAILED', `IM media send to ${imPeerAlias(channel, scope, peerKey)} failed: ${messageOf(error)}`, { cause: error })
    }
    deps.log?.note('info', `im_send delivered a ${media.kind} to ${imPeerAlias(channel, scope, peerKey)}`)
    return { parts: parts.length, at: deps.now() }
  }

  /**
   * 调用方给的 peerKey → 出站目标。绑定存在性每次都验：工具面只保证「绑到本
   * 会话」，路由保证「peer 真的有绑定」。
   *
   * `passiveReplyTo` 是消息引用回复的显式锚点：给定时直接用它，替代该 peer 的
   * 自动锚点（模型指名了要回哪一条）；缺省时沿用「最近一条」自动锚点。
   */
  async function sendTargetOf(peerKey: string, passiveReplyTo?: string): Promise<{
    target: ImTarget
    channel: ImChannelId
    scope: ImScope
    settings: ImSettings
  }> {
    const parts = imPeerKeyParts(peerKey)
    if (parts === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `malformed IM peer key '${peerKey}'; expected '<channel>:<accountId>:<scope>:<peerId>'`)
    }
    const channel = channelOf(parts.channel)
    if (channel === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `IM peer key '${peerKey}' names unknown channel '${parts.channel}'`)
    }
    const scope = parts.scope === 'private' || parts.scope === 'group' ? parts.scope : undefined
    if (scope === undefined) {
      throw new ImSendError('IM_SEND_INVALID_TARGET', `IM peer key '${peerKey}' names unknown scope '${parts.scope}'`)
    }
    const state = await deps.db.getState()
    if (state.imPeers?.[peerKey] === undefined) {
      throw new ImSendError('IM_SEND_UNBOUND', `IM peer '${peerKey}' has no binding; bind it in the dsh-soulmojito IM panel first`)
    }
    const anchor = replyAnchors.get(peerKey)
    const fresh = anchor !== undefined && deps.now() - anchor.at <= REPLY_ANCHOR_TTL_MS
    if (anchor !== undefined && !fresh) replyAnchors.delete(peerKey)
    const autoReplyTo = anchor !== undefined && fresh ? anchor.replyTo : undefined
    const replyTo = passiveReplyTo ?? autoReplyTo
    return {
      target: {
        channel,
        accountId: parts.accountId,
        scope,
        peerId: parts.peerId,
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      channel,
      scope,
      settings: state.imSettings ?? DEFAULT_IM_SETTINGS,
    }
  }

  /**
   * 媒体路径必须落在内部工作区内：模型不能把密钥、聊天记录或用户任意文件当
   * 附件发出去（群里的陌生人可以诱导它这么做）。realpath 同时挡住符号链接逃逸。
   */
  async function assertInsideWorkspace(localPath: string): Promise<void> {
    if (deps.workspaceRoot === undefined) return
    let root: string
    let target: string
    try {
      root = await realpath(await deps.workspaceRoot())
      target = await realpath(localPath)
    } catch (cause) {
      throw new ImSendError('IM_SEND_INVALID', `media path '${localPath}' cannot be resolved: ${messageOf(cause)}`)
    }
    const rel = relative(root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ImSendError(
        'IM_SEND_INVALID',
        `media path '${localPath}' is outside the session workspace; only files under the workspace (for example downloaded attachments) can be sent`,
      )
    }
  }

  async function notifyUnbound(target: ImTarget, peerKey: string, alias: string, now: number): Promise<void> {
    const last = noticed.get(peerKey)
    if (last !== undefined && now - last < UNBOUND_NOTICE_TTL_MS) {
      deps.log?.note('debug', `no binding for ${alias}; the bind notice is still suppressed`)
      return
    }
    noticed.set(peerKey, now)
    deps.log?.note('info', `no binding for ${alias}; replied with the bind notice`)
    await sendNotice(target, IM_UNBOUND_NOTICE, alias)
  }

  async function sendNotice(target: ImTarget, text: string, alias: string): Promise<void> {
    try {
      await deps.send(target, [{ kind: 'text', text, index: 0, total: 1 }])
    } catch (error) {
      // 只写日志环一条：`deps.logger` 本身就是同一个 sink 的镜像，写两次会重复。
      deps.log?.note('error', `sending a notice to ${alias} failed: ${messageOf(error)}`)
    }
  }

  return {
    inbound,
    flushPending,
    sendText,
    sendMedia,
    resolveMessageRef: (ref: string) => messageRefs.resolve(ref),
  }
}

/**
 * 入站正文 → 插进会话的插件来源消息正文。
 *
 * 头部给模型四件事：这是 IM 消息不是 DSH 用户输入、来源渠道与范围、回复要用
 * 哪个 peer alias、这条消息的稳定引用与接收时间（`im_send` 的 `replyTo` 可用
 * `msg=` 指回它）。引用是哈希，不带平台身份。群聊的发言人前缀由 `imUserTextOf`
 * 提供。
 */
export function relayTextOf(inbound: ImInbound, body: string, alias: string): string {
  const scope = inbound.scope === 'group' ? '群聊' : '私聊'
  return [
    `[IM ${inbound.channel}/${scope} peer=${alias} msg=${imMessageRef(inbound.dedupeKey)} time=${new Date(inbound.receivedAt).toISOString()}]`,
    body,
    `（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${alias}。）`,
  ].join('\n')
}

/**
 * 入站文本 → 会话里的一条用户消息。
 *
 * 群聊必须带发言人前缀：一个会话里可能有多个人说话，模型只能从文本看出「这是
 * 另一个人说的」。私聊不加前缀，避免每句话都被名字噪声切碎。
 */
export function imUserTextOf(inbound: ImInbound): string | undefined {
  const body = inbound.text.trim()
  const attachments = attachmentSummaryOf(inbound)
  const composed = inbound.scope === 'group'
    ? `[${displaySenderNameOf(inbound) ?? '群成员'}] ${body}`.trim()
    : body
  const withAttachments = attachments === undefined
    ? composed
    : `${composed}${composed === '' ? '' : '\n'}${attachments}`.trim()
  return withAttachments === '' ? undefined : withAttachments
}

/**
 * 平台显示名：QQ 群成员昵称、OneBot 名片等是安全可读的；私聊/C2C 的
 * `senderName` 常是 openid 前缀，不能当名字用——此时宁可缺省。
 */
function displaySenderNameOf(inbound: ImInbound): string | undefined {
  const name = inbound.senderName.trim()
  if (name === '') return undefined
  const id = inbound.senderId.trim()
  if (id.startsWith(name)) return undefined
  return name
}

/**
 * 附件摘要：本地路径必须进正文——模型只有看到路径才能用文件工具打开它。远程
 * 地址只说明「未下载」，不把 URL 塞进上下文（既不可取用，也会被复述出去）。
 */
function attachmentSummaryOf(inbound: ImInbound): string | undefined {
  if (inbound.media.length === 0) return undefined
  const labels = inbound.media.slice(0, 6).map((media) => {
    const label = media.kind === 'image' ? '图片' : media.kind === 'voice' ? '语音' : media.kind === 'video' ? '视频' : '文件'
    if (media.localPath !== undefined) return `${label}（${media.localPath}）`
    if (media.url !== undefined) return `${label}（未下载）`
    return label
  })
  const rest = inbound.media.length > labels.length ? `等 ${inbound.media.length} 个` : ''
  return `（附件：${labels.join('、')}${rest}）`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** peerKey 的渠道段只认三条真实通道；其余值说明绑定键被手改坏了。 */
function channelOf(value: string): ImChannelId | undefined {
  return value === 'qq' || value === 'weixin' || value === 'onebot' ? value : undefined
}
