/**
 * 无工具推理组合（DSH 0.2.1+ 的 spawn 子代理隔离面）。
 *
 * 0.2.0 宿主用 per-spawn `toolFilter` 清空子代理工具；0.2.1 的
 * `startActivation` 公开请求删除了该字段，官方替代是「独立 agent preset
 * 统一设置角色和工具」。本模块只做一件事：在 preset 挂载域把当前可见的
 * 宿主全局工具全部 `restrict` 掉，使 `agent-reasoning` 组合下的子代理在
 * 模型可见面与执行面都没有工具。
 *
 * 时序：preset 在宿主启动时预挂载，此时大部分全局工具还没注册（实测首轮
 * 只看得见 working_directory）。因此除首轮同步外还订阅 tools/change，
 * 以 250ms 去抖重扫一次；每次只 deny 尚未 deny 过的名字，restrict 自身
 * 触发的 change 不会形成循环。监听在 effect 清理时停表并置 disposed，
 * 避免宿主卸载后定时器再触达失效 ctx。
 */

export const name = 'dsh-soulmojito/reasoning'

export const inject = ['tools']

/** tools/change 去抖窗口；宿主启动期会为每个工具行触发一次。 */
const RESCAN_DELAY_MS = 250

export interface ReasoningContextLike {
  tools?: {
    schemas?: () => Array<{ name: string }>
    restrict?: (filter: { deny: string[] }) => unknown
  }
  on?: (event: 'tools/change', listener: () => void) => unknown
  effect?: (factory: () => unknown, label?: string) => unknown
  logger?: { warn?: (message: string) => void }
}

export function apply(ctx: ReasoningContextLike): void {
  const denied = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const denyVisible = (): void => {
    if (disposed) return
    const tools = ctx.tools
    if (typeof tools?.schemas !== 'function' || typeof tools?.restrict !== 'function') return
    const names = tools.schemas().map((schema) => schema.name).filter((name) => !denied.has(name))
    if (names.length === 0) return
    for (const name of names) denied.add(name)
    try {
      tools.restrict({ deny: names })
    } catch (error) {
      // 注册表拒绝是配置错误（宿主全局工具名漂移）；保留 denied 记账避免
      // 反复重试，但必须让失败可见。
      ctx.logger?.warn?.(`dsh-soulmojito/reasoning: tools.restrict({ deny: ${JSON.stringify(names)} }) failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const schedule = (): void => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      denyVisible()
    }, RESCAN_DELAY_MS)
  }

  denyVisible()
  ctx.on?.('tools/change', schedule)
  ctx.effect?.(() => () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }, 'dsh-soulmojito:reasoning-no-tools')
}
