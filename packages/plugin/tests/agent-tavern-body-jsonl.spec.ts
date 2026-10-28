import { describe, expect, it } from 'vitest'
import {
  BodyJsonlProjectionError,
  applyCandidateToChat,
  applyEditToChat,
  applyRestoreToChat,
  applySelectToChat,
  findBodyFloorIndexByGroupId,
  findBodyFloorIndexByMessageId,
  locateBodyFloor,
  type BodyJsonlCandidateInput,
  type BodyJsonlErrorCode,
} from '../src/agent-tavern/body-jsonl.js'
import type { ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'

const SEND_DATE = '2026-10-28T00:00:00.000Z'
const FIRST_CANDIDATE_DATE = '2026-10-28T00:00:01.000Z'
const SECOND_CANDIDATE_DATE = '2026-10-28T00:00:02.000Z'

function makeAssistantChat(messageId: string, mes: string): ChatLogIR {
  return {
    header: { user_name: 'User', character_name: 'ExampleCard', chat_metadata: {} },
    messages: [
      {
        name: 'User',
        is_user: true,
        is_system: false,
        send_date: SEND_DATE,
        mes: 'Hello',
      },
      {
        name: 'ExampleCard',
        is_user: false,
        is_system: false,
        send_date: SEND_DATE,
        mes,
        extra: {
          agentTavern: {
            architecture: 'agent-tavern',
            contextMode: 'native',
            sessionId: 'session-1',
            eventSeq: 2,
            messageId,
          },
        },
      },
    ],
  }
}

function makeCandidate(
  groupId: string,
  messageId: string,
  index: number,
  text: string,
  sendDate: string,
): BodyJsonlCandidateInput {
  return { groupId, messageId, index, text, sendDate }
}

function withMetadata(input: BodyJsonlCandidateInput): BodyJsonlCandidateInput {
  return {
    ...input,
    provider: 'example-provider',
    model: 'example-model',
    reasoning: 'reason-1',
    usage: { total_tokens: 12 },
    feedback: 'more detail',
  }
}

function floorOf(chat: ChatLogIR): ChatMessage {
  const floor = chat.messages[1]
  if (floor === undefined) throw new Error('test fixture is missing the body floor')
  return floor
}

function agentTavernOf(message: ChatMessage): Record<string, unknown> {
  const extra = message.extra
  if (extra === undefined) throw new Error('test fixture is missing extra')
  const agentTavern = extra.agentTavern
  if (typeof agentTavern !== 'object' || agentTavern === null || Array.isArray(agentTavern)) {
    throw new Error('test fixture is missing agentTavern metadata')
  }
  return agentTavern as Record<string, unknown>
}

function bindBodyGroup(chat: ChatLogIR, groupId: string): ChatLogIR {
  const next = structuredClone(chat)
  const floor = floorOf(next)
  const extra = floor.extra === undefined ? {} : floor.extra
  const current = extra.agentTavern
  const agentTavern = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>), bodyGroupId: groupId }
    : { bodyGroupId: groupId }
  floor.extra = { ...extra, agentTavern }
  return next
}

function seedTwoCandidates(): ChatLogIR {
  const withOne = applyCandidateToChat(
    makeAssistantChat('message-1', 'original body'),
    makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE),
  )
  return applyCandidateToChat(
    withOne,
    makeCandidate('group-1', 'message-2', 1, 'second body', SECOND_CANDIDATE_DATE),
  )
}

function captureError(run: () => unknown): BodyJsonlProjectionError {
  try {
    run()
  } catch (error) {
    if (error instanceof BodyJsonlProjectionError) return error
    throw error
  }
  throw new Error('expected BodyJsonlProjectionError')
}

function expectErrorCode(run: () => unknown, code: BodyJsonlErrorCode): void {
  expect(captureError(run).code).toBe(code)
}

