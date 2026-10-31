/**
 * IM 通道的持久化形状（提案 0024 §3.3/§4.3）。
 *
 * 只放「要落 `state.json` 的东西」：peer → 原生会话绑定、未绑定待办、访问控制。
 * 协议侧形状（`ImInbound` / `OutboundPart` / `ImChannel`）在
 * `packages/plugin/src/im/types.ts`，两者不混：store 不认识渠道协议。
 *
 * 绑定目标是**宿主原生会话 id**（`sessionId`），不是 Tavern 聊天：入站消息由
 * 插件以插件来源消息插进该会话，模型用 IM 工具自己回复（决策
 * 2026-10-31-im-native-session-binding）。
 *
 * 密钥、游标、去重键一律不进这里——`state.json` 会被面板、Mod 与工具面读取。
 */

export type ImScope = 'private' | 'group'

/** 访问控制三态：开放 / 白名单 / 关闭。 */
export type ImAccessMode = 'open' | 'allowlist' | 'disabled'

export interface ImSettings {
  /** QQ 群必须 @ 机器人才投递；默认开启，可关。 */
  groupRequireMention: boolean
  privateMode: ImAccessMode
  privateAllow: string[]
  groupMode: ImAccessMode
  groupAllow: string[]
  /** 单条出站上限；缺省按渠道默认（QQ 4500 / 微信 1800 / OneBot 2000）。 */
  chunkLimit?: number
}

/** 一条 peer → 原生会话的绑定。会话本身由用户在 DSH 里创建与打开。 */
export interface ImPeerBinding {
  /** 宿主原生会话 id（`session.id`），入站消息插进这个会话。 */
  sessionId: string
  scope: ImScope
  boundBy: 'auto' | 'manual'
  createdAt: string
}

/**
 * 未绑定对端的待办：对端发来消息但还没有绑定会话时记一条，面板据此显示
 * 「未绑定对端」并让用户一键绑到当前会话。只留最近 N 条（由写入方裁剪），
 * 消息正文不进 state。
 */
export interface ImPendingPeer {
  /** 最近一次入站时间（epoch ms）。 */
  lastAt: number
  /** 平台给出的显示名；私聊没有昵称时缺省（绝不拿 openid 充数）。 */
  senderName?: string
}

/**
 * 默认值刻意最严：两条通道都是白名单且名单为空 = 拒绝所有人；群聊必须 @。
 * 扫码绑定成功后由渠道把扫码人写进 privateAllow（提案 0024 §4.1）。
 */
export const DEFAULT_IM_SETTINGS: ImSettings = {
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
  const chunkLimit = record['chunkLimit']
  return {
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

/**
 * 绑定表容错读取：缺 sessionId 的记录直接丢弃，不让它污染路由。
 * v1 的 character/chatId 字段已废弃——绑定只看 sessionId，旧记录读出后
 * 自然降级为「会话绑定」，不再要求聊天归属。
 */
export function normalizeImPeers(value: unknown): Record<string, ImPeerBinding> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImPeerBinding> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId.trim() === '') continue
    const scope: ImScope = record['scope'] === 'group' ? 'group' : 'private'
    const boundBy: 'auto' | 'manual' = record['boundBy'] === 'manual' ? 'manual' : 'auto'
    const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date(0).toISOString()
    result[key] = { sessionId, scope, boundBy, createdAt }
  }
  return result
}

/** 未绑定待办容错读取：时间戳非有限数/为负的记录丢弃。 */
export function normalizeImPendingPeers(value: unknown): Record<string, ImPendingPeer> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImPendingPeer> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const lastAt = record['lastAt']
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0) continue
    const senderName = record['senderName']
    result[key] = {
      lastAt,
      ...(typeof senderName === 'string' && senderName.trim() !== '' ? { senderName: senderName.trim() } : {}),
    }
  }
  return result
}
