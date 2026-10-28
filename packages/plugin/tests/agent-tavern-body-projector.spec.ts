import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSessionEventData } from '../../bind/src/index.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'
import type { ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import { BODY_EVENT_TYPE } from '../src/agent-tavern/body.js'
import { AgentTavernProjector, type NativeSession, type NativeSessionEvent } from '../src/agent-tavern/projector.js'

const CHARACTER = 'Body Projector Character'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const cardData = (extensions: Record<string, unknown> = {}) => ({
  name: CHARACTER, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
  character_version: '', extensions,
})

async function fixture(sessionId = 'body-projector-session') {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData() })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'Alice', character_name: CHARACTER, chat_metadata: {},
  })
  await store.updateState(() => ({
    sessionBindings: {
      [sessionId]: {
        architecture: 'agent-tavern', contextMode: 'dsh-native',
        character: CHARACTER, chatId,
      },
    },
  }))
  return { root, store, chatId, sessionId }
}

type TestSession = NativeSession & { events: NativeSessionEvent[] }

function makeSession(id: string): TestSession {
  return { id, events: [] }
}

function nativeEvent(type: string, seq: number, time: number, data: HostSessionEventData): NativeSessionEvent {
  return { type, seq, time, data }
}

function turnStart(seq: number, turn: number): NativeSessionEvent {
  return nativeEvent('turn/start', seq, 1000 + seq, { turn })
}

function turnEnd(seq: number, turn: number): NativeSessionEvent {
  return nativeEvent('turn/end', seq, 1000 + seq, { turn, reason: { kind: 'completed' } })
}

function stepStart(seq: number, turn: number, step: number): NativeSessionEvent {
  return nativeEvent('step/start', seq, 1000 + seq, { turn, step })
}

function stepEnd(seq: number, turn: number, step: number): NativeSessionEvent {
  return nativeEvent('step/end', seq, 1000 + seq, { turn, step })
}

function userEvent(seq: number, id: string, text: string, form: string | undefined): NativeSessionEvent {
  return nativeEvent('user/message', seq, 1000 + seq, {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: form === undefined ? { kind: 'user' } : { kind: 'plugin:dsh-soulmojito', form },
  })
}

function assistantEvent(
  seq: number,
  id: string,
  text: string,
  turn: number,
  time: number,
  usage: Record<string, number> | undefined,
): NativeSessionEvent {
  return nativeEvent('assistant/message', seq, time, {
    turn,
    step: 1,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
    ...(usage === undefined ? {} : { usage }),
  })
}

function bodyEvent(seq: number, data: Record<string, unknown>): NativeSessionEvent {
  return nativeEvent(BODY_EVENT_TYPE, seq, 1000 + seq, data)
}

function seedBaseline(session: TestSession): void {
  session.events.push(
    turnStart(0, 1),
    userEvent(1, 'user-1', 'Open the door.', undefined),
    assistantEvent(2, 'group-1', 'Original body.', 1, 1200, undefined),
    turnEnd(3, 1),
  )
}

function seedRegenerateTurn(
  session: TestSession,
  turn: number,
  candidateId: string,
  text: string,
  time: number,
  usage: Record<string, number> | undefined,
): void {
  session.events.push(
    turnStart(6, turn),
    userEvent(7, 'body-trigger-op-1', 'Regenerate the last reply.', 'body-regenerate'),
    stepStart(8, turn, 1),
    assistantEvent(9, candidateId, text, turn, time, usage),
    stepEnd(10, turn, 1),
    turnEnd(11, turn),
  )
}

function seedCandidateZero(session: TestSession): void {
  session.events.push(
    bodyEvent(4, {
      op: 'op-start', opId: 'op-1', groupId: 'group-1', kind: 'regenerate',
      previousAnchorId: 'group-1', previousIndex: 0,
    }),
    bodyEvent(5, { op: 'candidate', groupId: 'group-1', messageId: 'group-1', index: 0 }),
  )
}

