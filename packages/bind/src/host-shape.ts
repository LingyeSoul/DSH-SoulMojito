/**
 * 宿主形状诊断。仓库不做宿主版本号检测，全部依赖 feature detection；本模块
 * 把「探测走了哪条绑定路径」变成可直接报告的结构化结果，插件激活时输出一行
 * 日志即可定位用户环境，无需读代码反推。形状名与 DSH 宿主版本对应：
 * `events` 为 rc.6 及更早的可变数组日志，`snapshotEvents`/`log` 为 0.1.2 起
 * 的私有日志加冻结快照。
 */
import { type HostSessionLog } from './host-session.js'

export type HostSessionShape = 'events' | 'snapshotEvents' | 'log' | 'unreadable' | 'absent'

export interface DshContextLike {
  agentPresets?: {
    mount?: (agentContext: unknown, presetId: string) => Promise<unknown>
  }
  systemPrompt?: {
    section?: (...args: unknown[]) => unknown
    context?: (...args: unknown[]) => unknown
  }
  tools?: {
    register?: (...args: unknown[]) => unknown
  }
  agents?: {
    get?: (...args: unknown[]) => unknown
    create?: (...args: unknown[]) => unknown
  }
}

export interface HostShapeReport {
  sessionShape: HostSessionShape
  services: {
    agentPresets: boolean
    systemPrompt: boolean
    tools: boolean
    agents: boolean
  }
  checkedAt: string
}

/** 会话事件日志的形状探测，命中顺序与 readSessionEvents 的读取顺序一致。 */
export function probeSessionShape(session: HostSessionLog | null | undefined): HostSessionShape {
  if (!session) return 'absent'
  if (Array.isArray(session.events)) return 'events'
  if (typeof session.snapshotEvents === 'function' && Array.isArray(session.snapshotEvents())) return 'snapshotEvents'
  if (Array.isArray(session.log)) return 'log'
  return 'unreadable'
}

export function describeHostShape(
  ctx: DshContextLike | null | undefined,
  session?: HostSessionLog | null,
): HostShapeReport {
  return {
    sessionShape: probeSessionShape(session),
    services: {
      agentPresets: typeof ctx?.agentPresets?.mount === 'function',
      systemPrompt: typeof ctx?.systemPrompt?.section === 'function'
        && typeof ctx?.systemPrompt?.context === 'function',
      tools: typeof ctx?.tools?.register === 'function',
      agents: typeof ctx?.agents?.get === 'function',
    },
    checkedAt: new Date().toISOString(),
  }
}
