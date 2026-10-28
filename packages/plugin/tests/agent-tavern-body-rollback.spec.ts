import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatLogIR } from '../../tavern-format/src/index.js'
import {
  ChatRevisionConflictError,
  MemoryStore,
  TavernStore,
  VariableStore,
  type MemoryRecord,
  type VariableSnapshot,
} from '../../tavern-store/src/index.js'
import {
  BodyRollbackError,
  createBodyWriteRollbackPort,
  type BodyRollbackPlan,
  type BodyRollbackStore,
  type BodyRollbackLogger,
  type BodyRollbackMemoryStore,
  type BodyRollbackVariableStore,
  type BodyWriteRollbackPort,
} from '../src/agent-tavern/body-rollback.js'
import {
  WRITE_JOURNAL_EVENT_TYPE,
  type WriteJournalEntry,
  type WriteJournalMemoryEntry,
  type WriteJournalMemoryTool,
  type WriteJournalRecordWriter,
  type WriteJournalVariableEntry,
  type WriteJournalVariableTool,
} from '../src/agent-tavern/write-journal.js'
import { appendMvuReceipt, readMvuReceipts, type MvuReceipt } from '../src/mvu.js'

// Proposal 0022 §5/§8/§9/§10: one port owns the write rollback of a body
// regeneration. These specs use synthetic cards, chats and session logs; the
// stores are the real file-backed implementations in a temporary directory.

const CHARACTER = 'Rollback Character'
const SESSION_ID = 'session-rollback'
const TURN = 7
const PREVIOUS_MESSAGE_ID = 'assistant-old'
const GROUP_ID = 'body-group-1'
const JOURNAL_AT = '2026-10-28T01:00:00.000Z'
const UPDATE_BODY = [
  'Old body.',
  '<UpdateVariable>',
  '<JSONPatch>',
  '[{ "op": "replace", "path": "/stat_data/hp", "value": 20 }]',
  '</JSONPatch>',
  '</UpdateVariable>',
].join('\n')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FixtureSeed {
  readonly bodyText: string
  readonly variables: Record<string, unknown>
  readonly receipts: readonly MvuReceipt[]
}

interface Fixture {
  readonly root: string
  readonly store: TavernStore
  readonly memory: MemoryStore
  readonly variables: VariableStore
  readonly chatId: string
  readonly events: unknown[]
  readonly floorIndex: number
}

interface PortOptions {
  readonly store?: BodyRollbackStore
  readonly memoryStore?: BodyRollbackMemoryStore
  readonly variableStore?: BodyRollbackVariableStore
  readonly resolveJournalWriter?: () => Promise<WriteJournalRecordWriter | undefined>
  readonly logger?: BodyRollbackLogger
}

function plainSeed(): FixtureSeed {
  return { bodyText: 'Old body.', variables: {}, receipts: [] }
}

function updateSeed(receipts: readonly MvuReceipt[]): FixtureSeed {
  return { bodyText: UPDATE_BODY, variables: { stat_data: { hp: 20 } }, receipts }
}

function bodyReceipt(at: string): MvuReceipt {
  return {
    at,
    turnKey: `body:${PREVIOUS_MESSAGE_ID}`,
    status: 'updated',
    changes: [{ name: 'stat_data.hp', before: 10, after: 20 }],
    failures: [],
  }
}

function settleReceipt(at: string): MvuReceipt {
  return {
    at,
    turnKey: '1',
    status: 'updated',
    changes: [{ name: 'mvu.favor', before: 1, after: 2 }],
    failures: [],
  }
}

async function createFixture(seed: FixtureSeed): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-rollback-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
  })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'User',
    character_name: CHARACTER,
    chat_metadata: {},
  })
  await store.updateState(() => ({
    sessionBindings: {
      [SESSION_ID]: {
        architecture: 'agent-tavern',
        contextMode: 'dsh-native',
        character: CHARACTER,
        chatId,
      },
    },
  }))
  const memory = await MemoryStore.open(root)
  const variables = await VariableStore.open(root)

  const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  const chat = snapshot.chat
  if (Object.keys(seed.variables).length > 0) chat.header.chat_metadata.variables = structuredClone(seed.variables)
  for (const receipt of seed.receipts) appendMvuReceipt(chat, structuredClone(receipt))
  chat.messages.push({
    name: 'User',
    is_user: true,
    is_system: false,
    send_date: JOURNAL_AT,
    mes: 'Go on.',
  })
  const floorIndex = chat.messages.length
  chat.messages.push({
    name: CHARACTER,
    is_user: false,
    is_system: false,
    send_date: JOURNAL_AT,
    mes: seed.bodyText,
    swipes: [seed.bodyText],
    swipe_id: 0,
    extra: {
      agentTavern: {
        bodyGroupId: GROUP_ID,
        anchorMessageId: PREVIOUS_MESSAGE_ID,
      },
    },
  })
  await store.saveChat(CHARACTER, chatId, chat, snapshot.revision)

  const events: unknown[] = [sessionEvent('turn/start', { turn: TURN })]
  return { root, store, memory, variables, chatId, events, floorIndex }
}

