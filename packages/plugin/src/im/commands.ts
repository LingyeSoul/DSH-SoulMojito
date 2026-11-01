/**
 * IM 侧斜杠指令（决策 2026-11-01-im-global-owner-and-commands）：
 * `/status`、`/bind <sessionId>`、`/unbind`、`/help` 由插件直接执行，
 * 指令文本**永不进入模型会话**。
 *
 * 只有账号的**全局主人**（`imAccountOwners[channel:accountId]`）可以执行：
 * 会话级主人（`imOwners[peerKey]`）是标记用的覆盖项，不构成执行权限——
 * 否则群聊里被设为「会话主人」的任何一个成员都能改绑会话。
 *
 * 微信渠道不参与主人指定，也不支持指令：私聊专用通道没有「其他成员」需要
 * 区分，保留一条拒绝回复比静默吞掉更容易排障。
 *
 * 顺序与路由的既有路径一致：先平台去重（重放的指令不执行第二次），再访问
 * 控制（白名单外的人拿不到任何回复），最后才是指令解析与主人校验。指令不是
 * 会话消息：不写 `imSenders`/`imOwners`，也不触发绑定会话的预设切换。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { ImPresetSwitchResult } from './handle.js'
import type { ImLogSink } from './log.js'
import { imSenderHash } from './owner.js'
import { imAccessAllows } from './settings.js'
import type { ImInbound, ImPeerBinding, ImSendStatusView, ImSettings, ImTarget } from './types.js'
import { DEFAULT_IM_SETTINGS, imAccountKey, imPeerAlias } from './types.js'

/** 非全局主人（含未设置全局主人）的拒绝文案；只说明规则，不回显身份。 */
export const IM_COMMAND_DENIED = '只有全局主人可以使用指令'

/** 微信渠道没有主人概念，指令一律不支持。 */
export const IM_COMMAND_CHANNEL_UNSUPPORTED = '微信渠道不支持指令（微信不需要设置主人）'

/** 未知指令的用法提示。 */
export const IM_COMMAND_USAGE = '可用指令：/status、/bind <sessionId>、/unbind、/help'

/** `/bind` 缺少参数时的用法提示。 */
export const IM_COMMAND_BIND_USAGE = '用法：/bind <sessionId>'

/** `/help` 的正文：四个指令 + 全局主人规则。 */
export const IM_COMMAND_HELP = [
  '可用指令（只有账号的全局主人可以使用）：',
  '/status 查看当前状态',
  '/bind <sessionId> 把本对话绑到指定会话',
  '/unbind 解除本对话的绑定',
  '/help 查看这份帮助',
].join('\n')

/** `/unbind` 成功与「本来就没绑」的两种回执。 */
export const IM_COMMAND_UNBOUND_OK = '已解除本对话的绑定'
export const IM_COMMAND_UNBOUND_NONE = '本对话当前未绑定'

/** 一条被截断的斜杠指令：`name` 已去首尾空白并转小写，`argument` 是剩余文本。 */
export interface ImParsedCommand {
  name: string
  argument: string
}

/**
 * 行首提及段（决策 2026-11-01-im-global-owner-and-commands）：OneBot codec 把
 * at 段渲染成 `@<qq>`，QQ 的 content 可能保留 `<@appid>` / `<@!appid>`。只认
 * ASCII id 形状，`@全体成员` 这类展示文本不会被误剥。
 */
const IM_MENTION_PREFIX = /^(?:<@!?[A-Za-z0-9_.:-]+>|@[A-Za-z0-9_.:-]+)/

/**
 * 指令候选文本：剥掉行首连续的提及段后再看是否以 `/` 开头。
 *
 * `groupRequireMention: true`（默认）下 OneBot 群消息正文必然带 `@机器人`
 * 前缀，不剥就永远认不出 `/status`；剥完后不是 `/` 的消息继续走普通入站路径。
 * 返回的是剥提及后的正文，指令参数从这个字符串解析。
 */
