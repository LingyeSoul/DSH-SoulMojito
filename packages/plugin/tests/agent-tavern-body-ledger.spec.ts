import { describe, expect, it } from 'vitest'
import {
  BODY_EVENT_TYPE,
  BodyLedgerError,
  createBodyProjection,
  effectiveBodyText,
  foldBodyLedger,
  replaceMessageText,
  type BodyEventData,
  type BodyLedger,
  type BodyLogEvent,
  type BodyMessageLike,
  type BodySessionEvent,
  type BodySessionEventData,
} from '../src/agent-tavern/body.js'

const GROUP = 'group-1'
const PROVIDER = 'example-provider'
const MODEL = 'example-model'

function assistantMessage(id: string, text: string): BodyMessageLike {
  return {
    id,
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'reasoning for the example reply' },
      { type: 'text', text },
    ],
    source: { kind: 'model', provider: PROVIDER, model: MODEL },
  }
}

function assistantEvent(seq: number, message: BodyMessageLike): BodySessionEvent {
  return { seq, type: 'assistant/message', data: { message } }
}

function bodyLog(seq: number, data: BodyEventData): BodyLogEvent {
  return { seq, type: BODY_EVENT_TYPE, data }
}

function bodyEvent(seq: number, data: BodyEventData): BodySessionEvent {
  return bodyLog(seq, data)
}

function rawBodyEvent(seq: number, data: BodySessionEventData): BodySessionEvent {
  return { seq, type: BODY_EVENT_TYPE, data }
}

function textOf(message: BodyMessageLike): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * Two candidates: `message-1` ("First draft") and `message-2`
 * ("Second draft"). Sequence layout:
 *
 *   0 assistant message-1, 1 candidate 0, 2 select 0,
 *   3 assistant message-2, 4 candidate 1, 5 select 1
 */
function baseEvents(): BodySessionEvent[] {
  return [
    assistantEvent(0, assistantMessage('message-1', 'First draft')),
    bodyEvent(1, { op: 'candidate', groupId: GROUP, messageId: 'message-1', index: 0 }),
    bodyEvent(2, { op: 'select', groupId: GROUP, index: 0 }),
    assistantEvent(3, assistantMessage('message-2', 'Second draft')),
    bodyEvent(4, { op: 'candidate', groupId: GROUP, messageId: 'message-2', index: 1, feedback: 'more detail' }),
    bodyEvent(5, { op: 'select', groupId: GROUP, index: 1 }),
  ]
}

function ledgerAt(events: readonly BodySessionEvent[], seq: number): BodyLedger {
  const ledger = foldBodyLedger(events, GROUP, seq)
  if (ledger === undefined) throw new Error(`expected a body ledger at seq ${seq}`)
  return ledger
}

function captureLedgerError(run: () => unknown): BodyLedgerError {
  try {
    run()
  } catch (error) {
    if (error instanceof BodyLedgerError) return error
    throw error
  }
  throw new Error('expected BodyLedgerError')
}

