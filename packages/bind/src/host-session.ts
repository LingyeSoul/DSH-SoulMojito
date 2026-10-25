/**
 * 宿主 Node half 的 Session 事件日志兼容读取层。DSH 0.1.2 把 `Session.events`
 * （可变数组属性）改成私有 `log` 加 `snapshotEvents()` 冻结快照；rc.6 仍暴露
 * `events`。探测顺序 events → snapshotEvents() → log，宿主形状不可读时返回
 * undefined，让调用方区分「空日志」与「非宿主会话对象」。
 */

export interface HostSessionLog {
  id?: string
  events?: readonly unknown[]
  log?: readonly unknown[]
  snapshotEvents?: (...args: unknown[]) => unknown
  [key: string]: unknown
}

export interface HostSessionEventData {
  source?: unknown
  message?: { id?: unknown; source?: unknown; content?: unknown }
  turn?: unknown
  step?: unknown
  [key: string]: unknown
}

export interface HostSessionEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: HostSessionEventData
}

export function readSessionEvents(session: HostSessionLog | null | undefined): readonly unknown[] | undefined {
  if (!session) return undefined
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    const snapshot = session.snapshotEvents()
    if (Array.isArray(snapshot)) return snapshot
  }
  if (Array.isArray(session.log)) return session.log
  return undefined
}

export function sessionEvents(session: HostSessionLog | null | undefined): readonly HostSessionEvent[] {
  return (readSessionEvents(session) ?? []) as readonly HostSessionEvent[]
}

/** 本插件的持久化身份名（2026-10-16 项目改名 dsh-tavern → DSH-SoulMojito）。
 * 新写入恒用本名；旧名（LEGACY_PLUGIN_NAME）只保留读取兼容。 */
export const PLUGIN_NAME = 'dsh-soulmojito'

/** 改名前的持久化身份名：存量会话工件里的 source 戳（v0-v3 的 `plugin` 成员、
 * v4 的 producer kind）读取端必须继续识别，否则旧会话失去插件身份。 */
export const LEGACY_PLUGIN_NAME = 'dsh-tavern'

/** v4 起本插件消息的 producer-owned source kind。宿主 v3→v4 迁移对不在同名
 * 生产者名单里的插件名按 `plugin:<name>` 重写，本插件两侧（迁移产物与新写入）
 * 因此收敛到同一 kind。改名前的历史值 `plugin:dsh-tavern` 由读取端双认
 * （LEGACY_TAVERN_PLUGIN_SOURCE_KIND），新写入恒为新名。 */
export const TAVERN_PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_NAME}`

/** 改名前的 producer-owned kind（只读兼容通道，不用于新写入）。 */
export const LEGACY_TAVERN_PLUGIN_SOURCE_KIND = `plugin:${LEGACY_PLUGIN_NAME}`

/**
 * 会话持久化格式版本（`session.header.version`，宿主 Session 公开字段，创建时即定）。
 * rc.2 起为 4（原生 V4 准入）；0.1.x 为 0-3。header 不可读时返回 undefined，
 * 调用方据此回退老宿主行为（测试 stub 与旧宿主都没有 header）。
 */
export function hostSessionFormatVersion(session: HostSessionLog | null | undefined): number | undefined {
  const version = (session as { header?: { version?: unknown } } | undefined)?.header?.version
  return typeof version === 'number' && Number.isSafeInteger(version) ? version : undefined
}

/**
 * 宿主原生会话分叉的谱系信息（decisions/2026-10-11-agent-tavern-host-fork）。
 * DSH `sessions.fork(source, boundary?)` 的子会话在 header 上携带
 * `parentSession`（seed lineage）与 `isSeeded: true`；`inheritedEventCount`
 * 是 Session 的公开字段——精确 fork 继承前缀长度（事件 seq 连续 0..N-1，
 * 边界 seq = N-1）。字段缺失/形状不可读时返回 undefined：调用方按「非 fork
 * 会话」处理，行为与老宿主一致。
 *
 * subagent 子会话（dsh-subagent-fork-in-process）同样以 fork 种子实现，靠
 * `header.origin === 'subagent'` 或 `delegationDepth > 0` 区分——不排除会把
 * tavern_deduce 子代理收养成第二个主角会话，必须显式挡掉。
 */
export interface HostSessionForkInfo {
  parentSession: string
  /** fork 继承前缀长度（边界 seq = inheritedEventCount - 1）；不可读时缺省。 */
  inheritedEventCount?: number
}

export function hostSessionForkInfo(session: HostSessionLog | null | undefined): HostSessionForkInfo | undefined {
  const header = (session as { header?: Record<string, unknown> } | undefined)?.header
  if (typeof header !== 'object' || header === null) return undefined
  if (header.origin === 'subagent') return undefined
  if (typeof header.delegationDepth === 'number' && Number.isSafeInteger(header.delegationDepth) && header.delegationDepth > 0) return undefined
  const parentSession = header.parentSession
  if (header.isSeeded !== true || typeof parentSession !== 'string' || parentSession === '') return undefined
  const inherited = (session as { inheritedEventCount?: unknown }).inheritedEventCount
  return {
    parentSession,
    ...(typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0 ? { inheritedEventCount: inherited } : {}),
  }
}

/**
 * 会话消息的插件 source 形状，按宿主 session format 版本分支：
 *
 * - v4+（DSH 0.2.0-rc.2 起）：持久化校验显式拒绝 `kind === 'plugin'`
 *   （"format v4 message requires a producer-owned source kind"），v3 的
 *   `{ kind, plugin }` 由宿主迁移重写为 `{ kind: 'plugin:<name>' }` 并丢弃
 *   `plugin` 成员，其余自有 JSON 成员（form/summary）保留；
 * - v0-v3：v2→v3 迁移边以封闭 kind 集合拒绝未知 kind（"cannot safely
 *   transform unclassified message source"），v4 形状写入老宿主工件会在
 *   升级时毒化整个会话文件，必须保持 `{ kind: 'plugin', plugin }`。
 *
 * 判定依据 `session.header.version`（宿主 Session 公开字段，创建时即定）；
 * header 缺失或版本不可读时回退 v0 形状——旧宿主与测试 stub（无 header）
 * 保持既有行为，v4 宿主必定带 header.version = 4。
 */
export function hostPluginMessageSource(
  session: HostSessionLog | null | undefined,
  members?: Record<string, unknown>,
): Record<string, unknown> {
  const version = hostSessionFormatVersion(session)
  const kind = version !== undefined && version >= 4
    ? TAVERN_PLUGIN_SOURCE_KIND
    : 'plugin'
  return {
    ...(kind === 'plugin' ? { plugin: PLUGIN_NAME } : {}),
    ...members,
    kind,
  }
}

/** 会话事件里的 source 是否本插件写入（v4 producer-owned kind 或 v0-v3 的
 * `{ kind: 'plugin', plugin }`）。宿主把 v3 工件读出时已迁移为 v4 kind；老形状
 * 匹配只为防御直读未迁移日志的路径。改名兼容（2026-10-16）：旧名 dsh-tavern 的
 * kind 与 plugin 值双认——存量会话的 marker 识别不断。 */
export function isHostPluginMessageSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as Record<string, unknown>
  if (record.kind === TAVERN_PLUGIN_SOURCE_KIND || record.kind === LEGACY_TAVERN_PLUGIN_SOURCE_KIND) return true
  return record.kind === 'plugin' && (record.plugin === PLUGIN_NAME || record.plugin === LEGACY_PLUGIN_NAME)
}
