/**
 * IM 运行时（提案 0024 §3）：把通道、路由、会话托管与宿主 seam 装到一起。
 *
 * 单进程单实例，由 `apply()` 创建、`ctx.effect` 的 disposer 关闭。OneBot 与 QQ
 * 是两条真实通道：账号都来自 store，OneBot 的反向 WS 走
 * `webServer.registerUpgrade`（缺这条 seam 的宿主只剩 HTTP POST webhook，能力原因
 * 写进 `capabilities.reasons`），QQ 走官方 SDK 的 WebSocket 网关 + 扫码绑定。
 * 两个外部系统都从 `CreateImRuntimeOptions` 注入，测试因此完全不碰网络；
 * QQ 的真实 SDK 由 `im/qq/sdk.ts` 从数据目录动态加载（包外挂安装，不进产物）。
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
import { createQQBinding, type QQBindCredential, type QQConnector } from './qq/bind.js'
import { QQChannel, type QQBotFactory } from './qq/channel.js'
import { loadQqConnector, loadQqSdk, type QqSdk } from './qq/sdk.js'
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
import type { ImAccountRef, ImBindStatus, ImChannel, ImChannelId, ImChannelView, ImTarget } from './types.js'
import { DEFAULT_IM_SETTINGS, imPeerKey } from './types.js'
import { ImStore } from './store.js'

export type ImRuntime = ImRuntimeHandle

export interface CreateImRuntimeOptions {
  db: TavernStore
  logger?: HostLogger
  /**
   * QQ 网关客户端工厂。缺省从数据目录动态加载官方 SDK（包外挂安装，见
   * `im/qq/sdk.ts`）；测试注入假 SDK，让「扫码成功 → 账号落库 → 通道在线」
   * 整条链路不碰网络、也不要求本机安装腾讯包。
   */
  qqBot?: QQBotFactory
  /** QQ 扫码连接器。缺省从数据目录动态加载；测试注入假连接器。 */
  qqConnector?: QQConnector
}

/** QR 绑定出来的账号默认标签；用户可在账号路由里改成自己的备注。 */
const QQ_BOUND_ACCOUNT_LABEL = 'QQ 机器人'

/** 账号落在 store 里，但本构建还没有该通道的适配器（微信在后续里程碑）。 */
export class ImChannelUnsupportedError extends Error {
  readonly code = 'IM_CHANNEL_UNSUPPORTED'
  readonly channel: ImChannelId

