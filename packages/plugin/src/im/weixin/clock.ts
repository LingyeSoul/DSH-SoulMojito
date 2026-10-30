/**
 * 微信通道的时钟注入面（提案 0024 §2.2 / M4）。
 *
 * `-14` 的 1 小时暂停、普通失败的 2s/30s 退避与扫码轮询间隔都必须能在测试里
 * 被推进：生产用真实定时器，测试注入可手动 `advance` 的假时钟，绝不真等。
 */

export interface WeixinClock {
  now(): number
  /** 被中止时 resolve（不是 reject）：循环自己检查 signal 后退出。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export const WEIXIN_REAL_CLOCK: WeixinClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => { finish() }
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  }),
}
