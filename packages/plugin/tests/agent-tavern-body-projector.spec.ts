import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSessionEventData } from '../../bind/src/index.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'
import type { ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import { BODY_EVENT_TYPE } from '../src/agent-tavern/body.js'
import { AgentTavernProjector, type NativeSession, type NativeSessionEvent } from '../src/agent-tavern/projector.js'
import { readMvuReceipts } from '../src/mvu.js'

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

/** Fixture whose card is marked as JSR MVU and whose chat starts with variables. */
async function mvuFixture(sessionId: string, variables: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-mvu-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: cardData({
      // MagVarUpdate marker only; no card script is ever executed.
      tavern_helper: { scripts: [{ type: 'script', content: "import 'https://example.invalid/MagVarUpdate/bundle.js'" }] },
    }),
  })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'Alice', character_name: CHARACTER, chat_metadata: { variables },
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

/** ST greeting floor exactly as `POST /chats` writes it (no agentTavern identity). */
function stGreetingFloor(greetings: readonly string[], selectedIndex: number): ChatMessage {
  const sendDate = new Date(1700000000000).toISOString()
  return {
    name: CHARACTER,
    is_user: false,
    is_system: false,
    send_date: sendDate,
    mes: greetings[selectedIndex]!,
    swipe_id: selectedIndex,
    swipes: [...greetings],
    swipe_info: greetings.map(() => ({ send_date: sendDate })),
  }
}

/** Fixture whose chat opens with the ST greeting floor `POST /chats` writes. */
async function importedFixture(sessionId: string, greetings: readonly string[], selectedIndex: number) {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-imported-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData() })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'Alice', character_name: CHARACTER, chat_metadata: {},
  }, [stGreetingFloor(greetings, selectedIndex)])
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

/** MVU fixture whose chat opens with the ST greeting floor `POST /chats` writes. */
async function importedMvuFixture(sessionId: string, variables: Record<string, unknown>, greeting: string) {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-mvu-imported-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: cardData({
      tavern_helper: { scripts: [{ type: 'script', content: "import 'https://example.invalid/MagVarUpdate/bundle.js'" }] },
    }),
  })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'Alice', character_name: CHARACTER, chat_metadata: { variables },
  }, [stGreetingFloor([greeting], 0)])
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

/** Assistant message with the synthetic mirror source the history import writes. */
function importedAssistantEvent(
  seq: number,
  id: string,
  text: string,
  turn: number,
  time: number,
): NativeSessionEvent {
  return nativeEvent('assistant/message', seq, time, {
    turn,
    step: 1,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'dsh-soulmojito', model: 'agent-tavern-import' },
    },
  })
}

/** One closed import turn carrying the mirror opening message. */
function seedImportedTurn(session: TestSession, anchorId: string, text: string): void {
  session.events.push(
    turnStart(0, 1),
    stepStart(1, 1, 1),
    importedAssistantEvent(2, anchorId, text, 1, 1200),
    stepEnd(3, 1, 1),
    turnEnd(4, 1),
  )
}

function updateCandidateText(patch: string): string {
  return `Fresh narrative.\n<UpdateVariable>\n<JSONPatch>\n${patch}\n</JSONPatch>\n</UpdateVariable>`
}

function editedCandidateText(patch: string): string {
  return `Edited narrative.\n<UpdateVariable>\n<JSONPatch>\n${patch}\n</JSONPatch>\n</UpdateVariable>`
}

/** Baseline turn, seeded candidate 0, then a regenerate turn and candidate 1. */
function seedMvuCandidateSession(session: TestSession, candidateText: string): void {
  seedBaseline(session)
  seedCandidateZero(session)
  seedRegenerateTurn(session, 2, 'candidate-1', candidateText, 2100, undefined)
  session.events.push(
    bodyEvent(12, { op: 'candidate', groupId: 'group-1', messageId: 'candidate-1', index: 1 }),
    bodyEvent(13, { op: 'select', groupId: 'group-1', index: 1 }),
  )
}

function statDataOf(message: ChatMessage): unknown {
  const variables = message.variables
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return undefined
  return (variables as Record<string, unknown>)['stat_data']
}

async function snapshotOf(store: TavernStore, chatId: string): Promise<ChatLogIR> {
  const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  return snapshot.chat
}

