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

export interface HostSessionEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: any
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
