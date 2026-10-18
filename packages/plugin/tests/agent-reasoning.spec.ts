import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/agent-reasoning.js'

interface ReasoningHarness {
  visible: string[]
  denials: Array<{ deny: string[] }>
  change: () => void
  dispose: () => void
  disposals: number
}

function harness(initial: string[]): ReasoningHarness {
  const state: ReasoningHarness = {
    visible: [...initial],
    denials: [],
    change: () => {},
    dispose: () => {},
    disposals: 0,
  }
  const listeners: Array<() => void> = []
  apply({
    tools: {
      schemas: () => state.visible.map((toolName) => ({ name: toolName })),
      restrict: (filter) => { state.denials.push(filter); return () => {} },
    },
    on: (_event, listener) => { listeners.push(listener); return () => {} },
    effect: (factory) => {
      const disposer = factory() as () => void
      state.dispose = () => { state.disposals += 1; disposer() }
      return () => {}
    },
  })
  state.change = () => { for (const listener of listeners) listener() }
  return state
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agent-reasoning preset module', () => {
  it('identifies as the tool-free preset row module', () => {
    expect(name).toBe('dsh-soulmojito/reasoning')
    expect(inject).toEqual(['tools'])
  })

  it('denies every visible global tool at mount', () => {
    const state = harness(['duckduckgo_search', 'working_directory'])
    expect(state.denials).toEqual([{ deny: ['duckduckgo_search', 'working_directory'] }])
  })

  it('sweeps tools registered after the preset mount, once each', () => {
    vi.useFakeTimers()
    const state = harness(['working_directory'])
    expect(state.denials).toEqual([{ deny: ['working_directory'] }])

    state.visible.push('duckduckgo_search')
    state.change()
    state.change()
    vi.advanceTimersByTime(250)
    expect(state.denials).toEqual([
      { deny: ['working_directory'] },
      { deny: ['duckduckgo_search'] },
    ])

    // A settled registry triggers no further denial.
    state.change()
    vi.advanceTimersByTime(250)
    expect(state.denials).toHaveLength(2)
  })

  it('stops sweeping after the host disposes the preset mount', () => {
    vi.useFakeTimers()
    const state = harness(['working_directory'])
    state.dispose()
    expect(state.disposals).toBe(1)

    state.visible.push('duckduckgo_search')
    state.change()
    vi.advanceTimersByTime(250)
    expect(state.denials).toEqual([{ deny: ['working_directory'] }])
  })

  it('keeps a visible tool denied across a failed restrict call without retrying forever', () => {
    const denied: Array<{ deny: string[] }> = []
    apply({
      tools: {
        schemas: () => [{ name: 'working_directory' }],
        restrict: (filter) => {
          denied.push(filter)
          throw new Error('unknown global tool')
        },
      },
      logger: { warn: () => {} },
    })
    expect(denied).toEqual([{ deny: ['working_directory'] }])
  })
})
