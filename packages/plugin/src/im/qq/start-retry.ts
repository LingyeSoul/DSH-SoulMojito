/**
 * QQ 网关启动的重试策略（2026-10-31 真机失败）。
 *
 * SDK 的 access_token 请求自带固定 10s 超时（`@tencent-connect/qqbot-nodejs` 1.0.5
 * 的 `protocol/api/token.ts`），断网或慢网时整次 `bot.start()` 失败，错误文本是
 * `Network error getting access_token: ...`。那个 AbortController 只属于 SDK
 * 内部：插件传不进 signal，也拦不下它，只能在通道层重试整次启动。
 *
 * 重试只认网络类失败。凭据错误（`Token fetch failed` HTTP 4xx）、SDK 形状错误与
 * 网关主动关闭都是确定性的，重试只会把「配置错了」拖成一条更长的失败链。
 */

/** 启动尝试次数：覆盖一次网络抖动，又不把确定性失败拖长。 */
export const QQ_START_ATTEMPTS = 3

/** 退避基数：第 n 次重试等 1s、2s。 */
const QQ_START_RETRY_BASE_DELAY_MS = 1_000

/**
 * 网络类启动失败才值得重试：SDK 把断网、DNS 失败与 access_token 的 10s 固定超时
 * 统一包成 `Network error getting access_token: ...`，网关地址拉取失败是
 * `Network error [path]: ...`；低层 socket 错误按 errno 文本兜底。
 */
export function isRetryableQqStartFailure(message: string): boolean {
  if (message.includes('Network error getting access_token')) return true
  if (message.includes('Network error [')) return true
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|socket hang up/i.test(message)
}

/** 第 `attempt` 次失败后的退避间隔；`undefined` = 次数已用尽，不再重试。 */
export function nextQqStartRetryDelayMs(attempt: number): number | undefined {
  if (attempt >= QQ_START_ATTEMPTS) return undefined
  return QQ_START_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
}

/** 缺省的退避等待；不 unref：这次启动正被调用方 await，进程不能提前收工。 */
export function qqStartRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
