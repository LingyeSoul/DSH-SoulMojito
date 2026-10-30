/**
 * AgentTavern body write rollback integration (proposal 0022 §5, §8, §9, §10).
 *
 * Unlike the unit-oriented rollback spec, this file never hands the port a
 * hand-built journal array: the real memory/variable tools write through the
 * real file-backed stores and append `plugin:dsh-soulmojito/write` records
 * through the host `appendPluginRecord` seam. The rollback port then consumes
 * those live session events together with `TavernStore`, `MemoryStore` and
 * `VariableStore`, so every assertion below reads state that the real stores
 * persisted. The host package import is the only double; all stores, chat files
 * and journal events are real and live in a throwaway DSH_HOME.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatLogIR } from '../../tavern-format/src/index.js'
import type {
  MemoryRecord,
  MemoryStore,
  TavernStore,
  VariableSnapshot,
  VariableStore,
} from '../../tavern-store/src/index.js'
import {
  createBodyWriteRollbackPort,
  type BodyRollbackLogger,
  type BodyRollbackPlan,
  type BodyWriteRollbackPort,
} from '../src/agent-tavern/body-rollback.js'
import {
  restoreBodyAfterFailure,
  type BodyAgentLike,
  type BodyRuntimeDeps,
  type BodyRuntimeFailure,
  type BodySessionLike,
  type PendingBodyOperation,
} from '../src/agent-tavern/body-runtime.js'
import { memoryTools } from '../src/agent-tavern/tools/memory.js'
import { memoryStore, tavernStore, variableStore } from '../src/agent-tavern/tools/stores.js'
import { variableTools } from '../src/agent-tavern/tools/variable.js'
import type { ToolDefinition } from '../src/agent-tavern/tools/shared.js'
import { readWriteJournal } from '../src/agent-tavern/write-journal.js'
import { appendMvuReceipt, readMvuReceipts, type MvuReceipt } from '../src/mvu.js'

const HOST_PACKAGE = '@deepseek-ai/dsh-session'
const DATA_DIR = 'soulmojito'
const OLD_TURN = 7
const OLD_MESSAGE_ID = 'assistant-old-integration'
const OLD_GROUP_ID = 'body-group-integration'
const BODY_RECEIPT_AT = '2026-10-28T05:00:00.000Z'
const SETTLE_RECEIPT_AT = '2026-10-28T05:10:00.000Z'
const OLD_BODY = [
  'Past evening under the lanterns.',
  '<UpdateVariable>',
  '<JSONPatch>',
  '[{ "op": "replace", "path": "/stat_data/hp", "value": 20 }]',
  '</JSONPatch>',
  '</UpdateVariable>',
].join('\n')
const NEW_TURN_BODY = 'The failed new turn body.'
const OLD_CHAT_VARIABLES = { stat_data: { hp: 20, mood: 'calm' } }
const OLD_CHAT_VARIABLES_UNDONE = { stat_data: { hp: 10, mood: 'calm' } }
const OLD_VARIABLE_NAME = 'old.turn.flag'
const NEW_VARIABLE_NAME = 'new.turn.flag'
const SETTLE_VARIABLE_NAME = 'mvu.favor'
const FAILED_TURN = OLD_TURN + 1
const CANDIDATE_MESSAGE_ID = 'assistant-new-restore-drift'
const TRIGGER_MESSAGE_ID = 'body-trigger-restore-drift'
const CANDIDATE_BODY = [
  'The failed regeneration.',
  '<UpdateVariable>',
  '<JSONPatch>',
  '[{ "op": "replace", "path": "/stat_data/hp", "value": 20 }]',
  '</JSONPatch>',
  '</UpdateVariable>',
].join('\n')

const hostState = vi.hoisted(() => ({
  module: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../../bind/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../bind/src/index.js')>()
  return {
    ...actual,
    importHostPackage: async (name: string): Promise<unknown> => {
      if (name !== HOST_PACKAGE) throw new Error(`unexpected host package import: ${name}`)
      if (hostState.module === undefined) throw new Error(`${HOST_PACKAGE} is not installed`)
      return hostState.module
    },
  }
})

const tools = new Map<string, ToolDefinition>(
  [...memoryTools(), ...variableTools()].map((definition) => [definition.name, definition] as const),
)

interface TestSession {
  readonly id: string
  readonly events: unknown[]
}

interface ToolExec {
  readonly agent: { readonly id: string; readonly session: TestSession }
}

interface Fixture {
  readonly sessionId: string
  readonly character: string
  readonly chatId: string
  readonly store: TavernStore
  readonly memory: MemoryStore
  readonly variables: VariableStore
  readonly session: TestSession
}

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields: Record<string, unknown> | undefined
}

interface RecordingLogger {
  readonly logger: BodyRollbackLogger
  readonly entries: LogEntry[]
}

interface OldTurnOptions {
  readonly fixture: Fixture
  readonly port: BodyWriteRollbackPort
  readonly turn: number
  readonly previousMessageId: string
  readonly groupId: string
}

interface PreparedOldTurn {
  readonly plan: BodyRollbackPlan
  readonly memoryCreated: MemoryRecord
  readonly memoryUpdatedBefore: MemoryRecord
  readonly memoryUpdatedAfter: MemoryRecord
  readonly variableAfter: VariableSnapshot
  readonly floorIndex: number
  readonly chatRevision: string
}

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-tavern-body-rollback-integration-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  hostState.module = {
    appendPluginRecord: (session: unknown, type: string, data: unknown): number => {
      const events = asRecord(session)['events']
      if (!Array.isArray(events)) throw new Error('fake host: session has no events array')
      const list: unknown[] = events
      const seq = list.length
      list.push({ seq, time: Date.now(), type, data })
      return seq
    },
  }
})

describe('AgentTavern body rollback integration (real stores + live write journal)', () => {
  it('prepares an old turn from the live journal, rolls the real stores back, and restores them', async () => {
    const fixture = await createFixture('prepare')
    const recording = recordingLogger()
    const port = createPort(fixture, recording.logger)
    const old = await prepareOldTurn({
      fixture,
      port,
      turn: OLD_TURN,
      previousMessageId: OLD_MESSAGE_ID,
      groupId: OLD_GROUP_ID,
    })

    expect(old.plan.journal.map((write) => `${write.kind}:${write.tool}`)).toEqual([
      'memory:memory_write',
      'memory:memory_update',
      'variable:variable_set',
    ])
    expect(old.plan.mvuReceipts).toHaveLength(1)
    expect(old.plan.mvuReceipts[0]).toMatchObject({ turnKey: `body:${OLD_MESSAGE_ID}`, at: BODY_RECEIPT_AT })
    expect(old.plan.chatRevision).toBe(old.chatRevision)
    expect(old.plan.preparedRevision).not.toBe(old.chatRevision)
    expect(old.plan.floorIndex).toBe(old.floorIndex)
    expect(old.plan.bodyText).toBeUndefined()
    expect(old.plan.diagnostics.map((entry) => entry.code)).toEqual(['vector-restore-skipped'])

    // prepare: the live journal undo reaches the real flat stores.
    const createdAfterUndo = await requireMemory(fixture, old.memoryCreated.id)
    expect(createdAfterUndo.deletedAt).toBeDefined()
    expect(await fixture.memory.read(old.memoryCreated.id, 'chat', fixture.chatId, false)).toBeUndefined()
    const updatedAfterUndo = await requireMemory(fixture, old.memoryUpdatedBefore.id)
    expect(updatedAfterUndo.content).toBe('old turn update before')
    expect(updatedAfterUndo.revision).toBe(old.memoryUpdatedBefore.revision)
    expect(await fixture.variables.get('chat', fixture.chatId, OLD_VARIABLE_NAME)).toBeUndefined()
    const variablesAfterUndo = await fixture.variables.list('chat', fixture.chatId)
    expect(variablesAfterUndo.map((snapshot) => snapshot.name)).not.toContain(OLD_VARIABLE_NAME)

    // prepare: the body receipt undo reaches the real chat tree and receipt log.
    const rolledBack = await chatOf(fixture)
    expect(rolledBack.header.chat_metadata.variables).toEqual(OLD_CHAT_VARIABLES_UNDONE)
    const receiptsAfterUndo = readMvuReceipts(rolledBack)
    expect(receiptsAfterUndo).toHaveLength(1)
    expect(receiptsAfterUndo[0]?.undoneAt).toBeDefined()

    // restore: the same plan replays the journal and the body receipt.
    await port.restore(old.plan)

    const createdAfterRestore = await requireMemory(fixture, old.memoryCreated.id)
    expect(createdAfterRestore.deletedAt).toBeUndefined()
    expect(createdAfterRestore.content).toBe('created by the old turn')
    expect(createdAfterRestore.revision).toBe(old.memoryCreated.revision)
    const updatedAfterRestore = await requireMemory(fixture, old.memoryUpdatedBefore.id)
    expect(updatedAfterRestore.content).toBe('old turn update after')
    expect(updatedAfterRestore.revision).toBe(old.memoryUpdatedAfter.revision)
    expect(await fixture.variables.get('chat', fixture.chatId, OLD_VARIABLE_NAME)).toMatchObject({
      value: 'set-by-old-turn',
      revision: old.variableAfter.revision,
    })

    const restored = await chatOf(fixture)
    expect(restored.header.chat_metadata.variables).toEqual(OLD_CHAT_VARIABLES)
    expect(readMvuReceipts(restored)[0]?.undoneAt).toBeUndefined()
    expect(restored.messages[old.floorIndex]).toMatchObject({
      mes: OLD_BODY,
      send_date: BODY_RECEIPT_AT,
      swipes: [OLD_BODY],
      swipe_id: 0,
      extra: { agentTavern: { bodyGroupId: OLD_GROUP_ID, anchorMessageId: OLD_MESSAGE_ID } },
    })

    expect(recording.entries).toContainEqual(expect.objectContaining({
      level: 'info',
      message: 'dsh-soulmojito body rollback: prepared',
    }))
    expect(recording.entries).toContainEqual(expect.objectContaining({
      level: 'info',
      message: 'dsh-soulmojito body rollback: restored',
    }))
    expect(recording.entries).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'dsh-soulmojito body rollback: memory vectors skipped',
    }))
  })

  it('undoes a failed new turn in the real stores before restoring the prepared old turn', async () => {
    const fixture = await createFixture('new-turn')
    const recording = recordingLogger()
    const port = createPort(fixture, recording.logger)
    const old = await prepareOldTurn({
      fixture,
      port,
      turn: OLD_TURN,
      previousMessageId: OLD_MESSAGE_ID,
      groupId: OLD_GROUP_ID,
    })

    const newTurn = OLD_TURN + 1
    const favorBefore = await fixture.variables.set('chat', fixture.chatId, SETTLE_VARIABLE_NAME, 1)
    openTurn(fixture.session, newTurn)

    pushToolCall(fixture.session, newTurn, 'memory_write')
    const newMemoryOutput = await runTool(fixture, 'memory_write', {
      scope: 'chat',
      kind: 'semantic',
      content: 'the failed new turn created this',
    })
    const newMemoryId = requireString(newMemoryOutput, 'id')
    const newMemory = await requireMemory(fixture, newMemoryId)

    pushToolCall(fixture.session, newTurn, 'variable_set')
    await runTool(fixture, 'variable_set', {
      scope: 'chat',
      name: NEW_VARIABLE_NAME,
      value: 'set-by-new-turn',
    })
    const newVariable = await fixture.variables.get('chat', fixture.chatId, NEW_VARIABLE_NAME)
    if (newVariable === undefined) throw new Error('new-turn variable is missing after the tool write')

    pushToolCall(fixture.session, newTurn, 'tavern_variable_settle')
    const favorAfter = await fixture.variables.set(
      'chat',
      fixture.chatId,
      SETTLE_VARIABLE_NAME,
      2,
      favorBefore.revision,
    )
    expect(favorAfter.value).toBe(2)

    const beforeSettleFloor = await fixture.store.getChatSnapshot(fixture.character, fixture.chatId)
    if (beforeSettleFloor === undefined) throw new Error('fixture chat is missing')
    const floor = beforeSettleFloor.chat.messages.length
    beforeSettleFloor.chat.messages.push({
      name: fixture.character,
      is_user: false,
      is_system: false,
      send_date: SETTLE_RECEIPT_AT,
      mes: NEW_TURN_BODY,
      extra: { agentTavern: { turn: newTurn } },
    })
    appendMvuReceipt(beforeSettleFloor.chat, settleReceipt(SETTLE_RECEIPT_AT, floor))
    await fixture.store.saveChat(
      fixture.character,
      fixture.chatId,
      beforeSettleFloor.chat,
      beforeSettleFloor.revision,
    )

    const result = await port.rollbackTurnWrites(fixture.sessionId, newTurn)

    expect(result).toMatchObject({
      sessionId: fixture.sessionId,
      turn: newTurn,
      undone: 2,
      receiptsUndone: 1,
      skippedUncommitted: [],
      failures: [],
    })
    expect(result.diagnostics).toEqual([])

    // rollbackTurnWrites: the new memory and flat variable are gone.
    const newMemoryAfterUndo = await requireMemory(fixture, newMemory.id)
    expect(newMemoryAfterUndo.deletedAt).toBeDefined()
    expect(await fixture.memory.read(newMemory.id, 'chat', fixture.chatId, false)).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, NEW_VARIABLE_NAME)).toBeUndefined()
    const variablesAfterNewTurnUndo = await fixture.variables.list('chat', fixture.chatId)
    expect(variablesAfterNewTurnUndo.map((snapshot) => snapshot.name)).not.toContain(NEW_VARIABLE_NAME)

    // rollbackTurnWrites: the settle receipt restored the flat value and is marked undone.
    expect(await fixture.variables.get('chat', fixture.chatId, SETTLE_VARIABLE_NAME)).toMatchObject({
      value: 1,
      revision: favorBefore.revision,
    })
    const afterNewTurnUndo = await chatOf(fixture)
    const receiptsAfterNewTurnUndo = readMvuReceipts(afterNewTurnUndo)
    expect(receiptsAfterNewTurnUndo).toHaveLength(2)
    expect(receiptsAfterNewTurnUndo[0]).toMatchObject({ turnKey: `body:${OLD_MESSAGE_ID}` })
    expect(receiptsAfterNewTurnUndo[0]?.undoneAt).toBeDefined()
    expect(receiptsAfterNewTurnUndo[1]).toMatchObject({ turnKey: String(floor) })
    expect(receiptsAfterNewTurnUndo[1]?.undoneAt).toBeDefined()

    // restore the old plan after the new turn is fully unwound.
    await port.restore(old.plan)

    const oldMemoryRestored = await requireMemory(fixture, old.memoryCreated.id)
    expect(oldMemoryRestored.deletedAt).toBeUndefined()
    expect(oldMemoryRestored.revision).toBe(old.memoryCreated.revision)
    const oldUpdatedRestored = await requireMemory(fixture, old.memoryUpdatedBefore.id)
    expect(oldUpdatedRestored.content).toBe('old turn update after')
    expect(oldUpdatedRestored.revision).toBe(old.memoryUpdatedAfter.revision)
    expect(await fixture.variables.get('chat', fixture.chatId, OLD_VARIABLE_NAME)).toMatchObject({
      value: 'set-by-old-turn',
      revision: old.variableAfter.revision,
    })

    // The new turn stays unwound, including its settle flat value.
    expect((await requireMemory(fixture, newMemory.id)).deletedAt).toBeDefined()
    expect(await fixture.variables.get('chat', fixture.chatId, NEW_VARIABLE_NAME)).toBeUndefined()
    expect(await fixture.variables.get('chat', fixture.chatId, SETTLE_VARIABLE_NAME)).toMatchObject({ value: 1 })

    const finalChat = await chatOf(fixture)
    expect(finalChat.header.chat_metadata.variables).toEqual(OLD_CHAT_VARIABLES)
    const finalReceipts = readMvuReceipts(finalChat)
    expect(finalReceipts).toHaveLength(2)
    expect(finalReceipts[0]).toMatchObject({ turnKey: `body:${OLD_MESSAGE_ID}` })
    expect(finalReceipts[0]?.undoneAt).toBeUndefined()
    expect(finalReceipts[1]).toMatchObject({ turnKey: String(floor) })
    expect(finalReceipts[1]?.undoneAt).toBeDefined()

    // The old body data is untouched by both the new-turn undo and the restore.
    expect(finalChat.messages).toHaveLength(3)
    expect(finalChat.messages[old.floorIndex]).toMatchObject({
      mes: OLD_BODY,
      send_date: BODY_RECEIPT_AT,
      swipes: [OLD_BODY],
      swipe_id: 0,
      extra: { agentTavern: { bodyGroupId: OLD_GROUP_ID, anchorMessageId: OLD_MESSAGE_ID } },
    })
    expect(finalChat.messages[floor]?.mes).toBe(NEW_TURN_BODY)

    expect(recording.entries).toContainEqual(expect.objectContaining({
      level: 'info',
      message: 'dsh-soulmojito body rollback: rolled back new-turn writes',
    }))
  })

  it('refuses a runtime restore on a drifted binding before writing the old chat', async () => {
    const fixture = await createFixture('restore-drift')
    const port = createPort(fixture, {})
    const old = await prepareOldTurn({
      fixture,
      port,
      turn: OLD_TURN,
      previousMessageId: OLD_MESSAGE_ID,
      groupId: OLD_GROUP_ID,
    })

    // The failed new turn projected its candidate receipt into the plan's chat
    // before the process died; that receipt is what a premature restore undo
    // would mark and save.
    const withCandidate = await snapshotOf(fixture, fixture.chatId)
    appendMvuReceipt(withCandidate.chat, candidateReceipt(CANDIDATE_MESSAGE_ID))
    await fixture.store.saveChat(
      fixture.character,
      fixture.chatId,
      withCandidate.chat,
      withCandidate.revision,
    )

    // Branch the chat and move the session to the branch: the plan's chat stays
    // on disk with live receipts, exactly like a user branch after a crash.
    const branchChatId = await fixture.store.createChat(
      fixture.character,
      structuredClone(withCandidate.chat.header),
      structuredClone(withCandidate.chat.messages),
    )
    await fixture.store.updateState((state) => {
      const binding = state.sessionBindings[fixture.sessionId]
      if (binding === undefined) throw new Error('fixture binding is missing')
      return {
        sessionBindings: {
          ...state.sessionBindings,
          [fixture.sessionId]: { ...binding, chatId: branchChatId },
        },
      }
    })

    const oldChatBefore = await snapshotOf(fixture, fixture.chatId)
    const branchBefore = await snapshotOf(fixture, branchChatId)

    const calls: string[] = []
    const recordingPort: BodyWriteRollbackPort = {
      ...port,
      rollbackTurnWrites: async (agentId: string, turn: number) => {
        calls.push(`rollback-turn:${turn}`)
        return port.rollbackTurnWrites(agentId, turn)
      },
      restore: async (plan: BodyRollbackPlan) => {
        calls.push('restore')
        return port.restore(plan)
      },
    }
    const harness = createRuntimeHarness(fixture, recordingPort)
    seedRestoreSession(harness)
    const eventsBefore = harness.events.length
    const op: PendingBodyOperation = {
      opId: 'body-op-restore-drift',
      groupId: OLD_GROUP_ID,
      previousAnchorId: OLD_MESSAGE_ID,
      previousIndex: 0,
      startSeq: 0,
      agentId: fixture.sessionId,
      triggerMessageId: TRIGGER_MESSAGE_ID,
      turn: FAILED_TURN,
      rollbackPlan: old.plan,
    }

    const failure = await restoreBodyAfterFailure(harness.deps, op).then(
      () => { throw new Error('expected the drifted restore to refuse') },
      (error: unknown) => error as BodyRuntimeFailure,
    )

    expect(failure.code).toBe('operation-failed')
    expect(failure.message).toContain(fixture.chatId)
    expect(failure.message).toContain(branchChatId)
    expect(failure.cause).toMatchObject({ code: 'body-rollback-target-missing' })

    // The refusal is the first restore step: no port call and no session write.
    expect(calls).toEqual([])
    expect(harness.events).toHaveLength(eventsBefore)

    // The old chat is neither saved nor half-rolled-back, and the branch keeps
    // its live copy of the candidate receipt.
    const oldChatAfter = await snapshotOf(fixture, fixture.chatId)
    expect(oldChatAfter.revision).toBe(oldChatBefore.revision)
    expect(receiptOf(oldChatAfter.chat, CANDIDATE_MESSAGE_ID)?.undoneAt).toBeUndefined()
    const branchAfter = await snapshotOf(fixture, branchChatId)
    expect(branchAfter.revision).toBe(branchBefore.revision)
    expect(receiptOf(branchAfter.chat, CANDIDATE_MESSAGE_ID)?.undoneAt).toBeUndefined()
  })
})

async function createFixture(label: string): Promise<Fixture> {
  const sessionId = `session-rollback-integration-${label}`
  const character = `Rollback Integration ${label}`
  const store = await tavernStore()
  if (store.rootPath !== join(home, DATA_DIR)) {
    throw new Error(`tavern store opened at '${store.rootPath}' instead of the temporary DSH_HOME`)
  }
  await store.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character,
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
  const chatId = await store.createChat(character, {
    user_name: 'User',
    character_name: character,
    chat_metadata: {},
  })
  await store.updateState((state) => ({
    sessionBindings: {
      ...state.sessionBindings,
      [sessionId]: {
        architecture: 'agent-tavern',
        contextMode: 'dsh-native',
        character,
        chatId,
      },
    },
  }))
  const memory = await memoryStore()
  const variables = await variableStore()
  const session: TestSession = { id: sessionId, events: [] }
  return { sessionId, character, chatId, store, memory, variables, session }
}

function createPort(fixture: Fixture, logger: BodyRollbackLogger): BodyWriteRollbackPort {
  return createBodyWriteRollbackPort({
    store: fixture.store,
    memoryStore: fixture.memory,
    variableStore: fixture.variables,
    sessionEvents: async (sessionId: string) => {
      if (sessionId !== fixture.sessionId) throw new Error(`unexpected session '${sessionId}'`)
      return fixture.session.events
    },
    logger,
  })
}

async function prepareOldTurn(options: OldTurnOptions): Promise<PreparedOldTurn> {
  const { fixture } = options
  const memoryUpdatedBefore = await fixture.memory.put({
    scope: 'chat',
    scopeId: fixture.chatId,
    kind: 'semantic',
    content: 'old turn update before',
    tags: ['rollback-integration'],
    importance: 0.5,
    confidence: 1,
    source: {
      kind: 'agent-tool',
      sessionId: fixture.sessionId,
      chatId: fixture.chatId,
      character: fixture.character,
    },
  })

  openTurn(fixture.session, options.turn)

  pushToolCall(fixture.session, options.turn, 'memory_write')
  const createdOutput = await runTool(fixture, 'memory_write', {
    scope: 'chat',
    kind: 'semantic',
    content: 'created by the old turn',
  })
  const memoryCreated = await requireMemory(fixture, requireString(createdOutput, 'id'))

  pushToolCall(fixture.session, options.turn, 'memory_update')
  await runTool(fixture, 'memory_update', {
    id: memoryUpdatedBefore.id,
    scope: 'chat',
    expectedRevision: memoryUpdatedBefore.revision,
    content: 'old turn update after',
  })
  const memoryUpdatedAfter = await requireMemory(fixture, memoryUpdatedBefore.id)

  pushToolCall(fixture.session, options.turn, 'variable_set')
  await runTool(fixture, 'variable_set', {
    scope: 'chat',
    name: OLD_VARIABLE_NAME,
    value: 'set-by-old-turn',
  })
  const variableAfter = await fixture.variables.get('chat', fixture.chatId, OLD_VARIABLE_NAME)
  if (variableAfter === undefined) throw new Error('old-turn variable is missing after the tool write')

  const journalEntries = readWriteJournal(fixture.session.events).filter((entry) => entry.turn === options.turn)
  expect(journalEntries.map((entry) => `${entry.kind}:${entry.tool}:${entry.phase}`)).toEqual([
    'memory:memory_write:before',
    'memory:memory_write:after',
    'memory:memory_update:before',
    'memory:memory_update:after',
    'variable:variable_set:before',
    'variable:variable_set:after',
  ])

  const snapshot = await fixture.store.getChatSnapshot(fixture.character, fixture.chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  snapshot.chat.header.chat_metadata.variables = structuredClone(OLD_CHAT_VARIABLES)
  appendMvuReceipt(snapshot.chat, bodyReceipt(BODY_RECEIPT_AT, options.previousMessageId))
  snapshot.chat.messages.push({
    name: 'User',
    is_user: true,
    is_system: false,
    send_date: BODY_RECEIPT_AT,
    mes: 'Continue.',
  })
  const floorIndex = snapshot.chat.messages.length
  snapshot.chat.messages.push({
    name: fixture.character,
    is_user: false,
    is_system: false,
    send_date: BODY_RECEIPT_AT,
    mes: OLD_BODY,
    swipes: [OLD_BODY],
    swipe_id: 0,
    extra: {
      agentTavern: {
        bodyGroupId: options.groupId,
        anchorMessageId: options.previousMessageId,
      },
    },
  })
  const chatRevision = await fixture.store.saveChat(
    fixture.character,
    fixture.chatId,
    snapshot.chat,
    snapshot.revision,
  )

  const plan = await options.port.prepare(fixture.sessionId, options.turn, options.previousMessageId)
  return {
    plan,
    memoryCreated,
    memoryUpdatedBefore,
    memoryUpdatedAfter,
    variableAfter,
    floorIndex,
    chatRevision,
  }
}

function openTurn(session: TestSession, turn: number): void {
  pushEvent(session, 'turn/start', { turn })
}

function pushToolCall(session: TestSession, turn: number, name: string): void {
  const index = session.events.length
  pushEvent(session, 'assistant/message', {
    turn,
    step: 1,
    message: {
      id: `assistant-${index}`,
      role: 'assistant',
      content: [{ type: 'tool-call', callId: `call-${index}`, name, arguments: '{}' }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  })
}

function pushEvent(session: TestSession, type: string, data: unknown): void {
  session.events.push({ seq: session.events.length, time: Date.now(), type, data })
}

async function runTool(fixture: Fixture, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool '${name}' is not registered`)
  const exec: ToolExec = { agent: { id: fixture.sessionId, session: fixture.session } }
  return asRecord(await definition.execute(args, exec))
}

async function requireMemory(fixture: Fixture, id: string): Promise<MemoryRecord> {
  const record = await fixture.memory.read(id, 'chat', fixture.chatId, true)
  if (record === undefined) throw new Error(`memory '${id}' is missing from the chat store`)
  return record
}

async function chatOf(fixture: Fixture): Promise<ChatLogIR> {
  const snapshot = await fixture.store.getChatSnapshot(fixture.character, fixture.chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  return snapshot.chat
}

function bodyReceipt(at: string, messageId: string): MvuReceipt {
  return {
    at,
    turnKey: `body:${messageId}`,
    status: 'updated',
    changes: [{ name: 'stat_data.hp', before: 10, after: 20 }],
    failures: [],
  }
}

function settleReceipt(at: string, floor: number): MvuReceipt {
  return {
    at,
    turnKey: String(floor),
    status: 'updated',
    changes: [{ name: SETTLE_VARIABLE_NAME, before: 1, after: 2 }],
    failures: [],
  }
}

function recordingLogger(): RecordingLogger {
  const entries: LogEntry[] = []
  return {
    entries,
    logger: {
      info: (message, fields) => { entries.push({ level: 'info', message, fields }) },
      warn: (message, fields) => { entries.push({ level: 'warn', message, fields }) },
      error: (message, fields) => { entries.push({ level: 'error', message, fields }) },
    },
  }
}

/* ------------------- runtime restore harness (binding drift) ---------------- */

