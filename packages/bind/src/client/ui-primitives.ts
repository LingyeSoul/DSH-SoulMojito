/**
 * client half 的宿主 UI 原子形状适配。
 *
 * DSH 0.2.0-rc.2 的 @deepseek-ai/dsh-client-ui-primitives 把产品图标从「尺寸后缀」
 * 命名（IconSparkle16、IconChevronDownOutline14）换成「描边后缀」
 * （IconSparkleRegular、IconSparkleMedium）：旧名字在新宿主上全部是 undefined，
 * 而渲染 undefined 组件会抛 React #130，把每一个挂载它的 slot 一起打崩
 * （settings.section、shell.overlay、sidebar.footer.action、
 * conversation.session.header.actions 同时失效）。
 *
 * 本模块按请求名解析宿主原子：原样命中优先（老宿主行为不变），否则回退到描边
 * 后缀变体并保留旧名字编码的尺寸，两者都没有时图标降级为空渲染并记入形状轨迹。
 * 非图标原子不做空渲染兜底——它们是交互本体，静默降级比显式失败更危险，缺符号时
 * 保持 undefined，由 client-vm-mount 门禁在产物阶段拦下。
 */

/** 形状轨迹里的一格：client half 请求的宿主 UI 原子最终解析成了什么。 */
export interface UiPrimitiveShapeTrace {
  /** 原样命中宿主导出的请求数（图标与非图标合计）。 */
  direct: number
  /** 由兼容层补出的旧图标名 → 实际使用的宿主导出名。 */
  aliased: Record<string, string>
  /** 宿主没有、已降级为空渲染的图标。 */
  synthesized: string[]
  /** 宿主没有、且未兜底的非图标原子（渲染即失败）。 */
  missing: string[]
}

export type CreateElementLike = (type: unknown, props: Record<string, unknown>) => unknown

export interface UiPrimitiveResolveOptions {
  /** 别名图标注入默认 size 所需的 createElement；缺失时别名直接返回宿主组件。 */
  createElement?: CreateElementLike | undefined
  /** 形状轨迹载体；解析结果写入其 uiPrimitives 字段。 */
  trace?: { uiPrimitives?: UiPrimitiveShapeTrace } | undefined
}

/** 旧世代的图标名以两位尺寸后缀收尾（IconSparkle16、IconChevronDownOutline14）。 */
const LEGACY_ICON_NAME = /^(Icon[A-Za-z]+?)(\d{2})$/

interface PrimitiveCandidate {
  name: string
  size?: number
}

function primitiveCandidates(name: string): PrimitiveCandidate[] {
  const legacy = LEGACY_ICON_NAME.exec(name)
  if (legacy === null) return [{ name }]
  const [, base = '', suffix = ''] = legacy
  const size = Number(suffix)
  return [
    { name },
    { name: `${base}Regular`, size },
    { name: `${base}Medium`, size },
  ]
}

function withDefaultSize(component: unknown, size: number, createElement: CreateElementLike): unknown {
  return (props: Record<string, unknown> | null) => createElement(component, { size, ...(props ?? {}) })
}

function nullIcon(): unknown {
  return () => null
}

/**
 * 包一层宿主 primitives 命名空间：属性读取即解析，未命中旧名的图标按描边后缀
 * 变体回退。返回值只用于解构，不做枚举。
 */
export function resolveUiPrimitives(
  namespace: unknown,
  options: UiPrimitiveResolveOptions = {},
): Record<string, unknown> {
  const host = (namespace ?? {}) as Record<string, unknown>
  const createElement = options.createElement
  const shape: UiPrimitiveShapeTrace = { direct: 0, aliased: {}, synthesized: [], missing: [] }
  if (options.trace !== undefined) options.trace.uiPrimitives = shape
  const cache = new Map<string, unknown>()

  function resolve(name: string): unknown {
    if (cache.has(name)) return cache.get(name)
    const value = resolveUncached(name)
    cache.set(name, value)
    return value
  }

  function resolveUncached(name: string): unknown {
    const direct = host[name]
    if (direct !== undefined) {
      shape.direct += 1
      return direct
    }
    for (const candidate of primitiveCandidates(name).slice(1)) {
      const component = host[candidate.name]
      if (component === undefined) continue
      shape.aliased[name] = candidate.name
      return candidate.size === undefined || createElement === undefined
        ? component
        : withDefaultSize(component, candidate.size, createElement)
    }
    if (name.startsWith('Icon')) {
      shape.synthesized.push(name)
      return nullIcon()
    }
    shape.missing.push(name)
    return undefined
  }

  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (typeof key === 'string' ? resolve(key) : undefined),
  })
}
