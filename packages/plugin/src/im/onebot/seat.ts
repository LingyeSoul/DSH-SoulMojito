/**
 * OneBot 反向 WS 的升级席位（提案 0024 §5「registerUpgrade」）。
 *
 * 宿主的 `registerUpgrade` 对同一路径重复注册会抛错，而插件热重载时新 fiber
 * 的注册**可能早于**旧 fiber 的 disposer 执行——按「每次 apply 注册一次」写，
 * 重载后新实例会永远拿不到路由，旧路由又指向已死的闭包。
 *
 * 因此席位在进程内只注册一次，并且**不由任何实例生命周期回收**：路由常驻，
 * 靠 globalThis 句柄（`im/handle.ts`）在每次握手时解析当前运行时。实例卸载后
 * 握手得到 503，重建后自动恢复，不需要重启进程。
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { resolveImRuntime } from '../handle.js'

/** 席位 key（bundle 间互见契约，不得变更）。 */
export const ONEBOT_SEAT_KEY = 'dsh-soulmojito:im-onebot-upgrade-seat'

const seatSymbol = Symbol.for(ONEBOT_SEAT_KEY)

interface SeatHolder {
  path: string
}

/** 宿主 webServer 的最小投影；socket 在宿主契约里是 unknown。 */
export interface OneBotSeatHost {
  registerUpgrade?(route: {
    path: string
    handler: (req: IncomingMessage, socket: unknown, head: Buffer) => Promise<void> | void
  }): () => void
}

export interface SeatResult {
  registered: boolean
  reason?: string
}

/**
 * 保证席位存在。已存在时直接返回成功（不重复注册、也不接管别人的路由）。
 * 返回的 `reason` 只在宿主缺 seam 时出现，供面板如实展示。
 */
/**
 * 保证席位存在。已存在时直接返回成功（不重复注册、也不接管别人的路由）。
 * 返回的 `reason` 只在宿主缺 seam 或注册失败时出现，供面板如实展示。
 */
export function ensureOneBotUpgradeSeat(host: OneBotSeatHost | undefined, path: string): SeatResult {
  if (host === undefined || typeof host.registerUpgrade !== 'function') {
    return {
      registered: false,
      reason: 'the host exposes no webServer.registerUpgrade; OneBot reverse WebSocket is unavailable (HTTP POST webhook still works)',
    }
  }
  const holder = globalThis as Record<symbol, SeatHolder | undefined>
  if (holder[seatSymbol]?.path === path) return { registered: true }
  try {
    host.registerUpgrade.call(host, {
      path,
      handler: (req, socket, head) => dispatchUpgrade(req, socket, head),
    })
  } catch (error) {
    return {
      registered: false,
      reason: `registering the OneBot upgrade route at ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  holder[seatSymbol] = { path }
  return { registered: true }
}

/** 握手分派：句柄缺失（IM 关闭/卸载中）时明确拒绝，不静默挂起。 */function dispatchUpgrade(req: IncomingMessage, socket: unknown, head: Buffer): void {
  const runtime = resolveImRuntime()
  const handler = runtime?.handleOneBotUpgrade
  if (handler === undefined) {
    rejectUpgrade(socket, 'IM runtime is not available; the OneBot endpoint is closed')
    return
  }
  void Promise.resolve(handler(req, socket, head)).catch(() => {
    rejectUpgrade(socket, 'OneBot upgrade handling failed')
  })
}

function rejectUpgrade(socket: unknown, reason: string): void {  const duplex = socket as Duplex
  if (duplex.destroyed) return
  try {
    duplex.write(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`)
  } finally {
    duplex.destroy()
  }
}

/** 测试隔离用：席位是 globalThis 状态，会在测试文件与用例之间共享。 */
export function clearOneBotSeatForTest(): void {
  delete (globalThis as Record<symbol, SeatHolder | undefined>)[seatSymbol]
}
