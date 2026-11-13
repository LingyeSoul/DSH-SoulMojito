import { describe, expect, it } from 'vitest'
import { GroupFormatError, parseGroupFile, serializeGroupFile } from '../src/group.js'

describe('group file', () => {
  it('parses the ST export shape with defaults', () => {
    const ir = parseGroupFile({
      id: 'tmp-1',
      name: 'Party',
      members: ['Alice', 'Bob'],
      activation_strategy: 2,
      disabled_members: ['Bob'],
      chat_id: 'chat.jsonl',
      chats: ['chat.jsonl'],
      unknown_key: 42,
    })
    expect(ir.name).toBe('Party')
    expect(ir.members).toEqual(['Alice', 'Bob'])
    expect(ir.activationStrategy).toBe(2)
    expect(ir.disabledMembers).toEqual(['Bob'])
    expect(ir.allowSelfResponses).toBe(false)
    expect(ir.extra).toEqual({ unknown_key: 42 })
    expect(ir.droppedMembers).toBeUndefined()
  })

  it('drops numeric members (ST chid indexes) and counts them', () => {
    const ir = parseGroupFile({ name: 'G', members: [3, 'Alice', 7, 12] })
    expect(ir.members).toEqual(['Alice'])
    expect(ir.droppedMembers).toBe(3)
  })

  it('keeps MANUAL (0) and normalizes only out-of-range strategies', () => {
    expect(parseGroupFile({ name: 'G' }).activationStrategy).toBe(1)
    expect(parseGroupFile({ name: 'G', activation_strategy: 0 }).activationStrategy).toBe(0)
    expect(parseGroupFile({ name: 'G', activation_strategy: 9 }).activationStrategy).toBe(1)
  })

  it('round-trips MANUAL without rewriting it to NATURAL', () => {
    const ir = parseGroupFile({ id: 'm', name: 'Manual Pair', members: ['A', 'B'], activation_strategy: 0 })
    expect(ir.activationStrategy).toBe(0)
    expect(serializeGroupFile(ir)['activation_strategy']).toBe(0)
    expect(parseGroupFile(serializeGroupFile(ir)).activationStrategy).toBe(0)
  })

  it('rejects nameless groups', () => {
    expect(() => parseGroupFile({ members: [] })).toThrow(GroupFormatError)
  })

  it('round-trips through serialization without losing unknown keys', () => {
    const obj = { id: 'x', name: 'G', members: ['A', 'B'], auto_mode_delay: 5, tag: 'keep' }
    const ir = parseGroupFile(obj)
    const out = serializeGroupFile(ir)
    expect(out['members']).toEqual(['A', 'B'])
    expect(out['auto_mode_delay']).toBe(5)
    expect(out['tag']).toBe('keep')
    expect(parseGroupFile(out)).toEqual(ir)
  })
})