async function captureRejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error('expected the projection to reject')
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

  it('adopts an imported anchor floor and projects candidate 0 into it', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-imported',
      ['First greeting.', 'Second greeting.', 'Chosen greeting.'],
      2,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', 'Chosen greeting.')
    session.events.push(bodyEvent(5, {
      op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0,
    }))
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages).toHaveLength(1)
    const floor = chat.messages[0]!
    expect(floor.mes).toBe('Chosen greeting.')
    expect(floor.swipes).toEqual(['Chosen greeting.'])
    expect(floor.swipe_id).toBe(0)
    expect(floor.swipe_info).toHaveLength(1)
    // Adopted floors stay outside the display override (decision 2026-10-20):
    // the group binding is written, the projected message id is not.
    expect(agentTavernOf(floor)).toMatchObject({
      bodyGroupId: 'import-anchor',
      anchorMessageId: 'import-anchor',
      sessionId,
    })
    expect(agentTavernOf(floor).messageId).toBeUndefined()
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 5 })

    const replayRoot = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-'))
    roots.push(replayRoot)
    const fresh = await AgentTavernProjector.open(replayRoot, store)
    await fresh.replay(session)
    expect(await snapshotOf(store, chatId)).toEqual(chat)
  })

  it('edits an adopted imported floor once the candidate is projected', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-imported-edit',
      ['Only greeting.', 'Chosen greeting.'],
      1,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', 'Chosen greeting.')
    session.events.push(
      bodyEvent(5, { op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0 }),
      bodyEvent(6, {
        op: 'edit', groupId: 'import-anchor', index: 0, text: 'Edited greeting.', previousText: 'Chosen greeting.',
      }),
    )
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    const floor = chat.messages[0]!
    expect(floor.mes).toBe('Edited greeting.')
    expect(floor.swipes).toEqual(['Edited greeting.'])
    expect(floor.swipe_id).toBe(0)
    expect(agentTavernOf(floor)).toMatchObject({ lastBodyEventSeq: 6, lastBodyMutation: 'edit' })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 6 })
  })

  it('applies an adopted imported MVU greeting and records one body receipt', async () => {
    const text = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const { root, store, chatId, sessionId } = await importedMvuFixture(
      'body-projector-mvu-imported',
      { initialized_lorebooks: true, stat_data: { mvu: { favor: 10 } } },
      text,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', text)
    session.events.push(bodyEvent(5, {
      op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0,
    }))
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 15 } } })
    expect(readMvuReceipts(chat).filter((receipt) => receipt.turnKey === 'body:import-anchor')).toHaveLength(1)
    const floor = chat.messages[0]!
    expect(floor.mes).toBe(text)
    expect(floor.swipes).toEqual([text])
    expect(statDataOf(floor)).toEqual({ mvu: { favor: 15 } })
  })

  it('keeps imported floors read-only to adoption for a non-mirror anchor', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-not-mirror',
      ['Greeting.'],
      0,
    )
    const session = makeSession(sessionId)
    session.events.push(
      turnStart(0, 1),
      stepStart(1, 1, 1),
      assistantEvent(2, 'live-anchor', 'Live body.', 1, 1200, undefined),
      stepEnd(3, 1, 1),
      turnEnd(4, 1),
      bodyEvent(5, { op: 'candidate', groupId: 'live-anchor', messageId: 'live-anchor', index: 0 }),
    )
    const projector = await AgentTavernProjector.open(root, store)
    const before = await snapshotOf(store, chatId)

    await expect(projector.project(session, session.events[5]!)).rejects.toMatchObject({
      name: 'BodyJsonlProjectionError',
      code: 'body-floor-not-found',
    })
    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 5 })
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

  it('refuses a restore whose body copy is not an assistant message', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-restore-pre-state')
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    seedCandidateZero(session)
    const forged = bodyEvent(6, { op: 'restore', groupId: 'group-1', messageId: 'ghost-restore', index: 0 })
    session.events.push(forged)
    const before = await snapshotOf(store, chatId)

    const error = await captureRejection(projector.project(session, forged))

    // The fold applies the restore to its own anchor without ever resolving the
    // message, so only the pre-event log can refuse a phantom restored copy.
    expect(error).toMatchObject({ name: 'BodyLedgerError', code: 'invalid-body-event' })
    expect((error as Error).message).toContain("restore for group 'group-1'")
    expect((error as Error).message).toContain("names 'ghost-restore' at index 0")
    expect((error as Error).message).toContain('seq 6')
    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 6 })
  })

  it('refuses a select whose pre-event anchor has no assistant message', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-select-pre-state')
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    seedCandidateZero(session)
    // A restore record can rebind the anchor to an id the log never carried; a
    // select that starts from that anchor no longer describes a real floor.
    session.events.push(
      bodyEvent(6, { op: 'restore', groupId: 'group-1', messageId: 'ghost-restore', index: 0 }),
      bodyEvent(7, { op: 'select', groupId: 'group-1', index: 0 }),
    )
    const before = await snapshotOf(store, chatId)

    const error = await captureRejection(projector.project(session, session.events[7]!))

    expect(error).toMatchObject({ name: 'BodyLedgerError', code: 'invalid-body-event' })
    expect((error as Error).message).toContain("select for group 'group-1' cannot be explained")
    expect((error as Error).message).toContain("anchor 'ghost-restore'")
    expect((error as Error).message).toContain('seq 7')
    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 7 })
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

  it('applies a candidate <UpdateVariable> and records one body receipt', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-receipt', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const text = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, text)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 15 } } })
    const receipts = readMvuReceipts(chat).filter((receipt) => receipt.turnKey === 'body:candidate-1')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ status: 'updated', failures: [] })
    const floor = floorOf(chat)
    expect(floor.mes).toBe(text)
    expect(floor.swipes?.[1]).toBe(text)
    expect(statDataOf(floor)).toEqual({ mvu: { favor: 15 } })
  })

  it('replays an MVU candidate without patching or recording a second receipt', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-replay', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const text = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, text)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const replayRoot = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-mvu-'))
    roots.push(replayRoot)
    const fresh = await AgentTavernProjector.open(replayRoot, store)
    await fresh.replay(session)
    await fresh.replay(session)

    const chat = await snapshotOf(store, chatId)
    // A second delta application would raise favor to 20.
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 15 } } })
    expect(readMvuReceipts(chat).filter((receipt) => receipt.turnKey === 'body:candidate-1')).toHaveLength(1)
  })

  it('does not record a body receipt for a candidate without <UpdateVariable>', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-plain', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const text = 'Plain body without a patch.'
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, text)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 10 } } })
    expect(readMvuReceipts(chat).filter((receipt) => receipt.turnKey === 'body:candidate-1')).toHaveLength(0)
    expect(floorOf(chat).mes).toBe(text)
  })

  /** Seed one projected assistant floor so a candidate can be located by message id. */
  async function seedProjectedFloor(
    store: TavernStore,
    chatId: string,
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    const sendDate = new Date(1200).toISOString()
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('fixture chat is missing')
    snapshot.chat.messages.push(
      { name: 'Alice', is_user: true, is_system: false, send_date: sendDate, mes: 'Open the door.' },
      {
        name: CHARACTER,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes: 'Previous body.',
        extra: { agentTavern: { sessionId, eventSeq: 0, messageId } },
      },
    )
    await store.saveChat(CHARACTER, chatId, snapshot.chat, snapshot.revision)
  }

  it('projects a non-MVU candidate whose message id carries a receipt separator', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-separator-plain')
    await seedProjectedFloor(store, chatId, sessionId, 'candidate#1')
    const session = makeSession(sessionId)
    session.events.push(
      assistantEvent(0, 'candidate#1', 'Plain body.', 1, 1200, undefined),
      bodyEvent(1, { op: 'candidate', groupId: 'candidate#1', messageId: 'candidate#1', index: 0 }),
    )
    const projector = await AgentTavernProjector.open(root, store)

    await projector.project(session, session.events[1]!)

    const chat = await snapshotOf(store, chatId)
    const floor = floorOf(chat)
    expect(floor.mes).toBe('Plain body.')
    expect(floor.swipes).toEqual(['Plain body.'])
    expect(agentTavernOf(floor)).toMatchObject({
      bodyGroupId: 'candidate#1',
      anchorMessageId: 'candidate#1',
    })
  })

  it('projects an edit for a non-MVU candidate whose message id carries a receipt separator', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-separator-edit')
    await seedProjectedFloor(store, chatId, sessionId, 'candidate#1')
    const session = makeSession(sessionId)
    session.events.push(
      assistantEvent(0, 'candidate#1', 'Plain body.', 1, 1200, undefined),
      bodyEvent(1, { op: 'candidate', groupId: 'candidate#1', messageId: 'candidate#1', index: 0 }),
      bodyEvent(2, {
        op: 'edit', groupId: 'candidate#1', index: 0, text: 'Edited plain body.', previousText: 'Plain body.',
      }),
    )
    const projector = await AgentTavernProjector.open(root, store)

    await projector.project(session, session.events[1]!)
    await projector.project(session, session.events[2]!)

    const chat = await snapshotOf(store, chatId)
    const floor = floorOf(chat)
    expect(floor.mes).toBe('Edited plain body.')
    expect(floor.swipes).toEqual(['Edited plain body.'])
    expect(readMvuReceipts(chat)).toHaveLength(0)
  })

  it('refuses an MVU candidate whose message id cannot form a receipt key', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-separator-mvu', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    await seedProjectedFloor(store, chatId, sessionId, 'candidate#1')
    const text = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const session = makeSession(sessionId)
    session.events.push(
      assistantEvent(0, 'candidate#1', text, 1, 1200, undefined),
      bodyEvent(1, { op: 'candidate', groupId: 'candidate#1', messageId: 'candidate#1', index: 0 }),
    )
    const projector = await AgentTavernProjector.open(root, store)
    const before = await snapshotOf(store, chatId)

    const error = await captureRejection(projector.project(session, session.events[1]!))

    expect(error).toMatchObject({ name: 'CandidateReceiptError', code: 'body-receipt-key-mismatch' })
    expect((error as Error).message).toContain('candidate#1')
    expect((error as Error).message).toContain("without '#'")
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', pendingCursor: 1 })
    // The refused projection saved nothing: the seeded floor keeps no swipes.
    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(floorOf(await snapshotOf(store, chatId)).swipes).toBeUndefined()
  })

  it('keeps one body receipt across a candidate CAS retry', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-cas', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const text = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, text)
    let conflicts = 0
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        const floor = chat.messages[1]
        if (conflicts === 0 && Array.isArray(floor?.swipes) && floor.swipes.length >= 2) {
          conflicts += 1
          throw new ChatRevisionConflictError(revision ?? '', 'changed')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    await projector.replay(session)

    expect(conflicts).toBe(1)
    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 15 } } })
    expect(readMvuReceipts(chat).filter((receipt) => receipt.turnKey === 'body:candidate-1')).toHaveLength(1)
  })

  it('migrates a legacy body receipt and applies an MVU edit exactly once', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-edit', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const oldText = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const newText = editedCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 3 }]')
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, oldText)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    expect(readMvuReceipts(await snapshotOf(store, chatId)).map((receipt) => receipt.turnKey))
      .toEqual(['body:candidate-1'])

    session.events.push(bodyEvent(14, {
      op: 'edit', groupId: 'group-1', index: 1, text: newText, previousText: oldText,
    }))
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages).toHaveLength(2)
    // The old receipt was undone: 10 + 5 + 3 would be 18, the new patch lands on 10.
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 13 } } })
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ turnKey: 'body:candidate-1#1', status: 'updated', failures: [] })
    expect(receipts[0]?.undoneAt).toBeUndefined()
    expect(receipts[0]?.changes).toContainEqual({ name: 'stat_data.mvu.favor', before: 10, after: 13 })

    const floor = floorOf(chat)
    expect(floor.swipe_id).toBe(1)
    expect(floor.mes).toBe(newText)
    expect(floor.swipes).toEqual(['Original body.', newText])
    expect(statDataOf(floor)).toEqual({ mvu: { favor: 13 } })
    expect(floor.swipe_info?.[1]).toMatchObject({ extra: { provider: 'test-provider', model: 'test-model' } })
    expect(agentTavernOf(floor)).toMatchObject({
      bodyGroupId: 'group-1', anchorMessageId: 'candidate-1', lastBodyEventSeq: 14, lastBodyMutation: 'edit',
    })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 14 })
  })

  it('replays one MVU edit event without a second undo or patch application', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-edit-replay', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const oldText = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const newText = editedCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 3 }]')
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, oldText)
    session.events.push(bodyEvent(14, {
      op: 'edit', groupId: 'group-1', index: 1, text: newText, previousText: oldText,
    }))
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)
    const afterEdit = await snapshotOf(store, chatId)

    const replayRoot = mkdtempSync(join(tmpdir(), 'agent-tavern-body-projector-mvu-'))
    roots.push(replayRoot)
    const fresh = await AgentTavernProjector.open(replayRoot, store)
    await fresh.replay(session)
    await fresh.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 13 } } })
    expect(readMvuReceipts(chat)).toEqual(readMvuReceipts(afterEdit))
    expect(readMvuReceipts(chat)).toHaveLength(1)
    expect(floorOf(chat).swipes).toEqual(['Original body.', newText])
    expect(floorOf(chat).mes).toBe(newText)
  })

  it('removes the candidate receipt when an MVU edit drops the patch block', async () => {
    const { root, store, chatId, sessionId } = await mvuFixture('body-projector-mvu-edit-plain', {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    const oldText = updateCandidateText('[{ "op": "delta", "path": "/mvu/favor", "value": 5 }]')
    const plainText = 'Plain replacement without a patch.'
    const session = makeSession(sessionId)
    seedMvuCandidateSession(session, oldText)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    session.events.push(bodyEvent(14, {
      op: 'edit', groupId: 'group-1', index: 1, text: plainText, previousText: oldText,
    }))
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 10 } } })
    expect(readMvuReceipts(chat)).toHaveLength(0)
    const floor = floorOf(chat)
    expect(floor.mes).toBe(plainText)
    expect(floor.swipes).toEqual(['Original body.', plainText])
    expect(statDataOf(floor)).toEqual({ mvu: { favor: 10 } })
    expect(agentTavernOf(floor)).toMatchObject({ lastBodyEventSeq: 14, lastBodyMutation: 'edit' })
  })

  it('projects a non-MVU edit without receipts or variable writes', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-plain-edit')
    const session = makeSession(sessionId)
    seedBaseline(session)
    seedCandidateZero(session)
    session.events.push(bodyEvent(6, {
      op: 'edit', groupId: 'group-1', index: 0, text: 'Edited body.', previousText: 'Original body.',
    }))
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    expect(chat.messages).toHaveLength(2)
    expect(chat.header.chat_metadata.variables).toBeUndefined()
    expect(readMvuReceipts(chat)).toHaveLength(0)
    const floor = floorOf(chat)
    expect(floor.swipes).toEqual(['Edited body.'])
    expect(floor.mes).toBe('Edited body.')
    expect(agentTavernOf(floor)).toMatchObject({ lastBodyEventSeq: 6, lastBodyMutation: 'edit' })
  })

  it('reprojects a failed event on replay after a later success advanced the cursor', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-pending-hole')
    const session = makeSession(sessionId)
    seedBaseline(session)
    let failBodyWrite = false
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        if (failBodyWrite) {
          failBodyWrite = false
          throw new Error('transient body write failure')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    await projector.replay(session)

    seedCandidateZero(session)
    session.events.push(bodyEvent(6, { op: 'op-finish', opId: 'op-1', result: 'ok', anchorId: 'group-1' }))

    failBodyWrite = true
    await expect(projector.project(session, session.events[5]!)).rejects.toThrow('transient body write failure')
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 5 })
    expect(floorOf(await snapshotOf(store, chatId)).swipes).toBeUndefined()

    // A later success must not advance the watermark past the failed cursor.
    await projector.project(session, session.events[6]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 5 })
    expect(floorOf(await snapshotOf(store, chatId)).swipes).toBeUndefined()

    await projector.replay(session)
    const chat = await snapshotOf(store, chatId)
    expect(floorOf(chat).swipes).toEqual(['Original body.'])
    expect(floorOf(chat).mes).toBe('Original body.')
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 6 })
  })

  it('keeps the lowest unfinished cursor across consecutive failures', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-pending-min')
    const session = makeSession(sessionId)
    seedBaseline(session)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(session)

    session.events.push(
      nativeEvent('assistant/message', 4, 1400, {
        turn: 1,
        step: 1,
        message: {
          id: 'ghost-anchor',
          role: 'assistant',
          content: [{ type: 'text', text: 'Ghost body.' }],
          source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
        },
      }),
      bodyEvent(5, { op: 'candidate', groupId: 'group-a', messageId: 'ghost-anchor', index: 0 }),
      bodyEvent(6, { op: 'candidate', groupId: 'group-b', messageId: 'ghost-anchor', index: 0 }),
      bodyEvent(7, { op: 'op-finish', opId: 'op-1', result: 'failed' }),
    )

    await expect(projector.project(session, session.events[5]!)).rejects.toMatchObject({
      code: 'body-floor-not-found',
    })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 5 })

    await expect(projector.project(session, session.events[6]!)).rejects.toMatchObject({
      code: 'body-floor-not-found',
    })
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 5 })

    await projector.project(session, session.events[7]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 5 })
    expect((await snapshotOf(store, chatId)).messages).toHaveLength(2)
  })

  it('does not skip a second failed cursor when replay closes the first hole', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-pending-two-holes')
    const session = makeSession(sessionId)
    seedBaseline(session)
    let failBodyWrite = false
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        if (failBodyWrite) {
          failBodyWrite = false
          throw new Error('transient body write failure')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    await projector.replay(session)

    session.events.push(
      bodyEvent(4, { op: 'candidate', groupId: 'group-1', messageId: 'group-1', index: 0 }),
      bodyEvent(5, {
        op: 'edit', groupId: 'group-1', index: 0, text: 'Edited body.', previousText: 'Original body.',
      }),
      bodyEvent(6, { op: 'op-finish', opId: 'op-1', result: 'ok', anchorId: 'group-1' }),
    )

    failBodyWrite = true
    await expect(projector.project(session, session.events[4]!)).rejects.toThrow('transient body write failure')
    // The edit targets a floor that has no selected swipe yet, so it fails as well.
    await expect(projector.project(session, session.events[5]!)).rejects.toMatchObject({
      name: 'CandidateReceiptError',
      code: 'stale-anchor',
    })
    await projector.project(session, session.events[6]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: 3, pendingCursor: 4 })

    // Replay closes seq 4 and must still re-project the second failed event (5).
    await projector.replay(session)
    const chat = await snapshotOf(store, chatId)
    expect(floorOf(chat).mes).toBe('Edited body.')
    expect(floorOf(chat).swipes).toEqual(['Edited body.'])
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 6 })
  })

  it('persists imported-floor adoption and its candidate in one chat save', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-adoption-one-save',
      ['Chosen greeting.'],
      0,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', 'Chosen greeting.')
    session.events.push(bodyEvent(5, {
      op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0,
    }))
    let saves = 0
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        saves += 1
        return store.saveChat(character, id, chat, revision)
      },
    })

    await projector.project(session, session.events[5]!)

    expect(saves).toBe(1)
    const chat = await snapshotOf(store, chatId)
    expect(chat.messages[0]?.swipes).toEqual(['Chosen greeting.'])
    expect(agentTavernOf(chat.messages[0]!).bodyGroupId).toBe('import-anchor')
  })

  it('does not persist imported-floor adoption when the candidate write fails', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-adoption-atomic',
      ['Chosen greeting.'],
      0,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', 'Chosen greeting.')
    session.events.push(bodyEvent(5, {
      op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0,
    }))
    let candidateWrites = 0
    let otherWrites = 0
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        // Fail the write that carries the projected candidate: a two-step
        // adoption would already have persisted the dropped swipe surface.
        const floor = chat.messages[0]
        if (floor !== undefined && Array.isArray(floor.swipes) && floor.swipes.includes('Chosen greeting.')) {
          candidateWrites += 1
          throw new Error('candidate write failed')
        }
        otherWrites += 1
        return store.saveChat(character, id, chat, revision)
      },
    })
    const before = await snapshotOf(store, chatId)

    await expect(projector.project(session, session.events[5]!)).rejects.toThrow('candidate write failed')

    expect(candidateWrites).toBe(1)
    expect(otherWrites).toBe(0)
    expect(await snapshotOf(store, chatId)).toEqual(before)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 5 })
  })

  it('refuses imported-floor adoption when the chosen floor is not the anchor mirror', async () => {
    const { root, store, chatId, sessionId } = await importedFixture(
      'body-projector-adoption-mismatch',
      ['Another greeting.'],
      0,
    )
    const session = makeSession(sessionId)
    seedImportedTurn(session, 'import-anchor', 'Chosen greeting.')
    session.events.push(bodyEvent(5, {
      op: 'candidate', groupId: 'import-anchor', messageId: 'import-anchor', index: 0,
    }))
    const projector = await AgentTavernProjector.open(root, store)
    const before = await snapshotOf(store, chatId)

    const error = await captureRejection(projector.project(session, session.events[5]!))

    expect(error).toMatchObject({ name: 'BodyJsonlProjectionError', code: 'body-adoption-mismatch' })
    expect((error as Error).message).toContain("group 'import-anchor'")
    expect((error as Error).message).toContain('chat floor 0')
    // Neither the mismatch detail nor the persisted checkpoint error may carry a
    // second copy of the body text out through GET /projection or logs.
    expect((error as Error).message).toContain('floor length 17')
    expect((error as Error).message).toContain('anchor length 16')
    expect((error as Error).message).not.toContain('Another greeting.')
    expect((error as Error).message).not.toContain('Chosen greeting.')
    expect(await snapshotOf(store, chatId)).toEqual(before)
    const status = await projector.status(sessionId)
    expect(status).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 5 })
    expect(status.error).not.toContain('Another greeting.')
    expect(status.error).not.toContain('Chosen greeting.')
  })

  it('does not read another floor text when a body group id equals its message id', async () => {
    const { root, store, chatId, sessionId } = await fixture('body-projector-locator')
    const sendDate = new Date(1200).toISOString()
    const chat = await snapshotOf(store, chatId)
    chat.messages.push(
      { name: 'Alice', is_user: true, is_system: false, send_date: sendDate, mes: 'Open the door.' },
      {
        name: CHARACTER,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes: 'Crossed floor.',
        swipe_id: 0,
        swipes: ['Crossed floor.'],
        swipe_info: [{ send_date: sendDate, extra: {} }],
        extra: { agentTavern: { sessionId, eventSeq: 2, messageId: 'group-1' } },
      },
      {
        name: CHARACTER,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes: 'Anchor body.',
        extra: { agentTavern: { sessionId, eventSeq: 3, messageId: 'anchor-1' } },
      },
    )
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('fixture chat is missing')
    await store.saveChat(CHARACTER, chatId, chat, snapshot.revision)

    const session = makeSession(sessionId)
    session.events.push(
      assistantEvent(0, 'anchor-1', 'Fresh body.', 1, 1200, undefined),
      bodyEvent(1, { op: 'candidate', groupId: 'group-1', messageId: 'anchor-1', index: 0 }),
    )
    const projector = await AgentTavernProjector.open(root, store)
    await projector.project(session, session.events[1]!)

    const projected = await snapshotOf(store, chatId)
    const target = projected.messages[2]!
    expect(target.mes).toBe('Fresh body.')
    expect(target.swipes).toEqual(['Fresh body.'])
    // The floor whose message id equals the group id keeps its own text.
    expect(projected.messages[1]!.mes).toBe('Crossed floor.')
    expect(projected.messages[1]!.swipes).toEqual(['Crossed floor.'])
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, 8.64e15 + 1])(
    'rejects a body candidate whose assistant time is %s',
    async (time) => {
      const { root, store, chatId, sessionId } = await fixture()
      const session = makeSession(sessionId)
      seedBaseline(session)
      session.events[2] = nativeEvent('assistant/message', 2, time, session.events[2]!.data!)
      session.events.push(bodyEvent(4, {
        op: 'candidate', groupId: 'group-1', messageId: 'group-1', index: 0,
      }))
      const projector = await AgentTavernProjector.open(root, store)

      const error = await captureRejection(projector.project(session, session.events[4]!))

      expect(error).toMatchObject({ name: 'BodyLedgerError', code: 'invalid-body-event' })
      expect((error as Error).message).toContain('assistant/message')
      expect((error as Error).message).toContain('seq 2')
      expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 4 })
      expect((await snapshotOf(store, chatId)).messages).toEqual([])
    },
  )
})