interface RuntimeHarness {
  readonly deps: BodyRuntimeDeps
  readonly events: unknown[]
}

/**
 * Minimal `BodyRuntimeDeps` around the real fixture session binding. The fake
 * session only records appends — the drift test refuses before any write, so
 * the surface is derived from the seeded events and the append seam stays a
 * recorder.
 */
function createRuntimeHarness(fixture: Fixture, port: BodyWriteRollbackPort): RuntimeHarness {
  const events: unknown[] = []
  const session: BodySessionLike = {
    id: fixture.sessionId,
    header: { version: 4 },
    events,
    get surface() {
      const nodes: number[] = []
      for (const [index, event] of events.entries()) {
        const type = (event as { type?: unknown }).type
        if (type === 'user/message' || type === 'assistant/message') nodes.push(index)
      }
      return { nodes }
    },
    append: (type: string, data: unknown) => {
      const event = { type, seq: events.length, time: Date.now(), data }
      events.push(event)
      return event
    },
  }
  const agent: BodyAgentLike = {
    id: fixture.sessionId,
    session,
    status: 'idle',
    phase: { kind: 'idle', lastTurn: FAILED_TURN },
    followup: () => undefined,
  }
  return {
    deps: {
      session,
      agent,
      appendRecord: (target: BodySessionLike, type: string, data: unknown) => target.append(type, data),
      writeRollback: port,
    },
    events,
  }
}