export function imCommandTextOf(text: string): string | undefined {
  let candidate = text.trim()
  for (;;) {
    const mention = IM_MENTION_PREFIX.exec(candidate)
    if (mention === null) break
    candidate = candidate.slice(mention[0].length).trimStart()
  }
  return candidate.startsWith('/') ? candidate : undefined
}

/**
 * 指令文本判定：剥掉行首提及段后以 `/` 开头。判定只看文本，不看附件——
 * 带附件的斜杠消息仍按指令处理，附件不会落盘（指令路径不物化媒体）。
 */
export function isImCommandText(text: string): boolean {
  return imCommandTextOf(text) !== undefined
}

/** 解析指令名与参数；不是指令时返回 undefined。`/` 单独出现算未知指令。 */
export function parseImCommand(text: string): ImParsedCommand | undefined {
  const candidate = imCommandTextOf(text)
  if (candidate === undefined) return undefined
  const body = candidate.slice(1)
  const spaceAt = body.search(/\s/)
  if (spaceAt < 0) return { name: body.toLowerCase(), argument: '' }
  return {
    name: body.slice(0, spaceAt).toLowerCase(),
    argument: body.slice(spaceAt + 1).trim(),
  }
}

/** 会话 id 的展示遮罩：与面板「短 id」同口径，避免把完整 id 贴进聊天窗口。 */
export function imMaskSessionId(sessionId: string): string {
  const trimmed = sessionId.trim()
  return trimmed.length > 12 ? `${trimmed.slice(0, 8)}…` : trimmed
}

export interface ImCommandDeps {
  db: Pick<TavernStore, 'getState' | 'updateState'>
  now: () => number
  /** 同路由的平台去重：重放的指令不会执行第二次。 */
  seenDedupe: (dedupeKey: string, now: number) => Promise<boolean>
  /** 复用路由的 sendNotice：一条短文本，不进会话（调用方不等待它完成）。 */
  sendNotice: (target: ImTarget, text: string, alias: string) => Promise<void>
  /** 出站节奏投影；缺省时 `/status` 省略发送行而不是编造状态。 */
  sendStatuses?: () => readonly ImSendStatusView[]
  /** `/bind` 之后的 AgentTavernIM 预设切换；缺省时回执说明「预设未切换」。 */
  applyImPreset?: (sessionId: string) => Promise<ImPresetSwitchResult>
  log?: ImLogSink
}

/** 路由能提供的全部接线；`handleImCommandIfAny` 用它避免 router 里再拼一份字面量。 */
export interface ImCommandWiring {
  db: Pick<TavernStore, 'getState' | 'updateState'>
  now: () => number
  seenDedupe: (dedupeKey: string, now: number) => Promise<boolean>
  sendStatuses?: () => readonly ImSendStatusView[]
  applyImPreset?: (sessionId: string) => Promise<ImPresetSwitchResult>
  log?: ImLogSink
}

export interface ImCommandInput {
  inbound: ImInbound
  peerKey: string
  alias: string
}

/**
 * 路由的唯一指令入口：文本不是指令时返回 false（继续走缓冲/合流），是则执行并
 * 返回 true。提及剥离、去重、访问控制、主人校验与回执都收在本模块，router 只
 * 保留一行分支。
 */
