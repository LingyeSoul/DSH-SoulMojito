/**
 * IM 管理面（提案 0024 §6.2）。
 *
 * 只做投影与配置：账号登记/解绑、扫码绑定相位、绑定、访问控制、模式切换。协议
 * 连接在 `im/onebot/` 与 `im/qq/`，这里只负责把账号交给运行时并把状态投影成面板
 * 可读的形状。密钥只经 POST 请求体进入 store，不经过任何读路由。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { OneBotError } from '../im/onebot/server.js'
import { QQBindError } from '../im/qq/bind.js'
import { QQChannelError } from '../im/qq/channel.js'
import { installQqRuntime } from '../im/qq/install.js'
import { qqRuntimeStatus, QqRuntimeError } from '../im/qq/sdk.js'
import { applyImSettingsPatch, ImSettingsError } from '../im/settings.js'
import type { ImLogLevel } from '../im/log.js'
import { ImStore, ImStoreError } from '../im/store.js'
import type { ImRuntime } from '../im/runtime.js'
import { imDisabledByEnv, ImChannelUnsupportedError } from '../im/runtime.js'
import { WeixinApiError } from '../im/weixin/api.js'
import { WeixinBindError, type WeixinBindErrorCode } from '../im/weixin/bind.js'
import { WeixinChannelError, type WeixinChannelErrorCode } from '../im/weixin/channel.js'
import type { ImAccountRef, ImChannelId, ImChannelView, ImPeerBinding, ImScope } from '../im/types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey, imPeerKeyParts } from '../im/types.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { INTERNAL_ERROR_MESSAGE, publicErrorMessage } from './public-error.js'

const CHANNELS: readonly ImChannelId[] = ['qq', 'weixin', 'onebot']

/** 同一时刻只允许一次 QQ 运行时安装：并发 pnpm 会互相踩 lockfile。 */
let qqInstallInFlight: Promise<unknown> | undefined

