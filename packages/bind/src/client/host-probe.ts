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

export interface ClientWorkspaceContext {
  get?: (serviceId: string) => unknown
  workspaces?: {
    connectWorkspace?: (workspaceId: string) => unknown
  }
  [key: string]: unknown
}

/** 本次连接命中的绑定路径：uiWorkspace 为 0.1.2 服务面，workspaces 为 rc.6 回退。 */
export type ClientProbePath = 'uiWorkspace' | 'workspaces' | 'unavailable'

/** 连接探测轨迹；client half 持有一份并在诊断输出里上报。 */
export interface ClientShapeTrace {
  connectPath?: ClientProbePath
  connectCalls: number
}

export function createClientShapeTrace(): ClientShapeTrace {
  return { connectCalls: 0 }
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