async function snapshotOf(store: TavernStore, chatId: string): Promise<ChatLogIR> {
  const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  return snapshot.chat
}

function floorOf(chat: ChatLogIR): ChatMessage {
  const floor = chat.messages[1]
  if (floor === undefined) throw new Error('fixture chat has no body floor')
  return floor
}

function agentTavernOf(message: ChatMessage): Record<string, unknown> {
  const extra = message.extra
  const agentTavern = extra === undefined ? undefined : extra.agentTavern
  if (typeof agentTavern !== 'object' || agentTavern === null || Array.isArray(agentTavern)) {
    throw new Error('fixture message has no agentTavern metadata')
  }
  return agentTavern as Record<string, unknown>
}

describe('AgentTavern body JSONL projector', () => {
  it('advances the checkpoint over op body records without touching JSONL', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)
    const before = await snapshotOf(store, chatId)

    session.events.push(
      bodyEvent(4, {
        op: 'op-start', opId: 'op-1', groupId: 'group-1', kind: 'regenerate',
        previousAnchorId: 'group-1', previousIndex: 0,
      }),
      bodyEvent(5, { op: 'op-finish', opId: 'op-1', result: 'failed', reason: 'test failure' }),
    )
    await projector.replay(session)

    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 5 })
  })

  it('merges a regenerated candidate into the same floor and skips its trigger turn', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData({
        regex_scripts: [
          { scriptName: 'Save Door', findRegex: 'door', replaceString: 'gate', placement: [2] },
          { scriptName: 'Display Only', findRegex: 'opens', replaceString: 'unlocks', placement: [2], markdownOnly: true },
          { scriptName: 'Prompt Only', findRegex: 'The door', replaceString: 'A door', placement: [2], promptOnly: true },
        ],
      }),
    })
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    seedCandidateZero(session)
    seedRegenerateTurn(session, 2, 'candidate-1', 'The door opens.', 2100, { input_tokens: 5, output_tokens: 7 })
    session.events.push(
      bodyEvent(12, {
        op: 'candidate', groupId: 'group-1', messageId: 'candidate-1', index: 1, feedback: 'warmer',
      }),
      bodyEvent(13, { op: 'select', groupId: 'group-1', index: 1 }),
      bodyEvent(14, { op: 'op-finish', opId: 'op-1', result: 'ok', anchorId: 'candidate-1' }),
    )
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The gate opens.'])
    const floor = floorOf(chat)
    expect(floor.swipes).toEqual(['Original body.', 'The gate opens.'])
    expect(floor.swipe_id).toBe(1)
    expect(floor.swipe_info).toHaveLength(2)
    expect(floor.swipe_info?.[0]).toMatchObject({ send_date: new Date(1200).toISOString() })
    expect(floor.swipe_info?.[1]).toMatchObject({
      send_date: new Date(2100).toISOString(),
      extra: {
        provider: 'test-provider',
        model: 'test-model',
        usage: { input_tokens: 5, output_tokens: 7 },
        feedback: 'warmer',
      },
    })
    expect(agentTavernOf(floor)).toMatchObject({ bodyGroupId: 'group-1', anchorMessageId: 'candidate-1' })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 14 })
  })

  it('does not append a floor for the assistant of a body-regenerate turn', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    session.events.push(
      turnStart(4, 2),
      userEvent(5, 'body-trigger-op-1', 'Regenerate the last reply.', 'body-regenerate'),
      stepStart(6, 2, 1),
      assistantEvent(7, 'candidate-1', 'Fresh body.', 2, 2100, undefined),
      stepEnd(8, 2, 1),
      turnEnd(9, 2),
    )
    await projector.replay(session)

    expect((await snapshotOf(store, chatId)).messages.map((message) => message.mes)).toEqual([
      'Open the door.', 'Original body.',
    ])
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 9 })
  })

  it('updates the selected candidate on select and edit without adding floors', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    seedCandidateZero(session)
    seedRegenerateTurn(session, 2, 'candidate-1', 'Fresh body.', 2100, undefined)
    session.events.push(
      bodyEvent(12, { op: 'candidate', groupId: 'group-1', messageId: 'candidate-1', index: 1 }),
      bodyEvent(13, { op: 'select', groupId: 'group-1', index: 1 }),
      bodyEvent(14, { op: 'select', groupId: 'group-1', index: 0 }),
      bodyEvent(15, {
        op: 'edit', groupId: 'group-1', index: 0, text: 'Edited body.', previousText: 'Original body.',
      }),
    )
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages).toHaveLength(2)
    const floor = floorOf(chat)
    expect(floor.swipe_id).toBe(0)
    expect(floor.mes).toBe('Edited body.')
    expect(floor.swipes).toEqual(['Edited body.', 'Fresh body.'])
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 15 })
  })

  it('merges a restored body copy into the anchor floor without adding a floor', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    seedCandidateZero(session)
    session.events.push(
      turnStart(6, 2),
      userEvent(7, 'body-trigger-op-1', 'Regenerate the last reply.', 'body-regenerate'),
      stepStart(8, 2, 1),
      stepEnd(9, 2, 1),
      turnEnd(10, 2),
      turnStart(11, 3),
      stepStart(12, 3, 1),
      assistantEvent(13, 'restored-1', 'Original body.', 3, 3000, undefined),
      bodyEvent(14, { op: 'restore', groupId: 'group-1', messageId: 'restored-1', index: 0 }),
      stepEnd(15, 3, 1),
      turnEnd(16, 3),
    )
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'Original body.'])
    const floor = floorOf(chat)
    expect(floor.swipes).toEqual(['Original body.'])
    expect(floor.swipe_id).toBe(0)
    expect(agentTavernOf(floor)).toMatchObject({ bodyGroupId: 'group-1', anchorMessageId: 'restored-1' })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 16 })
  })

  it('retries a CAS conflict and replays body projections idempotently', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const seedProjector = await AgentTavernProjector.open(root, store)
    await seedProjector.replay(session)

    session.events.push(
      bodyEvent(4, { op: 'candidate', groupId: 'group-1', messageId: 'group-1', index: 0 }),
    )
    let conflicts = 0
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        if (conflicts === 0) {
          conflicts += 1
          throw new ChatRevisionConflictError(revision ?? '', 'changed')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    await projector.project(session, session.events[4]!)

    expect(conflicts).toBe(1)
    const projected = await snapshotOf(store, chatId)
    expect(floorOf(projected).swipes).toEqual(['Original body.'])

    const freshRoot = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-'))
    roots.push(freshRoot)
    const fresh = await AgentTavernProjector.open(freshRoot, store)
    await fresh.replay(session)
    expect(await snapshotOf(store, chatId)).toEqual(projected)
    await fresh.replay(session)
    expect(await snapshotOf(store, chatId)).toEqual(projected)
  })

  it('fails explicitly when the candidate assistant message is missing', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)
    const missing = bodyEvent(4, { op: 'candidate', groupId: 'group-1', messageId: 'ghost', index: 0 })
    session.events.push(missing)

    await expect(projector.project(session, missing)).rejects.toMatchObject({
      name: 'BodyLedgerError',
      code: 'body-candidate-message-missing',
    })
    expect(await projector.status(sessionId)).toMatchObject({
      status: 'pending', lastCursor: 3, pendingCursor: 4,
    })
    expect((await snapshotOf(store, chatId)).messages).toHaveLength(2)
  })

  it('fails explicitly on a candidate index gap', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)
    const gap = bodyEvent(4, { op: 'candidate', groupId: 'group-1', messageId: 'group-1', index: 1 })
    session.events.push(gap)

    await expect(projector.project(session, gap)).rejects.toMatchObject({
      name: 'BodyLedgerError',
      code: 'body-candidate-gap',
    })
    expect(await projector.status(sessionId)).toMatchObject({
      status: 'pending', lastCursor: 3, pendingCursor: 4,
    })
    expect(floorOf(await snapshotOf(store, chatId)).swipes).toBeUndefined()
  })
})