export async function handleImCommandIfAny(
  wiring: ImCommandWiring,
  inbound: ImInbound,
  peerKey: string,
  sendNotice: ImCommandDeps['sendNotice'],
): Promise<boolean> {
  if (!isImCommandText(inbound.text)) return false
  await handleImCommand({
    db: wiring.db,
    now: wiring.now,
    seenDedupe: wiring.seenDedupe,
    sendNotice,
    ...(wiring.sendStatuses === undefined ? {} : { sendStatuses: wiring.sendStatuses }),
    ...(wiring.applyImPreset === undefined ? {} : { applyImPreset: wiring.applyImPreset }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  }, {
    inbound,
    peerKey,
    alias: imPeerAlias(inbound.channel, inbound.scope, peerKey),
  })
  return true
}

/**
 * 入站指令的全部副作用入口：去重 → 访问控制 → 主人校验 → 执行 → 回执。
 * 由 `handleImCommandIfAny` 在判定为指令后调用。
 */
export async function handleImCommand(deps: ImCommandDeps, input: ImCommandInput): Promise<void> {
  const { inbound, alias, peerKey } = input
  if (await deps.seenDedupe(inbound.dedupeKey, deps.now())) {
    deps.log?.note('debug', `ignored a duplicate IM command from ${alias} (dedupe)`)
    return
  }
  const settings: ImSettings = (await deps.db.getState()).imSettings ?? DEFAULT_IM_SETTINGS
  if (!imAccessAllows(settings, inbound.scope, inbound.peerId)) {
    deps.log?.note(
      'warn',
      `dropped an IM command from ${alias}: the access policy does not allow this peer (mode is allowlist and the peer is not listed, or the scope is disabled)`,
    )
    return
  }
  const reply = await runImCommand(deps, { inbound, peerKey, alias })
  if (reply === undefined) return
  // 回执不阻塞入站链：通道发送可能排队/超时，控制面回复不该拖住下一条消息。
  void deps.sendNotice(targetOf(inbound), reply, alias).catch((error: unknown) => {
    deps.log?.note('warn', `sending an IM command reply to ${alias} failed: ${messageOf(error)}`)
  })
}

async function runImCommand(deps: ImCommandDeps, input: ImCommandInput): Promise<string | undefined> {
  const command = parseImCommand(input.inbound.text)
  if (command === undefined) return undefined
  if (input.inbound.channel === 'weixin') return IM_COMMAND_CHANNEL_UNSUPPORTED
  const state = await deps.db.getState()
  const owner = state.imAccountOwners?.[imAccountKey(input.inbound.channel, input.inbound.accountId)]
  const senderHash = imSenderHash(input.inbound.channel, input.inbound.accountId, input.inbound.senderId)
  if (owner === undefined || owner.id !== senderHash) {
    deps.log?.note('warn', `denied IM command /${command.name} from ${input.alias}: the sender is not the account-global owner`)
    return IM_COMMAND_DENIED
  }
  deps.log?.note('info', `executed IM command /${command.name} from ${input.alias}`)
  switch (command.name) {
    case 'status':
      return statusReply(deps, input, state.imPeers, owner)
    case 'bind':
      return bindReply(deps, input, command.argument)
    case 'unbind':
      return unbindReply(deps, input)
    case 'help':
      return IM_COMMAND_HELP
    default:
      return IM_COMMAND_USAGE
  }
}

/** `/bind`：写绑定与待办，不创建/恢复会话；预设切换是 best-effort，不改绑定结果。 */
async function bindReply(deps: ImCommandDeps, input: ImCommandInput, argument: string): Promise<string> {
  const sessionId = argument.trim()
  if (sessionId === '') return IM_COMMAND_BIND_USAGE
  const binding: ImPeerBinding = {
    sessionId,
    scope: input.inbound.scope,
    boundBy: 'command',
    createdAt: new Date(deps.now()).toISOString(),
  }
  await deps.db.updateState((current) => {
    const pending = { ...(current.imPendingPeers ?? {}) }
    delete pending[input.peerKey]
    return {
      imPeers: { ...(current.imPeers ?? {}), [input.peerKey]: binding },
      imPendingPeers: pending,
    }
  })
  deps.log?.note('info', `bound ${input.alias} to a session by /bind (boundBy=command)`)
  const preset = await presetNoteOf(deps, sessionId, input.alias)
  return `已绑定到会话 ${imMaskSessionId(sessionId)}；${preset}`
}

/** `/bind` 预设切换失败的固定回执：原因只进运行日志，绝不发给对端。 */
export const IM_COMMAND_PRESET_FAILED = '预设切换失败（详见运行日志）'

/**
 * `/bind` 之后的预设切换说明：best-effort，失败不影响绑定本身。与面板改绑
 * 同一条语义——会话未打开/正在运行时留待宿主重试，而不是宣称已经切好。
 *
 * 失败原因只写 `deps.log`：回执会在群聊里可见，host 术语、preset 名称与
 * 异常原文（可能带绝对路径）不能发给对端。
 */
async function presetNoteOf(deps: ImCommandDeps, sessionId: string, alias: string): Promise<string> {
  if (deps.applyImPreset === undefined) return '预设未切换（运行时未提供切换能力）'
  try {
    const result = await deps.applyImPreset(sessionId)
    if (result.applied) return '已切换到 AgentTavernIM'
    const reason = result.reason ?? 'unknown reason'
    if (/running|not open/i.test(reason)) return '预设待切换（会话未打开或正在运行）'
    deps.log?.note('warn', `switching the bound session to AgentTavernIM for ${alias} failed: ${reason}`)
    return IM_COMMAND_PRESET_FAILED
  } catch (error) {
    deps.log?.note('warn', `switching the bound session to AgentTavernIM for ${alias} failed: ${messageOf(error)}`)
    return IM_COMMAND_PRESET_FAILED
  }
}

/** `/unbind`：同时清掉绑定与未绑定待办；两者都不存在时如实回「未绑定」。 */
async function unbindReply(deps: ImCommandDeps, input: ImCommandInput): Promise<string> {
  const state = await deps.db.getState()
  if (state.imPeers?.[input.peerKey] === undefined && state.imPendingPeers?.[input.peerKey] === undefined) {
    return IM_COMMAND_UNBOUND_NONE
  }
  await deps.db.updateState((current) => {
    const peers = { ...(current.imPeers ?? {}) }
    const pending = { ...(current.imPendingPeers ?? {}) }
    delete peers[input.peerKey]
    delete pending[input.peerKey]
    return { imPeers: peers, imPendingPeers: pending }
  })
  deps.log?.note('info', `unbound ${input.alias} by /unbind`)
  return IM_COMMAND_UNBOUND_OK
}

/** `/status`：渠道/范围/alias、会话、全局主人、当前时间与可选的发送节奏。 */
function statusReply(
  deps: ImCommandDeps,
  input: ImCommandInput,
  peers: Record<string, ImPeerBinding> | undefined,
  owner: { id: string; name: string },
): string {
  const inbound = input.inbound
  const binding = peers?.[input.peerKey]
  const lines = [
    '状态',
    `渠道：${inbound.channel} · ${inbound.scope === 'group' ? '群聊' : '私聊'}`,
    `对端：${input.alias}`,
    `会话：${binding === undefined ? '未绑定' : imMaskSessionId(binding.sessionId)}`,
    `全局主人：${owner.name.trim() === '' ? owner.id : owner.name.trim()}`,
    `时间：${new Date(deps.now()).toLocaleString()}`,
  ]
  const send = sendSummaryOf(deps, inbound)
  if (send !== undefined) lines.push(send)
  return lines.join('\n')
}

/** 发送节奏行：只投影本渠道本账号的一行；没有投影就整行省略。 */
function sendSummaryOf(deps: ImCommandDeps, inbound: ImInbound): string | undefined {
  const status = (deps.sendStatuses?.() ?? []).find(
    (row) => row.channel === inbound.channel && row.accountId === inbound.accountId,
  )
  if (status === undefined) return undefined
  const parts = [status.allowedNow ? '现在可发' : '需要等待']
  if (!status.allowedNow && status.nextSendAt !== undefined) parts.push(`下次 ${timeOf(status.nextSendAt)}`)
  if (status.throttleUntil !== undefined) parts.push(`冷却至 ${timeOf(status.throttleUntil)}`)
  parts.push(`队列 ${status.queueDepth} 条`)
  return `发送：${parts.join(' · ')}`
}

function timeOf(at: number): string {
  return new Date(at).toLocaleString()
}

function targetOf(inbound: ImInbound): ImTarget {
  return {
    channel: inbound.channel,
    accountId: inbound.accountId,
    scope: inbound.scope,
    peerId: inbound.peerId,
    ...(inbound.replyTo === undefined ? {} : { replyTo: inbound.replyTo }),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