describe('applyCandidateToChat', () => {
  it('creates swipes and swipe_info for the first candidate', () => {
    const chat = makeAssistantChat('message-1', 'original body')
    const snapshot = structuredClone(chat)
    const next = applyCandidateToChat(
      chat,
      withMetadata(makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE)),
    )
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['first body'])
    expect(floor.swipe_id).toBe(0)
    expect(floor.mes).toBe('first body')
    expect(floor.swipe_info).toEqual([
      {
        send_date: FIRST_CANDIDATE_DATE,
        extra: {
          provider: 'example-provider',
          model: 'example-model',
          reasoning: 'reason-1',
          usage: { total_tokens: 12 },
          feedback: 'more detail',
        },
      },
    ])
    expect(agentTavernOf(floor)).toMatchObject({
      messageId: 'message-1',
      bodyGroupId: 'group-1',
      anchorMessageId: 'message-1',
    })
    expect(next).not.toBe(chat)
    expect(floor).not.toBe(chat.messages[1])
    expect(chat).toEqual(snapshot)
  })

  it('appends consecutive candidates and makes the last one selected', () => {
    const withOne = applyCandidateToChat(
      makeAssistantChat('message-1', 'original body'),
      withMetadata(makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE)),
    )
    const next = applyCandidateToChat(
      withOne,
      makeCandidate('group-1', 'message-2', 1, 'second body', SECOND_CANDIDATE_DATE),
    )
    const floor = floorOf(next)
    const info = floor.swipe_info

    expect(floor.swipes).toEqual(['first body', 'second body'])
    expect(info).toHaveLength(2)
    expect(info?.[0]).toMatchObject({
      send_date: FIRST_CANDIDATE_DATE,
      extra: { provider: 'example-provider', model: 'example-model' },
    })
    expect(info?.[1]).toEqual({ send_date: SECOND_CANDIDATE_DATE, extra: {} })
    expect(floor.swipe_id).toBe(1)
    expect(floor.mes).toBe('second body')
    expect(agentTavernOf(floor)).toMatchObject({
      bodyGroupId: 'group-1',
      anchorMessageId: 'message-2',
    })
  })

  it('re-projects an existing candidate slot without duplicating it', () => {
    const withOne = applyCandidateToChat(
      makeAssistantChat('message-1', 'original body'),
      makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE),
    )
    const next = applyCandidateToChat(
      withOne,
      makeCandidate('group-1', 'message-1', 0, 'replayed body', SECOND_CANDIDATE_DATE),
    )
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['replayed body'])
    expect(floor.swipe_info).toHaveLength(1)
    expect(floor.swipe_id).toBe(0)
    expect(floor.mes).toBe('replayed body')
  })

  it('rejects a candidate index that would skip a slot', () => {
    const withOne = applyCandidateToChat(
      makeAssistantChat('message-1', 'original body'),
      makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE),
    )

    expectErrorCode(
      () => applyCandidateToChat(
        withOne,
        makeCandidate('group-1', 'message-3', 3, 'third body', SECOND_CANDIDATE_DATE),
      ),
      'body-candidate-gap',
    )
  })

  it('throws when neither group nor message locates a floor', () => {
    expectErrorCode(
      () => applyCandidateToChat(
        makeAssistantChat('message-1', 'original body'),
        makeCandidate('group-x', 'message-x', 0, 'body', FIRST_CANDIDATE_DATE),
      ),
      'body-floor-not-found',
    )
  })
})

describe('applySelectToChat', () => {
  it('switches the selected slot without adding a candidate', () => {
    const chat = seedTwoCandidates()
    const snapshot = structuredClone(chat)
    const next = applySelectToChat(chat, {
      groupId: 'group-1',
      index: 0,
      anchorMessageId: 'message-1',
    })
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['first body', 'second body'])
    expect(floor.swipe_info).toHaveLength(2)
    expect(floor.swipe_id).toBe(0)
    expect(floor.mes).toBe('first body')
    expect(agentTavernOf(floor).anchorMessageId).toBe('message-1')
    expect(chat).toEqual(snapshot)
  })

  it('rejects an out-of-range index', () => {
    expectErrorCode(
      () => applySelectToChat(seedTwoCandidates(), {
        groupId: 'group-1',
        index: 2,
        anchorMessageId: 'message-2',
      }),
      'body-index-out-of-range',
    )
  })

  it('rejects a floor without swipes', () => {
    expectErrorCode(
      () => applySelectToChat(makeAssistantChat('message-1', 'original body'), {
        groupId: 'group-1',
        index: 0,
        anchorMessageId: 'message-1',
      }),
      'body-swipes-missing',
    )
  })

  it('rejects an unknown body group', () => {
    expectErrorCode(
      () => applySelectToChat(seedTwoCandidates(), {
        groupId: 'group-x',
        index: 0,
        anchorMessageId: 'message-x',
      }),
      'body-floor-not-found',
    )
  })
})

describe('applyEditToChat', () => {
  it('edits the selected slot and keeps swipe_info untouched', () => {
    const chat = seedTwoCandidates()
    const snapshot = structuredClone(chat)
    const next = applyEditToChat(chat, { groupId: 'group-1', index: 1, text: 'edited second body' })
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['first body', 'edited second body'])
    expect(floor.swipe_id).toBe(1)
    expect(floor.mes).toBe('edited second body')
    expect(floor.swipe_info).toEqual(floorOf(chat).swipe_info)
    expect(agentTavernOf(floor).anchorMessageId).toBe('message-2')
    expect(chat).toEqual(snapshot)
  })

  it('rejects editing a slot other than the selected one', () => {
    expectErrorCode(
      () => applyEditToChat(seedTwoCandidates(), { groupId: 'group-1', index: 0, text: 'wrong slot' }),
      'body-index-mismatch',
    )
  })

  it('rejects an out-of-range index', () => {
    expectErrorCode(
      () => applyEditToChat(seedTwoCandidates(), { groupId: 'group-1', index: 2, text: 'missing slot' }),
      'body-index-out-of-range',
    )
  })
})