describe('foldBodyLedger', () => {
  it('appends candidates in order and selects the newest candidate', () => {
    const events = baseEvents()
    const first = ledgerAt(events, 1)

    expect(first.groupId).toBe(GROUP)
    expect(first.candidates).toHaveLength(1)
    expect(first.candidates[0]).toEqual({ messageId: 'message-1', index: 0, text: 'First draft' })
    expect(first.selectedIndex).toBe(0)
    expect(first.anchorMessageId).toBe('message-1')
    expect(first.edits.size).toBe(0)

    const second = ledgerAt(events, 5)
    expect(second.candidates.map((candidate) => candidate.index)).toEqual([0, 1])
    expect(second.candidates.map((candidate) => candidate.messageId)).toEqual(['message-1', 'message-2'])
    expect(second.candidates.map((candidate) => candidate.text)).toEqual(['First draft', 'Second draft'])
    expect(second.candidates[1]?.feedback).toBe('more detail')
    expect(second.selectedIndex).toBe(1)
    expect(second.anchorMessageId).toBe('message-2')
    expect(effectiveBodyText(second)).toBe('Second draft')
  })

  it('selects an earlier candidate without moving the surface anchor', () => {
    const events = [...baseEvents(), bodyEvent(6, { op: 'select', groupId: GROUP, index: 0 })]
    const ledger = ledgerAt(events, 6)

    expect(ledger.selectedIndex).toBe(0)
    expect(ledger.anchorMessageId).toBe('message-2')
    expect(ledger.candidates).toHaveLength(2)
    expect(effectiveBodyText(ledger)).toBe('First draft')
  })

  it('applies edits by candidate index and keeps the latest edit', () => {
    const events = [
      ...baseEvents(),
      bodyEvent(6, { op: 'edit', groupId: GROUP, index: 1, text: 'Edited second', previousText: 'Second draft' }),
      bodyEvent(7, { op: 'edit', groupId: GROUP, index: 1, text: 'Latest second', previousText: 'Edited second' }),
    ]
    const ledger = ledgerAt(events, 7)

    expect(ledger.selectedIndex).toBe(1)
    expect(ledger.edits.size).toBe(1)
    expect(ledger.edits.get(1)).toBe('Latest second')
    expect(ledger.candidates[1]?.text).toBe('Second draft')
    expect(effectiveBodyText(ledger)).toBe('Latest second')
  })

  it('keeps the original candidate text when selecting away from an edit', () => {
    const events = [
      ...baseEvents(),
      bodyEvent(6, { op: 'edit', groupId: GROUP, index: 1, text: 'Edited second', previousText: 'Second draft' }),
      bodyEvent(7, { op: 'select', groupId: GROUP, index: 0 }),
    ]
    const ledger = ledgerAt(events, 7)

    expect(ledger.selectedIndex).toBe(0)
    expect(effectiveBodyText(ledger)).toBe('First draft')
    expect(ledger.edits.get(1)).toBe('Edited second')
  })

  it('restores the previous anchor without adding a candidate', () => {
    const events = [
      ...baseEvents(),
      bodyEvent(6, { op: 'restore', groupId: GROUP, messageId: 'message-restored', index: 0 }),
    ]
    const ledger = ledgerAt(events, 6)

    expect(ledger.candidates).toHaveLength(2)
    expect(ledger.candidates.map((candidate) => candidate.messageId)).toEqual(['message-1', 'message-2'])
    expect(ledger.selectedIndex).toBe(0)
    expect(ledger.anchorMessageId).toBe('message-restored')
    expect(effectiveBodyText(ledger)).toBe('First draft')
  })

  it('ignores op-start and op-finish events', () => {
    const events: BodySessionEvent[] = [
      assistantEvent(0, assistantMessage('message-1', 'First draft')),
      bodyEvent(1, {
        op: 'op-start',
        opId: 'op-1',
        groupId: GROUP,
        kind: 'regenerate',
        previousAnchorId: 'message-1',
        previousIndex: 0,
      }),
      bodyEvent(2, { op: 'candidate', groupId: GROUP, messageId: 'message-1', index: 0 }),
      bodyEvent(3, { op: 'select', groupId: GROUP, index: 0 }),
      bodyEvent(4, { op: 'op-finish', opId: 'op-1', result: 'ok', anchorId: 'message-1' }),
    ]

    const ledger = ledgerAt(events, 4)
    expect(ledger.candidates).toHaveLength(1)
    expect(ledger.selectedIndex).toBe(0)
    expect(ledger.anchorMessageId).toBe('message-1')
    expect(ledger.edits.size).toBe(0)

    const withoutCandidates = foldBodyLedger([events[1]!, events[4]!], GROUP, 4)
    expect(withoutCandidates).toBeUndefined()
  })

  it('returns undefined for empty logs, missing groups, and watermarks before the first candidate', () => {
    expect(foldBodyLedger([], GROUP, 10)).toBeUndefined()
    expect(foldBodyLedger(baseEvents(), 'group-missing', 10)).toBeUndefined()
    expect(foldBodyLedger(baseEvents(), GROUP, 0)).toBeUndefined()
  })

  it('orders out-of-order events by seq', () => {
    const events = baseEvents()
    const shuffled = [events[5]!, events[2]!, events[4]!, events[0]!, events[3]!, events[1]!]
    const ledger = ledgerAt(shuffled, 5)

    expect(ledger.candidates.map((candidate) => candidate.messageId)).toEqual(['message-1', 'message-2'])
    expect(ledger.selectedIndex).toBe(1)
    expect(effectiveBodyText(ledger)).toBe('Second draft')
  })

  it('does not mutate the input events or share the returned ledger', () => {
    const events = baseEvents()
    const snapshot = structuredClone(events)
    const first = ledgerAt(events, 5)
    const second = ledgerAt(events, 5)

    expect(events).toEqual(snapshot)
    expect(first).not.toBe(second)
    expect(first.candidates).not.toBe(second.candidates)
    expect(first.edits).not.toBe(second.edits)
  })

  it('throws typed errors for invalid indices and candidate ordering', () => {
    const selectOutOfRange = captureLedgerError(() =>
      ledgerAt([...baseEvents(), bodyEvent(6, { op: 'select', groupId: GROUP, index: 2 })], 6))
    expect(selectOutOfRange.code).toBe('invalid-body-index')

    const editOutOfRange = captureLedgerError(() =>
      ledgerAt([...baseEvents(), bodyEvent(6, { op: 'edit', groupId: GROUP, index: 2, text: 'x', previousText: 'y' })], 6))
    expect(editOutOfRange.code).toBe('invalid-body-index')

    const restoreOutOfRange = captureLedgerError(() =>
      ledgerAt([...baseEvents(), bodyEvent(6, { op: 'restore', groupId: GROUP, messageId: 'message-3', index: 2 })], 6))
    expect(restoreOutOfRange.code).toBe('invalid-body-index')

    const negativeIndex = captureLedgerError(() =>
      foldBodyLedger([bodyEvent(1, { op: 'select', groupId: GROUP, index: -1 })], GROUP, 1))
    expect(negativeIndex.code).toBe('invalid-body-index')

    const gap = captureLedgerError(() => foldBodyLedger([
      assistantEvent(0, assistantMessage('message-1', 'First draft')),
      bodyEvent(1, { op: 'candidate', groupId: GROUP, messageId: 'message-1', index: 1 }),
    ], GROUP, 1))
    expect(gap.code).toBe('body-candidate-gap')
  })

  it('throws typed errors for malformed body events', () => {
    const unknownOp = captureLedgerError(() =>
      foldBodyLedger([rawBodyEvent(1, { op: 'explode' })], GROUP, 1))
    expect(unknownOp.code).toBe('invalid-body-op')

    const missingMessage = captureLedgerError(() =>
      foldBodyLedger([
        bodyEvent(1, { op: 'candidate', groupId: GROUP, messageId: 'message-missing', index: 0 }),
      ], GROUP, 1))
    expect(missingMessage.code).toBe('body-candidate-message-missing')

    const noPayload = captureLedgerError(() =>
      foldBodyLedger([{ seq: 1, type: BODY_EVENT_TYPE, data: undefined }], GROUP, 1))
    expect(noPayload.code).toBe('invalid-body-event')

    const badWatermark = captureLedgerError(() => foldBodyLedger(baseEvents(), GROUP, Number.NaN))
    expect(badWatermark.code).toBe('invalid-body-seq')

    const duplicateSeq = captureLedgerError(() => foldBodyLedger([
      assistantEvent(0, assistantMessage('message-1', 'First draft')),
      assistantEvent(0, assistantMessage('message-2', 'Second draft')),
    ], GROUP, 0))
    expect(duplicateSeq.code).toBe('invalid-body-seq')
  })
})

