/**
 * IM 通道的持久化形状（提案 0024 §3.3/§4.3）。
 *
 * 只放「要落 `state.json` 的东西」：绑定策略、peer → 会话绑定、访问控制。
 * 协议侧形状（`ImInbound` / `OutboundPart` / `ImChannel`）在
 * `packages/plugin/src/im/types.ts`，两者不混：store 不认识渠道协议。
 *
 * 密钥、游标、去重键一律不进这里——`state.json` 会被面板、Mod 与工具面读取。
 */

export type ImScope = 'private' | 'group'

/** 未知 peer 的绑定方式；默认 independent（一 peer 一独立会话）。 */
export type ImBindingMode = 'manual' | 'independent' | 'shared'

/** 访问控制三态：开放 / 白名单 / 关闭。 */
export type ImAccessMode = 'open' | 'allowlist' | 'disabled'

export interface ImChatRef {
  character: string
  chatId: string
}

export interface ImSettings {
  bindingMode: ImBindingMode
  /** independent 模式的来源聊天：决定角色与开场白。 */
  sourceChat?: ImChatRef
  /** shared 模式复用的聊天。 */
  sharedChat?: ImChatRef
  /** QQ 群必须 @ 机器人才投递；默认开启，可关。 */
  groupRequireMention: boolean
  privateMode: ImAccessMode
  privateAllow: string[]
  groupMode: ImAccessMode
  groupAllow: string[]
  /** 单条出站上限；缺省按渠道默认（QQ 4500 / 微信 1800 / OneBot 2000）。 */
  chunkLimit?: number
}

export interface ImPeerBinding {
  sessionId: string
  character: string
  chatId: string
  scope: ImScope
  boundBy: 'auto' | 'manual'
  createdAt: string
}

/**
 * 默认值刻意最严：两条通道都是白名单且名单为空 = 拒绝所有人；群聊必须 @。
 * 扫码绑定成功后由渠道把扫码人写进 privateAllow（提案 0024 §4.1）。
 */
export const DEFAULT_IM_SETTINGS: ImSettings = {
  bindingMode: 'independent',
  groupRequireMention: true,
  privateMode: 'allowlist',
  privateAllow: [],
  groupMode: 'allowlist',
  groupAllow: [],
}

/** 绑定键：群 id 与私聊 id 可能撞号，scope 必须进键。 */
export function imPeerKey(channel: string, accountId: string, scope: ImScope, peerId: string): string {
  return `${channel}:${accountId}:${scope}:${peerId}`
}

function normalizeChatRef(value: unknown): ImChatRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const character = record['character']
  const chatId = record['chatId']
  if (typeof character !== 'string' || character.trim() === '') return undefined
  if (typeof chatId !== 'string' || chatId.trim() === '') return undefined
  return { character, chatId }
}

function normalizeAccessMode(value: unknown, fallback: ImAccessMode): ImAccessMode {
  return value === 'open' || value === 'allowlist' || value === 'disabled' ? value : fallback
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/**
 * `state.json` 的容错读取：手改坏了的字段回落默认值，整体结构不因此失效。
 * 语义与 `normalizeSessionBindings` 同款——单条坏记录丢弃，不拖垮整份 state。
 */
export function normalizeImSettings(value: unknown): ImSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return structuredClone(DEFAULT_IM_SETTINGS)
  }
  const record = value as Record<string, unknown>
  const bindingMode: ImBindingMode = record['bindingMode'] === 'manual' || record['bindingMode'] === 'shared'
    ? record['bindingMode']
    : 'independent'
  const chunkLimit = record['chunkLimit']
  return {
    bindingMode,
    ...(normalizeChatRef(record['sourceChat']) === undefined ? {} : { sourceChat: normalizeChatRef(record['sourceChat']) }),
    ...(normalizeChatRef(record['sharedChat']) === undefined ? {} : { sharedChat: normalizeChatRef(record['sharedChat']) }),
    groupRequireMention: record['groupRequireMention'] !== false,
    privateMode: normalizeAccessMode(record['privateMode'], 'allowlist'),
    privateAllow: normalizeStringList(record['privateAllow']),
    groupMode: normalizeAccessMode(record['groupMode'], 'allowlist'),
    groupAllow: normalizeStringList(record['groupAllow']),
    ...(typeof chunkLimit === 'number' && Number.isSafeInteger(chunkLimit) && chunkLimit > 0
      ? { chunkLimit }
      : {}),
  }
}

/** 绑定表容错读取：缺字段的记录直接丢弃，不让它污染路由。 */
export function normalizeImPeers(value: unknown): Record<string, ImPeerBinding> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImPeerBinding> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const sessionId = record['sessionId']
    const character = record['character']
    const chatId = record['chatId']
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof character !== 'string' || character === '') continue
    if (typeof chatId !== 'string' || chatId === '') continue
    const scope: ImScope = record['scope'] === 'group' ? 'group' : 'private'
    const boundBy: 'auto' | 'manual' = record['boundBy'] === 'manual' ? 'manual' : 'auto'
    const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date(0).toISOString()
    result[key] = { sessionId, character, chatId, scope, boundBy, createdAt }
  }
  return result
}
