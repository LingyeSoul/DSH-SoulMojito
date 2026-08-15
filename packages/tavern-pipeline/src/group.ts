/**
 * 群聊回合变换（ST 语义）：为指定发言者重塑历史。
 *
 * - 发言者本人的历史消息 → assistant；
 * - 其他成员与用户 → user，正文带 `Name: ` 前缀（ST 群聊可观察行为）；
 * - 预设 `group_nudge_prompt` 作为回合末 user nudge（{{char}} = 发言者）。
 */

import type { ChatMessage } from '@dsh-tavern/format'

export interface GroupTurnInput {
  /** 当前发言者（成员角色名） */
  speaker: string
  messages: ChatMessage[]
  /** 启用成员名列表（{{group}} 宏用，由上层宏引擎消费；此处仅校验成员身份） */
  members: string[]
  userName: string
  /** 预设 group_nudge_prompt；空串表示不加 nudge */
  groupNudgePrompt?: string
}

export interface GroupTurnResult {
  messages: ChatMessage[]
  nudge?: { role: 'user'; content: string }
}

export const DEFAULT_GROUP_NUDGE = '[Write the next reply only as {{char}}, leaving out dialogue and actions for other group members.]'

/** 把群聊历史重塑为发言者视角的 chat completion 消息序列。 */
export function buildGroupTurn(input: GroupTurnInput): GroupTurnResult {
  const messages: ChatMessage[] = []
  for (const message of input.messages) {
    if (message.is_system) continue
    if (message.is_user) {
      messages.push(message)
      continue
    }
    const name = message.name || input.speaker
    if (name === input.speaker) {
      messages.push(message)
    } else {
      messages.push({
        ...message,
        is_user: true,
        mes: `${name}: ${message.mes}`,
      })
    }
  }
  const nudgeText = input.groupNudgePrompt !== undefined && input.groupNudgePrompt !== ''
    ? input.groupNudgePrompt
    : undefined
  return {
    messages,
    ...(nudgeText !== undefined ? { nudge: { role: 'user' as const, content: nudgeText.replace(/\{\{char\}\}/gi, input.speaker) } } : {}),
  }
}

/**
 * 选择下一个发言成员。
 * - NATURAL（strategy 1）：talkativeness 加权随机；排除上一发言者（除非
 *   allowSelfResponses）；talkativeness 来自卡扩展 data.extensions.talkativeness。
 * - LIST（strategy 2）：列表顺序轮转，跳过禁用成员。
 */
export function pickGroupMember(options: {
  strategy: 1 | 2
  members: string[]
  disabled: string[]
  talkativeness: (member: string) => number
  lastSpeaker?: string
  allowSelfResponses: boolean
  rng?: () => number
  explicit?: string
}): string | undefined {
  const enabled = options.members.filter((member) => !options.disabled.includes(member))
  if (enabled.length === 0) return undefined
  if (options.explicit !== undefined) {
    return enabled.includes(options.explicit) ? options.explicit : undefined
  }
  if (options.strategy === 2) {
    if (enabled.length === 1) return enabled[0]
    const last = options.lastSpeaker !== undefined ? enabled.indexOf(options.lastSpeaker) : -1
    return enabled[(last + 1) % enabled.length]
  }
  const rng = options.rng ?? Math.random
  const pool = options.allowSelfResponses || options.lastSpeaker === undefined
    ? enabled
    : enabled.filter((member) => member !== options.lastSpeaker)
  const candidates = pool.length > 0 ? pool : enabled
  if (candidates.length === 1) return candidates[0]
  const weights = candidates.map((member) => {
    const value = options.talkativeness(member)
    return Number.isFinite(value) && value > 0 ? value : 0.5
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = rng() * total
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]!
    if (roll <= 0) return candidates[i]
  }
  return candidates[candidates.length - 1]
}
