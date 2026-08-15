/**
 * ST 群组文件（groups/<name>.json）：群定义与成员/激活策略。
 *
 * 差异说明：ST 内部 members 存 chid 索引；本实现以角色名为键（store 按名寻址）。
 * 导入 ST 导出的群文件时，数字成员无法解析，跳过并在 `droppedMembers` 计数，
 * 不视为解析失败。`chats` 里的历史 chat id 列表仅透传。
 */

export interface GroupIR {
  id: string
  name: string
  /** 成员角色名列表 */
  members: string[]
  allowSelfResponses: boolean
  /** 1 = NATURAL（talkativeness 加权），2 = LIST（列表顺序轮转） */
  activationStrategy: 1 | 2
  /** 禁用成员名列表 */
  disabledMembers: string[]
  /** 当前 chat id */
  chatId: string
  /** 历史 chat id 列表（透传） */
  chats: string[]
  /** 自动模式间隔（消息数；透传） */
  autoModeDelay: number
  /** 未知字段透传袋 */
  extra?: Record<string, unknown>
  /** 导入时被跳过的数字成员数量 */
  droppedMembers?: number
}

export class GroupFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GroupFormatError'
  }
}

/** 解析 ST 群组文件对象；name 缺省取 obj.name。 */
export function parseGroupFile(obj: Record<string, unknown>, name?: string): GroupIR {
  const groupName = str(obj['name']) || (name ?? '')
  if (groupName === '') throw new GroupFormatError('group has no name')
  const membersRaw = Array.isArray(obj['members']) ? obj['members'] : []
  const members: string[] = []
  let droppedMembers = 0
  for (const member of membersRaw) {
    if (typeof member === 'string') {
      const trimmed = member.trim()
      if (trimmed !== '') members.push(trimmed)
    } else {
      droppedMembers += 1
    }
  }
  const KNOWN_GROUP_FIELDS = [
    'members', 'id', 'name', 'allow_self_responses', 'activation_strategy',
    'disabled_members', 'chat_id', 'chats', 'auto_mode_delay',
  ]
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!KNOWN_GROUP_FIELDS.includes(key)) extra[key] = value
  }
  const strategy = num(obj['activation_strategy'], 1)
  const chats = Array.isArray(obj['chats'])
    ? obj['chats'].filter((value): value is string => typeof value === 'string')
    : []
  return {
    id: str(obj['id']) || `group-${groupName}`,
    name: groupName,
    members,
    allowSelfResponses: bool(obj['allow_self_responses'], false),
    activationStrategy: strategy === 2 ? 2 : 1,
    disabledMembers: Array.isArray(obj['disabled_members'])
      ? obj['disabled_members'].filter((value): value is string => typeof value === 'string')
      : [],
    chatId: str(obj['chat_id']),
    chats,
    autoModeDelay: num(obj['auto_mode_delay'], 3),
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    ...(droppedMembers > 0 ? { droppedMembers } : {}),
  }
}

/** 序列化为 ST 群组文件对象（members 为角色名数组）。 */
export function serializeGroupFile(ir: GroupIR): Record<string, unknown> {
  return {
    ...(ir.extra ?? {}),
    id: ir.id,
    name: ir.name,
    members: [...ir.members],
    allow_self_responses: ir.allowSelfResponses,
    activation_strategy: ir.activationStrategy,
    disabled_members: [...ir.disabledMembers],
    chat_id: ir.chatId,
    chats: [...ir.chats],
    auto_mode_delay: ir.autoModeDelay,
  }
}

/* ------------------------------ 内部 ------------------------------ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
