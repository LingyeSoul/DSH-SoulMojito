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
export const QQ_SDK_PACKAGE = '@tencent-connect/qqbot-nodejs'
export const QQ_CONNECTOR_PACKAGE = '@tencent-connect/qqbot-connector'
/** 安装命令里的版本；升级时与 decision 记录同步改。 */
export const QQ_SDK_VERSION = '1.0.5'
export const QQ_CONNECTOR_VERSION = '1.2.0'
/** 包的 ESM 入口（相对各自的包目录）：只认这两个文件，不猜 exports 映射。 */
const QQ_SDK_ENTRY = 'dist/index.js'
const QQ_CONNECTOR_ENTRY = 'dist/esm/index.js'

/**
 * 运行时依赖清单：包名、版本、入口只此一处。状态检查、安装参数与安装命令都
 * 从这里取，避免三处版本号各自漂移。
 */
export interface QqRuntimePackageRef {
  readonly name: string
  readonly version: string
  /** 相对包目录的入口文件（安装完成的判定依据）。 */
  readonly entry: string
}

export const QQ_RUNTIME_PACKAGES: readonly QqRuntimePackageRef[] = [
  { name: QQ_SDK_PACKAGE, version: QQ_SDK_VERSION, entry: QQ_SDK_ENTRY },
  { name: QQ_CONNECTOR_PACKAGE, version: QQ_CONNECTOR_VERSION, entry: QQ_CONNECTOR_ENTRY },
]

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

/**
 * 入站附件（官方 d.ts 的 `InboundAttachment`）：`content_type` 是 MIME 风格的
 * 类型串，`url` 是平台 CDN 的 https 直链，`size` 单位为字节。语音另有
 * `voice_wav_url`（服务端转码的 wav）与 `asr_refer_text`（平台自带识别结果）。
 */
export interface QqInboundAttachment {
  content_type: string
  url: string
  filename?: string
  height?: number
  width?: number
  size?: number
  voice_wav_url?: string
  asr_refer_text?: string
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
  /**
   * SDK 1.0.5 把平台事件的 `attachments` 归一到这里；手写/旧版载荷只在
   * `raw.attachments` 上带同名数组，通道两处都认（见 channel.ts）。
   */
  attachments?: readonly QqInboundAttachment[]
  replyTarget: QqReplyTarget
  raw?: unknown
}

/** 发送回执里唯一有用的字段；其余由 SDK 保留。 */
export interface QqMessageResponse {
  id: string
}

/** 媒体发送的源：本地文件优先；图片/视频允许直传平台可抓取的 https 地址。 */
export interface QqMediaSource {
  localPath?: string
  url?: string
}

/** 媒体发送的附加项：`content` 是随媒体上屏的说明文字，`fileName` 只给文件消息。 */
export interface QqMediaSendOptions {
  content?: string
  fileName?: string
}

/** 媒体发送回执：SDK 先 upload 再落成消息，`message` 才是可引用的那一条。 */
export interface QqMediaSendResult {
  message?: QqMessageResponse
}

/** 通用媒体发送入参（`fileType` 取 SDK 的 `MediaFileType` 枚举值）。 */
export interface QqSendMediaOptions {
  target: QqReplyTarget
  fileType: number
  localPath?: string
  url?: string
  fileName?: string
  content?: string
}

