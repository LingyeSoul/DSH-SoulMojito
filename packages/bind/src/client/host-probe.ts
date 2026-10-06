/**
 * client half（ModuleLoader factory 内运行的 web 侧）的宿主工作区连接探测。
 * DSH 0.1.2 把 connectWorkspace 从 workspaces 控制器面挪到 uiWorkspace 服务；
 * rc.6 宿主仍暴露在 ctx.workspaces。ctx.get 是 client guard 的无声明可选查找，
 * 缺失服务返回 undefined，因此探测在两代宿主上都安全——声明注入 uiWorkspace
 * 会让插件在 rc.6 上永远挂起，所以刻意保持 declaration-free。
 *
 * 本文件由 scripts/build-plugin.mjs 打成 IIFE 注入 plugin client bundle 的
 * factory 顶部，无 DOM/宿主依赖，可在 Node 里直接测试。
 */

import { type UiPrimitiveShapeTrace } from './ui-primitives.js'

export interface ClientWorkspaceContext {
  get?: (serviceId: string) => unknown
  workspaces?: {
    connectWorkspace?: (workspaceId: string) => unknown
  }
  sessions?: {
    open?: (sessionId: string) => unknown
    binding?: (sessionId: string) => unknown
    retain?: (target: string, options: { source: string }) => { release?: () => void } | undefined
  }
  [key: string]: unknown
}

/** 本次连接命中的绑定路径：uiWorkspace 为 0.1.2 服务面，workspaces 为 rc.6 回退。 */
export type ClientProbePath = 'uiWorkspace' | 'workspaces' | 'unavailable'

/** 会话打开命中的绑定路径：uiWorkspace.openSession 为 0.2.0 服务面，sessions.open 为旧宿主回退。 */
export type ClientOpenSessionPath = 'uiWorkspace' | 'sessions' | 'unavailable'

/** 会话保留命中的路径：retain 为显式保留（0.2.0 契约），borrow 为旧宿主直接借用，unavailable 为两面缺失。 */
export type ClientRetainPath = 'retain' | 'borrow' | 'unavailable'

/** retainHostSession 返回的持有句柄；release 幂等，回退路径为空操作。 */
export interface HostSessionHold {
  readonly path: ClientRetainPath
  release(): void
}

/** 连接探测轨迹；client half 持有一份并在诊断输出里上报。 */
export interface ClientShapeTrace {
  connectPath?: ClientProbePath
  connectCalls: number
  openSessionPath?: ClientOpenSessionPath
  openSessionCalls: number
  retainPath?: ClientRetainPath
  retainCalls: number
  /** 宿主 UI 原子的解析结果；见 ui-primitives.ts。 */
  uiPrimitives?: UiPrimitiveShapeTrace
}

// client half 的 UI 原子适配与本探测模块一起注入同一个 factory（见
// scripts/build-plugin.mjs 的 __DSH_BIND_CLIENT_SLOT__），因此在此转出。
export { resolveUiPrimitives } from './ui-primitives.js'
export type {
  CreateElementLike,
  UiPrimitiveResolveOptions,
  UiPrimitiveShapeTrace,
} from './ui-primitives.js'

export function createClientShapeTrace(): ClientShapeTrace {
  return { connectCalls: 0, openSessionCalls: 0, retainCalls: 0 }
}

export function connectHostWorkspace(
  ctx: ClientWorkspaceContext,
  workspaceId: string,
  trace?: ClientShapeTrace,
): unknown {
  const uiWorkspace = ctx.get?.('uiWorkspace') as { connectWorkspace?: (id: string) => unknown } | undefined
  if (typeof uiWorkspace?.connectWorkspace === 'function') {
    if (trace) {
      trace.connectPath = 'uiWorkspace'
      trace.connectCalls += 1
    }
    return uiWorkspace.connectWorkspace(workspaceId)
  }
  if (typeof ctx.workspaces?.connectWorkspace === 'function') {
    if (trace) {
      trace.connectPath = 'workspaces'
      trace.connectCalls += 1
    }
    // 直接调用而非 Function.call：gates 的 internal-workspace 检查要求产物
    // 保留该字面表达式作为 rc.6 回退路径的防漂移标记。
    return ctx.workspaces.connectWorkspace(workspaceId)
  }
  if (trace) {
    trace.connectPath = 'unavailable'
    trace.connectCalls += 1
  }
  throw new Error('no workspace connect face on this host (uiWorkspace/workspaces both unavailable)')
}

