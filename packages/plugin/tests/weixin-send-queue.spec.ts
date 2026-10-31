/**
 * 微信出站队列（决策 2026-10-31-weixin-send-queue）的确定性单测：假时钟推进
 * 间隔/窗口/冷却，`sendPart` 是记录调用时刻的桩。真实 HTTP 路径由
 * `weixin-channel.spec.ts` 覆盖。
 */

import { describe, expect, it } from 'vitest'
import type { ImTarget, OutboundPart } from '../src/im/types.js'
import type { WeixinClock } from '../src/im/weixin/clock.js'
import { WeixinChannelError } from '../src/im/weixin/errors.js'
import { SEND_THROTTLE_COOLDOWN_MS, WeixinSendGuard } from '../src/im/weixin/send-guard.js'
import { WeixinSendQueue, type WeixinSendQueueOptions } from '../src/im/weixin/send-queue.js'

const ACCOUNT = 'acct-a'

interface QueueClock {
  clock: WeixinClock
  /** 推进「现在」并放行当前挂起的 sleep。 */
  advance(ms: number): void
  pendingMs(): number | undefined
}

function createQueueClock(start: number): QueueClock {
  let now = start
  let pending: { ms: number; resolve: () => void } | undefined
  const clock: WeixinClock = {
    now: () => now,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (pending?.resolve === finish) pending = undefined
        resolve()
      }
      const onAbort = (): void => { finish() }
      signal.addEventListener('abort', onAbort, { once: true })
      pending = { ms, resolve: finish }
    }),
  }
  return {
    clock,
    advance(ms) {
      now += ms
      const current = pending
      pending = undefined
      current?.resolve()
    },
    pendingMs: () => pending?.ms,
  }
}

/** 反复放行挂起的 sleep，直到队列暂时无事可做。 */
async function settle(clock: QueueClock): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    if (clock.pendingMs() === undefined) {
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      if (clock.pendingMs() === undefined) return
    }
    clock.advance(clock.pendingMs() ?? 1)
  }
  throw new Error('the send queue did not settle')
}

function textPart(text: string, index = 0, total = 1): OutboundPart {
  return { kind: 'text', text, index, total }
}

const target: ImTarget = { channel: 'weixin', accountId: ACCOUNT, scope: 'private', peerId: 'peer-a' }

interface SendRecord {
  text: string
  at: number
}

interface Harness {
  clock: QueueClock
  guard: WeixinSendGuard
  queue: WeixinSendQueue
  readonly sent: SendRecord[]
}

function queueHarness(options: {
  start: number
  intervalMs: number
  fastWaitMs?: number
  cooldownMs?: number
  handler?: (call: { text: string; at: number; index: number }) => Promise<string | undefined> | string | undefined
}): Harness {
  const clock = createQueueClock(options.start)
  const guard = new WeixinSendGuard({
    accountId: ACCOUNT,
    clock: clock.clock,
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  })
  const sent: SendRecord[] = []
  const handler = options.handler ?? (() => 'synthetic-message')
  const queue = new WeixinSendQueue({
    accountId: ACCOUNT,
    clock: clock.clock,
    guard,
    intervalMs: options.intervalMs,
    fastWaitMs: options.fastWaitMs ?? 10_000,
    maxRetries: 1,
    sendPart: async (_target, part) => {
      const text = part.kind === 'text' ? part.text : part.kind
      const at = clock.clock.now()
      const result = await handler({ text, at, index: part.index })
      sent.push({ text, at })
      return result
    },
  })
  return { clock, guard, queue, sent }
}

function throttleError(): WeixinChannelError {
  return new WeixinChannelError('WEIXIN_THROTTLED', 'synthetic -2 prepare failed')
}

