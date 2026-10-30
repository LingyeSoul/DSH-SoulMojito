/**
 * IM 管理面（提案 0024 §6.2）。
 *
 * 只做投影与配置：绑定、解绑、访问控制、模式切换。协议侧的扫码/连接在后续
 * 里程碑接入，这里先保证「面板能看见状态、能手工把一个聊天绑给一个 peer」。
 * 任何密钥都不经过这些路由。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { applyImSettingsPatch, ImSettingsError } from '../im/settings.js'
import type { ImRuntime } from '../im/runtime.js'
import { imDisabledByEnv } from '../im/runtime.js'
import type { ImChannelId, ImPeerBinding, ImScope } from '../im/types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey } from '../im/types.js'
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
      channels: runtime?.views() ?? [],
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
