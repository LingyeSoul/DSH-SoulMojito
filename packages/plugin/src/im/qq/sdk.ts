/**
 * QQ 官方 SDK 的运行时加载面（提案 0024 §5，2026-10-30 修订）。
 *
 * 两个腾讯包都不进分发产物：插件只从数据目录的 `im/runtime/node_modules`
 * 动态导入。理由见 `decisions/2026-10-30-qq-channel.md`——`qqbot-nodejs`
 * 体积大且带可选原生依赖，`qqbot-connector` 的许可证是 UNLICENSED，
 * 两者都不适合随本仓库的 GPL 产物分发。
 *
 * 因此这里**不能** `import ... from '@tencent-connect/...'`：包没装时 tsc
 * 也必须过。下面全是本模块自己的结构类型，只覆盖适配层真正用到的成员；
 * 关键导出在加载处校验，SDK 升级改形状时会在 `loadQqSdk` 失败，而不是在
 * 调用点炸开。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tavernDataRoot } from '../../dsh-home.js'

// 包名在本模块只作为字符串出现：用于拼运行期路径与安装命令，**不是** import
// 说明符；产物里因此只有这两行常量，没有任何 SDK 代码。
// （`index.mjs` 里检出这两个名字属于预期；SDK 源码/静态依赖才是禁止项。）
const QQ_SDK_PACKAGE = '@tencent-connect/qqbot-nodejs'
const QQ_CONNECTOR_PACKAGE = '@tencent-connect/qqbot-connector'
/** 安装命令里的版本；升级时与 decision 记录同步改。 */
const QQ_SDK_VERSION = '1.0.5'
const QQ_CONNECTOR_VERSION = '1.2.0'
/** 包的 ESM 入口（相对各自的包目录）：只认这两个文件，不猜 exports 映射。 */
const QQ_SDK_ENTRY = 'dist/index.js'
const QQ_CONNECTOR_ENTRY = 'dist/esm/index.js'

/** 平台会话类型；guild/dm 不在 IM 通道语义内，由通道丢弃。 */
export type QqChatScope = 'c2c' | 'group'

/** SDK 的 Logger 形状：info/error 必填，warn/debug 可选。 */
export interface QqLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  warn?(msg: string, meta?: Record<string, unknown>): void
  debug?(msg: string, meta?: Record<string, unknown>): void
}

/** 构造 `QQBot` 需要的选项子集；其余 SDK 选项与本适配层无关。 */
export interface QqBotOptions {
  appId: string
  appSecret: string
  accountId?: string
  transport?: 'websocket' | 'webhook'
  logger?: QqLogger
}

/** 出站落点；带 `msgId` 即被动回复，不带即主动推送。 */
export interface QqReplyTarget {
  scope: QqChatScope
  targetId: string
  msgId?: string
}

export interface QqGatewayDisconnect {
  code: number
  reason: string
  willReconnect: boolean
}

export interface QqMention {
  is_you?: boolean
}

/** 归一后的入站消息：只声明本适配层读取的字段。 */
export interface QqInboundMessage {
  rawEventType: string
  kind: 'c2c' | 'group' | 'guild' | 'dm'
  senderId: string
  senderName?: string
  content: string
  messageId: string
  timestamp: string
  groupOpenid?: string
  mentions?: readonly QqMention[]
  replyTarget: QqReplyTarget
  raw?: unknown
}

/** 发送回执里唯一有用的字段；其余由 SDK 保留。 */
export interface QqMessageResponse {
  id: string
}

/**
 * `QQBot` 实例上被本插件使用的成员。`on` 写成重载而不是
 * `(...args: unknown[])`：后者会让「只接两个参数的 message 处理器」在严格
 * 模式下不可赋值。
 */
export interface QqBotLike {
  on(event: 'ready' | 'resumed', handler: (data: unknown) => void): unknown
  on(event: 'disconnected', handler: (event: QqGatewayDisconnect) => void): unknown
  on(event: 'error', handler: (error: Error) => void): unknown
  on(event: 'message', handler: (ctx: unknown, message: QqInboundMessage) => void | Promise<void>): unknown
  start(): Promise<void>
  stop(): void
  sendText(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
  sendMarkdown(target: QqReplyTarget, content: string): Promise<QqMessageResponse>
}

/** `@tencent-connect/qqbot-nodejs` 的加载结果：构造器 + 消息类型常量。 */
export interface QqSdk {
  readonly QQBot: new (options: QqBotOptions) => QqBotLike
  readonly MsgType: Readonly<Record<string, number>>
}

/** 扫码连接器回调里的凭据；与官方 SDK 的 `QrConnectCredentials` 同形。 */
export interface QqConnectorCredential {
  appId: string
  appSecret: string
  /** 扫码用户的 openid：扫码人就是这个机器人的 owner。 */
  userOpenid?: string
}

export interface QqConnectorCallbacks {
  onSuccess(credentials: readonly QqConnectorCredential[]): void
  onFailure(error: Error): void
  onQrDisplayed?(url: string): void
  onQrExpired?(): void
}

export interface QqConnectorOptions {
  /** 官方 SDK 的控制台二维码开关；本插件恒传 false，二维码只走面板。 */
  displayQrCodeToConsole?: boolean
  signal?: AbortSignal
  source?: string
}

/** `startQrConnect` 的形状：注册回调后返回取消函数。 */
export type QqConnector = (callbacks: QqConnectorCallbacks, options: QqConnectorOptions) => () => void

/** 运行期状态投影：面板据此显示安装指引。 */
export interface QqRuntimeStatus {
  installed: boolean
  reason?: string
}

export type QqRuntimeErrorCode = 'QQ_RUNTIME_MISSING' | 'QQ_RUNTIME_INVALID'

/**
 * 运行期加载失败。`path` 指向期望的入口文件，message 里带完整安装命令——
 * 排障时不用回到文档里翻版本号。
 */
export class QqRuntimeError extends Error {
  readonly code: QqRuntimeErrorCode
  readonly path: string