export async function handleImApi(
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
  db: TavernStore,
  runtime: ImRuntime | undefined,
): Promise<void> {
  if (!route.startsWith('im')) return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })

  if (method === 'GET' && route === 'im') {
    const state = await db.getState()
    const disabled = imDisabledByEnv()
    return sendJson(res, 200, {
      ok: true,
      disabled,
      available: !disabled && runtime !== undefined && runtime.capabilities.available,
      reasons: disabled
        ? ['DSH_SOULMOJITO_DISABLE_IM is set']
        : (runtime?.capabilities.reasons ?? ['IM runtime was not mounted in this host process']),
      settings: state.imSettings ?? DEFAULT_IM_SETTINGS,
      peers: peerRows(state.imPeers),
      // 账号清单是 store 的事实、状态是运行时的投影：只列内存通道会让重启前的
      // 账号在面板上凭空消失，也会让「已配置但未连上」显示成不存在。
      channels: await channelViews(runtime, state.imPeers),
      // 两个腾讯包外挂安装：面板据此显示安装指引，而不是把「没装 SDK」显示成通道故障。
      qqRuntime: await qqRuntimeStatus(),
    })
  }

  // 腾讯包自动安装（2026-10-31）：与本地 ONNX 运行时同款一键安装。面板永远
  // 不把 shell 命令甩给用户；安装输出可能带绝对路径，敏感时只留在服务端日志。
  if (method === 'POST' && route === 'im/qq/install') {
    if (qqInstallInFlight !== undefined) {
      return sendJson(res, 409, { ok: false, message: 'a QQ runtime install is already in progress' })
    }
    const install = installQqRuntime({})
    qqInstallInFlight = install
    try {
      const outcome = await install
      const outputTail = safeInstallOutput(outcome.outputTail)
      if (!outcome.ok) {
        const detail = publicErrorMessage(new Error(outcome.message ?? 'the QQ runtime install failed'))
        const base = detail === INTERNAL_ERROR_MESSAGE
          ? 'the QQ runtime install failed; see the IM log for details'
          : detail
        // 输出尾段随失败一起给面板：pnpm 的失败原因多半只在 tail 里（脱敏失败时已置 undefined）。
        return sendJson(res, 400, {
          ok: false,
          message: outputTail === undefined ? base : `${base}\n${outputTail}`,
        })
      }
      return sendJson(res, 200, {
        ok: true,
        alreadyInstalled: outcome.alreadyInstalled,
        ...(outputTail === undefined ? {} : { outputTail }),
      })
    } finally {
      qqInstallInFlight = undefined
    }
  }

  if (method === 'POST' && route === 'im/accounts') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const body = await readJson(req)
    const channel = parseChannel(body.channel)
    const accountId = requireId(body.accountId, 'accountId')
    const secret = parseSecretBag(body.secret)
    const label = optionalLabel(body.label)
    // 更新已有账号时保留原始 createdAt：面板用它的排序与「绑定于」文案不能跳。
    const accounts = await ImStore.open(tavernDataRoot('im')).accounts()
    const existing = accounts.find((entry) => entry.channel === channel && entry.accountId === accountId)
    // 只换 token 时省略 label 不应把已有标签抹掉；显式传 label 才覆盖。
    const effectiveLabel = label ?? existing?.label
    const account: ImAccountRef = {
      channel,
      accountId,
      ...(effectiveLabel === undefined ? {} : { label: effectiveLabel }),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    try {
      await runtime.upsertAccount(account, secret)
    } catch (error) {
      if (error instanceof ImStoreError) throw new HttpError(400, safeHttpMessage(error, 'the IM store rejected the request; see the IM log for details'))
      if (error instanceof ImChannelUnsupportedError) throw new HttpError(501, error.message)
      if (error instanceof OneBotError) throw new HttpError(400, safeHttpMessage(error, 'the OneBot endpoint rejected the request; see the IM log for details'))
      if (error instanceof QQChannelError) throw new HttpError(400, safeHttpMessage(error, 'the QQ channel rejected the request; see the IM log for details'))
      // 微信凭据/参数错误与 QQ 同口径：坏输入 400，通道没在跑/状态读不出来 503。
      if (error instanceof WeixinChannelError) throw new HttpError(weixinChannelErrorStatus(error.code), safeHttpMessage(error, 'the WeChat channel rejected the request; see the IM log for details'))
      // 腾讯包没装是部署事实，不是用户输入错误：503 + 面板口径（不带绝对路径）。
      if (error instanceof QqRuntimeError) throw new HttpError(503, qqRuntimeUnavailableMessage(error))
      throw error
    }
    return sendJson(res, 200, { ok: true, account })
  }

  if (method === 'DELETE' && route === 'im/accounts') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const channel = parseChannel(url.searchParams.get('channel'))
    const accountId = requireId(url.searchParams.get('accountId'), 'accountId')
    const removed = await runtime.removeAccount(channel, accountId)
    if (!removed) {
      return sendJson(res, 404, { ok: false, message: `no IM account ${channel}/${accountId}` })
    }
    return sendJson(res, 200, { ok: true })
  }

  // 扫码绑定（提案 0024 §4.1 / §6.2）：QQ 与微信两条真实通道。OneBot 没有二维码，
  // 请求它时如实 501；微信多一个 verify 相位（POST im/bind/verify）。
  if (method === 'POST' && route === 'im/bind/start') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const body = await readJson(req)
    const channel = parseChannel(body.channel)
    if (channel === 'onebot') {
      throw new HttpError(501, 'QR binding for \'onebot\' is not available: OneBot endpoints are configured with a token, not a QR code')
    }
    if (runtime.startQrBind === undefined) throw new HttpError(501, 'this IM runtime exposes no QR binding')
    try {
      return sendJson(res, 200, { ok: true, ...(await runtime.startQrBind(channel)) })
    } catch (error) {
      // 已有会话在跑不是服务器错误：面板据此提示「先取消上一次扫码」。
      if (error instanceof QQBindError) throw new HttpError(error.code === 'QQ_BIND_BUSY' ? 409 : 503, safeHttpMessage(error, 'the QQ scan could not start; see the IM log for details'))
      if (error instanceof WeixinBindError) throw new HttpError(bindErrorStatus(error.code), safeHttpMessage(error, 'the WeChat scan was rejected; see the IM log for details'))
      // 拉二维码是真实网络请求：上游不可用是部署事实，不是用户输入错误。
      if (error instanceof WeixinApiError) throw new HttpError(503, safeHttpMessage(error, 'the WeChat backend is unavailable; see the IM log for details'))
      if (error instanceof ImChannelUnsupportedError) throw new HttpError(501, error.message)
      // 连接器是运行期加载的：没装腾讯包时如实 503，文案指向面板按钮。
      if (error instanceof QqRuntimeError) throw new HttpError(503, qqRuntimeUnavailableMessage(error))
      throw error
    }
  }

  // 微信验证码（`need_verifycode` 相位）：服务端解析后继续轮询，成功与否都体现在
  // 下一次 `im/bind/status` 的相位上。
  if (method === 'POST' && route === 'im/bind/verify') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    if (runtime.submitQrVerifyCode === undefined) {
      throw new HttpError(501, 'this IM runtime exposes no verification-code binding (only the WeChat QR flow needs one)')
    }
    const body = await readJson(req)
    const code = body.code
    if (typeof code !== 'string' || code.trim() === '') {
      throw new HttpError(400, 'code must be a non-empty string (the digits shown in the mobile WeChat app)')
    }
    try {
      return sendJson(res, 200, { ok: true, ...runtime.submitQrVerifyCode(code) })
    } catch (error) {
      if (error instanceof WeixinBindError) throw new HttpError(bindErrorStatus(error.code), error.message)
      throw error
    }
  }

  if (method === 'GET' && route === 'im/bind/status') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const status = runtime.qrBindStatus?.() ?? { phase: 'idle' as const }
    return sendJson(res, 200, { ok: true, ...status })
  }

  if (method === 'POST' && route === 'im/bind/cancel') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const status = runtime.cancelQrBind?.() ?? { phase: 'idle' as const }
    return sendJson(res, 200, { ok: true, ...status })
  }

  // OneBot HTTP POST 入站（提案 §6.2）：鉴权与事件解析都在通道内，这里只按
  // token 找到归属账号；没有任何账号接受就如实 401。
  if (method === 'POST' && route === 'im/onebot/webhook') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const handled = await runtime.handleOneBotWebhook(req, res)
    if (!handled) return sendJson(res, 401, { ok: false, message: 'no OneBot account accepts this token' })
    return
  }

  if (method === 'GET' && route === 'im/logs') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const limit = parseLogLimit(url.searchParams.get('limit'))
    const afterSeq = parseLogAfter(url.searchParams.get('after'))
    const minLevel = parseLogLevel(url.searchParams.get('level'))
    const snapshot = runtime.logs === undefined
      ? { entries: [], nextSeq: 0 }
      : runtime.logs({
        limit,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        ...(minLevel === undefined ? {} : { minLevel }),
      })
    // 时间对面板只用于显示：ISO 字符串比 epoch 更不容易被误当成本地时间。
    return sendJson(res, 200, {
      ok: true,
      nextSeq: snapshot.nextSeq,
      entries: snapshot.entries.map((entry) => ({
        seq: entry.seq,
        at: new Date(entry.at).toISOString(),
        level: entry.level,
        text: entry.text,
      })),
    })
  }

  if (method === 'POST' && route === 'im/settings') {
    const body = await readJson(req)
    const current = (await db.getState()).imSettings ?? DEFAULT_IM_SETTINGS
    let next
    try {
      next = applyImSettingsPatch(current, body.settings ?? body)
    } catch (error) {
      if (error instanceof ImSettingsError) throw new HttpError(400, error.message)
      throw error
    }
    await db.patchState({ imSettings: next })
    return sendJson(res, 200, { ok: true, settings: next })
  }

  if (method === 'POST' && route === 'im/peers') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const body = await readJson(req)
    const channel = parseChannel(body.channel)
    const scope = parseScope(body.scope)
    const accountId = requireId(body.accountId, 'accountId')
    const peerId = requireId(body.peerId, 'peerId')
    const character = requireId(body.character, 'character')
    const chatId = requireId(body.chatId, 'chatId')
    const key = imPeerKey(channel, accountId, scope, peerId)
    const state = await db.getState()
    const existing = state.imPeers?.[key]
    const result = await runtime.bindChat({ character, chatId }, existing?.sessionId)
    const binding: ImPeerBinding = {
      sessionId: result.sessionId,
      character: result.character,
      chatId: result.chatId,
      scope,
      boundBy: 'manual',
      createdAt: new Date().toISOString(),
    }
    await db.updateState((current) => ({
      imPeers: { ...(current.imPeers ?? {}), [key]: binding },
    }))
    return sendJson(res, 200, { ok: true, peer: { key, ...binding } })
  }

  if (method === 'DELETE' && route === 'im/peers') {
    const key = url.searchParams.get('key')
    if (key === null || key.trim() === '') throw new HttpError(400, 'key query is required')
    const state = await db.getState()
    if (state.imPeers?.[key] === undefined) return sendJson(res, 404, { ok: false, message: `no IM peer binding for ${key}` })
    // 解绑只删这一条：聊天与会话按产品决定保留，用户可以回到网页继续聊。
    const next = await db.updateState((current) => {
      const peers = { ...(current.imPeers ?? {}) }
      delete peers[key]
      return { imPeers: peers }
    })
    return sendJson(res, 200, { ok: true, peers: peerRows(next.imPeers) })
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

function peerRows(peers: Record<string, ImPeerBinding> | undefined): Array<{ key: string } & ImPeerBinding> {
  return Object.entries(peers ?? {})
    .map(([key, binding]) => ({ key, ...binding }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * store 账号 × 运行时状态的并集。账号是配置事实，通道状态是进程事实：
 * 重启后账号还在但通道尚未接回时，面板必须显示 idle 而不是「不存在」。
 */
async function channelViews(
  runtime: ImRuntime | undefined,
  peers: Record<string, ImPeerBinding> | undefined,
): Promise<ImChannelView[]> {
  const accounts = await ImStore.open(tavernDataRoot('im')).accounts()
  const live = new Map<string, ImChannelView>()
  for (const view of runtime?.views() ?? []) live.set(imAccountKey(view.channel, view.accountId), view)
  const rows: ImChannelView[] = []
  for (const account of accounts) {
    const key = imAccountKey(account.channel, account.accountId)
    const view = live.get(key)
    live.delete(key)
    rows.push({
      channel: account.channel,
      accountId: account.accountId,
      ...(account.label === undefined ? {} : { label: account.label }),
      status: view?.status ?? { state: 'idle' },
      peers: peerCount(peers, account.channel, account.accountId),
    })
  }
  // 运行时里活着但 store 里没有的通道照实带上，别名路径不隐藏异常状态。
  rows.push(...live.values())
  return rows
}

function peerCount(
  peers: Record<string, ImPeerBinding> | undefined,
  channel: ImChannelId,
  accountId: string,
): number {
  let count = 0
  for (const key of Object.keys(peers ?? {})) {
    const parts = imPeerKeyParts(key)
    if (parts !== undefined && parts.channel === channel && parts.accountId === accountId) count += 1
  }
  return count
}

function imAccountKey(channel: ImChannelId, accountId: string): string {
  return `${channel}:${accountId}`
}


/**
 * HTTP 错误面收口：内部错误消息可能带绝对路径（store 游标文件、媒体本地路径），
 * 先过 `publicErrorMessage` 的分类器，敏感时换成不含路径的固定文案。状态码语义
 * 不变——400/503 的分工仍由调用点决定。
 */
function safeHttpMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return publicErrorMessage(new Error(message)) === INTERNAL_ERROR_MESSAGE ? fallback : message
}

function parseSecretBag(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'secret must be an object of string values')
  }
  const bag: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new HttpError(400, `secret.${key} must be a string`)
    bag[key] = entry
  }
  return bag
}

function optionalLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'label must be a non-empty string')
  return value.trim()
}

function parseChannel(value: unknown): ImChannelId {
  if (typeof value !== 'string' || !CHANNELS.includes(value as ImChannelId)) {
    throw new HttpError(400, `channel must be one of ${CHANNELS.join(' | ')}`)
  }
  return value as ImChannelId
}

/**
 * 微信通道错误 → HTTP 状态：坏凭据/坏参数是用户输入（400）；通道没在跑、
 * 持久化状态读不出来、发送失败属运行时事实（503）。与 `QQChannelError → 400`、
 * `QqRuntimeError → 503` 同口径。
 */
function weixinChannelErrorStatus(code: WeixinChannelErrorCode): number {
  if (code === 'WEIXIN_BAD_SECRET' || code === 'WEIXIN_BAD_TARGET' || code === 'WEIXIN_BAD_MESSAGE') return 400
  return 503
}

/**
 * 微信绑定错误 → HTTP 状态：验证码本身坏是 400；「不是现在能做的事」
 * （忙碌、不在 verify 相位、没有会话、刷新额度用完）是 409；其余按不可用 503。
 */
function bindErrorStatus(code: WeixinBindErrorCode): number {
  if (code === 'WEIXIN_BIND_BAD_CODE') return 400
  if (
    code === 'WEIXIN_BIND_BUSY'
    || code === 'WEIXIN_BIND_NOT_VERIFYING'
    || code === 'WEIXIN_BIND_IDLE'
    || code === 'WEIXIN_BIND_REFRESH_EXHAUSTED'
  ) return 409
  return 503
}

