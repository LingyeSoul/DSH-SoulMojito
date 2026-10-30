/**
 * 账号 id 的**文件系统安全**派生（提案 0024 §4.2）。
 *
 * 平台给的机器人 id 不一定适合当文件名：微信的 `ilink_bot_id` 实际可能是
 * 邮箱形状（含 `@`），而 `ImStore` 只允许 `[A-Za-z0-9._-]`——直接把平台 id
 * 当 accountId 会在扫码成功的最后一刻炸掉（2026-10-30 实机反馈）。
 *
 * 规则：合法就直接用（保持可读、与 Webhook/游标路径稳定），不合法就按
 * `channel-<sha256 前 12 位>` 派生。原始 id 必须留在密钥袋里，展示用 label。
 */

import { createHash } from 'node:crypto'
import type { ImChannelId } from './types.js'

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._-]+$/

/** 平台 id → 可作为文件名与 peerKey 段的账号 id。 */
export function imAccountIdOf(channel: ImChannelId, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error(`cannot derive an IM account id: the ${channel} platform returned an empty id`)
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`cannot derive an IM account id: '${trimmed}' is a path traversal name`)
  }
  if (SAFE_ACCOUNT_ID.test(trimmed)) return trimmed
  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 12)
  return `${channel}-${digest}`
}
