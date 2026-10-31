/**
 * IM 通道的持久化形状（提案 0024 §3.3/§4.3）。
 *
 * 只放「要落 `state.json` 的东西」：peer → 原生会话绑定、未绑定待办、访问控制、
 * 会话主人与最近发言人。协议侧形状（`ImInbound` / `OutboundPart` / `ImChannel`）
 * 在 `packages/plugin/src/im/types.ts`，两者不混：store 不认识渠道协议。
 *
 * 身份边界：主人/发言人的**值**只存 `snd-<10 hex>` 哈希与显示名；peer 键沿用
 * 既有 `channel:account:scope:peerId` 约定（键本身含 peerId，本次不迁移）。
 *
 * 绑定目标是**宿主原生会话 id**（`sessionId`），不是 Tavern 聊天：入站消息由
 * 插件以插件来源消息插进该会话，模型用 IM 工具自己回复（决策
 * 2026-10-31-im-native-session-binding）。
 *
 * 密钥、游标、去重键一律不进这里——`state.json` 会被面板、Mod 与工具面读取。
 */

import { createHash } from 'node:crypto'

/** 发言人哈希的前缀：与 `imPeerAlias` / `imMessageRef` 同口径。 */
export const IM_SENDER_HASH_PREFIX = 'snd-'

/** 发言人哈希保留的十六进制位数。 */
export const IM_SENDER_HASH_HEX_LENGTH = 10

/** `Date` 能表示的最大毫秒值；超过它 `toISOString()` 会抛 RangeError。 */
export const IM_MAX_TIMESTAMP_MS = 8_640_000_000_000_000

const IM_SENDER_HASH_PATTERN = new RegExp(`^${IM_SENDER_HASH_PREFIX}[0-9a-f]{${IM_SENDER_HASH_HEX_LENGTH}}$`)

/**
 * 稳定、脱敏的发言人标识：`snd-` + sha256(`${channel}:${accountId}:${senderId}`)
 * 前 10 位十六进制。格式定义在 store 层，插件与 HTTP 只复用同一个纯函数。
 */
export function imSenderHash(channel: string, accountId: string, senderId: string): string {
  const hex = createHash('sha256')
    .update(`${channel}:${accountId}:${senderId}`)
    .digest('hex')
    .slice(0, IM_SENDER_HASH_HEX_LENGTH)
  return `${IM_SENDER_HASH_PREFIX}${hex}`
}

/** 只接受本模块产出的 `snd-<10 hex>` 形状；手改的原始 id 一律不当身份。 */
export function isImSenderHash(value: string): boolean {
  return IM_SENDER_HASH_PATTERN.test(value)
}

export type ImScope = 'private' | 'group'

/** 访问控制三态：开放 / 白名单 / 关闭。 */
export type ImAccessMode = 'open' | 'allowlist' | 'disabled'

/**
 * 微信出站节奏的取值边界（决策 2026-10-31-weixin-send-queue）。
 *
 * 缺省 3s：iLink 的硬上限是 30s 窗口 5 条，日常短句回复按 3s 间隔铺开既能守住
 * 窗口，又不至于让一次 2–5 条回复拖过一整分钟；下限 500ms 防止面板填出仍会触发
 * 平台突发的节奏，上限 60s 防止把回复拖到对端以为机器人离线。校验在
 * `packages/plugin/src/im/settings.ts` 的 `applyImSettingsPatch` 里生效。
 */
export const WEIXIN_SEND_INTERVAL_DEFAULT_MS = 3_000
export const WEIXIN_SEND_INTERVAL_MIN_MS = 500
export const WEIXIN_SEND_INTERVAL_MAX_MS = 60_000