function parseScope(value: unknown): ImScope {
  if (value !== 'private' && value !== 'group') throw new HttpError(400, "scope must be 'private' or 'group'")
  return value
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} must be a non-empty string`)
  return value.trim()
}

/**
 * 安装输出可能含绝对路径与用户名，只回传「看起来不敏感」的文本；其余写服务端
 * 日志（与 memory/embed 的一键安装同口径）。
 */
function safeInstallOutput(outputTail: string): string | undefined {
  if (outputTail === '') return undefined
  if (publicErrorMessage(new Error(outputTail)) !== INTERNAL_ERROR_MESSAGE) return outputTail
  console.warn('dsh-soulmojito qq runtime install output withheld', {
    operation: 'qq-runtime-install',
    outputTail,
  })
  return undefined
}

/** 日志读取窗口：缺省 200，硬上限 500（与环形缓冲容量一致）。 */
function parseLogLimit(value: string | null): number {
  if (value === null || value === '') return 200
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new HttpError(400, 'limit must be an integer in 1..500')
  }
  return parsed
}

function parseLogAfter(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'after must be a non-negative integer (the nextSeq of the previous page)')
  }
  return parsed
}

function parseLogLevel(value: string | null): ImLogLevel | undefined {
  if (value === null || value === '') return undefined
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  throw new HttpError(400, "level must be one of 'debug' | 'info' | 'warn' | 'error'")
}

/**
 * QQ 运行时不可用的用户可见文案：`QqRuntimeError.message` 带入口绝对路径，
 * 那是服务端排障信息，不进 HTTP 响应（与媒体/安装输出同一条隐私纪律）。
 */
function qqRuntimeUnavailableMessage(error: QqRuntimeError): string {
  const detail = error.code === 'QQ_RUNTIME_MISSING'
    ? 'is not installed or cannot be loaded'
    : 'is installed but does not expose the expected exports'
  return `the QQ runtime ${detail}; open the IM panel and press 安装 QQ 依赖 to install or repair it`
}
