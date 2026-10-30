/**
 * IM 运行时的跨 bundle 句柄（提案 0024 §3.6，镜像 `games/handle.ts` 纪律）。
 *
 * 为什么必须锚 globalThis：IM 运行时只活在 index bundle（`apply()` 里创建并
 * 交给 `setImRuntime`），而 IM 工具族活在 agent bundle（`agent.mjs` 是独立
 * esbuild 产物，模块级变量不共享）。注册动作（index bundle 写）与消费动作
 * （agent bundle 每次工具调用读）只能经 globalThis 互见。
 *
 * 本模块刻意不 import `runtime.ts`：agent bundle 内联这份 seam 时不会把更新
 * 服务、Mod 宿主与 store 装配整图拖进去。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostSessionEventLike, HostSessionLike } from '../host-contract.js'
import { envCompat } from '../env-compat.js'
import type { ImSessionCapabilities } from './session-host.js'
import type { ImAccountRef, ImBindStatus, ImChannelId, ImChannelView, ImSendReceipt } from './types.js'

/** bundle 间互见契约 key（不得变更）。 */
export const IM_RUNTIME_KEY = 'dsh-soulmojito:im-runtime'

const runtimeSymbol = Symbol.for(IM_RUNTIME_KEY)

/** 工具面需要的最小路由投影：主动发文本。 */
export interface ImRouterHandle {
  sendText(peerKey: string, text: string): Promise<ImSendReceipt>
}

/** 运行时契约：工具面、HTTP 面与装配面共用同一份形状。 */
export interface ImRuntimeHandle {
  readonly capabilities: ImSessionCapabilities
  views(): ImChannelView[]
  /** 登记或更新一个账号：密钥落盘后按通道适配器启动。 */
  upsertAccount(account: ImAccountRef, secret: Record<string, string>): Promise<void>
  /** 停通道并删账号与密钥；账号原本不存在时返回 false。 */
  removeAccount(channel: ImChannelId, accountId: string): Promise<boolean>
  /**
   * OneBot HTTP POST 入站：按 token 选中账号并处理。
   * 返回 false 表示当前没有任何账号接受这个 token（调用方回 401）。
   */
  handleOneBotWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** 手动绑定：把已存在的聊天补上会话与 AgentTavern 绑定。 */
  bindChat(
    chat: { character: string; chatId: string },
    existingSessionId: string | undefined,
  ): Promise<{ sessionId: string; character: string; chatId: string }>
  /** `session/event` 接线点；非 IM 会话直接返回。 */
  handleSessionEvent(session: HostSessionLike, event: HostSessionEventLike): void
  /**
   * 反向 WS 握手分派（由常驻的升级席位调用）。可选：没有 OneBot 通道的实现
   * （测试假件、将来的空装）不必实现它。
   */
  handleOneBotUpgrade?(req: unknown, socket: unknown, head: Buffer): Promise<void>
  /**
   * 扫码绑定（提案 0024 §4.1）：本轮只有 QQ。三个成员都可选，缺省表示这个
   * 运行时没有绑定能力（面板照实显示 501，不假装扫码可用）。
   */
  startQrBind?(channel: ImChannelId): Promise<ImBindStatus>
  /** 当前绑定相位；`waiting` 相位里的 `url` 供面板渲染二维码。 */
  qrBindStatus?(): ImBindStatus
  /** 取消进行中的扫码；没有活动会话时是空操作。 */
  cancelQrBind?(): ImBindStatus
  dispose(): Promise<void>
  readonly router: ImRouterHandle
}

interface RuntimeHolder {
  runtime: ImRuntimeHandle
  token: number
}

let nextToken = 1

/**
 * 写侧：发布当前运行时，返回撤销函数。
 *
 * sequence 守卫（镜像 `publishGamesService`）：热重载/二次 apply 时旧 fiber 的
 * disposer 晚于新 fiber 执行，无条件下删会把新句柄一起抹掉，`getImRuntime()`
 * 变 undefined 而旧实例还活着——回复抽取静默停摆。
 */
export function publishImRuntime(runtime: ImRuntimeHandle): () => void {
  const holder = globalThis as Record<symbol, RuntimeHolder | undefined>
  const token = nextToken++
  holder[runtimeSymbol] = { runtime, token }
  return () => {
    if (holder[runtimeSymbol]?.token === token) delete holder[runtimeSymbol]
  }
}

/** 读侧：逐调用解析；缺失（IM 未装配 / 已卸载）返回 undefined。 */
export function resolveImRuntime(): ImRuntimeHandle | undefined {
  return (globalThis as Record<symbol, RuntimeHolder | undefined>)[runtimeSymbol]?.runtime
}

/** 测试隔离用：globalThis 在测试文件间共享，必须能强制摘除。 */
export function clearImRuntimeForTest(): void {
  delete (globalThis as Record<symbol, RuntimeHolder | undefined>)[runtimeSymbol]
}

/**
 * 环境硬关：`DSH_SOULMOJITO_DISABLE_IM` 非空且不为 0/false。
 *
 * 放在 handle 而不是 runtime：agent bundle 只需要这一个同步判定来决定是否注册
 * 工具，不能为它把整个运行时装配图拖进工具面。
 */
export function imDisabledByEnv(): boolean {
  const disabled = envCompat('DISABLE_IM')?.trim()
  return disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false'
}