/**
 * `QQBot` 实例上被本插件使用的成员。`on` 写成重载而不是
 * `(...args: unknown[])`：后者会让「只接两个参数的 message 处理器」在严格
 * 模式下不可赋值。
 *
 * 媒体方法全是可选的：包版本/build 差异可能少某个便捷方法，通道在调用点
 * 给出「这个 build 没有 sendX」的明确报错，而不是在类型层假装一定有。
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
  sendImage?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendVideo?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendVoice?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendFile?(target: QqReplyTarget, source: QqMediaSource, opts?: QqMediaSendOptions): Promise<QqMediaSendResult>
  sendMedia?(opts: QqSendMediaOptions): Promise<QqMediaSendResult>
}

/** `@tencent-connect/qqbot-nodejs` 的加载结果：构造器 + 消息类型常量。 */
export interface QqSdk {
  readonly QQBot: new (options: QqBotOptions) => QqBotLike
  readonly MsgType: Readonly<Record<string, number>>
  /**
   * 媒体文件类型枚举（IMAGE/VIDEO/VOICE/FILE）。旧 build 可能不导出：缺省时
   * 媒体仍按 `sendImage`/`sendFile` 等便捷方法发送，只有需要原始 `sendMedia`
   * 的调用方才用得到这张表。
   */
  readonly MediaFileType?: Readonly<Record<string, number>>
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
 * 运行期加载失败。`path` 指向期望的入口文件；message 只说「缺哪个包、去面板
 * 按安装按钮」，**绝不**把 shell 命令甩给用户——QQ 运行时的安装由插件自己在
 * 面板里完成（提案 0024 §5，镜像本地 ONNX 运行时）。
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

/**
 * 两个包任一缺失都算未安装：只有两个都能导入时扫码与网关才完整可用。
 */
export async function qqRuntimeStatus(): Promise<QqRuntimeStatus> {
  const root = qqRuntimeRoot()
  const missing: string[] = []
  for (const dependency of QQ_RUNTIME_PACKAGES) {
    if (!(await qqFileExists(join(root, 'node_modules', dependency.name, dependency.entry), root))) {
      missing.push(`${dependency.name}@${dependency.version}`)
    }
  }
  if (missing.length === 0) return { installed: true }
  // reason 会经 `GET im` 进浏览器：只给包名与动作，不带运行期目录的绝对路径。
  return {
    installed: false,
    reason: `QQ runtime packages are missing: ${missing.join(', ')}. `
      + 'Open the IM panel and press 安装 QQ 依赖 to let the plugin install them.',
  }
}

/** 加载官方网关 SDK；缺包或缺少关键导出都抛出指向面板安装的 `QqRuntimeError`。 */
export async function loadQqSdk(): Promise<QqSdk> {
  const root = qqRuntimeRoot()
  const entry = join(root, 'node_modules', QQ_SDK_PACKAGE, QQ_SDK_ENTRY)
  const module = await qqImportRuntime(entry, QQ_SDK_PACKAGE, root)
  const bot = module['QQBot']
  if (typeof bot !== 'function') {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_SDK_PACKAGE} has no QQBot constructor at ${entry}; open the IM panel and press 安装 QQ 依赖 to reinstall the runtime`,
      entry,
    )
  }
  const msgType = module['MsgType']
  if (!qqIsRecord(msgType)) {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_SDK_PACKAGE} has no MsgType table at ${entry}; open the IM panel and press 安装 QQ 依赖 to reinstall the runtime`,
      entry,
    )
  }
  const sdk: QqSdk = { QQBot: bot as QqSdk['QQBot'], MsgType: msgType as Readonly<Record<string, number>> }
  // MediaFileType 不是必需导出：1.0.5 有它，旧 build 可能没有；缺省时媒体发送
  // 按 sendImage/sendFile 等便捷方法走。既然存在就必须是表——形状坏了属于
  // SDK 变更，在加载处就炸，而不是等到发图时才炸在类型假设上。
  const mediaFileType = module['MediaFileType']
  if (mediaFileType === undefined) return sdk
  if (!qqIsRecord(mediaFileType)) {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_SDK_PACKAGE} exports a non-object MediaFileType at ${entry}; open the IM panel and press 安装 QQ 依赖 to reinstall the runtime`,
      entry,
    )
  }
  return { ...sdk, MediaFileType: mediaFileType as Readonly<Record<string, number>> }
}

/** 加载扫码连接器；扫码只在绑定流程里用到，缺包时同样指向面板安装。 */
export async function loadQqConnector(): Promise<QqConnector> {
  const root = qqRuntimeRoot()
  const entry = join(root, 'node_modules', QQ_CONNECTOR_PACKAGE, QQ_CONNECTOR_ENTRY)
  const module = await qqImportRuntime(entry, QQ_CONNECTOR_PACKAGE, root)
  const startQrConnect = module['startQrConnect']
  if (typeof startQrConnect !== 'function') {
    throw new QqRuntimeError(
      'QQ_RUNTIME_INVALID',
      `${QQ_CONNECTOR_PACKAGE} has no startQrConnect() at ${entry}; open the IM panel and press 安装 QQ 依赖 to reinstall the runtime`,
      entry,
    )
  }
  return startQrConnect as QqConnector
}

/**
 * 动态导入一个运行期模块。所有失败都归一到 `QQ_RUNTIME_MISSING`：
 * 用户视角只有一件事可做——去面板按安装按钮；原始错误挂在 cause 上供排障。
 */
async function qqImportRuntime(entry: string, packageName: string, root: string): Promise<Record<string, unknown>> {
  try {
    return await import(pathToFileURL(entry).href) as Record<string, unknown>
  } catch (cause) {
    throw new QqRuntimeError(
      'QQ_RUNTIME_MISSING',
      `${packageName} could not be loaded from ${entry}: ${qqReasonOf(cause)}. `
        + `If it is not installed, open the IM panel and press 安装 QQ 依赖 (runtime root: ${root})`,
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
      `cannot inspect ${path}: ${qqReasonOf(cause)}. Fix the directory permissions and retry; the QQ runtime is installed from the IM panel (root: ${root})`,
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
