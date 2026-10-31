/**
 * 微信通道的结构化错误（`channel.ts` 与 `send-guard.ts` 共用）。
 *
 * code 分成三组：凭据/目标/消息（调用方修参数）、状态（账号没跑/暂停/冷却）、
 * 发送失败（上游或网络）。HTTP 路由按 code 映射状态码（`http/im.ts`）。
 */

export type WeixinChannelErrorCode =
  | 'WEIXIN_BAD_SECRET'
  | 'WEIXIN_BAD_TARGET'
  | 'WEIXIN_BAD_MESSAGE'
  | 'WEIXIN_CLOSED'
  | 'WEIXIN_STATE'
  | 'WEIXIN_PAUSED'
  | 'WEIXIN_SEND_FAILED'
  | 'WEIXIN_SEND_BUDGET_EXHAUSTED'
  | 'WEIXIN_THROTTLED'

/** 通道级错误：code 供路由/测试判断，message 是给人和模型看的可行动文本。 */
export class WeixinChannelError extends Error {
  readonly code: WeixinChannelErrorCode

  constructor(code: WeixinChannelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WeixinChannelError'
    this.code = code
  }
}