describe('WeixinSendQueue pacing and window budget', () => {
  it('spaces separate sends by the interval and keeps parts of one send contiguous', async () => {
    const harness = queueHarness({ start: 0, intervalMs: 500 })
    const first = harness.queue.enqueue(target, [textPart('a1', 0, 2), textPart('a2', 1, 2)])
    const second = harness.queue.enqueue(target, [textPart('b1')])
    await settle(harness.clock)
    await expect(first).resolves.toMatchObject({ parts: 2, at: 500 })
    await expect(second).resolves.toMatchObject({ parts: 1, at: 1000 })
    // 一个逻辑发送的 part 连续执行，别的任务不插队。
    expect(harness.sent).toEqual([
      { text: 'a1', at: 0 },
      { text: 'a2', at: 500 },
      { text: 'b1', at: 1000 },
    ])
  })

  it('waits for the 30s/5 window instead of rejecting and delivers the queued send afterwards', async () => {
    const harness = queueHarness({ start: 0, intervalMs: 500 })
    for (let index = 0; index < 5; index += 1) {
      const pending = harness.queue.enqueue(target, [textPart(`第${index + 1}条`)])
      await settle(harness.clock)
      await pending
    }
    expect(harness.sent.map((record) => record.at)).toEqual([0, 500, 1000, 1500, 2000])

    const sixth = harness.queue.enqueue(target, [textPart('第六条')])
    // 预计开始时间超过快速等待上限：立刻给带时间的排队回执，而不是抛预算错误。
    await expect(sixth).resolves.toEqual({ status: 'queued', parts: 1, scheduledAt: 30_000 })
    expect(harness.queue.status()).toMatchObject({ allowedNow: false, nextSendAt: 30_000, queueDepth: 1 })
    expect(harness.sent).toHaveLength(5)

    await settle(harness.clock)
    expect(harness.sent.map((record) => record.at)).toEqual([0, 500, 1000, 1500, 2000, 30_000])
    expect(harness.queue.status().queueDepth).toBe(0)
  })

  it('releases the caller with a queued receipt when a previous send runs past the fast-wait deadline', async () => {
    // 前序任务卡在一次「请求超时」里（测试用可控 promise 模拟），轮到第二条时
    // 入队已超过 fastWait：不能再让调用方干等，先回排队回执、后台继续发。
    const clock = createQueueClock(0)
    const guard = new WeixinSendGuard({ accountId: ACCOUNT, clock: clock.clock })
    const sent: SendRecord[] = []
    let releaseFirst: () => void = () => {}
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const queue = new WeixinSendQueue({
      accountId: ACCOUNT,
      clock: clock.clock,
      guard,
      intervalMs: 0,
      fastWaitMs: 100,
      maxRetries: 1,
      sendPart: async (_target, part) => {
        const text = part.kind === 'text' ? part.text : part.kind
        if (text === 'first') await firstBlocked
        sent.push({ text, at: clock.clock.now() })
        return `message-${text}`
      },
    })
    const first = queue.enqueue(target, [textPart('first')])
    const second = queue.enqueue(target, [textPart('second')])
    expect(sent).toHaveLength(0)

    // 第一条在飞时时钟前滚 150ms（超过 100ms 的 fastWait），随后才结束。
    clock.advance(150)
    releaseFirst()
    await expect(first).resolves.toMatchObject({ parts: 1, messageId: 'message-first' })
    await expect(second).resolves.toEqual({ status: 'queued', parts: 1, scheduledAt: 150 })
    await settle(clock)
    expect(sent.map((record) => record.text)).toEqual(['first', 'second'])
    expect(sent[1]?.at).toBe(150)
    expect(queue.status().queueDepth).toBe(0)
  })
})

