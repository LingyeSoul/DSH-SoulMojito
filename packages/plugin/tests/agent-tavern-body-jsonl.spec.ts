import { describe, expect, it } from 'vitest'
import {
  BodyJsonlProjectionError,
  applyCandidateToChat,
  applyEditToChat,
  applyFloorAdoptionToChat,
  applyRestoreToChat,
  applySelectToChat,
  findBodyFloorIndexByGroupId,
  findBodyFloorIndexByMessageId,
  locateBodyFloor,
  locateBodyFloorForRead,
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

/** ST greeting floor as `POST /chats` writes it: no AgentTavern identity. */
function makeImportedChat(mes: string, swipes: readonly string[], selectedIndex: number): ChatLogIR {
  const swipeInfo = swipes.map(() => ({ send_date: SEND_DATE, extra: {} }))
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
        swipe_id: selectedIndex,
        swipes: [...swipes],
        swipe_info: swipeInfo,
      },
    ],
  }
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

  it('fills missing swipe_info slots with a dated ST entry', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    const floor = floorOf(chat)
    floor.swipes = ['first body', 'second body', 'third body']
    floor.swipe_id = 0
    floor.swipe_info = []

    const next = applyCandidateToChat(
      chat,
      makeCandidate('group-1', 'message-4', 2, 'third body', SECOND_CANDIDATE_DATE),
    )

    expect(floorOf(next).swipe_info).toEqual([
      { send_date: SECOND_CANDIDATE_DATE, extra: {} },
      { send_date: SECOND_CANDIDATE_DATE, extra: {} },
      { send_date: SECOND_CANDIDATE_DATE, extra: {} },
    ])
  })

  it('rejects a candidate without a send date instead of writing an empty swipe_info entry', () => {
    expectErrorCode(
      () => applyCandidateToChat(
        makeAssistantChat('message-1', 'original body'),
        makeCandidate('group-1', 'message-1', 0, 'first body', undefined as unknown as string),
      ),
      'invalid-body-send-date',
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
  it('restores the selected slot and rewrites swipe_id/mes to match the anchor', () => {
    const chat = seedTwoCandidates()
    const snapshot = structuredClone(chat)
    const next = applyRestoreToChat(chat, {
      groupId: 'group-1',
      index: 0,
      messageId: 'message-1',
    })
    const floor = floorOf(next)

    expect(floor.swipes).toEqual(['first body', 'second body'])
    expect(floor.swipe_info).toEqual(floorOf(chat).swipe_info)
    expect(floor.swipe_id).toBe(0)
    expect(floor.mes).toBe('first body')
    expect(agentTavernOf(floor).anchorMessageId).toBe('message-1')
    expect(chat).toEqual(snapshot)
  })

  it('keeps the edit watermark while restoring the selection surface', () => {
    const chat = seedTwoCandidates()
    const floor = floorOf(chat)
    const extra = floor.extra ?? {}
    floor.extra = {
      ...extra,
      agentTavern: { ...agentTavernOf(floor), lastBodyEventSeq: 7, lastBodyMutation: 'edit' },
    }

    const next = applyRestoreToChat(chat, {
      groupId: 'group-1',
      index: 0,
      messageId: 'message-1',
    })

    expect(agentTavernOf(floorOf(next))).toMatchObject({
      anchorMessageId: 'message-1',
      lastBodyEventSeq: 7,
      lastBodyMutation: 'edit',
    })
    expect(floorOf(next).mes).toBe('first body')
  })

  it('rejects an out-of-range index without touching the chat', () => {
    const chat = seedTwoCandidates()
    const snapshot = structuredClone(chat)

    expectErrorCode(
      () => applyRestoreToChat(chat, {
        groupId: 'group-1',
        index: 4,
        messageId: 'message-1',
      }),
      'body-index-out-of-range',
    )
    expect(chat).toEqual(snapshot)
  })

  it('refuses a floor without swipes instead of keeping the failed text', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    const snapshot = structuredClone(chat)

    expectErrorCode(
      () => applyRestoreToChat(chat, {
        groupId: 'group-1',
        index: 0,
        messageId: 'message-1',
      }),
      'body-swipes-missing',
    )
    expect(chat).toEqual(snapshot)
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

  it('refuses a group that matches more than one floor and lists every index', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    chat.messages.push({
      name: 'ExampleCard',
      is_user: false,
      is_system: false,
      send_date: SEND_DATE,
      mes: 'duplicated body',
      extra: { agentTavern: { bodyGroupId: 'group-1' } },
    })
    const snapshot = structuredClone(chat)

    const error = captureError(() => findBodyFloorIndexByGroupId(chat, 'group-1'))
    expect(error.code).toBe('body-group-mismatch')
    expect(error.message).toContain("body group 'group-1'")
    expect(error.message).toContain('(1, 2)')

    expectErrorCode(() => locateBodyFloor(chat, 'group-1', undefined), 'body-group-mismatch')
    expectErrorCode(
      () => applySelectToChat(chat, { groupId: 'group-1', index: 0, anchorMessageId: 'message-1' }),
      'body-group-mismatch',
    )
    expectErrorCode(
      () => applyCandidateToChat(
        chat,
        makeCandidate('group-1', 'message-2', 1, 'second body', SECOND_CANDIDATE_DATE),
      ),
      'body-group-mismatch',
    )
    expectErrorCode(
      () => applyEditToChat(chat, { groupId: 'group-1', index: 0, text: 'edited body' }),
      'body-group-mismatch',
    )
    expectErrorCode(
      () => applyRestoreToChat(chat, { groupId: 'group-1', index: 0, messageId: 'message-1' }),
      'body-group-mismatch',
    )
    expect(chat).toEqual(snapshot)
  })

  it('refuses a duplicated body message id on the write path and bounds the listed indices', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    for (let stray = 0; stray < 3; stray += 1) {
      chat.messages.push({
        name: 'ExampleCard',
        is_user: false,
        is_system: false,
        send_date: SEND_DATE,
        mes: `stray body ${stray}`,
        extra: { agentTavern: { messageId: 'message-1', bodyGroupId: `stray-${stray}` } },
      })
    }
    const snapshot = structuredClone(chat)

    // The write path refuses a duplicated message id just like the read path;
    // the index list stays bounded so a damaged chat cannot amplify into
    // checkpoints, HTTP bodies and logs.
    const message = captureError(() => findBodyFloorIndexByMessageId(chat, 'message-1'))
    expect(message.code).toBe('body-group-mismatch')
    expect(message.message).toContain("body message 'message-1' matches 4 chat floors (1, 2, 3 and 1 more)")
    expect(message.message).not.toContain('(1, 2, 3, 4')
    expectErrorCode(() => locateBodyFloor(chat, 'missing-group', 'message-1'), 'body-group-mismatch')

    const grouped = bindBodyGroup(makeAssistantChat('message-1', 'original body'), 'group-1')
    for (let stray = 0; stray < 4; stray += 1) {
      grouped.messages.push({
        name: 'ExampleCard',
        is_user: false,
        is_system: false,
        send_date: SEND_DATE,
        mes: `stray body ${stray}`,
        extra: { agentTavern: { bodyGroupId: 'group-1' } },
      })
    }
    const group = captureError(() => findBodyFloorIndexByGroupId(grouped, 'group-1'))
    expect(group.message).toContain("body group 'group-1' matches 5 chat floors (1, 2, 3 and 2 more)")
    expect(chat).toEqual(snapshot)
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

describe('locateBodyFloorForRead', () => {
  it('returns the group-bound floor and nothing for a cold chat', () => {
    const chat = seedTwoCandidates()

    expect(locateBodyFloorForRead(chat, { messageId: 'message-1', groupId: 'group-1' })).toBe(1)
    expect(locateBodyFloorForRead(chat, { messageId: 'unprojected-body' })).toBeUndefined()
  })

  it('finds the floor of a selected candidate by its message id', () => {
    const chat = seedTwoCandidates()

    expect(locateBodyFloorForRead(chat, { messageId: 'message-2' })).toBe(1)
  })

  it('refuses a duplicated group binding instead of serving one floor', () => {
    const chat = seedTwoCandidates()
    chat.messages.push({
      name: 'ExampleCard',
      is_user: false,
      is_system: false,
      send_date: SEND_DATE,
      mes: 'duplicated body',
      swipe_id: 0,
      swipes: ['duplicated body'],
      extra: { agentTavern: { bodyGroupId: 'group-1', anchorMessageId: 'message-2' } },
    })
    const snapshot = structuredClone(chat)

    const error = captureError(() => locateBodyFloorForRead(chat, { messageId: 'message-1', groupId: 'group-1' }))
    expect(error.code).toBe('body-group-mismatch')
    expect(error.message).toContain('(1, 2)')

    expectErrorCode(() => locateBodyFloorForRead(chat, { messageId: 'message-2' }), 'body-group-mismatch')
    expect(chat).toEqual(snapshot)
  })

  it('refuses a message id that resolves to two floors of different groups', () => {
    const chat = bindBodyGroup(makeAssistantChat('message-1', 'first floor'), 'group-1')
    const duplicate = structuredClone(chat.messages[1]!)
    duplicate.extra = { agentTavern: { bodyGroupId: 'group-2', anchorMessageId: 'message-1' } }
    chat.messages.push(duplicate)

    expectErrorCode(() => locateBodyFloorForRead(chat, { messageId: 'message-1' }), 'body-group-mismatch')
  })
})

describe('applyFloorAdoptionToChat', () => {
  it('binds the mirror floor, snapshots its swipe surface and drops it', () => {
    const chat = makeImportedChat('Chosen greeting.', ['First greeting.', 'Chosen greeting.'], 1)
    const snapshot = structuredClone(chat)
    const next = applyFloorAdoptionToChat(chat, {
      groupId: 'group-1',
      sessionId: 'session-1',
      anchorMessageId: 'message-1',
      anchorText: 'Chosen greeting.',
    })
    const floor = floorOf(next)

    expect(floor.mes).toBe('Chosen greeting.')
    expect(floor.swipes).toBeUndefined()
    expect(floor.swipe_id).toBeUndefined()
    expect(floor.swipe_info).toBeUndefined()
    expect(agentTavernOf(floor)).toMatchObject({
      bodyGroupId: 'group-1',
      anchorMessageId: 'message-1',
      sessionId: 'session-1',
    })
    // The dropped ST surface stays recoverable.
    expect(agentTavernOf(floor).adoptedSwipes).toEqual({
      swipes: ['First greeting.', 'Chosen greeting.'],
      swipe_id: 1,
      swipe_info: [
        { send_date: SEND_DATE, extra: {} },
        { send_date: SEND_DATE, extra: {} },
      ],
    })
    expect(chat).toEqual(snapshot)
  })

  it('refuses a floor whose text is not the anchor mirror and keeps the chat untouched', () => {
    const chat = makeImportedChat('Another greeting.', ['Another greeting.'], 0)
    const snapshot = structuredClone(chat)
    const error = captureError(() => applyFloorAdoptionToChat(chat, {
      groupId: 'group-1',
      sessionId: 'session-1',
      anchorMessageId: 'message-1',
      anchorText: 'Chosen greeting.',
    }))

    expect(error.code).toBe('body-adoption-mismatch')
    expect(error.message).toContain("group 'group-1'")
    expect(error.message).toContain('chat floor 1')
    // The refusal stays metadata-only: the message reaches the projection
    // checkpoint, GET /projection and logs, which must not carry body text
    // (decision 2026-10-29, same round that dropped plan.bodyText).
    expect(error.message).toContain('floor length 17')
    expect(error.message).toContain('anchor length 16')
    expect(error.message).not.toContain('Another greeting.')
    expect(error.message).not.toContain('Chosen greeting.')
    expect(chat).toEqual(snapshot)
  })

  it('refuses a floor that already carries AgentTavern metadata', () => {
    const chat = makeImportedChat('Chosen greeting.', ['Chosen greeting.'], 0)
    floorOf(chat).extra = { agentTavern: { sessionId: 'other-session' } }

    const error = captureError(() => applyFloorAdoptionToChat(chat, {
      groupId: 'group-1',
      sessionId: 'session-1',
      anchorMessageId: 'message-1',
      anchorText: 'Chosen greeting.',
    }))

    expect(error.code).toBe('body-adoption-mismatch')
    expect(error.message).toContain('AgentTavern metadata')
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