function sessionEvent(type: string, data: unknown): unknown {
  return { type, seq: 0, time: Date.parse(JOURNAL_AT), data }
}

function nextEvent(events: unknown[], type: string, data: unknown): void {
  events.push({ type, seq: events.length, time: Date.parse(JOURNAL_AT) + events.length, data })
}

function pushToolCall(fixture: Fixture, name: string): void {
  pushToolCallInTurn(fixture, name, TURN)
}

function pushToolCallInTurn(fixture: Fixture, name: string, turn: number): void {
  nextEvent(fixture.events, 'assistant/message', {
    turn,
    step: 1,
    message: {
      id: `tool-call-${fixture.events.length}`,
      role: 'assistant',
      content: [{
        type: 'tool-call',
        callId: `call-${fixture.events.length}`,
        name,
        arguments: '{}',
      }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  })
}

function memoryJournal(
  journalId: string,
  tool: WriteJournalMemoryTool,
  phase: 'before' | 'after',
  record: MemoryRecord,
  state: MemoryRecord | null,
): WriteJournalMemoryEntry {
  return memoryJournalInTurn(journalId, tool, phase, record, state, TURN)
}

function memoryJournalInTurn(
  journalId: string,
  tool: WriteJournalMemoryTool,
  phase: 'before' | 'after',
  record: MemoryRecord,
  state: MemoryRecord | null,
  turn: number,
): WriteJournalMemoryEntry {
  return {
    kind: 'memory',
    tool,
    journalId,
    sessionId: SESSION_ID,
    turn,
    phase,
    at: JOURNAL_AT,
    target: { id: record.id, scope: record.scope, scopeId: record.scopeId },
    ...(phase === 'before' ? { before: state } : { after: state }),
  }
}

function variableJournal(
  journalId: string,
  tool: WriteJournalVariableTool,
  phase: 'before' | 'after',
  scopeId: string,
  state: readonly VariableSnapshot[] | null,
): WriteJournalVariableEntry {
  return variableJournalInTurn(journalId, tool, phase, scopeId, state, TURN)
}

function variableJournalInTurn(
  journalId: string,
  tool: WriteJournalVariableTool,
  phase: 'before' | 'after',
  scopeId: string,
  state: readonly VariableSnapshot[] | null,
  turn: number,
): WriteJournalVariableEntry {
  return {
    kind: 'variable',
    tool,
    journalId,
    sessionId: SESSION_ID,
    turn,
    phase,
    at: JOURNAL_AT,
    target: { scope: 'chat', scopeId },
    ...(phase === 'before' ? { before: state } : { after: state }),
  }
}

function pushJournal(fixture: Fixture, entry: WriteJournalEntry): void {
  nextEvent(fixture.events, WRITE_JOURNAL_EVENT_TYPE, entry)
}

function createPort(fixture: Fixture, options: PortOptions): BodyWriteRollbackPort {
  const writer: WriteJournalRecordWriter = () => undefined
  return createBodyWriteRollbackPort({
    store: options.store ?? fixture.store,
    memoryStore: options.memoryStore ?? fixture.memory,
    variableStore: options.variableStore ?? fixture.variables,
    sessionEvents: async () => fixture.events,
    resolveJournalWriter: options.resolveJournalWriter ?? (async () => writer),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}

async function putMemory(fixture: Fixture, content: string): Promise<MemoryRecord> {
  return fixture.memory.put({
    scope: 'chat',
    scopeId: fixture.chatId,
    kind: 'semantic',
    content,
    tags: ['rollback'],
    importance: 0.5,
    confidence: 1,
    source: { kind: 'agent-tool', sessionId: SESSION_ID, chatId: fixture.chatId, character: CHARACTER },
  })
}

async function updateMemory(fixture: Fixture, record: MemoryRecord, content: string): Promise<MemoryRecord> {
  return fixture.memory.put({
    id: record.id,
    scope: record.scope,
    scopeId: record.scopeId,
    kind: record.kind,
    content,
    tags: record.tags,
    importance: record.importance,
    confidence: record.confidence,
    source: record.source,
  }, record.revision)
}

async function chatOf(fixture: Fixture): Promise<ChatLogIR> {
  const snapshot = await fixture.store.getChatSnapshot(CHARACTER, fixture.chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  return snapshot.chat
}

async function captureError(operation: Promise<unknown>): Promise<BodyRollbackError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof BodyRollbackError) return error
    throw error
  }
  throw new Error('expected the operation to fail, but it resolved')
}

function failingStore(fixture: Fixture, error: Error): BodyRollbackStore {
  return {
    getState: () => fixture.store.getState(),
    getCharacter: (name: string) => fixture.store.getCharacter(name),
    getChatSnapshot: (character: string, chatId: string) => fixture.store.getChatSnapshot(character, chatId),
    saveChat: async () => { throw error },
  }
}

describe('AgentTavern body write rollback (proposal 0022 §5)', () => {
  it('rolls memory create/update/forget back to before and replays after on restore', async () => {
    const fixture = await createFixture(plainSeed())
    const created = await putMemory(fixture, 'created by the old turn')
    const updatedBefore = await putMemory(fixture, 'update before')
    const updatedAfter = await updateMemory(fixture, updatedBefore, 'update after')
    const forgottenBefore = await putMemory(fixture, 'forget before')
    await fixture.memory.forget(forgottenBefore.id, 'chat', fixture.chatId, forgottenBefore.revision)
    const forgottenAfter = await fixture.memory.read(forgottenBefore.id, 'chat', fixture.chatId, true)
    if (forgottenAfter === undefined) throw new Error('forgotten fixture record is missing')

    pushToolCall(fixture, 'memory_write')
    pushToolCall(fixture, 'memory_update')
    pushToolCall(fixture, 'memory_forget')
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'before', created, null))
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'after', created, created))
    pushJournal(fixture, memoryJournal('journal-update', 'memory_update', 'before', updatedBefore, updatedBefore))
    pushJournal(fixture, memoryJournal('journal-update', 'memory_update', 'after', updatedBefore, updatedAfter))
    pushJournal(fixture, memoryJournal('journal-forget', 'memory_forget', 'before', forgottenBefore, forgottenBefore))
    pushJournal(fixture, memoryJournal('journal-forget', 'memory_forget', 'after', forgottenBefore, forgottenAfter))

    const before = await fixture.store.getChatSnapshot(CHARACTER, fixture.chatId)
    if (before === undefined) throw new Error('fixture chat is missing')
    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)

    expect(plan).toMatchObject({
      sessionId: SESSION_ID,
      turn: TURN,
      previousMessageId: PREVIOUS_MESSAGE_ID,
      floorIndex: fixture.floorIndex,
      chatRevision: before.revision,
      preparedRevision: before.revision,
    })
    expect(plan.journal.map((write) => write.journalId)).toEqual(['journal-write', 'journal-update', 'journal-forget'])
    expect(plan.diagnostics.map((entry) => entry.code)).toContain('vector-restore-skipped')

    const createdAfterUndo = await fixture.memory.read(created.id, 'chat', fixture.chatId, true)
    expect(createdAfterUndo?.deletedAt).toBeDefined()
    const updatedAfterUndo = await fixture.memory.read(updatedBefore.id, 'chat', fixture.chatId, true)
    expect(updatedAfterUndo).toMatchObject({ content: 'update before', revision: updatedBefore.revision })
    const forgottenAfterUndo = await fixture.memory.read(forgottenBefore.id, 'chat', fixture.chatId, true)
    expect(forgottenAfterUndo).toMatchObject({ content: 'forget before', revision: forgottenBefore.revision })
    expect(forgottenAfterUndo?.deletedAt).toBeUndefined()

    await port.commit(plan)
    expect((await fixture.memory.read(created.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()

    await port.restore(plan)

    const createdAfterRestore = await fixture.memory.read(created.id, 'chat', fixture.chatId, true)
    expect(createdAfterRestore).toMatchObject({ content: 'created by the old turn', revision: created.revision })
    expect(createdAfterRestore?.deletedAt).toBeUndefined()
    const updatedAfterRestore = await fixture.memory.read(updatedBefore.id, 'chat', fixture.chatId, true)
    expect(updatedAfterRestore).toMatchObject({ content: 'update after', revision: updatedAfter.revision })
    const forgottenAfterRestore = await fixture.memory.read(forgottenBefore.id, 'chat', fixture.chatId, true)
    expect(forgottenAfterRestore).toMatchObject({ revision: forgottenAfter.revision })
    expect(forgottenAfterRestore?.deletedAt).toBeDefined()
  })

  it('rolls variable set/patch/delete back to before and replays after on restore', async () => {
    const fixture = await createFixture(plainSeed())
    const favorBefore = await fixture.variables.set('chat', fixture.chatId, 'favor', 1)
    const hpAfter = await fixture.variables.set('chat', fixture.chatId, 'hp', 10)
    const patchAfter = await fixture.variables.patch('chat', fixture.chatId, [
      { name: 'favor', value: 5 },
      { name: 'newFlag', value: true },
    ])
    const moodBefore = await fixture.variables.set('chat', fixture.chatId, 'mood', 'calm')
    await fixture.variables.delete('chat', fixture.chatId, 'mood', moodBefore.revision)

    pushToolCall(fixture, 'variable_set')
    pushToolCall(fixture, 'variable_patch')
    pushToolCall(fixture, 'variable_delete')
    pushJournal(fixture, variableJournal('journal-set', 'variable_set', 'before', fixture.chatId, null))
    pushJournal(fixture, variableJournal('journal-set', 'variable_set', 'after', fixture.chatId, [hpAfter]))
    pushJournal(fixture, variableJournal('journal-patch', 'variable_patch', 'before', fixture.chatId, [favorBefore]))
    pushJournal(fixture, variableJournal('journal-patch', 'variable_patch', 'after', fixture.chatId, patchAfter))
    pushJournal(fixture, variableJournal('journal-delete', 'variable_delete', 'before', fixture.chatId, [moodBefore]))
    pushJournal(fixture, variableJournal('journal-delete', 'variable_delete', 'after', fixture.chatId, null))

    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)

    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, 'favor')).toMatchObject({ value: 1 })
    expect(await fixture.variables.get('chat', fixture.chatId, 'newFlag')).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, 'mood')).toMatchObject({ value: 'calm' })

    await port.restore(plan)

    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toMatchObject({ value: 10, revision: hpAfter.revision })
    expect(await fixture.variables.get('chat', fixture.chatId, 'favor')).toMatchObject({ value: 5 })
    expect(await fixture.variables.get('chat', fixture.chatId, 'newFlag')).toMatchObject({ value: true })
    expect(await fixture.variables.get('chat', fixture.chatId, 'mood')).toBeUndefined()
  })

  it('handles repeated writes to the same memory and variable across journal groups', async () => {
    const fixture = await createFixture(plainSeed())
    const memoryV0 = await putMemory(fixture, 'memory v0')
    const memoryV1 = await updateMemory(fixture, memoryV0, 'memory v1')
    const memoryV2 = await updateMemory(fixture, memoryV1, 'memory v2')
    const variableV1 = await fixture.variables.set('chat', fixture.chatId, 'hp', 1)
    const variableV2 = await fixture.variables.set('chat', fixture.chatId, 'hp', 2, variableV1.revision)
    const variableV3 = await fixture.variables.set('chat', fixture.chatId, 'hp', 3, variableV2.revision)

    pushToolCall(fixture, 'memory_update')
    pushToolCall(fixture, 'variable_set')
    pushJournal(fixture, memoryJournal('memory-step-1', 'memory_update', 'before', memoryV0, memoryV0))
    pushJournal(fixture, memoryJournal('memory-step-1', 'memory_update', 'after', memoryV0, memoryV1))
    pushJournal(fixture, memoryJournal('memory-step-2', 'memory_update', 'before', memoryV0, memoryV1))
    pushJournal(fixture, memoryJournal('memory-step-2', 'memory_update', 'after', memoryV0, memoryV2))
    pushJournal(fixture, variableJournal('variable-step-1', 'variable_set', 'before', fixture.chatId, null))
    pushJournal(fixture, variableJournal('variable-step-1', 'variable_set', 'after', fixture.chatId, [variableV1]))
    pushJournal(fixture, variableJournal('variable-step-2', 'variable_set', 'before', fixture.chatId, [variableV1]))
    pushJournal(fixture, variableJournal('variable-step-2', 'variable_set', 'after', fixture.chatId, [variableV2]))
    pushJournal(fixture, variableJournal('variable-step-3', 'variable_set', 'before', fixture.chatId, [variableV2]))
    pushJournal(fixture, variableJournal('variable-step-3', 'variable_set', 'after', fixture.chatId, [variableV3]))

    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)

    expect(await fixture.memory.read(memoryV0.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'memory v0',
      revision: memoryV0.revision,
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toBeUndefined()

    await port.restore(plan)

    expect(await fixture.memory.read(memoryV0.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'memory v2',
      revision: memoryV2.revision,
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toMatchObject({
      value: 3,
      revision: variableV3.revision,
    })
  })

  it('undoes body receipts in the chat tree and settle receipts in the flat store, then redoes both', async () => {
    const receipts = [bodyReceipt('2026-10-28T01:00:01.000Z'), settleReceipt('2026-10-28T01:00:02.000Z')]
    const fixture = await createFixture(updateSeed(receipts))
    // The settle tool writes the flat chat scope, not chat_metadata.variables.
    await fixture.variables.set('chat', fixture.chatId, 'mvu.favor', 2)
    pushToolCall(fixture, 'tavern_variable_settle')
    const port = createPort(fixture, {})

    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)
    expect(plan.mvuReceipts).toHaveLength(2)
    expect(plan.chatRevision).not.toBe(plan.preparedRevision)

    const rolledBack = await chatOf(fixture)
    expect(rolledBack.header.chat_metadata.variables).toEqual({ stat_data: { hp: 10 } })
    expect(await fixture.variables.get('chat', fixture.chatId, 'mvu.favor')).toMatchObject({ value: 1 })
    expect(readMvuReceipts(rolledBack).map((receipt) => receipt.undoneAt !== undefined)).toEqual([true, true])

    await port.restore(plan)

    const restored = await chatOf(fixture)
    expect(restored.header.chat_metadata.variables).toEqual({ stat_data: { hp: 20 } })
    expect(await fixture.variables.get('chat', fixture.chatId, 'mvu.favor')).toMatchObject({ value: 2 })
    expect(readMvuReceipts(restored).map((receipt) => receipt.undoneAt !== undefined)).toEqual([false, false])
  })

  it('restores settle receipts in the flat store (existing, added, deleted keys) without touching chat variables', async () => {
    const older: MvuReceipt = {
      at: '2026-10-28T01:00:03.000Z',
      turnKey: '1',
      status: 'updated',
      changes: [{ name: 'hp', before: 10, after: 15 }],
      failures: [],
    }
    const newer: MvuReceipt = {
      at: '2026-10-28T01:00:04.000Z',
      turnKey: '1',
      status: 'updated',
      changes: [
        { name: 'hp', before: 15, after: 20 },
        { name: 'newFlag', after: true },
        { name: 'mood', before: 'calm' },
      ],
      failures: [],
    }
    const chatVariables = { seed: { untouched: true } }
    const fixture = await createFixture({
      bodyText: 'Old body.',
      variables: chatVariables,
      receipts: [older, newer],
    })
    await fixture.variables.set('chat', fixture.chatId, 'hp', 20)
    await fixture.variables.set('chat', fixture.chatId, 'newFlag', true)
    pushToolCall(fixture, 'tavern_variable_settle')

    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)
    expect(plan.mvuReceipts).toHaveLength(2)
    expect(plan.chatRevision).not.toBe(plan.preparedRevision)

    // Undo is newest-first: hp 20 -> 15, newFlag deleted, mood restored;
    // the older receipt then takes hp 15 -> 10.
    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toMatchObject({ value: 10 })
    expect(await fixture.variables.get('chat', fixture.chatId, 'newFlag')).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, 'mood')).toMatchObject({ value: 'calm' })
    const rolledBack = await chatOf(fixture)
    expect(rolledBack.header.chat_metadata.variables).toEqual(chatVariables)
    expect(readMvuReceipts(rolledBack).map((receipt) => receipt.undoneAt !== undefined)).toEqual([true, true])

    // A second prepare sees both settle receipts undone and must not write the
    // flat store again; the receipt state, not the plan snapshot, decides.
    const second = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)
    expect(second.journal).toHaveLength(0)
    expect(second.chatRevision).toBe(second.preparedRevision)
    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toMatchObject({ value: 10 })

    await port.restore(plan)

    // Redo is oldest-first: hp 10 -> 15, then 15 -> 20, newFlag added, mood deleted.
    expect(await fixture.variables.get('chat', fixture.chatId, 'hp')).toMatchObject({ value: 20 })
    expect(await fixture.variables.get('chat', fixture.chatId, 'newFlag')).toMatchObject({ value: true })
    expect(await fixture.variables.get('chat', fixture.chatId, 'mood')).toBeUndefined()
    const restored = await chatOf(fixture)
    expect(restored.header.chat_metadata.variables).toEqual(chatVariables)
    expect(readMvuReceipts(restored).map((receipt) => receipt.undoneAt !== undefined)).toEqual([false, false])
  })

  it('rolls back a failed new turn memory/variable writes without touching the old turn', async () => {
    const newTurn = TURN + 1
    const fixture = await createFixture({
      bodyText: 'Old body.',
      variables: {},
      receipts: [bodyReceipt('2026-10-28T01:00:09.000Z')],
    })
    const before = await fixture.store.getChatSnapshot(CHARACTER, fixture.chatId)
    if (before === undefined) throw new Error('fixture chat is missing')

    // Old turn write: committed journal at TURN; rollbackTurnWrites(8) must ignore it.
    const oldRecord = await putMemory(fixture, 'old turn record')
    pushJournal(fixture, memoryJournal('old-turn-write', 'memory_write', 'before', oldRecord, null))
    pushJournal(fixture, memoryJournal('old-turn-write', 'memory_write', 'after', oldRecord, oldRecord))
    await fixture.variables.set('chat', fixture.chatId, 'oldTurnVar', 'kept')

    // New turn memory create/update/forget.
    const created = await putMemory(fixture, 'new turn create')
    const updateBefore = await putMemory(fixture, 'new turn update before')
    const updateAfter = await updateMemory(fixture, updateBefore, 'new turn update after')
    const forgetBefore = await putMemory(fixture, 'new turn forget before')
    await fixture.memory.forget(forgetBefore.id, 'chat', fixture.chatId, forgetBefore.revision)
    const forgetAfter = await fixture.memory.read(forgetBefore.id, 'chat', fixture.chatId, true)
    if (forgetAfter === undefined) throw new Error('new-turn forgotten record is missing')

    // New turn variable set/patch/delete.
    const patchBefore = await fixture.variables.set('chat', fixture.chatId, 'patched', 1)
    const patchAfter = await fixture.variables.patch('chat', fixture.chatId, [{ name: 'patched', value: 2 }])
    const added = await fixture.variables.set('chat', fixture.chatId, 'added', 1)
    const deletedBefore = await fixture.variables.set('chat', fixture.chatId, 'deleted', 'keep')
    await fixture.variables.delete('chat', fixture.chatId, 'deleted', deletedBefore.revision)

    nextEvent(fixture.events, 'turn/start', { turn: newTurn })
    pushToolCallInTurn(fixture, 'memory_write', newTurn)
    pushToolCallInTurn(fixture, 'memory_update', newTurn)
    pushToolCallInTurn(fixture, 'memory_forget', newTurn)
    pushToolCallInTurn(fixture, 'variable_set', newTurn)
    pushToolCallInTurn(fixture, 'variable_patch', newTurn)
    pushToolCallInTurn(fixture, 'variable_delete', newTurn)
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'before', created, null, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'after', created, created, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-update', 'memory_update', 'before', updateBefore, updateBefore, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-update', 'memory_update', 'after', updateBefore, updateAfter, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-forget', 'memory_forget', 'before', forgetBefore, forgetBefore, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-forget', 'memory_forget', 'after', forgetBefore, forgetAfter, newTurn))
    pushJournal(fixture, variableJournalInTurn('new-set', 'variable_set', 'before', fixture.chatId, null, newTurn))
    pushJournal(fixture, variableJournalInTurn('new-set', 'variable_set', 'after', fixture.chatId, [added], newTurn))
    pushJournal(fixture, variableJournalInTurn('new-patch', 'variable_patch', 'before', fixture.chatId, [patchBefore], newTurn))
    pushJournal(fixture, variableJournalInTurn('new-patch', 'variable_patch', 'after', fixture.chatId, patchAfter, newTurn))
    pushJournal(fixture, variableJournalInTurn('new-delete', 'variable_delete', 'before', fixture.chatId, [deletedBefore], newTurn))
    pushJournal(fixture, variableJournalInTurn('new-delete', 'variable_delete', 'after', fixture.chatId, null, newTurn))

    const port = createPort(fixture, {})
    const result = await port.rollbackTurnWrites(SESSION_ID, newTurn)

    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      turn: newTurn,
      undone: 6,
      skippedUncommitted: [],
      failures: [],
    })
    expect((await fixture.memory.read(created.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()
    expect(await fixture.memory.read(updateBefore.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'new turn update before',
      revision: updateBefore.revision,
    })
    expect(await fixture.memory.read(forgetBefore.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'new turn forget before',
      revision: forgetBefore.revision,
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'added')).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, 'patched')).toMatchObject({
      value: 1,
      revision: patchBefore.revision,
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'deleted')).toMatchObject({
      value: 'keep',
      revision: deletedBefore.revision,
    })

    // The old turn's journal and the MVU receipt stay untouched.
    expect(await fixture.memory.read(oldRecord.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'old turn record',
      revision: oldRecord.revision,
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'oldTurnVar')).toMatchObject({ value: 'kept' })
    const after = await fixture.store.getChatSnapshot(CHARACTER, fixture.chatId)
    expect(after?.revision).toBe(before.revision)
    expect(readMvuReceipts(await chatOf(fixture))[0]?.undoneAt).toBeUndefined()
  })

  it('skips before-only new-turn entries and makes rollbackTurnWrites idempotent', async () => {
    const newTurn = TURN + 1
    const fixture = await createFixture(plainSeed())
    const created = await putMemory(fixture, 'new turn create')
    const pendingTarget = await putMemory(fixture, 'pending target')

    nextEvent(fixture.events, 'turn/start', { turn: newTurn })
    pushToolCallInTurn(fixture, 'memory_write', newTurn)
    pushToolCallInTurn(fixture, 'memory_update', newTurn)
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'before', created, null, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'after', created, created, newTurn))
    pushJournal(fixture, memoryJournalInTurn('pending-update', 'memory_update', 'before', pendingTarget, pendingTarget, newTurn))

    const port = createPort(fixture, {})
    const first = await port.rollbackTurnWrites(SESSION_ID, newTurn)
    expect(first).toMatchObject({ undone: 1, skippedUncommitted: ['pending-update'], failures: [] })
    expect((await fixture.memory.read(created.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()
    expect(await fixture.memory.read(pendingTarget.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'pending target',
      revision: pendingTarget.revision,
    })

    const second = await port.rollbackTurnWrites(SESSION_ID, newTurn)
    expect(second).toMatchObject({ undone: 0, skippedUncommitted: ['pending-update'], failures: [] })
    expect((await fixture.memory.read(created.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()
    expect(await fixture.memory.read(pendingTarget.id, 'chat', fixture.chatId, true)).toMatchObject({
      revision: pendingTarget.revision,
    })
  })

  it('reports per-entry failures from rollbackTurnWrites and continues with other entries', async () => {
    const newTurn = TURN + 1
    const fixture = await createFixture(plainSeed())
    const created = await putMemory(fixture, 'new turn create')
    const added = await fixture.variables.set('chat', fixture.chatId, 'added', 1)

    nextEvent(fixture.events, 'turn/start', { turn: newTurn })
    pushToolCallInTurn(fixture, 'memory_write', newTurn)
    pushToolCallInTurn(fixture, 'variable_set', newTurn)
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'before', created, null, newTurn))
    pushJournal(fixture, memoryJournalInTurn('new-create', 'memory_write', 'after', created, created, newTurn))
    pushJournal(fixture, variableJournalInTurn('new-set', 'variable_set', 'before', fixture.chatId, null, newTurn))
    pushJournal(fixture, variableJournalInTurn('new-set', 'variable_set', 'after', fixture.chatId, [added], newTurn))

    const failingMemory: BodyRollbackMemoryStore = {
      read: (id, scope, scopeId, includeDeleted) => fixture.memory.read(id, scope, scopeId, includeDeleted),
      forget: async () => { throw new Error('memory store is down') },
      restore: (record, expectedRevision) => fixture.memory.restore(record, expectedRevision),
    }
    const port = createPort(fixture, { memoryStore: failingMemory })
    const result = await port.rollbackTurnWrites(SESSION_ID, newTurn)

    expect(result.undone).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({
      journalId: 'new-create',
      kind: 'memory',
      tool: 'memory_write',
      code: 'body-rollback-failed',
    })
    expect(result.failures[0]?.message).toContain('memory store is down')
    expect(await fixture.memory.read(created.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'new turn create',
    })
    expect(await fixture.variables.get('chat', fixture.chatId, 'added')).toBeUndefined()
  })

  it('refuses a turn whose write tool calls have no journal record', async () => {
    const fixture = await createFixture(plainSeed())
    pushToolCall(fixture, 'memory_write')
    const port = createPort(fixture, {})

    const error = await captureError(port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID))
    expect(error).toMatchObject({
      name: 'BodyRollbackError',
      code: 'body-state-unsafe',
      detail: 'write-journal-missing',
      sessionId: SESSION_ID,
      turn: TURN,
    })
    expect(error.message).toContain('memory_write')
  })

  it('reports write-journal-unavailable when the host cannot journal at all', async () => {
    const fixture = await createFixture(plainSeed())
    pushToolCall(fixture, 'variable_set')
    const port = createPort(fixture, { resolveJournalWriter: async () => undefined })

    const error = await captureError(port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID))
    expect(error).toMatchObject({
      code: 'body-state-unsafe',
      detail: 'write-journal-unavailable',
    })
    expect(error.message).toContain('appendPluginRecord')
  })

  it('refuses an <UpdateVariable> body without its MVU receipt', async () => {
    const fixture = await createFixture({ bodyText: UPDATE_BODY, variables: { stat_data: { hp: 20 } }, receipts: [] })
    const port = createPort(fixture, {})

    const error = await captureError(port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID))
    expect(error).toMatchObject({
      code: 'body-state-unsafe',
      detail: 'mvu-receipt-missing',
    })
    expect((await chatOf(fixture)).header.chat_metadata.variables).toEqual({ stat_data: { hp: 20 } })
  })

  it('treats a before-only journal group as uncommitted and leaves its target untouched', async () => {
    const fixture = await createFixture(plainSeed())
    const committed = await putMemory(fixture, 'committed create')
    const uncommitted = await putMemory(fixture, 'before-only target')

    pushToolCall(fixture, 'memory_write')
    pushToolCall(fixture, 'memory_update')
    pushJournal(fixture, memoryJournal('journal-committed', 'memory_write', 'before', committed, null))
    pushJournal(fixture, memoryJournal('journal-committed', 'memory_write', 'after', committed, committed))
    pushJournal(fixture, memoryJournal('journal-pending', 'memory_update', 'before', uncommitted, uncommitted))

    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)

    expect(plan.journal.map((write) => write.journalId)).toEqual(['journal-committed'])
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({
        code: 'journal-uncommitted-skipped',
        message: expect.stringContaining('journal-pending'),
      }),
      expect.objectContaining({ code: 'vector-restore-skipped' }),
    ])
    expect((await fixture.memory.read(committed.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()
    expect(await fixture.memory.read(uncommitted.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'before-only target',
      revision: uncommitted.revision,
    })

    await port.restore(plan)
    expect(await fixture.memory.read(committed.id, 'chat', fixture.chatId, true)).toMatchObject({
      revision: committed.revision,
    })
  })

  it('surfaces a CAS conflict and compensates the flat stores back to the old state', async () => {
    const fixture = await createFixture(updateSeed([bodyReceipt('2026-10-28T01:00:01.000Z')]))
    const created = await putMemory(fixture, 'created before the conflict')
    pushToolCall(fixture, 'memory_write')
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'before', created, null))
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'after', created, created))

    const port = createPort(fixture, {
      store: failingStore(fixture, new ChatRevisionConflictError('stale-revision', 'current-revision')),
    })
    const error = await captureError(port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID))

    expect(error).toMatchObject({
      code: 'body-rollback-conflict',
      stage: 'chat-save',
      compensated: true,
    })
    expect(error.message).toContain('changed in another tab')
    expect(await fixture.memory.read(created.id, 'chat', fixture.chatId, true)).toMatchObject({
      content: 'created before the conflict',
      revision: created.revision,
    })
    const untouched = await chatOf(fixture)
    expect(untouched.header.chat_metadata.variables).toEqual({ stat_data: { hp: 20 } })
    expect(readMvuReceipts(untouched)[0]?.undoneAt).toBeUndefined()
  })

  it('surfaces a generic chat save failure without swallowing it', async () => {
    const fixture = await createFixture(updateSeed([bodyReceipt('2026-10-28T01:00:01.000Z')]))
    const created = await putMemory(fixture, 'created before the save failure')
    pushToolCall(fixture, 'memory_write')
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'before', created, null))
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'after', created, created))

    const port = createPort(fixture, {
      store: failingStore(fixture, new Error('disk is full')),
    })
    const error = await captureError(port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID))

    expect(error).toMatchObject({
      code: 'body-rollback-save-failed',
      stage: 'chat-save',
      compensated: true,
    })
    expect(error.message).toContain('disk is full')
    expect(await fixture.memory.read(created.id, 'chat', fixture.chatId, true)).toMatchObject({
      revision: created.revision,
    })
  })

  it('throws when restore cannot relocate its MVU receipts and keeps the stores rolled back', async () => {
    const fixture = await createFixture(updateSeed([bodyReceipt('2026-10-28T01:00:01.000Z')]))
    const created = await putMemory(fixture, 'created before the receipt loss')
    pushToolCall(fixture, 'memory_write')
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'before', created, null))
    pushJournal(fixture, memoryJournal('journal-write', 'memory_write', 'after', created, created))

    const port = createPort(fixture, {})
    const plan = await port.prepare(SESSION_ID, TURN, PREVIOUS_MESSAGE_ID)

    // Simulate an external edit that drops the receipt the plan depends on.
    const snapshot = await fixture.store.getChatSnapshot(CHARACTER, fixture.chatId)
    if (snapshot === undefined) throw new Error('fixture chat is missing')
    delete snapshot.chat.header.chat_metadata.mvu
    await fixture.store.saveChat(CHARACTER, fixture.chatId, snapshot.chat, snapshot.revision)

    const error = await captureError(port.restore(plan))
    expect(error).toMatchObject({
      code: 'body-rollback-failed',
      stage: 'mvu-redo',
    })
    expect(error.message).toContain('no mvu.receipts')
    expect((await fixture.memory.read(created.id, 'chat', fixture.chatId, true))?.deletedAt).toBeDefined()
  })

  it('rejects a malformed plan before touching any store', async () => {
    const fixture = await createFixture(plainSeed())
    const port = createPort(fixture, {})
    const malformed = { sessionId: '', turn: TURN } as unknown as BodyRollbackPlan

    const error = await captureError(port.restore(malformed))
    expect(error).toMatchObject({ code: 'invalid-arguments', stage: 'restore' })
  })
})
