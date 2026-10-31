/**
 * 微信出站队列（决策 2026-10-31-weixin-send-queue）：
 * 按账号一条 FIFO，把「突发预算等待」「-2 冷却重试」从调用方手里接过来。
 *
 * 规则：
 * - 每个 part 的真实 `sendmessage` 不早于 `lastSendAt + intervalMs`，也不早于
 *   窗口腾出的下一个名额（窗口仍是 30s/5 条的硬上限）；`-2` 冷却期内一个请求
 *   都不发。到点前 `sendGuard.reserveSlot()` 占位，占不到就等 `nextWindowSlotAt`。
 * - 一个逻辑发送（一次 `im_send` 的所有 part）在队内连续执行，part 之间不插别的
 *   发送；失败从失败的那个 part 继续，不重发已成功的 part。
 * - `-2`：记录冷却、保留队首任务，最多再试 `maxRetries` 次；再失败就把错误交给
 *   仍在等待的调用方，并保留「未送达」的事实，绝不静默丢弃。
 * - 快速路径：预计能在 `fastWaitMs` 内开始就等真实结果；否则立刻返回
 *   `{ status: 'queued', scheduledAt }`，由队列在后台发送。每次真正等待/发送前
 *   都会滚动重判：入队已超过 fastWait，或本轮计划开始晚于 deadline，就先给回执；
 *   中途才撞上长冷却时同样先给排队回执（调用方不该被工具超时拖住 5 分钟）。
 *
 * 状态与任务都是进程内的：重启丢掉未发出的排队消息，不假装它们还会送达。
 */

import type { HostLogger } from '../../host-contract.js'
import type {
  ImQueuedSendReceipt,
  ImSendOutcome,
  ImSendReceipt,
  ImSendStatus,
  ImTarget,
  OutboundPart,
} from '../types.js'
import type { WeixinClock } from './clock.js'
import { WeixinChannelError } from './errors.js'
import { SEND_THROTTLE_COOLDOWN_MS, SEND_WINDOW_MAX, SEND_WINDOW_MS, type WeixinSendGuard } from './send-guard.js'

/** 一轮工具调用最多为真实发送等多久：超时改回「已排队 + 预计时间」。 */
export const IM_SEND_FAST_WAIT_MS = 10_000
/** `-2` 后额外重试一次；平台会把连续重试当惩罚，重试再多只会更糟。 */
export const WEIXIN_SEND_MAX_RETRIES = 1

export interface WeixinSendQueueOptions {
  accountId: string
  clock: WeixinClock
  guard: WeixinSendGuard
  /** 相邻两次 `sendmessage` 的最小间隔（毫秒）；由设置注入，可运行中更新。 */
  intervalMs: number
  fastWaitMs: number
  maxRetries: number
  /** 单个 part 的真实发送；返回平台 message id（没有就 undefined）。 */
  sendPart: (target: ImTarget, part: OutboundPart) => Promise<string | undefined>
  /** 一个逻辑发送第一次出站前回调一次（输入状态、context_token 告警）。 */
  onJobStart?: (target: ImTarget) => void
  logger?: HostLogger
}

interface SendJob {
  target: ImTarget
  parts: readonly OutboundPart[]
  enqueuedAt: number
  /** 计划的第一部分开始时间；也是「已排队」回执里的 scheduledAt。 */
  scheduledAt: number
  nextPart: number
  lastMessageId: string | undefined
  throttleRetries: number
  callerSettled: boolean
  started: boolean
  /** 本任务每个 part 的计划开始时间（全局投影里各占一条）。 */
  projectedStarts: number[]
  resolve: (outcome: ImSendOutcome) => void
  reject: (error: unknown) => void
  promise: Promise<ImSendOutcome>
}

export class WeixinSendQueue {
  private readonly accountId: string
  private readonly clock: WeixinClock
  private readonly guard: WeixinSendGuard
  private readonly fastWaitMs: number
  private readonly maxRetries: number
  private readonly sendPart: WeixinSendQueueOptions['sendPart']
  private readonly onJobStart: WeixinSendQueueOptions['onJobStart']
  private readonly logger: HostLogger | undefined

  private interval: number
  private jobs: SendJob[] = []
  /** 所有待执行 part 的计划开始时间（升序），用于算窗口与 nextSendAt。 */
  private projectedStarts: number[] = []
  private lastSendAt: number | undefined
  private stopped = false
  private stopController = new AbortController()
  private loopPromise: Promise<void> | undefined

