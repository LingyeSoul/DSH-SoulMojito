/**
 * IM 会话主人（决策 2026-10-31-im-owner-designation）：纯函数面。
 *
 * 身份只过哈希：`snd-` + sha256(`${channel}:${accountId}:${senderId}`) 前 10 位
 * 十六进制。哈希格式与校验定义在 `tavern-store/src/im-state.ts`（state 归一化
 * 也要用同一份），这里 re-export 并做发言人表合并。主人/发言人的**值**只存
 * 哈希；peer 键沿用既有 `channel:account:scope:peerId` 约定。
 *
 * 模块不碰 IO、不认识 db。
 */

import type { ImSenderEntry } from './types.js'
import { IM_SENDER_HASH_HEX_LENGTH, IM_SENDER_HASH_PREFIX, imSenderHash, isImSenderHash } from './types.js'

export { IM_SENDER_HASH_HEX_LENGTH, IM_SENDER_HASH_PREFIX, imSenderHash, isImSenderHash }

/** 一次投递里某个发言人的最新事实（哈希、显示名、投递时间）。 */
export interface ImSenderUpdate {
  id: string
  name: string
  lastAt: number
}

/**
 * 合并一批投递的发言人事实到既有表。
 *
 * - 新发言人插到最前；同 id 的更新在窗口外（`lastAt` 已过刷新窗口）刷新并挪到
 *   最前，窗口内**整条跳过**（含改名——窗口只有几分钟，不值得为一次改名落盘）。
 * - 入参先按 id 去重取最新；输出按「新/刷新在前、未动按原序」排列并截到上限。
 * - 返回 undefined 表示没有任何变化，调用方应跳过这次 state 写入；输入数组与
 *   既有数组都不被修改。
 */
export function mergeImSenderEntries(
  existing: readonly ImSenderEntry[],
  updates: readonly ImSenderUpdate[],
  options: { maxEntries: number; refreshWindowMs: number },
): ImSenderEntry[] | undefined {
  if (updates.length === 0) return undefined
  const latest = new Map<string, ImSenderUpdate>()
  for (const update of updates) {
    const previous = latest.get(update.id)
    if (previous === undefined || update.lastAt >= previous.lastAt) latest.set(update.id, update)
  }
  const moved = new Map<string, ImSenderEntry>()
  for (const update of latest.values()) {
    const previous = existing.find((entry) => entry.id === update.id)
    if (previous !== undefined && update.lastAt - previous.lastAt < options.refreshWindowMs) continue
    moved.set(update.id, { id: update.id, name: update.name, lastAt: update.lastAt })
  }
  if (moved.size === 0) return undefined
  const added = [...moved.values()].sort((left, right) => right.lastAt - left.lastAt)
  const kept = existing.filter((entry) => !moved.has(entry.id))
  const next = [...added, ...kept].slice(0, options.maxEntries)
  return next
}