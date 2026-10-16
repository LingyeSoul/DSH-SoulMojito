/**
 * Confirmable host-session writes（D-2，决策 2026-10-11-confirmable-session-writes）。
 *
 * LittleWhiteBox 的工程教训（Apache-2.0，只抄语义不复刻源码）：宿主保存 API 可能
 * 吞异常/等锁超时静默不保存——「写完 marker 后从服务端读回验证在场才继续」。本
 * 仓库对应的风险面是跨版本宿主形状（见 host-session）：已知宿主的 `Session.append`
 * 同步写入内存日志并返回带 seq 的落账事件（dsh-session 的 append：`log.push` 后
 * 返回冻结事件，坏事件在 append 现场抛错），但「append 返回成功而日志无痕迹」在
 * 写侧无法排除。一切「写宿主侧状态后，后续行为依赖它成立」的写入——轮次基线推
 * 进、会话身份 marker、composer 接管判据——都必须经过这里的读回验证。
 *
 * 单条 marker 协议（confirmSessionAppend）：
 * 1. 追加后立即读回（sessionEvents 兼容层：events → snapshotEvents() → log）；
 * 2. 在场即返回 true；缺席则重写一次再读回（在场即停，append-only 日志不会重复；
 *    重写后在场补一行 warn，让退化的宿主可观测）；
 * 3. 两次尝试均缺席：打一行 error（含写入点标识与两次尝试结果）并返回 false，
 *    由调用方按该写入点的既有错误形态上抛或降级——静默吞正是要消灭的行为。
 *
 * 会话日志不可读（宿主形状未知，readSessionEvents 返回 undefined → 空数组）时无
 * 法确认，协议如实走到第 3 步；调用方按保守路径处理，绝不硬造确认。
 *
 * 批量 turn 结构写入（landedPlanAppends）不能盲目整段重放：重复轮号本身就是
 * v4 准入要消灭的损坏形状。验证按「计划前缀连续落在日志尾部」对齐计数；只有
 * 日志尾部恰好等于已落地前缀（无计划外残渣）时，调用方才允许按对齐数补写缺
 * 失后缀重试一次——后缀接续在密集轮号之后，不产生重复轮号。
 */
import { sessionEvents, type HostSessionEvent, type HostSessionLog } from './host-session.js'

export interface ConfirmableWriteLogger {
  warn?: (message: string) => void
  error?: (message: string) => void
}

export interface ConfirmSessionAppendOptions {
  /** 宿主会话对象；读取走 host-session 兼容层。 */
  session: HostSessionLog | null | undefined
  /** 写入点标识，进可观测日志行。 */
  label: string
  logger?: ConfirmableWriteLogger
  /** 执行一次追加；协议最多调用两次（首次 + 一次重写）。 */
  append: () => unknown
  /** 读回判定：事件日志里是否已存在这次写入的落账。 */
  present: (events: readonly HostSessionEvent[]) => boolean
}

/**
 * 单条「必须成立」marker 的读回验证。返回 true = 已确认在场（首次或重写后）；
 * false = 两次尝试后仍不在场（error 日志已打）。重写只在读回缺席时发生，对幂等
 * marker（同 id 的 preset/selected、同 summary 的 notice）安全；调用方须保证其
 * 写入点满足这一前提。
 */
export function confirmSessionAppend(options: ConfirmSessionAppendOptions): boolean {
  options.append()
  if (options.present(sessionEvents(options.session))) return true
  options.append()
  if (options.present(sessionEvents(options.session))) {
    options.logger?.warn?.(
      `dsh-soulmojito: session write '${options.label}' was accepted but invisible on first read-back; the rewrite made it visible (degraded host append suspected)`,
    )
    return true
  }
  options.logger?.error?.(
    `dsh-soulmojito: session write '${options.label}' could not be confirmed by read-back (attempt 1: absent, attempt 2: absent after one rewrite); failing honestly instead of continuing on unconfirmed host state`,
  )
  return false
}

/** 计划追加项的最小形状（与 plugin 侧 SessionImportAppend 兼容）。 */
export interface PlannedSessionAppend {
  type: string
  data: unknown
}

/**
 * 批量计划落在宿主日志尾部的连续前缀长度。从 baseLength（写入前的日志长度）起
 * 逐条比对 type 与 data 的 JSON 序列（宿主 append 落账的是入参快照，键序保持），
 * 首个不匹配即停。返回值供调用方判断：
 * - 等于 plan.length：全部落地；
 * - 小于 plan.length 且 events.length === baseLength + 返回值：干净前缀，可安全
 *   补写缺失后缀重试一次；
 * - 小于 plan.length 且日志更长：尾部有计划外残渣（错位/异源事件），任何重放都
 *   会重复边界事件，禁止重试，只能如实降级。
 */
export function landedPlanAppends(
  session: HostSessionLog | null | undefined,
  plan: readonly PlannedSessionAppend[],
  baseLength: number,
): number {
  const events = sessionEvents(session)
  if (!Number.isSafeInteger(baseLength) || baseLength < 0 || events.length <= baseLength) return 0
  let landed = 0
  while (baseLength + landed < events.length && landed < plan.length) {
    const event = events[baseLength + landed]
    const item = plan[landed]
    if (event === undefined || item === undefined) break
    if (event.type !== item.type || JSON.stringify(event.data) !== JSON.stringify(item.data)) break
    landed += 1
  }
  return landed
}
