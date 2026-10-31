import { describe, expect, it } from 'vitest'
import type { HostAgentLike } from '../src/host-contract.js'
import {
  ImSessionNotLiveError,
  buildImFollowupMessage,
  inspectImSessionCapabilities,
  listLiveAgents,
  liveAgentOf,
  requireLiveAgent,
} from '../src/im/session-host.js'

const followup = async (): Promise<void> => {}

function agent(id: string): HostAgentLike {
  return { id, session: { id }, followup }
}

describe('inspectImSessionCapabilities', () => {
  it('requires the host agents service and its get(id)', () => {
    expect(inspectImSessionCapabilities(undefined)).toEqual({
      available: false,
      reasons: ['the host exposes no agents service; IM cannot insert messages into a session'],
    })
    expect(inspectImSessionCapabilities({}).reasons)
      .toEqual(['the host agents service exposes no get(id); IM cannot find the bound session agent'])
    expect(inspectImSessionCapabilities({ get: () => undefined })).toEqual({ available: true, reasons: [] })
  })
})

describe('liveAgentOf', () => {
  it('returns the live agent and degrades a throwing get to "not open"', () => {
    const live = agent('session-a')
    expect(liveAgentOf({ get: (id) => (id === 'session-a' ? live : undefined) }, 'session-a')).toBe(live)
    expect(liveAgentOf({ get: () => undefined }, 'session-a')).toBeUndefined()
    expect(liveAgentOf({ get: () => { throw new Error('fiber inactive') } }, 'session-a')).toBeUndefined()
    expect(liveAgentOf(undefined, 'session-a')).toBeUndefined()
  })
})

describe('requireLiveAgent', () => {
  it('throws a structured "session not live" error when the session is closed', () => {
    expect(() => requireLiveAgent({ get: () => undefined }, 'session-a')).toThrow(ImSessionNotLiveError)
    try {
      requireLiveAgent({ get: () => undefined }, 'session-a')
    } catch (error) {
      expect((error as ImSessionNotLiveError).code).toBe('IM_SESSION_NOT_LIVE')
      expect((error as Error).message).toContain('session-a')
    }
  })

  it('refuses an agent that cannot accept followup messages', () => {
    const broken: HostAgentLike = { id: 'session-a', session: { id: 'session-a' } }
    expect(() => requireLiveAgent({ get: () => broken }, 'session-a')).toThrow(/exposes no followup/)
  })

  it('returns the agent when it can accept messages', () => {
    const live = agent('session-a')
    expect(requireLiveAgent({ get: () => live }, 'session-a')).toBe(live)
  })
})

describe('listLiveAgents', () => {
  it('degrades a missing or throwing list to an empty array', () => {
    expect(listLiveAgents(undefined)).toEqual([])
    expect(listLiveAgents({})).toEqual([])
    expect(listLiveAgents({ list: () => { throw new Error('not ready') } })).toEqual([])
    const rows = [agent('session-a'), agent('session-b')]
    expect(listLiveAgents({ list: () => rows })).toEqual(rows)
  })
})

describe('buildImFollowupMessage', () => {
  const message = { id: 'im-1', text: '[IM qq/私聊]\n在吗', summary: 'IM qq/private message from peer-x' }

  it('builds a plugin-source relay message for a v4 session', () => {
    const built = buildImFollowupMessage({ header: { version: 4 } }, message)
    expect(built).toMatchObject({
      id: 'im-1',
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'plugin:dsh-soulmojito', form: 'relay', summary: message.summary },
    })
  })

  it('falls back to the v0 source shape for old sessions', () => {
    const built = buildImFollowupMessage({}, message)
    expect(built['source']).toEqual({ kind: 'plugin', plugin: 'dsh-soulmojito', form: 'relay', summary: message.summary })
  })
})
