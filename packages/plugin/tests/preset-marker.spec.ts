import { describe, expect, it } from 'vitest'
import { lastSelectedPresetId } from '../src/session/preset-marker.js'

describe('lastSelectedPresetId', () => {
  it('returns the final selection, not the first one', () => {
    const session = {
      events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'agent-tavern' } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
      ],
    }
    expect(lastSelectedPresetId(session)).toBe('standard')
  })

  it('reads the snapshotEvents host shape', () => {
    const events = [
      { type: 'agent-preset/selected', data: { agentPreset: 'agent-novel' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'card-workbench' } },
    ]
    expect(lastSelectedPresetId({ snapshotEvents: () => Object.freeze([...events]) })).toBe('card-workbench')
  })

  it('returns undefined without a marker or an unreadable session', () => {
    expect(lastSelectedPresetId({ events: [{ type: 'turn/start', data: { turn: 1 } }] })).toBeUndefined()
    expect(lastSelectedPresetId({ events: [{ type: 'agent-preset/selected', data: { agentPreset: 42 } }] })).toBeUndefined()
    expect(lastSelectedPresetId(null)).toBeUndefined()
    expect(lastSelectedPresetId(undefined)).toBeUndefined()
  })
})