  constructor(code: QqRuntimeErrorCode, message: string, path: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'QqRuntimeError'
    this.code = code
    this.path = path
  }
}

/** QQ 运行时的安装目录：`$DSH_HOME/<tavern>/im/runtime`。 */
export function qqRuntimeRoot(): string {
  return tavernDataRoot('im', 'runtime')
}

/** 唯一一条安装命令；错误信息与面板提示都从这里取，避免两处版本号漂移。 */
export function qqInstallCommand(root: string): string {
  return `cd "${root}" && pnpm add ${QQ_SDK_PACKAGE}@${QQ_SDK_VERSION} ${QQ_CONNECTOR_PACKAGE}@${QQ_CONNECTOR_VERSION}`
}

/** 两个包任一缺失都算未安装：只有两个都能导入时扫码与网关才完整可用。 */
export async function qqRuntimeStatus(): Promise<QqRuntimeStatus> {
  const root = qqRuntimeRoot()
  const missing: string[] = []
  for (const dependency of [
    { name: QQ_SDK_PACKAGE, entry: QQ_SDK_ENTRY, version: QQ_SDK_VERSION },
    { name: QQ_CONNECTOR_PACKAGE, entry: QQ_CONNECTOR_ENTRY, version: QQ_CONNECTOR_VERSION },
  ]) {
    if (!(await qqFileExists(join(root, 'node_modules', dependency.name, dependency.entry), root))) {
      missing.push(`${dependency.name}@${dependency.version}`)
    }
  }
  if (missing.length === 0) return { installed: true }
  return {
    installed: false,
    reason: `QQ runtime packages are missing from ${root}: ${missing.join(', ')}. Install them with: ${qqInstallCommand(root)}`,
  }
}

/** 加载官方网关 SDK；缺包或缺少关键导出都抛出带安装命令的 `QqRuntimeError`。 */
export async function loadQqSdk(): Promise<QqSdk> {
  const root = qqRuntimeRoot()
  const entry = join(root, 'node_modules', QQ_SDK_PACKAGE, QQ_SDK_ENTRY)
  const module = await qqImportRuntime(entry, QQ_SDK_PACKAGE, root)
  const bot = module['QQBot']
  if (typeof bot !== 'function') {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_SDK_PACKAGE} has no QQBot constructor at ${entry}; reinstall with: ${qqInstallCommand(root)}`,
      entry,
    )
  }
  const msgType = module['MsgType']
  if (!qqIsRecord(msgType)) {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_SDK_PACKAGE} has no MsgType table at ${entry}; reinstall with: ${qqInstallCommand(root)}`,
      entry,
    )
  }
  return { QQBot: bot as QqSdk['QQBot'], MsgType: msgType as Readonly<Record<string, number>> }
}

/** 加载扫码连接器；扫码只在绑定流程里用到，缺包时同样给安装命令。 */
export async function loadQqConnector(): Promise<QqConnector> {
  const root = qqRuntimeRoot()
  const entry = join(root, 'node_modules', QQ_CONNECTOR_PACKAGE, QQ_CONNECTOR_ENTRY)
  const module = await qqImportRuntime(entry, QQ_CONNECTOR_PACKAGE, root)
  const startQrConnect = module['startQrConnect']
  if (typeof startQrConnect !== 'function') {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_CONNECTOR_PACKAGE} has no startQrConnect() at ${entry}; reinstall with: ${qqInstallCommand(root)}`,
      entry,
    )
  }
  return startQrConnect as QqConnector
}

/**
 * 动态导入一个运行期模块。所有失败都归一到 `QQ_RUNTIME_MISSING`：
 * 用户视角只有一件事可做——按命令装包；原始错误挂在 cause 上供排障。
 */
async function qqImportRuntime(entry: string, packageName: string, root: string): Promise<Record<string, unknown>> {
  try {
    return await import(pathToFileURL(entry).href) as Record<string, unknown>
  } catch (cause) {
    throw new QqRuntimeError(
      'QQ_RUNTIME_MISSING',
      `${packageName} could not be loaded from ${entry}: ${qqReasonOf(cause)}. If it is not installed, run: ${qqInstallCommand(root)}`,
      entry,
      { cause },
    )
  }
}

async function qqFileExists(path: string, root: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (cause) {
    const errno = qqErrnoOf(cause)
    // 文件不存在 = 没装；其它 errno 是环境问题，不能伪装成「缺包」。
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return false
    throw new QqRuntimeError(
      'QQ_RUNTIME_MISSING',
      `cannot inspect ${path}: ${qqReasonOf(cause)}. Fix the directory permissions, then retry; the packages install with: ${qqInstallCommand(root)}`,
      path,
      { cause },
    )
  }
}

function qqErrnoOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function qqIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function qqReasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