describe('WeixinSendQueue -2 retry semantics', () => {
  it('pauses on -2, retries the failed part once and resolves with the real receipt', async () => {
    let calls = 0
    const harness = queueHarness({
      start: 0,
      intervalMs: 0,
      fastWaitMs: 1_000,
      cooldownMs: 100,
      handler: ({ at }) => {
        calls += 1
        if (calls === 1) {
          harness.guard.throttle('peer-a', new Error('synthetic -2'))
          throw throttleError()
        }
        return `message-after-${String(at)}`
      },
    })
    const pending = harness.queue.enqueue(target, [textPart('被节流')])
    await settle(harness.clock)
    await expect(pending).resolves.toMatchObject({
      parts: 1,
      at: 100,
      messageId: 'message-after-100',
    })
    expect(calls).toBe(2)
    expect(harness.sent).toEqual([{ text: '被节流', at: 100 }])
    expect(harness.queue.status().queueDepth).toBe(0)
  })

  it('rejects the still-waiting caller with WEIXIN_THROTTLED when the retry is throttled again', async () => {
    let calls = 0
    const harness = queueHarness({
      start: 0,
      intervalMs: 0,
      fastWaitMs: 1_000,
      cooldownMs: 100,
      handler: () => {
        calls += 1
        harness.guard.throttle('peer-a', new Error('synthetic -2'))
        throw throttleError()
      },
    })
    const pending = harness.queue.enqueue(target, [textPart('重试再失败')])
    const failure = pending.catch((error: unknown) => error)
    await settle(harness.clock)
    await expect(failure).resolves.toMatchObject({ code: 'WEIXIN_THROTTLED' })
    expect(calls).toBe(2)
    expect(harness.queue.status().queueDepth).toBe(0)
  })

  it('returns a queued receipt with scheduledAt when the cooldown exceeds the fast wait, then still retries', async () => {
    let calls = 0
    const harness = queueHarness({
      start: 0,
      intervalMs: 0,
      fastWaitMs: 1_000,
      cooldownMs: SEND_THROTTLE_COOLDOWN_MS,
      handler: () => {
        calls += 1
        if (calls === 1) {
          harness.guard.throttle('peer-a', new Error('synthetic -2'))
          throw throttleError()
        }
        return 'synthetic-message'
      },
    })
    const pending = harness.queue.enqueue(target, [textPart('长冷却')])
    // 第一次 -2 在同一个微任务链里回执：先放行一轮宏任务，再断言「还没重试」。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await expect(pending).resolves.toEqual({
      status: 'queued',
      parts: 1,
      scheduledAt: SEND_THROTTLE_COOLDOWN_MS,
    })
    expect(calls).toBe(1)
    expect(harness.queue.status()).toMatchObject({
      allowedNow: false,
      throttleUntil: SEND_THROTTLE_COOLDOWN_MS,
      queueDepth: 1,
    })

    await settle(harness.clock)
    expect(calls).toBe(2)
    expect(harness.sent).toEqual([{ text: '长冷却', at: SEND_THROTTLE_COOLDOWN_MS }])
    expect(harness.queue.status().queueDepth).toBe(0)
  })
})

describe('WeixinSendQueue status and stop', () => {
  it('projects allowedNow, nextSendAt and cooldown from the injected clock', async () => {
    const harness = queueHarness({ start: 1_000, intervalMs: 500, cooldownMs: 60_000 })
    expect(harness.queue.status()).toEqual({ allowedNow: true, queueDepth: 0 })

    await harness.queue.enqueue(target, [textPart('第一条')])
    await settle(harness.clock)
    expect(harness.queue.status()).toEqual({ allowedNow: false, nextSendAt: 1_500, queueDepth: 0 })

    harness.guard.throttle('peer-a', new Error('synthetic -2'))
    expect(harness.queue.status()).toMatchObject({
      allowedNow: false,
      throttleUntil: 61_000,
      nextSendAt: 61_000,
    })
  })

  it('rejects queued jobs with WEIXIN_CLOSED on stop and stays idempotent', async () => {
    const harness = queueHarness({ start: 0, intervalMs: 500 })
    const first = harness.queue.enqueue(target, [textPart('a1')])
    const second = harness.queue.enqueue(target, [textPart('b1')])
    const firstFailure = first.catch((error: unknown) => error)
    const secondFailure = second.catch((error: unknown) => error)
    await harness.queue.stop()
    await expect(firstFailure).resolves.toMatchObject({ code: 'WEIXIN_CLOSED' })
    await expect(secondFailure).resolves.toMatchObject({ code: 'WEIXIN_CLOSED' })
    expect(harness.queue.status().queueDepth).toBe(0)
    await harness.queue.stop()
    await expect(harness.queue.enqueue(target, [textPart('stop 之后')]))
      .rejects.toMatchObject({ code: 'WEIXIN_CLOSED' })
  })
})
