/**
 * IM 运行时（提案 0024 §3）：把通道、路由、会话托管与宿主 seam 装到一起。
 *
 * 单进程单实例，由 `apply()` 创建、`ctx.effect` 的 disposer 关闭。OneBot、QQ 与
 * 微信是三条真实通道：账号都来自 store，OneBot 的反向 WS 走
 * `webServer.registerUpgrade`（缺这条 seam 的宿主只剩 HTTP POST webhook，能力原因
 * 写进 `capabilities.reasons`），QQ 走官方 SDK 的 WebSocket 网关 + 扫码绑定，
 * 微信走自研 iLink HTTP 客户端的长轮询 + 扫码绑定。两个外部系统都从
 * `CreateImRuntimeOptions` 注入，测试因此完全不碰网络；QQ 的真实 SDK 由
 * `im/qq/sdk.ts` 从数据目录动态加载（包外挂安装，不进产物）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { envCompat } from '../env-compat.js'
import type { HostAgentLike, HostLogger, PluginContext } from '../host-contract.js'
import { API } from '../http/router.js'
import { lastSelectedPresetId } from '../session/preset-marker.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { confirmSessionAppend } from '../../../bind/src/index.js'
import { tavernDataRoot } from '../dsh-home.js'
import { prepareInternalWorkspace } from '../workspace.js'
import { imDisabledByEnv, type ImPresetSwitchResult, type ImRuntimeHandle } from './handle.js'
import { openImMediaStore } from './media-store.js'
import { createOneBotUpgradeHandler, OneBotChannel } from './onebot/server.js'
import { ensureOneBotUpgradeSeat } from './onebot/seat.js'
import { createQQBinding, type QQBindCredential, type QQConnector } from './qq/bind.js'
import { QQChannel, type QQBotFactory } from './qq/channel.js'
import { loadQqConnector, loadQqSdk, type QqSdk } from './qq/sdk.js'
import {
  WEIXIN_DEFAULT_BOT_TYPE,
  WEIXIN_DEFAULT_CDN_BASE_URL,
  WEIXIN_FIXED_BASE_URL,
  type WeixinCredential,
} from './weixin/api.js'
import { createWeixinBinding } from './weixin/bind.js'
import { WeixinChannel, WEIXIN_LONG_POLL_TIMEOUT_MS } from './weixin/channel.js'
import { WEIXIN_REAL_CLOCK } from './weixin/clock.js'
import { openWeixinContextTokens } from './weixin/context-tokens.js'
import { WEIXIN_MEDIA_MAX_BYTES } from './weixin/media.js'
import { createImRouter, type ImRouter } from './router.js'
import { imAccountIdOf } from './account-id.js'
import { createImLog, IM_LOG_CAPACITY, wrapImLogger } from './log.js'
import {
  buildImFollowupMessage,
  inspectImSessionCapabilities,
  liveAgentOf,
  listLiveAgents,
  requireLiveAgent,
  type ImAgentsSeam,
  type ImSessionCapabilities,
} from './session-host.js'
import type { ImAccountRef, ImBindStatus, ImChannel, ImChannelId, ImChannelView, ImTarget } from './types.js'
import { AGENT_TAVERN_IM_PRESET_ID, DEFAULT_IM_SETTINGS, imPeerKey, imPeerKeyParts } from './types.js'
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
  /** 微信扫码入口。缺省官方固定地址；测试指向本地桩服务，自建反代也可覆盖。 */
  weixinQrBaseUrl?: string
  /** 微信媒体 CDN 入口。缺省官方 c2c 域名；测试指向本地桩服务。 */
  weixinCdnBaseUrl?: string
}

/** QR 绑定出来的账号默认标签；用户可在账号路由里改成自己的备注。 */
const QQ_BOUND_ACCOUNT_LABEL = 'QQ 机器人'
const WEIXIN_BOUND_ACCOUNT_LABEL = '微信机器人'