describe('effectiveBodyText', () => {
  it('returns undefined when the ledger has no candidate', () => {
    const ledger: BodyLedger = {
      groupId: GROUP,
      candidates: [],
      selectedIndex: 0,
      anchorMessageId: 'message-1',
      edits: new Map<number, string>(),
    }

    expect(effectiveBodyText(ledger)).toBeUndefined()
  })

  it('returns undefined when the selected index is outside the candidate list', () => {
    const ledger: BodyLedger = {
      groupId: GROUP,
      candidates: [{ messageId: 'message-1', index: 0, text: 'First draft' }],
      selectedIndex: 4,
      anchorMessageId: 'message-1',
      edits: new Map<number, string>(),
    }

    expect(effectiveBodyText(ledger)).toBeUndefined()
  })
})

describe('replaceMessageText', () => {
  it('collapses text blocks while preserving identity, source and non-text blocks', () => {
    const message: BodyMessageLike = {
      id: 'message-1',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'reasoning' },
        { type: 'text', text: 'old one' },
        { type: 'image', attachment: { id: 'attachment-1' } },
        { type: 'text', text: 'old two' },
      ],
      source: { kind: 'model', provider: PROVIDER, model: MODEL },
    }
    const snapshot = structuredClone(message)

    const next = replaceMessageText(message, 'new body')

    expect(next).not.toBe(message)
    expect(next.content).not.toBe(message.content)
    expect(next.id).toBe('message-1')
    expect(next.role).toBe('assistant')
    expect(next.source).toEqual({ kind: 'model', provider: PROVIDER, model: MODEL })
    expect(next.content).toEqual([
      { type: 'reasoning', text: 'reasoning' },
      { type: 'text', text: 'new body' },
      { type: 'image', attachment: { id: 'attachment-1' } },
    ])
    expect(message).toEqual(snapshot)
  })

  it('appends a text block when the message has none', () => {
    const message: BodyMessageLike = {
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'reasoning' }],
    }

    expect(replaceMessageText(message, 'new body').content).toEqual([
      { type: 'reasoning', text: 'reasoning' },
      { type: 'text', text: 'new body' },
    ])
    expect(message.content).toEqual([{ type: 'reasoning', text: 'reasoning' }])
  })
})