  constructor(options: WeixinSendQueueOptions) {
    this.accountId = options.accountId
    this.clock = options.clock
    this.guard = options.guard
    this.interval = options.intervalMs
    this.fastWaitMs = options.fastWaitMs
    this.maxRetries = options.maxRetries
    this.sendPart = options.sendPart
    this.onJobStart = options.onJobStart
    this.logger = options.logger
  }

  /** 通道 start：stop 过的队列可以重新启用（账号重连走同一实例时）。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.stopController = new AbortController()
  }

  /** 面板改了间隔：后续入队与下一次等待按新值；已在等的任务保留原计划时间。 */
  setIntervalMs(value: number): void {
    this.interval = value
  }

  /**
   * 入队一个逻辑发送。返回的 promise 要么给真实回执，要么给排队回执；
   * 已排队任务在后台继续，不会因为调用方离开而停。
   */
  enqueue(target: ImTarget, parts: readonly OutboundPart[]): Promise<ImSendOutcome> {
    const now = this.clock.now()
    if (this.stopped) {
      return Promise.reject(new WeixinChannelError(
        'WEIXIN_CLOSED',
        `weixin account '${this.accountId}' is not running; replies can only be delivered while polling is active`,
      ))
    }
    if (parts.length === 0) return Promise.resolve({ parts: 0, at: now })
    const job = this.createJob(target, parts, now)
    this.jobs.push(job)
    this.wake()
    // 预计等待超过工具调用能承受的范围：立刻交回排队回执，后台发送。
    if (job.scheduledAt - now > this.fastWaitMs) this.settleQueued(job, job.scheduledAt)
    return job.promise
  }

