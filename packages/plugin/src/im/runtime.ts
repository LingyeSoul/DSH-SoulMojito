/**
 * IM 运行时（提案 0024 §3）：把通道、路由、会话托管与宿主 seam 装到一起。
 *
 * 单进程单实例，由 `apply()` 创建、`ctx.effect` 的 disposer 关闭。OneBot 是
 * 第一条真实通道：账号来自 store，反向 WS 走 `webServer.registerUpgrade`，缺
 * 这条 seam 的宿主只剩 HTTP POST webhook——能力原因写进 `capabilities.reasons`，
 * 面板据此显示限制而不是假装反向 WS 可用。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { AGENT_TAVERN_PRESET_ID } from '../agent-tavern/capabilities.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { envCompat } from '../env-compat.js'
import type { HostLogger, HostSessionEventLike, HostSessionLike, PluginContext } from '../host-contract.js'
import { API } from '../http/router.js'
import { ensureAgentPresetDeclared } from '../http/novel.js'
import { displayTextForMessage } from '../prompt-context.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { bindSession } from '../session/binding.js'
import type { ChatMessage } from '../../../tavern-format/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { sessionEvents } from '../../../bind/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { prepareInternalWorkspace } from '../workspace.js'
import { imDisabledByEnv, type ImRuntimeHandle } from './handle.js'
import { createOneBotUpgradeHandler, OneBotChannel } from './onebot/server.js'
import { ensureOneBotUpgradeSeat } from './onebot/seat.js'
import { createImRouter, type ImRouter } from './router.js'
import {
  bindImChat,
  ensureImAgent,
  ensureImSession,
  inspectImSessionCapabilities,
  type ImAgentsSeam,
  type ImPresetsSeam,
  type ImSessionCapabilities,
  type ImSessionDeps,
} from './session-host.js'
import type { ImAccountRef, ImChannel, ImChannelId, ImChannelView, ImTarget } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey } from './types.js'
import { ImStore } from './store.js'

export type ImRuntime = ImRuntimeHandle

export interface CreateImRuntimeOptions {
  db: TavernStore
  logger?: HostLogger
}

/** 账号落在 store 里，但本构建还没有该通道的适配器（QQ/微信在后续里程碑）。 */
export class ImChannelUnsupportedError extends Error {
  readonly code = 'IM_CHANNEL_UNSUPPORTED'
  readonly channel: ImChannelId

  constructor(channel: ImChannelId) {
    super(`IM channel '${channel}' has no adapter in this build; only 'onebot' can be started`)
    this.name = 'ImChannelUnsupportedError'
    this.channel = channel
  }
}

export { imDisabledByEnv }