describe('createBodyProjection', () => {
  const projection = createBodyProjection()

  it('uses the body event type and updates only the surface anchor on select', () => {
    const events = [...baseEvents(), bodyEvent(6, { op: 'select', groupId: GROUP, index: 0 })]
    const event = events[6] as BodyLogEvent
    const result = projection.project(event, { events })

    expect(projection.type).toBe(BODY_EVENT_TYPE)
    expect(result.size).toBe(1)
    expect([...result.keys()]).toEqual([3])
    expect(result.has(0)).toBe(false)

    const message = result.get(3)
    expect(message).toBeDefined()
    if (message === undefined) throw new Error('expected the projected anchor')
    expect(message.id).toBe('message-2')
    expect(message.role).toBe('assistant')
    expect(message.source).toEqual({ kind: 'model', provider: PROVIDER, model: MODEL })
    expect(textOf(message)).toBe('First draft')
    expect(message.content[0]).toEqual({ type: 'reasoning', text: 'reasoning for the example reply' })
  })

  it('projects the latest edit for the selected candidate', () => {
    const events = [...baseEvents(), bodyEvent(6, {
      op: 'edit',
      groupId: GROUP,
      index: 1,
      text: 'Edited second',
      previousText: 'Second draft',
    })]
    const result = projection.project(events[6] as BodyLogEvent, { events })

    expect([...result.keys()]).toEqual([3])
    const message = result.get(3)
    if (message === undefined) throw new Error('expected the projected anchor')
    expect(textOf(message)).toBe('Edited second')
    expect(message.id).toBe('message-2')
  })

  it('returns an empty map for non select/edit events', () => {
    const events = baseEvents()
    const nonProjected: BodyLogEvent[] = [
      events[4] as BodyLogEvent,
      bodyLog(6, {
        op: 'op-start',
        opId: 'op-1',
        groupId: GROUP,
        kind: 'regenerate',
        previousAnchorId: 'message-2',
        previousIndex: 1,
      }),
      bodyLog(7, { op: 'op-finish', opId: 'op-1', result: 'ok', anchorId: 'message-2' }),
      bodyLog(8, { op: 'restore', groupId: GROUP, messageId: 'message-2', index: 1 }),
    ]

    for (const event of nonProjected) {
      expect(projection.project(event, { events }).size).toBe(0)
    }
  })

  it('returns an empty map when the group has no ledger', () => {
    const event = bodyLog(6, { op: 'select', groupId: 'group-missing', index: 0 })
    const result = projection.project(event, { events: baseEvents() })

    expect(result.size).toBe(0)
  })

  it('returns an empty map when the ledger anchor is absent from the events', () => {
    const events = [
      ...baseEvents(),
      bodyEvent(6, { op: 'restore', groupId: GROUP, messageId: 'message-missing', index: 0 }),
      bodyEvent(7, { op: 'select', groupId: GROUP, index: 0 }),
    ]
    const result = projection.project(events[7] as BodyLogEvent, { events })

    expect(result.size).toBe(0)
  })
})
