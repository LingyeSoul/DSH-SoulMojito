import { describe, expect, it } from 'vitest'
import { describeHostShape, probeSessionShape } from '../src/host-shape.js'
import type { DshContextLike } from '../src/host-shape.js'

function makeFullContext(): DshContextLike {
  return {
    agentPresets: { mount: async () => ({}) },
    systemPrompt: { section: () => ({}), context: () => ({}) },
    tools: { register: () => ({}) },
    agents: { get: () => ({}) },
  }
}

describe('probeSessionShape', () => {
  it('maps the rc.6 events array shape', () => {
    expect(probeSessionShape({ events: [] })).toBe('events')
  })

  it('maps the 0.1.2 snapshotEvents shape', () => {
    expect(probeSessionShape({ snapshotEvents: () => Object.freeze([]) })).toBe('snapshotEvents')
  })

  it('maps the private log shape', () => {
    expect(probeSessionShape({ log: [] })).toBe('log')
  })

  it('reports unreadable for non-host session objects and absent for nullish input', () => {
    expect(probeSessionShape({})).toBe('unreadable')
    expect(probeSessionShape(null)).toBe('absent')
    expect(probeSessionShape(undefined)).toBe('absent')
  })

  it('follows the same precedence as readSessionEvents (events > snapshotEvents > log)', () => {
    expect(probeSessionShape({ events: [], snapshotEvents: () => [] })).toBe('events')
    expect(probeSessionShape({ snapshotEvents: () => [], log: [] })).toBe('snapshotEvents')
  })
})

describe('describeHostShape', () => {
  it('reports every service as present on a full rc/0.1.2 context', () => {
    const report = describeHostShape(makeFullContext())
    expect(report.services).toEqual({
      agentPresets: true,
      systemPrompt: true,
      tools: true,
      agents: true,
    })
  })

  it('reports individual service misses for partial contexts', () => {
    const report = describeHostShape({ agents: { get: () => ({}) } })
    expect(report.services).toEqual({
      agentPresets: false,
      systemPrompt: false,
      tools: false,
      agents: true,
    })
  })

  it('requires both systemPrompt.section and context', () => {
    expect(describeHostShape({ systemPrompt: { section: () => ({}) } }).services.systemPrompt).toBe(false)
  })

  it('tolerates nullish contexts and carries the session shape', () => {
    const report = describeHostShape(null, { log: [] })
    expect(report.sessionShape).toBe('log')
    expect(report.services.agents).toBe(false)
    expect(typeof report.checkedAt).toBe('string')
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false)
  })
})
