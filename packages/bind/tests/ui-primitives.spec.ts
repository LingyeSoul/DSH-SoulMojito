import { describe, expect, it } from 'vitest'
import { resolveUiPrimitives, type UiPrimitiveShapeTrace } from '../src/client/ui-primitives.js'

interface Element {
  type: unknown
  props: Record<string, unknown>
}

const createElement = (type: unknown, props: Record<string, unknown>): Element => ({ type, props })

function hostWith(entries: Record<string, unknown>): Record<string, unknown> {
  return entries
}

function resolveFrom(
  host: Record<string, unknown>,
  options: { trace?: { uiPrimitives?: UiPrimitiveShapeTrace } } = {},
): { read: (name: string) => unknown; trace: UiPrimitiveShapeTrace } {
  const trace: { uiPrimitives?: UiPrimitiveShapeTrace } = options.trace ?? {}
  const resolved = resolveUiPrimitives(host, { createElement, trace })
  return {
    read: (name: string) => resolved[name],
    trace: trace.uiPrimitives as UiPrimitiveShapeTrace,
  }
}

function render(resolved: unknown, props: Record<string, unknown> = {}): Element {
  return (resolved as (value: Record<string, unknown>) => Element)(props)
}

describe('resolveUiPrimitives', () => {
  it('aliases legacy size-suffixed icons onto the stroke-suffixed host names', () => {
    const host = hostWith({ IconSparkleRegular: 'sparkle-regular', IconSparkleMedium: 'sparkle-medium' })
    const { read, trace } = resolveFrom(host)

    const element = render(read('IconSparkle16'))

    expect(element.type).toBe('sparkle-regular')
    expect(element.props.size).toBe(16)
    expect(trace.aliased).toEqual({ IconSparkle16: 'IconSparkleRegular' })
    expect(trace.synthesized).toEqual([])
    expect(trace.missing).toEqual([])
  })

  it('keeps the size the legacy name encoded, including the 14px glyphs', () => {
    const host = hostWith({ IconChevronDownOutlineRegular: 'chevron' })
    const { read, trace } = resolveFrom(host)

    expect(render(read('IconChevronDownOutline14')).props.size).toBe(14)
    expect(trace.aliased).toEqual({ IconChevronDownOutline14: 'IconChevronDownOutlineRegular' })
  })

  it('lets callers override the legacy default size', () => {
    const host = hostWith({ IconSparkleRegular: 'sparkle-regular' })
    const { read } = resolveFrom(host)

    expect(render(read('IconSparkle16'), { size: 18 }).props.size).toBe(18)
  })

  it('prefers a verbatim host export so older hosts keep their own icon set', () => {
    const host = hostWith({ IconSparkle16: 'legacy-sparkle', IconSparkleRegular: 'sparkle-regular' })
    const { read, trace } = resolveFrom(host)

    expect(read('IconSparkle16')).toBe('legacy-sparkle')
    expect(trace.aliased).toEqual({})
    expect(trace.direct).toBe(1)
  })

  it('falls back to the medium stroke variant when only that one is exported', () => {
    const host = hostWith({ IconSparkleMedium: 'sparkle-medium' })
    const { read, trace } = resolveFrom(host)

    expect(render(read('IconSparkle16')).type).toBe('sparkle-medium')
    expect(trace.aliased).toEqual({ IconSparkle16: 'IconSparkleMedium' })
  })

  it('passes non-icon primitives through verbatim and counts them', () => {
    const host = hostWith({ Button: 'button', Modal: 'modal', Tooltip: 'tooltip' })
    const { read, trace } = resolveFrom(host)

    expect(read('Button')).toBe('button')
    expect(read('Modal')).toBe('modal')
    expect(read('Tooltip')).toBe('tooltip')
    expect(trace.direct).toBe(3)
    expect(trace.aliased).toEqual({})
    expect(trace.missing).toEqual([])
  })

  it('degrades an icon that no host export can serve to a null renderer instead of undefined', () => {
    const host = hostWith({ IconSparkleRegular: 'sparkle-regular' })
    const { read, trace } = resolveFrom(host)

    const resolved = read('IconRemovedGlyph16')

    expect(typeof resolved).toBe('function')
    expect((resolved as () => null)()).toBeNull()
    // React #130 is raised for undefined element types; a null renderer keeps
    // the surrounding slot alive while the trace carries the divergence.
    expect(trace.synthesized).toEqual(['IconRemovedGlyph16'])
    expect(trace.missing).toEqual([])
  })

  it('reports a missing non-icon primitive as missing without disguising it', () => {
    const host = hostWith({ Button: 'button' })
    const { read, trace } = resolveFrom(host)

    expect(read('Modal')).toBeUndefined()
    expect(trace.missing).toEqual(['Modal'])
    expect(trace.synthesized).toEqual([])
  })

  it('returns the host component unwrapped when no createElement is available', () => {
    const resolved = resolveUiPrimitives(hostWith({ IconSparkleRegular: 'sparkle-regular' }))
    expect(resolved['IconSparkle16']).toBe('sparkle-regular')
  })

  it('caches per name, ignores symbol probes, and tolerates a nullish namespace', () => {
    const { read, trace } = resolveFrom(hostWith({ Button: 'button' }))
    const resolved = resolveUiPrimitives(null, { trace: {} })

    expect(read('Button')).toBe(read('Button'))
    expect(trace.direct).toBe(1)
    expect(((resolved as Record<symbol, unknown>)[Symbol.toStringTag])).toBeUndefined()
    expect(((resolveUiPrimitives(undefined) as Record<string, unknown>).Button)).toBeUndefined()
  })
})
