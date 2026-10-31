/**
 * 会话主人的投递侧账本（决策 2026-10-31-im-owner-designation）。
 *
 * 从 `router.ts` 抽出的三个动作：
 * - 读本 peer 的主人哈希（只读 state）；
 * - 判断一条入站消息的发言人是否匹配主人（只比哈希，绝不比原始 id）；
 * - 记录已投递消息的发言人（有界、5 分钟刷新窗口、best-effort）。
 *
 * **写入是 best-effort**：`insert` 已经成功，账本失败只能丢「最近发言人」这条
 * 辅助信息，不能把异常冒泡回 `deliverOne`/`deliverMerged`——批次里余下条目已被
 * 去重表标记，冒泡会丢消息。失败只写一条 warn（不含原始 id）。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import type { ImLogSink } from './log.js'
import { imSenderHash, mergeImSenderEntries, type ImSenderUpdate } from './owner.js'
import { displaySenderNameOf } from './relay.js'
import { IM_SENDERS_MAX_PER_PEER, IM_SENDER_REFRESH_WINDOW_MS, type ImInbound } from './types.js'

export interface ImOwnerLedgerDeps {
  db: Pick<TavernStore, 'getState' | 'updateState'>
  now: () => number
  /** 面板「IM 运行日志」的落点；缺省时静默（测试与降级路径）。 */
  log?: ImLogSink
}

export interface ImOwnerLedger {
  /** 本 peer 的主人哈希；未指定时 undefined。 */
  ownerIdOf(peerKey: string): Promise<string | undefined>
  /** 一条入站消息的发言人是否就是本会话主人。 */
  isOwnerMessage(message: ImInbound, ownerId: string | undefined): boolean
  /**
   * 记录一批已投递消息的发言人：只写哈希与群聊昵称（私聊不存名字，沿用 pending
   * 纪律），窗口内重复投递不重写 `state.json`。**永不 reject**——投递成功后的
   * 辅助写入失败只 warn，不影响消息本身。
   */
  rememberSenders(peerKey: string, alias: string, messages: readonly ImInbound[]): Promise<void>
}

export function createImOwnerLedger(deps: ImOwnerLedgerDeps): ImOwnerLedger {
  async function ownerIdOf(peerKey: string): Promise<string | undefined> {
    const state = await deps.db.getState()
    return state.imOwners?.[peerKey]?.id
  }

  function isOwnerMessage(message: ImInbound, ownerId: string | undefined): boolean {
    if (ownerId === undefined) return false
    return imSenderHash(message.channel, message.accountId, message.senderId) === ownerId
  }

  async function rememberSenders(peerKey: string, alias: string, messages: readonly ImInbound[]): Promise<void> {
    try {
      const now = deps.now()
      const updates: ImSenderUpdate[] = messages.map((message) => ({
        id: imSenderHash(message.channel, message.accountId, message.senderId),
        name: message.scope === 'group' ? (displaySenderNameOf(message) ?? '') : '',
        lastAt: now,
      }))
      const options = { maxEntries: IM_SENDERS_MAX_PER_PEER, refreshWindowMs: IM_SENDER_REFRESH_WINDOW_MS }
      const state = await deps.db.getState()
      if (mergeImSenderEntries(state.imSenders?.[peerKey] ?? [], updates, options) === undefined) {
        deps.log?.note('debug', `sender refresh for ${alias} is within the ${IM_SENDER_REFRESH_WINDOW_MS}ms write window; state not rewritten`)
        return
      }
      await deps.db.updateState((current) => {
        const merged = mergeImSenderEntries(current.imSenders?.[peerKey] ?? [], updates, options)
        if (merged === undefined) return {}
        return { imSenders: { ...(current.imSenders ?? {}), [peerKey]: merged } }
      })
    } catch (error) {
      // 投递已成功：账本失败只记 warn，绝不把异常抛回投递路径。
      deps.log?.note('warn', `could not record recent senders for ${alias}; the message was delivered: ${messageOf(error)}`)
    }
  }

  return { ownerIdOf, isOwnerMessage, rememberSenders }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}