export interface ImSettings {
  /** QQ 群必须 @ 机器人才投递；默认开启，可关。 */
  groupRequireMention: boolean
  privateMode: ImAccessMode
  privateAllow: string[]
  groupMode: ImAccessMode
  groupAllow: string[]
  /** 单条出站上限；缺省按渠道默认（QQ 4500 / 微信 1800 / OneBot 2000）。 */
  chunkLimit?: number
  /**
   * 微信出站间隔（毫秒）；缺省 = `WEIXIN_SEND_INTERVAL_DEFAULT_MS`。
   * 面板可填 500..60000 的整数，`null` 清除回默认；30s/5 条的窗口与 `-2`
   * 冷却仍是改不动的硬上限。
   */
  weixinSendIntervalMs?: number
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
 * IM 会话主人（决策 2026-10-31-im-owner-designation）：每个 peer 至多一位。
 * 主人/发言人的**值**只存哈希：`id` 是 `snd-` + sha256(channel:accountId:senderId)
 * 前 10 位十六进制；原始 openid/user_id 不进入这张表的值、面板投影、relay 文本
 * 与日志。peer 键沿用既有 `channel:account:scope:peerId` 约定（键本身含 peerId，
 * 本次不迁移）。键不存在表示未指定主人。`privateAllow` 存原始 id 是历史例外，
 * 不复制到新面。
 */
export interface ImOwnerEntry {
  /** `imSenderHash` 产出的哈希（`snd-` + 10 位十六进制）。 */
  id: string
  /** 平台显示名（群聊昵称）；私聊对端没有安全名字时为空串，面板回退显示「对端」。 */
  name: string
  /** 设置时间（ISO 字符串）。 */
  setAt: string
}

/** 一条记录下来的发言人：哈希 + 显示名 + 最近一次投递时间。 */
export interface ImSenderEntry {
  id: string
  name: string
  /** 最近一次投递的本地时间（epoch ms）；写入方按窗口限流刷新。 */
  lastAt: number
}

/** 每个 peer 保留的最近发言人数上限：面板选择器够用，陌生人群刷不爆 state。 */
export const IM_SENDERS_MAX_PER_PEER = 20

/**
 * 同一发言人的刷新窗口（决策 2026-10-31-im-owner-designation）：窗口内重复投递
 * 只更新内存、不重写 `state.json`，避免每条消息一次落盘；窗口外的投递刷新
 * `lastAt` 并把该发言人挪到最前。
 */
export const IM_SENDER_REFRESH_WINDOW_MS = 5 * 60_000

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
  const sendInterval = record['weixinSendIntervalMs']
  return {
    groupRequireMention: record['groupRequireMention'] !== false,
    privateMode: normalizeAccessMode(record['privateMode'], 'allowlist'),
    privateAllow: normalizeStringList(record['privateAllow']),
    groupMode: normalizeAccessMode(record['groupMode'], 'allowlist'),
    groupAllow: normalizeStringList(record['groupAllow']),
    ...(typeof chunkLimit === 'number' && Number.isSafeInteger(chunkLimit) && chunkLimit > 0
      ? { chunkLimit }
      : {}),
    // 手改坏了的间隔（非整数/越界）直接丢弃回落默认，不拖垮整份设置。
    ...(typeof sendInterval === 'number'
      && Number.isSafeInteger(sendInterval)
      && sendInterval >= WEIXIN_SEND_INTERVAL_MIN_MS
      && sendInterval <= WEIXIN_SEND_INTERVAL_MAX_MS
      ? { weixinSendIntervalMs: sendInterval }
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

/**
 * 未绑定待办容错读取：时间戳非有限数/为负/超过 `Date` 上界（`IM_MAX_TIMESTAMP_MS`）
 * 的记录丢弃——与 `imSenders`/`imOwners` 共用同一时间范围，避免 `toISOString()`
 * 在投影层抛 RangeError。
 */
export function normalizeImPendingPeers(value: unknown): Record<string, ImPendingPeer> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImPendingPeer> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const lastAt = record['lastAt']
    if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0 || lastAt > IM_MAX_TIMESTAMP_MS) continue
    const senderName = record['senderName']
    result[key] = {
      lastAt,
      ...(typeof senderName === 'string' && senderName.trim() !== '' ? { senderName: senderName.trim() } : {}),
    }
  }
  return result
}

/**
 * 发言人表容错读取（决策 2026-10-31-im-owner-designation）：缺 id、非
 * `snd-<10 hex>` 哈希、时间戳非有限数/为负/超过 `Date` 上界、重复 id 的条目
 * 丢弃或合并，按时间倒序并截到上限。旧 state.json 没有这张表时返回空表。
 */
export function normalizeImSenders(value: unknown): Record<string, ImSenderEntry[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImSenderEntry[]> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry)) continue
    const byId = new Map<string, ImSenderEntry>()
    for (const item of entry) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      const id = record['id']
      const lastAt = record['lastAt']
      if (typeof id !== 'string' || !isImSenderHash(id.trim())) continue
      if (typeof lastAt !== 'number' || !Number.isFinite(lastAt) || lastAt < 0 || lastAt > IM_MAX_TIMESTAMP_MS) continue
      const name = record['name']
      const trimmed = id.trim()
      const previous = byId.get(trimmed)
      // 同一 id 多条记录时保留最新一条；状态写方本就不会写出重复，手改才会。
      if (previous !== undefined && previous.lastAt >= lastAt) continue
      byId.set(trimmed, {
        id: trimmed,
        name: typeof name === 'string' ? name.trim() : '',
        lastAt,
      })
    }
    if (byId.size === 0) continue
    result[key] = [...byId.values()]
      .sort((left, right) => right.lastAt - left.lastAt)
      .slice(0, IM_SENDERS_MAX_PER_PEER)
  }
  return result
}

/**
 * 主人表容错读取（决策 2026-10-31-im-owner-designation）：缺 id 或非
 * `snd-<10 hex>` 哈希的记录丢弃；`name` 缺省空串，`setAt` 缺失/非法回落 epoch
 * （展示字段，不拖垮整条记录）；其余字段忽略。旧 state.json 没有这张表时返回空表。
 */
export function normalizeImOwners(value: unknown): Record<string, ImOwnerEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, ImOwnerEntry> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string' || !isImSenderHash(id.trim())) continue
    const name = record['name']
    const setAt = record['setAt']
    result[key] = {
      id: id.trim(),
      name: typeof name === 'string' ? name.trim() : '',
      setAt: typeof setAt === 'string' && setAt.trim() !== '' ? setAt : new Date(0).toISOString(),
    }
  }
  return result
}