  constructor(channel: ImChannelId) {
    super(`IM channel '${channel}' has no adapter in this build; only 'onebot' and 'qq' can be started`)
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
  // 外部系统的接缝都从 options 进来：生产由运行期加载器给，测试注入假件。
  const injectedBot: QQBotFactory | undefined = options.qqBot
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

  function openQQ(account: ImAccountRef, secret: Record<string, string>, createBot: QQBotFactory): QQChannel {
    return new QQChannel({
      accountId: account.accountId,
      secret,
      router: { handle: async (inbound) => router.inbound(inbound) },
      groupRequireMention: async () => ((await db.getState()).imSettings ?? DEFAULT_IM_SETTINGS).groupRequireMention,
      createBot,
      // 账号级能力：官方机器人只有申请到 markdown 权限才能发 msg_type=2。
      markdownSupport: secret['markdownSupport'] === 'true',
      now: () => Date.now(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  }

  /** QQ 没有 upgrade/webhook 索引表：换账号就是停旧通道、装新通道，再无别的登记。 */
  async function installQQ(account: ImAccountRef, channel: QQChannel): Promise<void> {
    const key = channelKey(account.channel, account.accountId)
    const previous = channels.get(key)
    if (previous !== undefined) {
      await previous.stop()
      channels.delete(key)
    }
    channels.set(key, channel)
    try {
      await channel.start(lifetime.signal)
    } catch (error) {
      channels.delete(key)
      throw error
    }
  }

  // ---- 扫码绑定（本轮只有 QQ；实例进程内唯一，见 im/qq/bind.ts）----

  // 扫码连接器只在真正扫码时加载：没装腾讯包不影响其它通道，也不影响面板打开。
  const injectedConnector: QQConnector | undefined = options.qqConnector
  const qqBinding = createQQBinding({
    connect: injectedConnector === undefined ? () => loadQqConnector() : () => Promise.resolve(injectedConnector),
  })

  /**
   * 扫码成功后的落库顺序：先账号与密钥（upsertAccount 会立刻接通道），再把人加进
   * 私聊白名单。反过来的话，绑定成功到白名单生效之间会有一段「扫了码却被访问控制
   * 拒绝」的窗口。
   */
  async function adoptQQCredential(credentials: readonly QQBindCredential[]): Promise<void> {
    const credential = credentials[0]
    if (credential === undefined) {
      throw new Error('the QQ connector reported a successful scan without any credential; nothing was saved')
    }
    const appId = credential.appId.trim()
    const appSecret = credential.appSecret.trim()
    if (appId === '' || appSecret === '') {
      throw new Error('the QQ connector returned an empty appId or appSecret; nothing was saved')
    }
    const accounts = await store.accounts()
    const existing = accounts.find((entry) => entry.channel === 'qq' && entry.accountId === appId)
    await upsertAccount({
      channel: 'qq',
      accountId: appId,
      label: QQ_BOUND_ACCOUNT_LABEL,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }, { appId, appSecret })
    const openid = typeof credential.userOpenid === 'string' ? credential.userOpenid.trim() : ''
    if (openid !== '') await addImPrivateAllow(openid)
  }

  /** 扫码人即 owner：只追加白名单，不改访问模式——空名单仍然是「拒绝所有人」。 */
  async function addImPrivateAllow(openid: string): Promise<void> {
    const state = await db.getState()
    if ((state.imSettings ?? DEFAULT_IM_SETTINGS).privateAllow.includes(openid)) return
    await db.updateState((current) => {
      const settings = current.imSettings ?? DEFAULT_IM_SETTINGS
      // 并发两次扫码成功时，后到的那个只补一次名单，不重复追加。
      if (settings.privateAllow.includes(openid)) return {}
      return { imSettings: { ...settings, privateAllow: [...settings.privateAllow, openid] } }
    })
  }

  async function startQrBind(channelId: ImChannelId): Promise<ImBindStatus> {
    if (channelId !== 'qq') throw new ImChannelUnsupportedError(channelId)
    return qqBinding.startQrConnect({
      onQrDisplayed: (url) => {
        // 二维码链接带一次性凭据：日志只留 host，解析不了就只写就绪（审查 P2-3）。
        options.logger?.info?.(`dsh-soulmojito im qq bind: QR code ready${qrHostSuffix(url)}`)
      },
      onSuccess: async (credentials) => { await adoptQQCredential(credentials) },
      onFailure: (error) => {
        options.logger?.warn?.(`dsh-soulmojito im qq bind failed: ${error.message}`)
      },
    }, { signal: lifetime.signal, source: 'dsh-soulmojito' })
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
      if (account.channel === 'onebot') {
        // 先构造通道：token 为空时在这里就拒绝，绝不让「没有可用密钥的账号」落盘。
        const channel = openOneBot(account, secret)
        // 原样回写密钥袋：只挑 token 会把调用方存的 selfId 等附加键在重启恢复时抹掉。
        await store.putAccount(account, { ...secret })
        await installOneBot(account, channel)
        return
      }
      if (account.channel === 'qq') {
        // 腾讯包外挂安装：先加载 SDK，再构造通道。加载失败即缺包/坏包，账号不落盘，
        // 错误里带确切安装命令（与「不留半残账号」一致）。
        const createBot = injectedBot ?? createQqBotFactory(await loadQqSdk())
        // 构造期校验 appId/appSecret：坏凭据同样一律不进磁盘。
        const channel = openQQ(account, secret, createBot)
        const previous = await store.readSecret('qq', account.accountId)
        await store.putAccount(account, { ...secret })
        try {
          await installQQ(account, channel)
        } catch (error) {
          // 落盘后安装失败必须回滚：新建账号删掉；改配置的账号还原旧密钥。
          // 两者都保证「store 里没有连不上的半残配置」，同时不因一次网络抖动
          // 抹掉用户已有的机器人（审查 P2-2）。
          try {
            if (previous === undefined) await store.deleteAccount('qq', account.accountId)
            else await store.putAccount(account, previous)
          } catch (rollbackError) {
            // 回滚本身失败时把原始失败挂在 cause 上：调用方至少能分辨「网关拒绝」
            // 与「磁盘写坏」，否则只剩最后一条错误，排障无门（审查 P2-3）。
            throw new Error(
              `qq account '${account.accountId}' failed to install and its credential rollback also failed: ${messageOf(rollbackError)}`,
              { cause: error },
            )
          }
          throw error
        }
        return
      }
      throw new ImChannelUnsupportedError(account.channel)
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

  // 重启恢复：store 里已有的 OneBot / QQ 账号逐个重建通道（走与面板登记同一条 upsert）。
  async function restoreAccounts(): Promise<void> {
    const accounts = await store.accounts()
    for (const account of accounts) {
      if (account.channel !== 'onebot' && account.channel !== 'qq') continue
      try {
        const secret = await store.readSecret(account.channel, account.accountId)
        if (secret === undefined) {
          options.logger?.warn?.(`dsh-soulmojito im: ${account.channel}/${account.accountId} has no stored secret; skipped`)
          continue
        }
        await upsertAccount(account, secret)
      } catch (error) {
        options.logger?.warn?.(`dsh-soulmojito im: ${account.channel}/${account.accountId} failed to start: ${messageOf(error)}`)
      }
    }
  }
  void restoreAccounts().catch((error: unknown) => {
    options.logger?.warn?.(`dsh-soulmojito im: restoring stored accounts failed: ${messageOf(error)}`)
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
    startQrBind,
    qrBindStatus: () => qqBinding.status(),
    cancelQrBind: () => qqBinding.cancel(),
    dispose: async () => {
      // 先取消扫码再中止生命信号：连接器的「已取消」回调不能和卸载抢同一份状态。
      qqBinding.cancel()
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

/** 运行期 SDK → 通道工厂；构造器形状已在 `loadQqSdk` 里校验过。 */
function createQqBotFactory(sdk: QqSdk): QQBotFactory {
  return (botOptions) => new sdk.QQBot(botOptions)
}

/**
 * 二维码 URL 的日志投影：只保留 host。链接里带一次性凭据，整条打出来等于把
 * 绑定令牌写进日志；解析失败时宁可不写，也不退回原文（审查 P2-3）。
 */
function qrHostSuffix(url: string): string {
  try {
    const host = new URL(url).host
    return host === '' ? '' : ` (${host})`
  } catch {
    return ''
  }
}

function noop(): void {
  // 串行链只关心「上一步已结束」，失败由各自返回的 promise 上抛。
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
