/**
 * 入站短窗合流（决策 2026-10-31-im-inbound-coalescing）。
 *
 * 纯函数模块：只做排序与合流文本拼装，不碰定时器、不做 IO。定时器、缓冲与冲刷
 * 状态在 `router.ts`；这里的东西可以被单测直接钉住。
 *
 * 为什么有窗口：手机端连发「在吗」「睡了吗」「帮我看个东西」是常态，逐条插入会把
 * 宿主会话刷成一串独立的用户轮。窗口把同一 peer 的连发收成一条；窗口必须有界，
 * 条数与字符数超限立即冲刷（`router.ts`）。
 */

import type { ImInbound, ImMediaRef } from './types.js'

/** 同一 peer 的合流窗口：窗口内到达的文本连发合并成一条插入。 */
export const IM_COALESCE_WINDOW_MS = 600

/** 单批条数上限：缓冲达到这个条数立即冲刷，不等窗口。 */
export const IM_COALESCE_MAX_MESSAGES = 8

/** 单批字符上限：缓冲正文合计超过这个长度立即冲刷，避免一条消息塞爆上下文。 */
export const IM_COALESCE_MAX_CHARS = 4000

/**
 * 路由缓冲里的一条入站消息。
 *
 * `seq` 是本地到达序号：平台时间缺失或相同时用它稳定排序（先到先出）。
 * `loadMedia` 与 `inbound()` 的惰性媒体物化同源，冲刷时才会被调用。
 */
export interface ImCoalesceEntry {
  inbound: ImInbound
  loadMedia?: () => Promise<readonly ImMediaRef[]>
  /** 本地到达序号，路由内单调递增。 */
  seq: number
  /** 入缓冲时的本地钟表时间（epoch ms），只用于去重/提示/锚点的时间戳。 */
  at: number
}

/**
 * 批次排序：平台事件时间（缺省回退本地接收时间）升序；完全相同时按本地到达序号
 * 升序。返回新数组，不改输入。
 */
export function orderInboundEntries(entries: readonly ImCoalesceEntry[]): ImCoalesceEntry[] {
  return [...entries].sort((left, right) => {
    const leftAt = left.inbound.platformAt ?? left.inbound.receivedAt
    const rightAt = right.inbound.platformAt ?? right.inbound.receivedAt
    if (leftAt !== rightAt) return leftAt - rightAt
    return left.seq - right.seq
  })
}

/** 合流批次里的一条正文：ref 是它的 `msg-` 引用，正文行前缀用它锚定单条消息。 */
export interface ImMergedRelayItem {
  body: string
  ref: string
}

/**
 * 合流批次的转发正文：头部标注「连续 N 条消息」（不带 msg/time——一条头对多条，
 * 挂谁的都不对），正文每条前缀自己的 `[msg-…] ` 引用，尾部仍是 im_send 提示。
 * 群聊/私聊措辞与单条 `relayTextOf` 一致；群聊正文由 `imUserTextOf` 预先带上
 * `[昵称]` 前缀，这里不再加工。
 */
export function mergedRelayTextOf(items: readonly ImMergedRelayItem[], alias: string, channel: string, scope: string): string {
  const scopeLabel = scope === 'group' ? '群聊' : '私聊'
  return [
    `[IM ${channel}/${scopeLabel} peer=${alias}]（连续 ${items.length} 条消息）`,
    ...items.map((item) => `[${item.ref}] ${item.body}`),
    `（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${alias}。）`,
  ].join('\n')
}