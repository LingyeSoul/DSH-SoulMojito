/**
 * IM 管理面（提案 0024 §6.2）。
 *
 * 只做投影与配置：账号登记/解绑、绑定、访问控制、模式切换。OneBot 的协议连接
 * 在 `im/onebot/`（反向 WS + webhook），这里只负责把账号交给运行时并把状态
 * 投影成面板可读的形状。密钥只经 POST 请求体进入 store，不经过任何读路由。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { OneBotError } from '../im/onebot/server.js'
import { applyImSettingsPatch, ImSettingsError } from '../im/settings.js'
import { ImStore, ImStoreError } from '../im/store.js'
import type { ImRuntime } from '../im/runtime.js'
import { imDisabledByEnv, ImChannelUnsupportedError } from '../im/runtime.js'
import type { ImAccountRef, ImChannelId, ImChannelView, ImPeerBinding, ImScope } from '../im/types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey, imPeerKeyParts } from '../im/types.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

const CHANNELS: readonly ImChannelId[] = ['qq', 'weixin', 'onebot']

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
    })
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
      if (error instanceof ImStoreError) throw new HttpError(400, error.message)
      if (error instanceof ImChannelUnsupportedError) throw new HttpError(501, error.message)
      if (error instanceof OneBotError) throw new HttpError(400, error.message)
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

  // OneBot HTTP POST 入站（提案 §6.2）：鉴权与事件解析都在通道内，这里只按
  // token 找到归属账号；没有任何账号接受就如实 401。
  if (method === 'POST' && route === 'im/onebot/webhook') {
    if (runtime === undefined) throw new HttpError(503, 'IM runtime is not available in this host process')
    const handled = await runtime.handleOneBotWebhook(req, res)
    if (!handled) return sendJson(res, 401, { ok: false, message: 'no OneBot account accepts this token' })
    return
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

function parseScope(value: unknown): ImScope {
  if (value !== 'private' && value !== 'group') throw new HttpError(400, "scope must be 'private' or 'group'")
  return value
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} must be a non-empty string`)
  return value.trim()
}
