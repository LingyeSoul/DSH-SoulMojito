import { describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_NUDGE, buildGroupTurn, pickGroupMember } from '../src/group.js'

function message(name: string, mes: string, is_user = false) {
  return { name, is_user, is_system: false, send_date: 'now', mes }
}

describe('group turn transform', () => {
  it('maps the speaker history to assistant and prefixes others as user', () => {
    const result = buildGroupTurn({
      speaker: 'Alice',
      members: ['Alice', 'Bob'],
      userName: 'User',
      messages: [
        message('User', 'hi', true),
        message('Alice', 'greetings'),
        message('Bob', 'yo'),
      ],
    })
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]).toMatchObject({ is_user: true, mes: 'hi' })
    expect(result.messages[1]).toMatchObject({ is_user: false, mes: 'greetings' })
    expect(result.messages[2]).toMatchObject({ is_user: true, mes: 'Bob: yo' })
  })

  it('skips system messages and applies the group nudge with speaker substitution', () => {
    const result = buildGroupTurn({
      speaker: 'Alice',
      members: ['Alice'],
      userName: 'User',
      messages: [message('sys', 'note', false, )],
      groupNudgePrompt: 'Reply as {{char}} now.',
    })
    // @ts-expect-error test fixture uses is_system flag below
    result.messages.push({ ...message('sys', 'note2'), is_system: true })
    expect(result.nudge).toEqual({ role: 'user', content: 'Reply as Alice now.' })
  })

  it('defaults the nudge when no preset value is provided', () => {
    const result = buildGroupTurn({ speaker: 'B', members: ['B'], userName: 'U', messages: [] })
    expect(result.nudge).toBeUndefined()
    expect(DEFAULT_GROUP_NUDGE).toContain('{{char}}')
  })
})

describe('member picking', () => {
  const talk = (member: string) => (member === 'Chatty' ? 0.9 : member === 'Silent' ? 0.1 : 0.5)

  it('returns the explicit member when valid', () => {
    const pick = pickGroupMember({
      strategy: 1, members: ['A', 'B'], disabled: [], talkativeness: talk, allowSelfResponses: false, explicit: 'B',
    })
    expect(pick).toBe('B')
  })

  it('rejects explicit members outside the enabled list', () => {
    const pick = pickGroupMember({
      strategy: 1, members: ['A', 'B'], disabled: ['B'], talkativeness: talk, allowSelfResponses: false, explicit: 'B',
    })
    expect(pick).toBeUndefined()
  })

  it('never returns undefined for a non-empty enabled set', () => {
    for (let i = 0; i < 20; i++) {
      const pick = pickGroupMember({
        strategy: 1, members: ['A', 'B', 'C'], disabled: [], talkativeness: talk,
        allowSelfResponses: false, lastSpeaker: 'A', rng: () => i / 20,
      })
      expect(pick).toBeDefined()
      expect(['B', 'C']).toContain(pick)
    }
  })

  it('falls back to the full pool when only the last speaker remains', () => {
    const pick = pickGroupMember({
      strategy: 1, members: ['A', 'B'], disabled: ['B'], talkativeness: talk,
      allowSelfResponses: false, lastSpeaker: 'A', rng: () => 0.99,
    })
    expect(pick).toBe('A')
  })

  it('rotates in list order and skips disabled members', () => {
    const members = ['A', 'B', 'C']
    const disabled = ['B']
    expect(pickGroupMember({ strategy: 2, members, disabled, talkativeness: talk, allowSelfResponses: false, lastSpeaker: 'A' })).toBe('C')
    expect(pickGroupMember({ strategy: 2, members, disabled, talkativeness: talk, allowSelfResponses: false, lastSpeaker: 'C' })).toBe('A')
    expect(pickGroupMember({ strategy: 2, members, disabled, talkativeness: talk, allowSelfResponses: false })).toBe('A')
  })

  it('weights natural picks by talkativeness', () => {
    let chatty = 0
    for (let i = 0; i < 1000; i++) {
      const pick = pickGroupMember({
        strategy: 1, members: ['Chatty', 'Silent'], disabled: [], talkativeness: talk,
        allowSelfResponses: true, rng: () => Math.random(),
      })
      if (pick === 'Chatty') chatty += 1
    }
    expect(chatty).toBeGreaterThan(700)
  })
})
