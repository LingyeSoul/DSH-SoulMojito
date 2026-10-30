/**
 * QQ 扫码绑定状态机（提案 0024 §4.1 / M3）。
 *
 * 只做状态机与取消：二维码从哪来、凭据落到哪个账号、扫码人何时进白名单，都由
 * 调用方通过回调决定（运行时负责落库，本模块不认识 store 也不认识 Tavern）。
 *
 * 三条不变量：
 * 1. 进程内只允许一个活动会话——两个二维码同时轮询会让「扫码人即 owner」的归属
 *    变成掷硬币；第二个 start 直接抛 `QQ_BIND_BUSY`。
 * 2. 过期回调必须被丢弃：取消后连接器仍可能回调 `onFailure('已取消')` 甚至迟到的
 *    `onSuccess`，用会话身份比对挡掉，绝不让已取消的扫码改写账号。
 * 3. 相位只朝前走：waiting → saving → idle/failed，取消是 waiting/saving → idle。
 */

import type { ImBindStatus } from '../types.js'
import type { QqConnector, QqConnectorCallbacks, QqConnectorCredential, QqConnectorOptions } from './sdk.js'

/**
 * 连接器词汇直接复用 `sdk.ts` 的结构类型：那边是运行期校验过的官方
 * `startQrConnect` 形状，这里再声明一份只会让两边慢慢漂移。
 *
 * 连接器不在产物里，由调用方在 `start()` 时惰性加载（包缺失时投影成 failed），
 * 因此本模块没有静态 import。
 */
export type QQBindCredential = QqConnectorCredential
export type QQConnectorCallbacks = QqConnectorCallbacks
export type QQConnectorOptions = QqConnectorOptions
/** 返回取消函数；与 `@tencent-connect/qqbot-connector` 的 `startQrConnect` 同形。 */
export type QQConnector = QqConnector

export type QQBindErrorCode = 'QQ_BIND_BUSY' | 'QQ_BIND_ABORTED'

export class QQBindError extends Error {
  readonly code: QQBindErrorCode

  constructor(code: QQBindErrorCode, message: string) {
    super(message)
    this.name = 'QQBindError'
    this.code = code
  }
}

/** 调用方提供的回调：失败不是异常路径，运行时要打日志但不必中断。 */
export interface QQBindCallbacks {
  onQrDisplayed?(url: string): void
  onSuccess(credentials: readonly QQBindCredential[]): void | Promise<void>
  onFailure?(error: Error): void
}

export interface QQBindStartOptions {
  /** 运行时生命信号：插件卸载/热重载时随参数中止，不留孤儿轮询。 */
  signal: AbortSignal
  /** 拼进二维码 URL 的来源标识。 */
  source: string
}

export interface QQBinding {
  startQrConnect(callbacks: QQBindCallbacks, options: QQBindStartOptions): Promise<ImBindStatus>
  cancel(): ImBindStatus
  status(): ImBindStatus
  /** 与 cancel 等价；运行时 dispose 时调用。 */
  dispose(): void
}

export interface QQBindingOptions {
  /** 惰性加载扫码连接器；缺包时 start 投影为 failed，reason 即加载错误。 */
  connect: () => Promise<QqConnector>
}

interface BindingSession {
  controller: AbortController
  /** 连接器自己的取消函数（它持有一个内部 AbortController）。 */
  stop: () => void
}

export function createQQBinding(options: QQBindingOptions): QQBinding {
  let phase: ImBindStatus = { phase: 'idle' }
  let session: BindingSession | undefined

  function status(): ImBindStatus {
    return { ...phase }
  }

  async function startQrConnectSession(callbacks: QQBindCallbacks, start: QQBindStartOptions): Promise<ImBindStatus> {
    if (session !== undefined) {
      throw new QQBindError('QQ_BIND_BUSY', 'a QQ QR binding session is already running; cancel it before starting another one')
    }
    if (start.signal.aborted) {
      throw new QQBindError('QQ_BIND_ABORTED', 'the QQ QR binding cannot start: the runtime is already shutting down')
    }
    const controller = new AbortController()
    const current: BindingSession = { controller, stop: () => {} }
    session = current
    phase = { phase: 'waiting' }

    // 连接器是运行期动态导入的：加载期间面板保持 waiting，加载失败同样是 failed 相位。
    let connector: QqConnector
    try {
      connector = await options.connect()
    } catch (error) {
      // 已取消的会话：错误属于过期请求，不覆盖 cancel 已经写好的 idle 相位。
      if (session !== current) return status()
      session = undefined
      phase = { phase: 'failed', reason: messageOf(error) }
      throw error
    }
    // 加载期间被取消：会话已摘，绝不再开一个无人认领的轮询。
    if (session !== current) return status()
    if (start.signal.aborted) {
      session = undefined
      phase = { phase: 'idle' }
      throw new QQBindError('QQ_BIND_ABORTED', 'the QQ QR binding cannot start: the runtime is already shutting down')
    }

    let stop: () => void
    try {
      stop = connector({
        onQrDisplayed: (url) => {
          if (session !== current) return
          phase = { phase: 'waiting', url }
          callbacks.onQrDisplayed?.(url)
        },
        onQrExpired: () => {
          if (session !== current) return
          // SDK 会自己拉新码；旧链接必须立刻作废，面板不能继续展示扫不动的二维码。
          phase = { phase: 'waiting' }
        },
        onSuccess: (credentials) => {
          if (session !== current) return
          phase = { phase: 'saving' }
          // 保存失败不只改相位：调用方要拿到原始错误（例如磁盘 0600 校验失败）。
          void Promise.resolve(callbacks.onSuccess(credentials)).then(
            () => {
              if (session !== current) return
              session = undefined
              phase = { phase: 'idle' }
            },
            (error: unknown) => {
              if (session !== current) return
              session = undefined
              const reason = messageOf(error)
              phase = { phase: 'failed', reason }
              callbacks.onFailure?.(error instanceof Error ? error : new Error(reason))
            },
          )
        },
        onFailure: (error) => {
          if (session !== current) return
          session = undefined
          phase = { phase: 'failed', reason: error.message }
          callbacks.onFailure?.(error)
        },
      }, {
        signal: controller.signal,
        source: start.source,
        // 官方 SDK 默认把二维码 URL 打到宿主控制台；二维码只经 onQrDisplayed 交给面板。
        displayQrCodeToConsole: false,
      })
    } catch (error) {
      // 起不来就必须把会话摘干净：否则下一次 start 会被自己的残骸判成 busy。
      session = undefined
      phase = { phase: 'failed', reason: messageOf(error) }
      throw error
    }
    current.stop = stop
    return status()
  }

  function cancel(): ImBindStatus {
    const current = session
    if (current === undefined) return status()
    // 先摘会话再中止：连接器的 onFailure('已取消') 到来时必须被当成过期回调丢弃。
    // `saving` 相位里取消只停轮询，已经开始的写盘不回滚——账号要么完整落库要么
    // 在 upsertAccount 里失败并进入 failed，不存在「取消了一半」的账号。
    session = undefined
    phase = { phase: 'idle' }
    current.controller.abort()
    current.stop()
    return status()
  }

  return {
    startQrConnect: startQrConnectSession,
    cancel,
    status,
    dispose: () => { cancel() },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