/**
 * 把一个会话打开到宿主主视图。DSH 0.2.0-rc.2 起「打开会话」不在 sessions
 * 控制器面上（ClientSessions 只剩 retain/using/create/fork/binding/list），
 * 主视图切换由 UiWorkspaceService.openSession 负责（retain source=mainView +
 * 替换 selection）；旧宿主的 sessions.open 保留为回退，行为与 connectHostWorkspace
 * 的双面探测同构。
 */
export function openHostSession(
  ctx: ClientWorkspaceContext,
  sessionId: string,
  trace?: ClientShapeTrace,
): void {
  const uiWorkspace = ctx.get?.('uiWorkspace') as { openSession?: (target: string) => unknown } | undefined
  if (typeof uiWorkspace?.openSession === 'function') {
    if (trace) {
      trace.openSessionPath = 'uiWorkspace'
      trace.openSessionCalls += 1
    }
    uiWorkspace.openSession(sessionId)
    return
  }
  if (typeof ctx.sessions?.open === 'function') {
    if (trace) {
      trace.openSessionPath = 'sessions'
      trace.openSessionCalls += 1
    }
    ctx.sessions.open(sessionId)
    return
  }
  if (trace) {
    trace.openSessionPath = 'unavailable'
    trace.openSessionCalls += 1
  }
  throw new Error('no session open face on this host (uiWorkspace.openSession/sessions.open both unavailable)')
}

/**
 * 以插件名义显式 retain 一个宿主会话作用域，使持有期内 ctx.sessions
 * .binding(sessionId) 可借。DSH 0.2.0-rc.2 起 uiWorkspace.connectWorkspace
 * 内部走 sessions.create（宿主契约「retain it before borrowing its
 * binding」），不再隐式保留；binding() 只返回已 retain 的作用域，未保留时
 * 恒为 undefined。调用方在 openSessionView 建立 mainView 保留后 release
 * 归还本引用，全程保持引用计数 ≥ 1。
 *
 * retain 面缺失、宿主拒绝或 reference 形状不可用时退回旧宿主的直接借用
 * （binding 无需 retain），本函数自身永不抛错；两面缺失时标记 unavailable。
 */
export function retainHostSession(
  ctx: ClientWorkspaceContext,
  sessionId: string,
  trace?: ClientShapeTrace,
): HostSessionHold {
  const sessions = ctx?.sessions
  if (typeof sessions?.retain === 'function') {
    try {
      const reference = sessions.retain(sessionId, { source: 'dsh-tavern' })
      const releaseReference = reference?.release
      if (typeof releaseReference === 'function') {
        if (trace) {
          trace.retainPath = 'retain'
          trace.retainCalls += 1
        }
        let released = false
        return {
          path: 'retain',
          release() {
            if (released) return
            released = true
            releaseReference()
          },
        }
      }
    } catch {
      // 未知会话或宿主拒绝 retain：落入下方 borrow 回退，调用方的 binding()
      // 借用语义与旧宿主一致（可能为 undefined，由调用方决定跳过或报错）。
    }
  }
  const fallbackPath: ClientRetainPath = typeof sessions?.binding === 'function' ? 'borrow' : 'unavailable'
  if (trace) {
    trace.retainPath = fallbackPath
    trace.retainCalls += 1
  }
  return {
    path: fallbackPath,
    release() {},
  }
}
