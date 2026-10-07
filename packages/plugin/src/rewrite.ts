/**
 * 带意见重写（提案 0011，Rewrite with Feedback 功能复刻）的纯逻辑。
 *
 * 职责：generate() body 里 feedback 参数的校验/归一 + regenerate 请求的
 * 注入块格式化。意见是一次性生成指引：只进入本次请求的 system 段末尾
 * （guides 块之后）与 swipe 元数据回显，绝不作为楼层落盘。
 */

const FEEDBACK_MAX_LENGTH = 1000

/**
 * feedback 参数归一：undefined 原样通过；字符串 trim 后非空 ≤1000 字符；
 * 空串（含纯空白）归一为 undefined——等价于普通 regenerate，不加注入块。
 * 非字符串直接拒绝（防滥用边界，对齐 guide text ≤500 的校验语义）。
 */
export function optionalFeedback(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('feedback must be a string')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > FEEDBACK_MAX_LENGTH) {
    throw new Error(`feedback must be at most ${FEEDBACK_MAX_LENGTH} characters`)
  }
  return trimmed
}

/**
 * regenerate 的重写指令块：feedback 缺失时返回 undefined（不加块，链路直通）；
 * 命格式见提案 0011 §1：位于 system 段末尾、guides 块之后。措辞自带
 * 「保留用户未点名的问题」语义——重写只动意见指向的部分。
 */
export function formatRewriteBlock(feedback: string | undefined): string | undefined {
  if (feedback === undefined || feedback === '') return undefined
  return `Rewrite directive for this reply (user feedback; the previous reply is being rewritten): ${feedback}`
}