/** 扫码轮询节奏：1s 一次与参考实现一致；二维码有效期由绑定器自己管。 */
const WEIXIN_BIND_POLL_INTERVAL_MS = 1_000

/** 账号落在 store 里，但本构建还没有该通道的适配器（三条通道之外不可达）。 */
export class ImChannelUnsupportedError extends Error {
  readonly code = 'IM_CHANNEL_UNSUPPORTED'
  readonly channel: ImChannelId

  constructor(channel: ImChannelId) {
    super(`IM channel '${channel}' has no adapter in this build; 'onebot', 'qq' and 'weixin' are the supported channels`)
    this.name = 'ImChannelUnsupportedError'
    this.channel = channel
  }
}

export { imDisabledByEnv }

export function createImRuntime(ctx: PluginContext, options: CreateImRuntimeOptions): ImRuntime {
  const { db } = options
  const agents = ctx.agents as ImAgentsSeam | undefined
  const capabilities = inspectImSessionCapabilities(agents)
  const channels = new Map<string, ImChannel>()
  const oneBotChannels = new Map<string, OneBotChannel>()
  // 外部系统的接缝都从 options 进来：生产由运行期加载器给，测试注入假件。
  const injectedBot: QQBotFactory | undefined = options.qqBot
  const store = ImStore.open(tavernDataRoot('im'))
  // 运行时生命信号：热重载/卸载时连同账号连接一起停，不留下孤儿 socket。
  const lifetime = new AbortController()
  // 面板可见的运行日志：通道/绑定器/路由共用同一条镜像，独立于宿主终端。
  const imLog = createImLog({ capacity: IM_LOG_CAPACITY, now: () => Date.now() })
  const logger = wrapImLogger(options.logger, imLog)
  // 附件落内部工作区：会话 cwd 就在这里，模型能读到；一个实例给所有通道共用。
  const mediaStore = openImMediaStore({
    workspaceRoot: async () => (await prepareInternalWorkspace()).path,
    now: () => Date.now(),
    maxBytes: WEIXIN_MEDIA_MAX_BYTES,
  })

  /**
   * 绑定会话时把 preset 切到 AgentTavernIM（决策 2026-10-31-im-native-session-binding）。
   *
   * - 只切 AgentLoop 会话；`agent-novel` / `card-workbench` / `st` 有各自的架构，
   *   强行 recompose 会把它们的工具面拆掉，直接拒绝并在面板说明。
   * - 会话正在跑或不在线时不动：由 index 的 agent/created / agent/status(idle)
   *   重试，等它空闲/打开后再切；绑定本身已经成功。
   * - marker 必须读回确认（confirmSessionAppend）：宿主重启后按最后一条
   *   `agent-preset/selected` 恢复 preset，写丢等于下次又变回原预设。
   */
  async function applyPresetToAgent(agent: HostAgentLike): Promise<ImPresetSwitchResult> {
    const presets = ctx.agentPresets
    if (typeof presets?.recompose !== 'function') {
      return { applied: false, reason: 'the host cannot recompose agent presets' }
    }
    const sessionId = agent.session?.id ?? agent.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { applied: false, reason: 'the agent has no session id' }
    }
    try {
      const header = agent.session?.header as { origin?: unknown; delegationDepth?: unknown } | undefined
      if (header?.origin === 'subagent'
        || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) {
        return { applied: false, reason: 'subagent sessions cannot be switched to AgentTavernIM' }
      }
      const state = await db.getState()
      const architecture = state.sessionBindings[sessionId]?.architecture
      if (architecture === 'agent-novel' || architecture === 'card-workbench' || architecture === 'st') {
        return {
          applied: false,
          reason: `session architecture '${architecture}' cannot be switched to AgentTavernIM`,
        }
      }
      if (agent.status === 'running') {
        return { applied: false, reason: 'the session is running; the preset will switch when it becomes idle' }
      }
      if (lastSelectedPresetId(agent.session) === AGENT_TAVERN_IM_PRESET_ID) return { applied: true }
      const preset = await presets.recompose(agent.ctx, AGENT_TAVERN_IM_PRESET_ID)
      if (preset.id !== AGENT_TAVERN_IM_PRESET_ID) {
        return { applied: false, reason: `the host selected preset '${preset.id}' instead of AgentTavernIM` }
      }
      const session = agent.session as { append?: (type: string, data: unknown, opts?: unknown) => unknown }
      if (typeof session.append !== 'function') {
        return { applied: false, reason: 'the session does not expose append(); the preset cannot be made durable' }
      }
      const confirmed = confirmSessionAppend({
        session: agent.session,
        logger,
        label: `AgentTavernIM preset marker (${sessionId})`,
        append: () => session.append?.('agent-preset/selected', { agentPreset: preset.id }),
        present: () => lastSelectedPresetId(agent.session) === preset.id,
      })
      if (!confirmed) return { applied: false, reason: 'the AgentTavernIM preset marker could not be confirmed' }
      imLog.note('info', `im bind: switched ${sessionId} to ${AGENT_TAVERN_IM_PRESET_ID}`)
      return { applied: true }
    } catch (error) {
      return { applied: false, reason: messageOf(error) }
    }
  }

  async function applyImPreset(sessionId: string): Promise<ImPresetSwitchResult> {
    const agent = liveAgentOf(agents, sessionId)
    if (agent === undefined) return { applied: false, reason: 'the session is not open' }
    return applyPresetToAgent(agent)
  }

  async function ensurePresetForAgent(agent: unknown): Promise<ImPresetSwitchResult> {
    if (typeof agent !== 'object' || agent === null) return { applied: false, reason: 'invalid agent' }
    const candidate = agent as HostAgentLike
    const sessionId = candidate.session?.id ?? candidate.id
    if (typeof sessionId !== 'string' || sessionId === '') return { applied: false, reason: 'the agent has no session id' }
    const state = await db.getState()
    const bound = Object.values(state.imPeers ?? {}).some((binding) => binding.sessionId === sessionId)
    if (!bound) return { applied: false, reason: 'the session has no IM binding' }
    return applyPresetToAgent(candidate)
  }

  async function ensurePresets(): Promise<void> {
    const state = await db.getState()
    const bound = new Set(Object.values(state.imPeers ?? {}).map((binding) => binding.sessionId))
    for (const agent of listLiveAgents(agents)) {
      const sessionId = agent.session?.id ?? agent.id
      if (typeof sessionId !== 'string' || !bound.has(sessionId)) continue
      await applyPresetToAgent(agent).catch((error: unknown) => {
        logger?.warn?.(`dsh-soulmojito im: switching ${sessionId} to AgentTavernIM failed: ${messageOf(error)}`)
      })
    }
  }

  const router = createImRouter({
    db,
    now: () => Date.now(),
    seenDedupe: (dedupeKey, now) => store.seenDedupe(dedupeKey, now),
    followup: async (sessionId, message) => {
      // 绑定的是原生会话：只投给活着的 agent，绝不创建/resume 会话。
      const agent = requireLiveAgent(agents, sessionId)
      await agent.followup?.(buildImFollowupMessage(agent.session, message))
    },
    workspaceRoot: async () => (await prepareInternalWorkspace()).path,
    send: async (target, parts) => {
      const channel = channels.get(channelKey(target.channel, target.accountId))
      if (channel === undefined) {
        throw new Error(`IM channel ${target.channel}/${target.accountId} is not running`)
      }
      await channel.send(target, parts)
    },
    log: imLog,
    logger,
  })

  // ---- 账号生命周期 ----

  function openOneBot(account: ImAccountRef, secret: Record<string, string>): OneBotChannel {
    return new OneBotChannel({
      accountId: account.accountId,
      secret,
      router: { handle: async (inbound) => router.inbound(inbound) },
      groupRequireMention: async () => ((await db.getState()).imSettings ?? DEFAULT_IM_SETTINGS).groupRequireMention,
      now: () => Date.now(),
      logger,
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
      router: { handle: async (inbound, inboundOptions) => router.inbound(inbound, inboundOptions) },
      groupRequireMention: async () => ((await db.getState()).imSettings ?? DEFAULT_IM_SETTINGS).groupRequireMention,
      createBot,
      // 账号级能力：官方机器人只有申请到 markdown 权限才能发 msg_type=2。
      markdownSupport: secret['markdownSupport'] === 'true',
      media: mediaStore,
      now: () => Date.now(),
      logger,
    })
  }

  function openWeixin(account: ImAccountRef, secret: Record<string, string>): WeixinChannel {
    const contextTokens = openWeixinContextTokens(tavernDataRoot('im'), account.accountId)
    return new WeixinChannel({
      accountId: account.accountId,
      // 构造期校验 botToken/baseUrl：坏凭据在落盘前就被拒绝（见 upsertAccount）。
      token: secret['botToken'] ?? '',
      baseUrl: secret['baseUrl'] ?? '',
      router: { handle: async (inbound, inboundOptions) => router.inbound(inbound, inboundOptions) },
      loadCursor: async () => store.readCursor(account.accountId),
      saveCursor: async (cursor) => store.writeCursor(account.accountId, cursor),
      loadContextTokens: async () => contextTokens.load(),
      saveContextTokens: async (tokens) => contextTokens.save(tokens),
      clock: WEIXIN_REAL_CLOCK,
      longPollTimeoutMs: WEIXIN_LONG_POLL_TIMEOUT_MS,
      typingEnabled: true,
      cdnBaseUrl: options.weixinCdnBaseUrl ?? WEIXIN_DEFAULT_CDN_BASE_URL,
      media: mediaStore,
      logger,
    })
  }

  /**
   * QQ / 微信都没有 upgrade/webhook 索引表：换账号就是停旧通道、装新通道，
   * 再无别的登记。启动失败时把新通道从表里摘掉，调用方负责回滚密钥。
   */
  async function installSingleChannel(account: ImAccountRef, channel: ImChannel): Promise<void> {
    const key = channelKey(account.channel, account.accountId)
    const previous = channels.get(key)
    if (previous !== undefined) {
      await previous.stop()
      channels.delete(key)
    }
    channels.set(key, channel)
    try {
      await channel.start(lifetime.signal)
      logger.info?.(`dsh-soulmojito im: ${account.channel}/${account.accountId} channel installed and polling`)
    } catch (error) {
      channels.delete(key)
      throw error
    }
  }

  // ---- 扫码绑定（QQ 与微信各自一个活动会话，互不顶掉）----

  // 扫码连接器只在真正扫码时加载：没装腾讯包不影响其它通道，也不影响面板打开。
  const injectedConnector: QQConnector | undefined = options.qqConnector
  const qqBinding = createQQBinding({
    connect: injectedConnector === undefined ? () => loadQqConnector() : () => Promise.resolve(injectedConnector),
  })
  // 微信不需要外挂包：协议客户端是自研 HTTP，入口只影响「扫哪台服务器」。
  const weixinBinding = createWeixinBinding({
    qrBaseUrl: options.weixinQrBaseUrl ?? WEIXIN_FIXED_BASE_URL,
    botType: WEIXIN_DEFAULT_BOT_TYPE,
    pollIntervalMs: WEIXIN_BIND_POLL_INTERVAL_MS,
    clock: WEIXIN_REAL_CLOCK,
    localTokenList: loadWeixinLocalTokens,
    logger,
  })
  /** 最近一次 startQrBind 选中的通道；两个绑定器各自保留自己的相位。 */
  let activeQrBind: 'qq' | 'weixin' | undefined

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

  /** 微信扫码确认：账号 id 由 `ilink_bot_id` 派生（可能含 `@`，不能直接当文件名）。 */
  async function adoptWeixinCredential(credential: WeixinCredential): Promise<void> {
    const botToken = credential.botToken.trim()
    const baseUrl = credential.baseUrl.trim()
    const ilinkBotId = credential.ilinkBotId.trim()
    if (botToken === '' || baseUrl === '' || ilinkBotId === '') {
      throw new Error('the WeChat backend confirmed the scan without bot_token/baseurl/ilink_bot_id; nothing was saved')
    }
    const ilinkUserId = credential.ilinkUserId?.trim() ?? ''
    // 平台 id 保留在密钥袋里；accountId 只用于文件路径与 peerKey，必须文件系统安全。
    const accountId = imAccountIdOf('weixin', ilinkBotId)
    const accounts = await store.accounts()
    const existing = accounts.find((entry) => entry.channel === 'weixin' && entry.accountId === accountId)
    await upsertAccount({
      channel: 'weixin',
      accountId,
      label: WEIXIN_BOUND_ACCOUNT_LABEL,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }, {
      botToken,
      baseUrl,
      ilinkBotId,
      ...(ilinkUserId === '' ? {} : { ilinkUserId }),
    })
    if (ilinkUserId !== '') await addImPrivateAllow(ilinkUserId)
  }

  /**
   * 本机已存的 bot token，最多 10 个：重复扫码时平台回 `binded_redirect`，
   * 不会给同一个机器人重发凭据。单个账号密钥读不出来只 warn 并跳过——
   * 它是「让平台少发一张码」的优化，不该让新扫码整个失败。
   */
  async function loadWeixinLocalTokens(): Promise<readonly string[]> {
    const accounts = await store.accounts()
    const tokens: string[] = []
    for (const account of [...accounts].reverse()) {
      if (account.channel !== 'weixin') continue
      let secret: Record<string, string> | undefined
      try {
        secret = await store.readSecret('weixin', account.accountId)
      } catch (error) {
        logger?.warn?.(`dsh-soulmojito im weixin bind: skipped ${account.accountId} local token: ${messageOf(error)}`)
        continue
      }
      const token = secret?.['botToken']?.trim() ?? ''
      if (token === '') continue
      tokens.push(token)
      if (tokens.length >= 10) break
    }
    return tokens
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
    if (channelId === 'qq') {
      activeQrBind = 'qq'
      return qqBinding.startQrConnect({
        onQrDisplayed: (url) => {
          // 二维码链接带一次性凭据：日志只留 host，解析不了就只写就绪（审查 P2-3）。
          logger?.info?.(`dsh-soulmojito im qq bind: QR code ready${qrHostSuffix(url)}`)
        },
        onSuccess: async (credentials) => { await adoptQQCredential(credentials) },
        onFailure: (error) => {
          logger?.warn?.(`dsh-soulmojito im qq bind failed: ${error.message}`)
        },
      }, { signal: lifetime.signal, source: 'dsh-soulmojito' })
    }
    if (channelId === 'weixin') {
      activeQrBind = 'weixin'
      return weixinBinding.start({
        onQrDisplayed: (url) => {
          logger?.info?.(`dsh-soulmojito im weixin bind: QR code ready${qrHostSuffix(url)}`)
        },
        onSuccess: async (credential) => { await adoptWeixinCredential(credential) },
        onAlreadyBound: () => {
          logger?.info?.('dsh-soulmojito im weixin bind: the bot is already bound; existing credential stays in use')
        },
        onFailure: (error) => {
          logger?.warn?.(`dsh-soulmojito im weixin bind failed: ${error.message}`)
        },
      }, { signal: lifetime.signal })
    }
    throw new ImChannelUnsupportedError(channelId)
  }

  /**
   * 面板轮询的相位：优先回当前扫描通道；它回到 idle 后把身份还回去。
   * 另一个绑定器只有「还在进行中」的相位值得展示——终态失败不该在
   * 另一个通道刚成功后被翻出来。
   */
  function qrBindStatus(): ImBindStatus {
    const qqStatus = qqBinding.status()
    const weixinStatus = weixinBinding.status()
    if (activeQrBind === 'qq' && qqStatus.phase !== 'idle') return qqStatus
    if (activeQrBind === 'weixin' && weixinStatus.phase !== 'idle') return weixinStatus
    if (activeQrBind !== undefined) activeQrBind = undefined
    if (isRunningBindPhase(weixinStatus.phase)) return weixinStatus
    if (isRunningBindPhase(qqStatus.phase)) return qqStatus
    return { phase: 'idle' }
  }

  /** 微信验证码：只在 `verify` 相位合法；非法相位由绑定器抛结构化错误。 */
  function submitQrVerifyCode(code: string): ImBindStatus {
    return weixinBinding.submitVerifyCode(code)
  }

  function cancelQrBind(): ImBindStatus {
    const active = activeQrBind
    activeQrBind = undefined
    if (active === 'qq') return qqBinding.cancel()
    if (active === 'weixin') return weixinBinding.cancel()
    // 没有活动会话：两边都取消（两个 cancel 都是幂等空操作），返回 idle 收起弹窗。
    qqBinding.cancel()
    weixinBinding.cancel()
    return { phase: 'idle' }
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
          await installSingleChannel(account, channel)
        } catch (error) {
          await rollbackAccountSecret(account, previous, error)
          throw error
        }
        return
      }
      if (account.channel === 'weixin') {
        // 微信凭据同样先验后存：缺 botToken/baseUrl 时 openWeixin 就抛错，账号不落盘。
        const channel = openWeixin(account, secret)
        const previous = await store.readSecret('weixin', account.accountId)
        await store.putAccount(account, { ...secret })
        try {
          await installSingleChannel(account, channel)
        } catch (error) {
          await rollbackAccountSecret(account, previous, error)
          throw error
        }
        return
      }
      throw new ImChannelUnsupportedError(account.channel)
    })
  }

  /**
   * 落盘后安装失败必须回滚：新建账号删掉；改配置的账号还原旧密钥。
   * 两者都保证「store 里没有连不上的半残配置」，同时不因一次网络抖动抹掉
   * 用户已有的机器人（审查 P2-2）。回滚本身失败时把原始失败挂在 cause 上，
   * 调用方至少能分辨「网关拒绝」与「磁盘写坏」（审查 P2-3）。
   */
  async function rollbackAccountSecret(
    account: ImAccountRef,
    previous: Record<string, string> | undefined,
    error: unknown,
  ): Promise<void> {
    try {
      if (previous === undefined) await store.deleteAccount(account.channel, account.accountId)
      else await store.putAccount(account, previous)
    } catch (rollbackError) {
      throw new Error(
        `${account.channel} account '${account.accountId}' failed to install and its credential rollback also failed: ${messageOf(rollbackError)}`,
        { cause: error },
      )
    }
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
      // 游标按 accountId 命名，跨渠道共用同一个键：另一个渠道还在用同名账号时
      // 不能替它删游标，否则那个账号重启会从头重收历史。
      const stillUsed = (await store.accounts()).some((entry) => entry.accountId === accountId)
      if (!stillUsed) {
        await store.deleteCursor(accountId).catch((error: unknown) => {
          logger?.warn?.(`dsh-soulmojito im: deleting the cursor for ${channelId}/${accountId} failed: ${messageOf(error)}`)
        })
      }
      // 附件是 PII：解绑即删这个账号的媒体目录，不等下一次启动的 TTL 清扫。
      await mediaStore.remove(channelId, accountId).catch((error: unknown) => {
        logger?.warn?.(`dsh-soulmojito im: deleting the media of ${channelId}/${accountId} failed: ${messageOf(error)}`)
      })
      // 账号没了，绑定与待办就是死记录：面板不能继续显示它、im_send 也不该再选中它。
      await db.updateState((current) => {
        const peers = { ...(current.imPeers ?? {}) }
        const pending = { ...(current.imPendingPeers ?? {}) }
        for (const key of Object.keys(peers)) {
          const parts = imPeerKeyParts(key)
          if (parts?.channel === channelId && parts.accountId === accountId) delete peers[key]
        }
        for (const key of Object.keys(pending)) {
          const parts = imPeerKeyParts(key)
          if (parts?.channel === channelId && parts.accountId === accountId) delete pending[key]
        }
        return { imPeers: peers, imPendingPeers: pending }
      }).catch((error: unknown) => {
        logger?.warn?.(`dsh-soulmojito im: deleting the bindings of ${channelId}/${accountId} failed: ${messageOf(error)}`)
      })
      if (channelId === 'weixin') {
        await openWeixinContextTokens(tavernDataRoot('im'), accountId).clear().catch((error: unknown) => {
          logger?.warn?.(`dsh-soulmojito im: deleting the weixin context tokens for ${accountId} failed: ${messageOf(error)}`)
        })
      }
      return removed || live !== undefined
    })
  }

  // ---- 反向 WS 升级路由（进程内常驻席位，见 im/onebot/seat.ts）----
  const upgradeHandler = createOneBotUpgradeHandler({
    channels: () => [...oneBotChannels.values()],
    logger,
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

  // 重启恢复：store 里已有的账号逐个重建通道（走与面板登记同一条 upsert）。
  async function restoreAccounts(): Promise<void> {
    const accounts = await store.accounts()
    for (const account of accounts) {
      try {
        const secret = await store.readSecret(account.channel, account.accountId)
        if (secret === undefined) {
          logger?.warn?.(`dsh-soulmojito im: ${account.channel}/${account.accountId} has no stored secret; skipped`)
          continue
        }
        await upsertAccount(account, secret)
      } catch (error) {
        logger?.warn?.(`dsh-soulmojito im: ${account.channel}/${account.accountId} failed to start: ${messageOf(error)}`)
      }
    }
  }
  void restoreAccounts().catch((error: unknown) => {
    logger?.warn?.(`dsh-soulmojito im: restoring stored accounts failed: ${messageOf(error)}`)
  })

  return {
    router,
    capabilities,
    logs: (query) => imLog.read(query),
    upsertAccount,
    removeAccount,
    handleOneBotWebhook,
    views: () => [...channels.values()].map((channel) => ({
      channel: channel.channel,
      accountId: channel.accountId,
      status: channel.status(),
      peers: 0,
    })),
    isSessionLive: (sessionId) => liveAgentOf(agents, sessionId) !== undefined,
    applyImPreset,
    ensurePresetForAgent,
    ensurePresets,
    handleOneBotUpgrade,
    startQrBind,
    qrBindStatus,
    submitQrVerifyCode,
    cancelQrBind,
    dispose: async () => {
      // 先取消扫码再中止生命信号：连接器的「已取消」回调不能和卸载抢同一份状态。
      qqBinding.cancel()
      weixinBinding.cancel()
      activeQrBind = undefined
      lifetime.abort()
      for (const channel of channels.values()) {
        await channel.stop().catch((error: unknown) => {
          logger?.warn?.(`dsh-soulmojito im: stopping ${channel.channel}/${channel.accountId} failed: ${messageOf(error)}`)
        })
      }
      channels.clear()
      oneBotChannels.clear()
    },
  }
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

/** 只有「用户还能继续操作」的相位值得跨通道兜底展示。 */
function isRunningBindPhase(phase: ImBindStatus['phase']): boolean {
  return phase === 'waiting' || phase === 'verify' || phase === 'saving'
}

function noop(): void {
  // 串行链只关心「上一步已结束」，失败由各自返回的 promise 上抛。
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