export function createImRuntime(ctx: PluginContext, options: CreateImRuntimeOptions): ImRuntime {
  const { db } = options
  const agents = ctx.agents as ImAgentsSeam | undefined
  const presets = ctx.agentPresets as ImPresetsSeam | undefined
  const capabilities = inspectImSessionCapabilities(agents, presets)
  const channels = new Map<string, ImChannel>()
  const oneBotChannels = new Map<string, OneBotChannel>()
  const store = ImStore.open(tavernDataRoot('im'))
  // 运行时生命信号：热重载/卸载时连同账号连接一起停，不留下孤儿 socket。
  const lifetime = new AbortController()

  const sessionDeps: ImSessionDeps = {
    db,
    agents,
    presets,
    presetId: AGENT_TAVERN_PRESET_ID,
    ensurePreset: async () => { await ensureAgentPresetDeclared(ctx, AGENT_TAVERN_PRESET_ID) },
    workspace: async () => (await prepareInternalWorkspace()).path,
    bind: async (sessionId, character, chatId) =>
      bindSession(db, sessionId, character, chatId, false, 'agent-tavern', 'dsh-native'),
    presetChanged: async () => { await emitAgentPresetChanged() },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }

  const router = createImRouter({
    db,
    now: () => Date.now(),
    seenDedupe: (dedupeKey, now) => store.seenDedupe(dedupeKey, now),
    ensureSession: async (request) => ensureImSession(sessionDeps, request),
    followup: async (sessionId, message) => {
      const agent = await liveAgent(sessionDeps, sessionId)
      const target = agent as { followup?: (payload: unknown) => unknown }
      if (typeof target.followup !== 'function') {
        throw new Error(`the host agent for session ${sessionId} exposes no followup()`)
      }
      await target.followup({
        id: message.id,
        role: 'user',
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      })
    },
    render: async (target, text) => renderForTarget(db, target, text),
    send: async (target, parts) => {
      const channel = channels.get(channelKey(target.channel, target.accountId))
      if (channel === undefined) {
        throw new Error(`IM channel ${target.channel}/${target.accountId} is not running`)
      }
      await channel.send(target, parts)
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  function handleSessionEvent(session: HostSessionLike, event: HostSessionEventLike): void {
    if (event.type !== 'turn/end') return
    const sessionId = session.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const turn = event.data?.['turn']
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return
    void isImSession(db, sessionId).then((bound) => {
      if (!bound) return
      return router.finishTurn(sessionId, turn, sessionEvents(session))
    }).catch((error: unknown) => {
      options.logger?.warn?.(`dsh-soulmojito im: turn ${turn} of ${sessionId} reply failed: ${messageOf(error)}`)
    })
  }

  // ---- 账号生命周期 ----

  function openOneBot(account: ImAccountRef, secret: Record<string, string>): OneBotChannel {
    return new OneBotChannel({
      accountId: account.accountId,
      secret,
      router: { handle: async (inbound) => router.inbound(inbound) },
      groupRequireMention: async () => ((await db.getState()).imSettings ?? DEFAULT_IM_SETTINGS).groupRequireMention,
      now: () => Date.now(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  }

  async function installOneBot(account: ImAccountRef, channel: OneBotChannel): Promise<void> {
    const key = channelKey(account.channel, account.accountId)
    const previous = channels.get(key)
    if (previous !== undefined) {
      await previous.stop()
      channels.delete(key)
      oneBotChannels.delete(key)
    }
    channels.set(key, channel)
    oneBotChannels.set(key, channel)
    try {
      await channel.start(lifetime.signal)
    } catch (error) {
      channels.delete(key)
      oneBotChannels.delete(key)
      throw error
    }
  }

  // 账号增删串行化：启动恢复与面板请求可能同时改写同一个账号，后写必须赢。
  let accountTail: Promise<void> = Promise.resolve()

  function serialAccounts<T>(task: () => Promise<T>): Promise<T> {
    const run = accountTail.then(task, task)
    accountTail = run.then(noop, noop)
    return run
  }

  async function upsertAccount(account: ImAccountRef, secret: Record<string, string>): Promise<void> {
    return serialAccounts(async () => {
      if (account.channel !== 'onebot') throw new ImChannelUnsupportedError(account.channel)
      // 先构造通道：token 为空时在这里就拒绝，绝不让「没有可用密钥的账号」落盘。
      const channel = openOneBot(account, secret)
      // 原样回写密钥袋：只挑 token 会把调用方存的 selfId 等附加键在重启恢复时抹掉。
      await store.putAccount(account, { ...secret })
      await installOneBot(account, channel)
    })
  }

  async function removeAccount(channelId: ImChannelId, accountId: string): Promise<boolean> {
    return serialAccounts(async () => {
      const key = channelKey(channelId, accountId)
      const live = channels.get(key)
      if (live !== undefined) {
        await live.stop()
        channels.delete(key)
      }
      oneBotChannels.delete(key)
      const removed = await store.deleteAccount(channelId, accountId)
      return removed || live !== undefined
    })
  }

  // ---- 反向 WS 升级路由（进程内常驻席位，见 im/onebot/seat.ts）----
  const upgradeHandler = createOneBotUpgradeHandler({
    channels: () => [...oneBotChannels.values()],
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  const seat = ensureOneBotUpgradeSeat(ctx.webServer, `${API}/im/onebot/ws`)
  if (!seat.registered) {
    const reason = seat.reason ?? 'the OneBot reverse WebSocket endpoint could not be registered'
    capabilities.reasons.push(reason)
  }
  async function handleOneBotUpgrade(req: unknown, socket: unknown, head: Buffer): Promise<void> {
    await upgradeHandler(req as IncomingMessage, socket as Duplex, head)
  }

  async function handleOneBotWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    for (const channel of oneBotChannels.values()) {
      if (!channel.acceptsWebhook(req)) continue
      // token 每账号独立；同 token 多账号属于配置错误，按登记顺序取第一个。
      await channel.handleWebhook(req, res)
      return true
    }
    return false
  }

  // 重启恢复：store 里已有的 OneBot 账号逐个重建通道（走与面板登记同一条 upsert）。
  async function restoreAccounts(): Promise<void> {
    const accounts = await store.accounts()
    for (const account of accounts) {
      if (account.channel !== 'onebot') continue
      try {
        const secret = await store.readSecret('onebot', account.accountId)
        if (secret === undefined) {
          options.logger?.warn?.(`dsh-soulmojito im: onebot/${account.accountId} has no stored secret; skipped`)
          continue
        }
        await upsertAccount(account, secret)
      } catch (error) {
        options.logger?.warn?.(`dsh-soulmojito im: onebot/${account.accountId} failed to start: ${messageOf(error)}`)
      }
    }
  }
  void restoreAccounts().catch((error: unknown) => {
    options.logger?.warn?.(`dsh-soulmojito im: restoring onebot accounts failed: ${messageOf(error)}`)
  })

  return {
    router,
    capabilities,
    upsertAccount,
    removeAccount,
    handleOneBotWebhook,
    views: () => [...channels.values()].map((channel) => ({
      channel: channel.channel,
      accountId: channel.accountId,
      status: channel.status(),
      peers: 0,
    })),
    bindChat: async (chat, existingSessionId) => bindImChat(sessionDeps, chat, existingSessionId),
    handleSessionEvent,
    handleOneBotUpgrade,
    dispose: async () => {
      lifetime.abort()
      for (const channel of channels.values()) {
        await channel.stop().catch((error: unknown) => {
          options.logger?.warn?.(`dsh-soulmojito im: stopping ${channel.channel}/${channel.accountId} failed: ${messageOf(error)}`)
        })
      }
      channels.clear()
      oneBotChannels.clear()
    },
  }
}

/** 会话是否被任一 IM peer 绑定；未绑定的会话不参与回复抽取。 */
async function isImSession(db: TavernStore, sessionId: string): Promise<boolean> {
  const state = await db.getState()
  for (const binding of Object.values(state.imPeers ?? {})) {
    if (binding.sessionId === sessionId) return true
  }
  return false
}

/** 重启后 live agent 可能已不在注册表里：先 resume/create，再投递。 */
async function liveAgent(deps: ImSessionDeps, sessionId: string): Promise<unknown> {
  const live = deps.agents?.get?.(sessionId)
  if (live !== undefined && live !== null) return live
  return ensureImAgent(deps, sessionId)
}

/**
 * 展示层渲染：与面板渲染走同一套 `markdownOnly` 正则，IM 看到的正文因此
 * 与网页端一致；渲染失败时退回原文——宁可少一层正则，也不要丢一整轮回复。
 */
async function renderForTarget(db: TavernStore, target: ImTarget, text: string): Promise<string> {
  const state = await db.getState()
  const key = imPeerKey(target.channel, target.accountId, target.scope, target.peerId)
  const binding = state.imPeers?.[key]
  if (binding === undefined) return text
  const card = await db.getCharacter(binding.character)
  const scripts = await collectSessionRegexScripts(db, state, binding.character, binding.chatId, card)
  const message: ChatMessage = {
    name: '',
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
  }
  return displayTextForMessage(scripts, message, 0)
}

function channelKey(channel: string, accountId: string): string {
  return `${channel}:${accountId}`
}

function noop(): void {
  // 串行链只关心「上一步已结束」，失败由各自返回的 promise 上抛。
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