/** Closed old turn plus the closed failed turn whose candidate carries an MVU patch. */
function seedRestoreSession(harness: RuntimeHarness): void {
  const events = harness.events
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ type, seq: events.length, time: Date.now(), data })
  }
  push('turn/start', { turn: 1 })
  push('user/message', {
    id: 'user-old',
    role: 'user',
    content: [{ type: 'text', text: 'Go on.' }],
    source: { kind: 'user' },
  })
  push('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: {
      id: OLD_MESSAGE_ID,
      role: 'assistant',
      content: [{ type: 'text', text: OLD_BODY }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  push('turn/start', { turn: FAILED_TURN })
  push('user/message', {
    id: TRIGGER_MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text: 'Regenerate the last reply.' }],
    source: { kind: 'plugin:dsh-soulmojito', form: 'body-regenerate' },
  })
  push('assistant/message', {
    turn: FAILED_TURN,
    step: 1,
    stream: [],
    message: {
      id: CANDIDATE_MESSAGE_ID,
      role: 'assistant',
      content: [{ type: 'text', text: CANDIDATE_BODY }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  })
  push('turn/end', { turn: FAILED_TURN, reason: { kind: 'error', error: { message: 'model failed', code: 'TEST' } } })
}

function candidateReceipt(messageId: string): MvuReceipt {
  return {
    at: SETTLE_RECEIPT_AT,
    turnKey: `body:${messageId}`,
    status: 'updated',
    changes: [{ name: 'stat_data.hp', before: 10, after: 20 }],
    failures: [],
  }
}

function receiptOf(chat: ChatLogIR, messageId: string): MvuReceipt | undefined {
  return readMvuReceipts(chat).find((receipt) => receipt.turnKey === `body:${messageId}`)
}

async function snapshotOf(fixture: Fixture, chatId: string): Promise<{ chat: ChatLogIR; revision: string }> {
  const snapshot = await fixture.store.getChatSnapshot(fixture.character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' is missing`)
  return snapshot
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field '${field}' must be a non-empty string, received '${String(value)}'`)
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object value')
  }
  return value as Record<string, unknown>
}