describe('applyRestoreToChat', () => {
  it('only moves the anchor and does not add or select a candidate', () => {
    const chat = seedTwoCandidates()
    const snapshot = structuredClone(chat)
    const next = applyRestoreToChat(chat, {
      groupId: 'group-1',
      index: 0,
      messageId: 'message-1',
    })
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['first body', 'second body'])
    expect(floor.swipe_info).toHaveLength(2)
    expect(floor.swipe_id).toBe(1)
    expect(floor.mes).toBe('second body')
    expect(agentTavernOf(floor).anchorMessageId).toBe('message-1')
    expect(chat).toEqual(snapshot)
  })

  it('rejects an out-of-range index', () => {
    expectErrorCode(
      () => applyRestoreToChat(seedTwoCandidates(), {
        groupId: 'group-1',
        index: 4,
        messageId: 'message-1',
      }),
      'body-index-out-of-range',
    )
  })

  it('rejects an unknown body group', () => {
    expectErrorCode(
      () => applyRestoreToChat(seedTwoCandidates(), {
        groupId: 'group-x',
        index: 0,
        messageId: 'message-x',
      }),
      'body-floor-not-found',
    )
  })
})

describe('body floor locators', () => {
  it('locates the first floor by message id and later floors by body group id', () => {
    const chat = makeAssistantChat('message-1', 'original body')

    expect(findBodyFloorIndexByGroupId(chat, 'group-1')).toBeUndefined()
    expect(findBodyFloorIndexByMessageId(chat, 'message-1')).toBe(1)
    expect(locateBodyFloor(chat, 'group-1', 'message-1')).toBe(1)

    const withOne = applyCandidateToChat(
      chat,
      makeCandidate('group-1', 'message-1', 0, 'first body', FIRST_CANDIDATE_DATE),
    )
    expect(findBodyFloorIndexByGroupId(withOne, 'group-1')).toBe(1)
    expect(locateBodyFloor(withOne, 'group-1', 'message-2')).toBe(1)

    const next = applyCandidateToChat(
      withOne,
      makeCandidate('group-1', 'message-2', 1, 'second body', SECOND_CANDIDATE_DATE),
    )
    expect(findBodyFloorIndexByGroupId(next, 'group-1')).toBe(1)
    expect(floorOf(next).swipes).toEqual(['first body', 'second body'])
  })

  it('throws when a group cannot be located by id', () => {
    expectErrorCode(
      () => locateBodyFloor(makeAssistantChat('message-1', 'original body'), 'group-1', undefined),
      'body-floor-not-found',
    )
  })

  it('rejects projecting a second group onto an already bound floor', () => {
    const bound = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'other-group')
    expectErrorCode(
      () => applyCandidateToChat(
        bound,
        makeCandidate('group-1', 'message-1', 0, 'body', FIRST_CANDIDATE_DATE),
      ),
      'body-group-mismatch',
    )
  })
})

describe('swipe_info compatibility', () => {
  it('preserves unknown metadata across edit, select and candidate replay', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    const floor = floorOf(chat)
    floor.mes = 'original body'
    floor.swipes = ['original body', 'alternate body']
    floor.swipe_id = 0
    floor.swipe_info = [
      {
        send_date: FIRST_CANDIDATE_DATE,
        extra: { provider: 'legacy-provider', custom_flag: true },
        custom_top: { keep: true },
      },
      {
        send_date: SECOND_CANDIDATE_DATE,
        extra: { model: 'legacy-model' },
      },
    ]
    const originalInfo = structuredClone(floor.swipe_info)

    const edited = applyEditToChat(chat, { groupId: 'group-1', index: 0, text: 'edited body' })
    expect(floorOf(edited).swipe_info).toEqual(originalInfo)

    const selected = applySelectToChat(chat, {
      groupId: 'group-1',
      index: 1,
      anchorMessageId: 'message-2',
    })
    expect(floorOf(selected).swipe_info).toEqual(originalInfo)

    const replayed = applyCandidateToChat(
      chat,
      withMetadata(makeCandidate('group-1', 'message-2', 1, 'replayed alternate', SECOND_CANDIDATE_DATE)),
    )
    const replayedInfo = floorOf(replayed).swipe_info

    expect(replayedInfo).toHaveLength(2)
    expect(replayedInfo?.[0]).toEqual(originalInfo?.[0])
    expect(replayedInfo?.[1]).toMatchObject({
      send_date: SECOND_CANDIDATE_DATE,
      extra: {
        model: 'legacy-model',
        provider: 'example-provider',
        reasoning: 'reason-1',
        feedback: 'more detail',
      },
    })
    expect(replayedInfo?.[1]).not.toHaveProperty('custom_top')
    expect(floorOf(replayed).swipes).toEqual(['original body', 'replayed alternate'])
    expect(floorOf(replayed).mes).toBe('replayed alternate')
  })
})
