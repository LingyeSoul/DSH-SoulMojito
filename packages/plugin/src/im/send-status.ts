/**
 * 出站节奏投影（决策 2026-10-31-weixin-send-queue）：把通道实现的可选
 * `sendStatus()` 汇总成面板与 `/status` 共用的只读行。
 *
 * 抽成独立模块守 800 行预算：runtime 与 router 都只需一行调用；没有队列语义
 * 的通道（QQ/OneBot）不产出任何行，调用方按「无排队信息」降级。
 */

import type { ImChannel, ImSendStatusView } from './types.js'

/** 每个实现了发送队列的通道一行；入参顺序保持稳定，面板按 channel/accountId 展示。 */
export function sendStatusesOf(channels: Iterable<ImChannel>): ImSendStatusView[] {
  const rows: ImSendStatusView[] = []
  for (const channel of channels) {
    const status = channel.sendStatus?.()
    if (status === undefined) continue
    rows.push({ channel: channel.channel, accountId: channel.accountId, ...status })
  }
  return rows
}