  /** 取消挂起的等待并拒绝所有未结算任务；幂等。 */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopController.abort()
    const error = new WeixinChannelError(
      'WEIXIN_CLOSED',
      `weixin account '${this.accountId}' stopped; queued messages were not delivered`,
    )
    for (const job of this.jobs.splice(0)) {
      this.releaseJobProjection(job)
      if (job.callerSettled) {
        this.logger?.warn?.(
          `dsh-soulmojito im weixin/${this.accountId}: a queued send was dropped because the channel stopped before it could retry (the caller already had a queued receipt)`,
        )
        continue
      }
      job.callerSettled = true
      job.reject(error)
    }
    this.projectedStarts = []
    await this.loopPromise?.catch(() => {
      // 循环自己消化异常；stop 只负责等它退出。
    })
  }

  /** 出站节奏投影；从注入的时钟取「现在」，测试与面板看到的是同一事实。 */
  status(): ImSendStatus {
    const now = this.clock.now()
    const throttleUntil = this.guard.throttleUntil()
    if (this.stopped) return { allowedNow: false, queueDepth: 0 }
    const queueHead = this.projectedStarts.length === 0
      ? now
      : Math.max(now, this.projectedStarts[0] ?? now)
    const lastSendFloor = this.lastSendAt === undefined ? now : this.lastSendAt + this.interval
    let at = Math.max(now, queueHead, lastSendFloor, throttleUntil ?? 0)
    at = Math.max(at, this.guard.nextWindowSlotAt(at))
    at = this.nextWindowAwareAt(at, this.projectedStarts)
    const allowedNow = this.jobs.length === 0 && at <= now
    return {
      allowedNow,
      ...(allowedNow ? {} : { nextSendAt: at }),
      ...(throttleUntil !== undefined && throttleUntil > now ? { throttleUntil } : {}),
      queueDepth: this.jobs.length,
    }
  }

  private createJob(target: ImTarget, parts: readonly OutboundPart[], now: number): SendJob {
    const planned = this.planParts(parts.length, now)
    let resolveJob: (outcome: ImSendOutcome) => void = () => {}
    let rejectJob: (error: unknown) => void = () => {}
    const promise = new Promise<ImSendOutcome>((resolve, reject) => {
      resolveJob = resolve
      rejectJob = reject
    })
    return {
      target,
      parts,
      enqueuedAt: now,
      scheduledAt: planned[0] ?? now,
      nextPart: 0,
      lastMessageId: undefined,
      throttleRetries: 0,
      callerSettled: false,
      started: false,
      projectedStarts: planned,
      resolve: resolveJob,
      reject: rejectJob,
      promise,
    }
  }

  /** 规划 `count` 个 part 的开始时间：间隔 + 窗口额度，逐条投影。 */
  private planParts(count: number, now: number): number[] {
    let at = Math.max(
      now,
      this.lastSendAt === undefined ? now : this.lastSendAt + this.interval,
      this.projectedStarts.length === 0 ? now : (this.projectedStarts.at(-1) ?? now) + this.interval,
      this.guard.throttleUntil() ?? 0,
    )
    const planned: number[] = []
    for (let index = 0; index < count; index += 1) {
      // 真实窗口里的既有发送 + 本队列已投影的未来 part，两边都要让开。
      at = Math.max(at, this.guard.nextWindowSlotAt(at))
      at = this.nextWindowAwareAt(at, this.projectedStarts)
      planned.push(at)
      this.projectedStarts.push(at)
      this.projectedStarts.sort((left, right) => left - right)
      at += this.interval
    }
    return planned
  }

  /**
   * 在 `at` 之后找第一个「30s 窗口里不足 5 条」的时刻。candidates 是已排定但
   * 还没发出的 part 开始时间；窗口里的第 5 条必须过期才有空位（严格 `<`，
   * 与 guard 的 `now - at < SEND_WINDOW_MS` 同口径）。
   */
  private nextWindowAwareAt(at: number, candidates: readonly number[]): number {
    let candidate = at
    for (;;) {
      const inWindow: number[] = []
      for (const start of candidates) {
        if (start <= candidate && candidate - start < SEND_WINDOW_MS) inWindow.push(start)
      }
      if (inWindow.length < SEND_WINDOW_MAX) return candidate
      inWindow.sort((left, right) => left - right)
      candidate = Math.max(candidate, (inWindow[0] ?? candidate) + SEND_WINDOW_MS)
    }
  }

  private wake(): void {
    if (this.stopped || this.loopPromise !== undefined || this.jobs.length === 0) return
    this.loopPromise = this.runLoop()
      .catch((error: unknown) => {
        this.logger?.warn?.(
          `dsh-soulmojito im weixin/${this.accountId}: the outbound queue loop stopped: ${messageOf(error)}`,
        )
      })
      .finally(() => {
        this.loopPromise = undefined
        if (!this.stopped && this.jobs.length > 0) this.wake()
      })
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const job = this.jobs[0]
      if (job === undefined) return
      await this.runJob(job)
    }
  }

  /** 跑完一个逻辑发送（含等待、占位、`-2` 重试）；结束时该任务必然已出队。 */
  private async runJob(job: SendJob): Promise<void> {
    while (job.nextPart < job.parts.length) {
      if (this.stopped) return
      const at = this.nextPartStart(job)
      // 滚动收口：前序任务的请求超时或长间隔会把「轮到本任务」推迟过 fastWait，
      // 不能等真正阻塞了才想起调用方。每次等待/发送前重判一次。
      this.settleIfFastWaitExceeded(job, at)
      await this.sleepUntil(at)
      if (this.stopped) return
      try {
        this.guard.reserveSlot()
      } catch (error) {
        if (error instanceof WeixinChannelError && error.code === 'WEIXIN_SEND_BUDGET_EXHAUSTED') {
          // 投影算漏了（时钟跳变/并发），按守卫给的真实空位重排，绝不把
          // 预算错误抛给调用方。
          await this.sleepUntil(this.guard.nextWindowSlotAt(this.clock.now()))
          continue
        }
        this.dropJob(job, error)
        return
      }
      const startedAt = this.clock.now()
      this.lastSendAt = startedAt
      this.consumeProjected(job)
      if (!job.started) {
        job.started = true
        try {
          this.onJobStart?.(job.target)
        } catch (error) {
          this.logger?.warn?.(`dsh-soulmojito im weixin/${this.accountId}: onJobStart failed: ${messageOf(error)}`)
        }
      }
      try {
        const messageId = await this.sendPart(job.target, job.parts[job.nextPart] as OutboundPart)
        if (messageId !== undefined) job.lastMessageId = messageId
        job.nextPart += 1
      } catch (error) {
        if (this.stopped) {
          // stop() 已经把这个任务从队列里摘掉并拒绝了调用方；这里只退出循环。
          return
        }
        if (!isThrottleError(error)) {
          this.dropJob(job, error)
          return
        }
        if (job.throttleRetries >= this.maxRetries) {
          this.dropJob(job, error)
          return
        }
        job.throttleRetries += 1
        const until = this.guard.throttleUntil() ?? this.clock.now() + SEND_THROTTLE_COOLDOWN_MS
        this.logger?.warn?.(
          `dsh-soulmojito im weixin/${this.accountId}: send was throttled with ret/errcode -2; retry ${job.throttleRetries}/${this.maxRetries} at ${new Date(until).toISOString()}`,
        )
        // 冷却拖过工具调用等待上限时必须先回执，不能把调用方挂 5 分钟。
        if (until > job.enqueuedAt + this.fastWaitMs) this.settleQueued(job, until)
        await this.sleepUntil(until)
      }
    }
    this.finishJob(job)
  }

  /**
   * 快速等待的滚动收口：入队已超过 `fastWaitMs`，或本轮计划开始晚于
   * `enqueuedAt + fastWaitMs`，就把调用方先放行为排队回执（后台继续发送），
   * 不让前序任务的请求超时或长间隔把工具调用拖过等待上界。
   */
  private settleIfFastWaitExceeded(job: SendJob, at: number): void {
    if (job.callerSettled) return
    const deadline = job.enqueuedAt + this.fastWaitMs
    if (this.clock.now() < deadline && at <= deadline) return
    this.settleQueued(job, Math.max(at, this.clock.now()))
  }

  /** 下一 part 的最早开始：间隔、计划表、冷却与窗口一起取最大。 */
  private nextPartStart(job: SendJob): number {
    const now = this.clock.now()
    const planned = job.projectedStarts[job.nextPart]
    let at = Math.max(
      now,
      this.lastSendAt === undefined ? now : this.lastSendAt + this.interval,
      planned ?? now,
      this.guard.throttleUntil() ?? 0,
    )
    at = Math.max(at, this.guard.nextWindowSlotAt(at))
    at = this.nextWindowAwareAt(at, this.projectedWithout(job))
    return at
  }

  /** 全局投影减去本任务剩下的计划点（同一时间值按出现次数扣除）。 */
  private projectedWithout(job: SendJob): number[] {
    const remaining = job.projectedStarts.slice(job.nextPart)
    const result: number[] = []
    for (const start of this.projectedStarts) {
      const index = remaining.indexOf(start)
      if (index >= 0) remaining.splice(index, 1)
      else result.push(start)
    }
    return result
  }

  private consumeProjected(job: SendJob): void {
    const planned = job.projectedStarts[job.nextPart]
    if (planned === undefined) return
    const index = this.projectedStarts.indexOf(planned)
    if (index >= 0) this.projectedStarts.splice(index, 1)
  }

  private releaseJobProjection(job: SendJob): void {
    for (const planned of job.projectedStarts.slice(job.nextPart)) {
      const index = this.projectedStarts.indexOf(planned)
      if (index >= 0) this.projectedStarts.splice(index, 1)
    }
  }

  private finishJob(job: SendJob): void {
    const index = this.jobs.indexOf(job)
    if (index >= 0) this.jobs.splice(index, 1)
    this.releaseJobProjection(job)
    if (job.callerSettled) {
      this.logger?.debug?.(
        `dsh-soulmojito im weixin/${this.accountId}: a queued send finished after the caller had a queued receipt`,
      )
      return
    }
    job.callerSettled = true
    const receipt: ImSendReceipt = {
      parts: job.parts.length,
      at: this.clock.now(),
      ...(job.lastMessageId === undefined ? {} : { messageId: job.lastMessageId }),
    }
    job.resolve(receipt)
  }

  private dropJob(job: SendJob, error: unknown): void {
    const index = this.jobs.indexOf(job)
    if (index >= 0) this.jobs.splice(index, 1)
    this.releaseJobProjection(job)
    if (job.callerSettled) {
      // 调用方已经拿到排队回执：失败只能进日志与状态（im_time 的队列归零就是
      // 这条消息没送出的信号），绝不静默当作已送达。
      this.logger?.warn?.(
        `dsh-soulmojito im weixin/${this.accountId}: a queued send failed after the caller had a queued receipt and was NOT delivered: ${messageOf(error)}`,
      )
      return
    }
    job.callerSettled = true
    job.reject(error)
  }

  private settleQueued(job: SendJob, scheduledAt: number): void {
    if (job.callerSettled) return
    job.callerSettled = true
    const receipt: ImQueuedSendReceipt = {
      status: 'queued',
      parts: job.parts.length,
      scheduledAt,
    }
    job.resolve(receipt)
    this.logger?.debug?.(
      `dsh-soulmojito im weixin/${this.accountId}: a send was queued for ${new Date(scheduledAt).toISOString()} (${job.parts.length} part(s))`,
    )
  }

  /** 睡到 `at`；stop 会中止睡眠并让循环自行退出。 */
  private async sleepUntil(at: number): Promise<void> {
    const delay = at - this.clock.now()
    if (delay <= 0) return
    await this.clock.sleep(delay, this.stopController.signal)
  }
}

function isThrottleError(error: unknown): boolean {
  return error instanceof WeixinChannelError && error.code === 'WEIXIN_THROTTLED'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
