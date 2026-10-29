/**
 * Write journal regression (proposal 0022 §3, §8, §9).
 *
 * The host plugin-record seam is replaced through the bind package mock, every
 * session is a synthetic event array, and the stores live in a throwaway
 * DSH_HOME. The character, chat, memories and variables here are all
 * synthetic: no real card or user data is read.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TavernStore } from '../../tavern-store/src/index.js'
import type { JsonValue, MemoryRecord, VariableSnapshot } from '../../tavern-store/src/index.js'
import { memoryTools } from '../src/agent-tavern/tools/memory.js'
import { variableTools } from '../src/agent-tavern/tools/variable.js'
import {
  SETTLE_INTENT_EVENT_TYPE,
  WRITE_JOURNAL_EVENT_TYPE,
  appendSettleIntentWith,
  appendWriteJournal,
  appendWriteJournalWith,
  currentTurnOf,
  foldSettleIntents,
  jsonSafeSettleReceipt,
  newJournalId,
  readSettleIntents,
  readWriteJournal,
  type SettleIntentDecideEntry,
  type SettleIntentEntry,
  type SettleIntentExtendEntry,
  type SettleIntentOpenEntry,
  type WriteJournalEntry,
  type WriteJournalMemoryEntry,
  type WriteJournalMemoryTool,
  type WriteJournalPhase,
  type WriteJournalVariableEntry,
  type WriteJournalVariableTool,
} from '../src/agent-tavern/write-journal.js'

const hostState = vi.hoisted(() => ({
  module: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../../bind/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../bind/src/index.js')>()
  return {
    ...actual,
    importHostPackage: async (name: string): Promise<unknown> => {
      if (name !== '@deepseek-ai/dsh-session') throw new Error(`unexpected host package import: ${name}`)
      if (hostState.module === undefined) throw new Error('@deepseek-ai/dsh-session is not installed')
      return hostState.module
    },
  }
})

const AGENT_ID = 'native'
const CHARACTER = 'Journal Test Character'
const CREATED_AT = '2026-10-28T00:00:00.000Z'

interface TestSession {
  readonly id: string
  readonly events: unknown[]
  appendPluginRecord(type: string, data: unknown): number
}

interface JournalSessionHarness {
  readonly session: TestSession
  failPhase: WriteJournalPhase | undefined
  openTurn(turn: number): void
  closeTurn(turn: number): void
}

/**
 * Minimal session double: an append-only event array plus the host
 * `appendPluginRecord` method the mock writer delegates to. `failPhase` makes
 * the append throw for one phase, which is how the tests probe ordering.
 */
function createJournalSession(openTurn: number | undefined): JournalSessionHarness {
  const events: unknown[] = []
  const harness: JournalSessionHarness = {
    session: {
      id: `session-${events.length}`,
      events,
      appendPluginRecord: (type: string, data: unknown): number => {
        const record = asRecord(data)
        const phase = record['phase']
        if (harness.failPhase !== undefined && phase === harness.failPhase) {
          throw new Error(`synthetic journal append failure for phase '${String(phase)}'`)
        }
        const seq = events.length
        events.push({ seq, type, data })
        return seq
      },
    },
    failPhase: undefined,
    openTurn: (turn: number): void => {
      events.push({ seq: events.length, type: 'turn/start', data: { turn } })
    },
    closeTurn: (turn: number): void => {
      events.push({ seq: events.length, type: 'turn/end', data: { turn } })
    },
  }
  if (openTurn !== undefined) harness.openTurn(openTurn)
  return harness
}

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string; session?: unknown } }): Promise<unknown>
}

interface ToolExec {
  readonly agent: { readonly id: string; readonly session: unknown }
}

const tools = new Map<string, RegisteredTool>()

function execOf(harness: JournalSessionHarness): ToolExec {
  return { agent: { id: AGENT_ID, session: harness.session } }
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  harness: JournalSessionHarness,
): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool '${name}' is not registered`)
  return asRecord(await definition.execute(args, execOf(harness)))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object value')
  return value as Record<string, unknown>
}

function memoryEntries(
  harness: JournalSessionHarness,
  tool: WriteJournalMemoryTool,
): WriteJournalMemoryEntry[] {
  return readWriteJournal(harness.session.events)
    .filter((entry): entry is WriteJournalMemoryEntry => entry.kind === 'memory' && entry.tool === tool)
}

function variableEntries(
  harness: JournalSessionHarness,
  tool: WriteJournalVariableTool,
): WriteJournalVariableEntry[] {
  return readWriteJournal(harness.session.events)
    .filter((entry): entry is WriteJournalVariableEntry => entry.kind === 'variable' && entry.tool === tool)
}

/** Contents of a `memory_search` result, used as the store witness. */
async function searchedContents(query: string): Promise<unknown[]> {
  const result = await runTool('memory_search', { query, scope: 'chat' }, createJournalSession(undefined))
  const hits = result['hits']
  if (!Array.isArray(hits)) throw new Error('memory_search returned no hits array')
  return hits.map((hit) => asRecord(hit)['content'])
}

function memoryRecordFixture(id: string, content: string, revision: string): MemoryRecord {
  return {
    id,
    scope: 'chat',
    scopeId: 'fixture-chat',
    kind: 'semantic',
    content,
    tags: ['synthetic'],
    importance: 0.5,
    confidence: 0.9,
    source: { kind: 'agent-tool', sessionId: AGENT_ID, chatId: 'fixture-chat', character: 'Fixture Character' },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision,
  }
}

function variableSnapshotFixture(name: string, value: JsonValue): VariableSnapshot {
  return { scope: 'chat', scopeId: 'fixture-chat', name, value, revision: 'rev-1', updatedAt: CREATED_AT }
}

function settleIntentFixture(opId: string, items: SettleIntentOpenEntry['items']): SettleIntentOpenEntry {
  return {
    kind: 'settle-intent',
    phase: 'open',
    opId,
    sessionId: AGENT_ID,
    character: CHARACTER,
    scope: 'chat',
    scopeId: 'fixture-chat',
    turnKey: '4',
    receiptAt: CREATED_AT,
    at: CREATED_AT,
    items,
  }
}

/** Decision fixture: the exact receipt the batch was about to persist. */
function settleDecisionFixture(opId: string): SettleIntentDecideEntry {
  return {
    kind: 'settle-intent',
    phase: 'decide',
    opId,
    sessionId: AGENT_ID,
    at: CREATED_AT,
    chatCharacter: CHARACTER,
    chatId: 'fixture-chat',
    receipt: {
      at: CREATED_AT,
      turnKey: '4',
      status: 'updated',
      changes: [{ name: 'mood', before: 'calm', after: 'alert' }],
      failures: [],
      opId,
    },
  }
}

/** Raw event wrapper: invalid payloads must reach the parser untyped. */
function settleEventsOf(...data: unknown[]): unknown[] {
  return data.map((entry, seq) => ({ seq, type: SETTLE_INTENT_EVENT_TYPE, data: entry }))
}

let home: string
let chatId: string

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-tavern-write-journal-'))
  process.env.DSH_HOME = home
  const store = await TavernStore.open(join(home, 'soulmojito'))
  await store.importCharacter({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER,
      description: 'A synthetic character used only by write journal tests.',
      personality: 'Careful',
      scenario: 'A quiet test room.',
      first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    },
  })
  chatId = await store.createChat(CHARACTER, {
    user_name: 'Tester',
    character_name: CHARACTER,
    chat_metadata: { createdAt: CREATED_AT },
  })
  await store.updateState(() => ({
    sessionBindings: {
      [AGENT_ID]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId },
    },
  }))

  for (const definition of [...memoryTools(), ...variableTools()]) tools.set(definition.name, definition)
})

afterAll(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  hostState.module = {
    appendPluginRecord: (session: unknown, type: string, data: unknown): unknown => {
      const method = asRecord(session)['appendPluginRecord']
      if (typeof method !== 'function') throw new Error('fake host: session has no appendPluginRecord')
      return method.call(session, type, data)
    },
  }
})

describe('currentTurnOf', () => {
  it('returns the open turn and clears it on turn/end', () => {
    expect(currentTurnOf([])).toBeUndefined()
    expect(currentTurnOf([
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { text: 'hello' } },
    ])).toBe(1)
    expect(currentTurnOf([
      { seq: 0, type: 'turn/start', data: { turn: 2 } },
      { seq: 1, type: 'turn/end', data: { turn: 2 } },
    ])).toBeUndefined()
    expect(currentTurnOf([
      { seq: 0, type: 'turn/start', data: { turn: 2 } },
      { seq: 1, type: 'turn/end', data: { turn: 2 } },
      { seq: 2, type: 'turn/start', data: { turn: 3 } },
    ])).toBe(3)
  })

  it('rejects a turn/start without an integer turn instead of guessing', () => {
    expect(() => currentTurnOf([{ seq: 0, type: 'turn/start', data: {} }])).toThrow(/non-negative integer/)
  })
})

describe('readWriteJournal', () => {
  it('replays before/after records in log order and ignores other events', () => {
    const journalId = newJournalId()
    const before = memoryRecordFixture('memory-replay', 'before content', 'rev-1')
    const after = memoryRecordFixture('memory-replay', 'after content', 'rev-2')
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 4 } },
      {
        seq: 1,
        type: WRITE_JOURNAL_EVENT_TYPE,
        data: {
          kind: 'memory', tool: 'memory_write', journalId, sessionId: AGENT_ID, turn: 4,
          phase: 'before', at: CREATED_AT,
          target: { id: before.id, scope: 'chat', scopeId: 'fixture-chat' },
          before,
        },
      },
      { seq: 2, type: 'assistant/message', data: { message: { id: 'm1', role: 'assistant', content: [] } } },
      {
        seq: 3,
        type: WRITE_JOURNAL_EVENT_TYPE,
        data: {
          kind: 'memory', tool: 'memory_write', journalId, sessionId: AGENT_ID, turn: 4,
          phase: 'after', at: CREATED_AT,
          target: { id: after.id, scope: 'chat', scopeId: 'fixture-chat' },
          after,
        },
      },
      {
        seq: 4,
        type: WRITE_JOURNAL_EVENT_TYPE,
        data: {
          kind: 'variable', tool: 'variable_set', journalId: 'journal-variable', sessionId: AGENT_ID, turn: 4,
          phase: 'after', at: CREATED_AT,
          target: { scope: 'chat', scopeId: 'fixture-chat' },
          after: [variableSnapshotFixture('mood', 'calm')],
        },
      },
    ]

    const entries = readWriteJournal(events)

    expect(entries).toHaveLength(3)
    const [beforeEntry, afterEntry, variableEntry] = entries
    if (beforeEntry?.kind !== 'memory' || afterEntry?.kind !== 'memory' || variableEntry?.kind !== 'variable') {
      throw new Error('expected memory, memory, variable journal entries')
    }
    expect(beforeEntry).toMatchObject({
      tool: 'memory_write', journalId, sessionId: AGENT_ID, turn: 4, phase: 'before',
      target: { id: before.id, scope: 'chat', scopeId: 'fixture-chat' },
    })
    expect(beforeEntry.before).toEqual(before)
    expect(afterEntry.phase).toBe('after')
    expect(afterEntry.after).toEqual(after)
    expect(variableEntry.after).toEqual([variableSnapshotFixture('mood', 'calm')])
  })

  it('rejects a malformed journal payload instead of skipping it', () => {
    expect(() => readWriteJournal([
      { seq: 0, type: WRITE_JOURNAL_EVENT_TYPE, data: { kind: 'memory', tool: 'memory_write' } },
    ])).toThrow(/target/)
    expect(() => readWriteJournal([
      { seq: 0, type: WRITE_JOURNAL_EVENT_TYPE, data: { kind: 'not-a-kind' } },
    ])).toThrow(/unknown kind/)
  })

  it('reads a noop record and rejects one carrying a state or an unknown phase', () => {
    const noop = {
      kind: 'variable', tool: 'variable_delete', journalId: 'journal-noop', sessionId: AGENT_ID, turn: 4,
      phase: 'noop', at: CREATED_AT,
      target: { scope: 'chat', scopeId: 'fixture-chat' },
      names: ['ghost.flag'],
    }
    const eventsOf = (data: unknown): unknown[] => [{ seq: 0, type: WRITE_JOURNAL_EVENT_TYPE, data }]

    expect(readWriteJournal(eventsOf(noop))).toEqual([noop])
    expect(() => readWriteJournal(eventsOf({ ...noop, phase: 'skip' }))).toThrow(/phase/)
    expect(() => readWriteJournal(eventsOf({ ...noop, before: null }))).toThrow(/noop record must not carry/)
  })

  it('round-trips journaled variable names and rejects a malformed names list', () => {
    const entry = {
      kind: 'variable', tool: 'variable_set', journalId: 'journal-names', sessionId: AGENT_ID, turn: 4,
      phase: 'before', at: CREATED_AT,
      target: { scope: 'chat', scopeId: 'fixture-chat' },
      names: ['journal.mood', 'journal.tide'],
      before: null,
    }
    const eventsOf = (data: unknown): unknown[] => [{ seq: 0, type: WRITE_JOURNAL_EVENT_TYPE, data }]

    expect(readWriteJournal(eventsOf(entry))).toEqual([entry])
    expect(() => readWriteJournal(eventsOf({ ...entry, names: [] }))).toThrow(/names/)
    expect(() => readWriteJournal(eventsOf({ ...entry, names: ['journal.mood', 7] }))).toThrow(/names/)
  })

  it('appendWriteJournalWith writes the journal event type through the injected writer', () => {
    const harness = createJournalSession(1)
    const entry: WriteJournalEntry = {
      kind: 'memory',
      tool: 'memory_write',
      journalId: newJournalId(),
      sessionId: AGENT_ID,
      turn: 1,
      phase: 'before',
      at: CREATED_AT,
      target: { id: 'memory-injected', scope: 'chat', scopeId: 'fixture-chat' },
      before: null,
    }
    const result = appendWriteJournalWith(
      (session, type, data) => {
        const method = asRecord(session)['appendPluginRecord']
        if (typeof method !== 'function') throw new Error('test session has no appendPluginRecord')
        return method.call(session, type, data)
      },
      harness.session,
      entry,
    )
    expect(result).toBe('recorded')
    expect(readWriteJournal(harness.session.events)).toEqual([entry])
  })
})

describe('journal availability', () => {
  it('reports unavailable when the host exposes no appendPluginRecord', async () => {
    hostState.module = {}
    const harness = createJournalSession(3)
    const entry: WriteJournalEntry = {
      kind: 'memory',
      tool: 'memory_write',
      journalId: newJournalId(),
      sessionId: AGENT_ID,
      turn: 3,
      phase: 'before',
      at: CREATED_AT,
      target: { id: 'memory-unavailable', scope: 'chat', scopeId: 'fixture-chat' },
      before: null,
    }
    await expect(appendWriteJournal({ session: harness.session }, entry)).resolves.toBe('unavailable')
    expect(readWriteJournal(harness.session.events)).toEqual([])
  })

  it('keeps an ordinary memory write when the host has no journal seam', async () => {
    hostState.module = {}
    const harness = createJournalSession(9)
    const written = await runTool('memory_write', {
      scope: 'chat', kind: 'semantic', content: 'Ordinary write without a journal host.',
    }, harness)
    expect(typeof written['id']).toBe('string')
    expect(readWriteJournal(harness.session.events)).toEqual([])
  })
})

describe('memory tools journal their writes', () => {
  it('memory_write journals a null before and the stored record after', async () => {
    const harness = createJournalSession(4)
    const content = 'A brass logbook sits under the counter.'
    const written = await runTool('memory_write', { scope: 'chat', kind: 'semantic', content }, harness)

    const entries = memoryEntries(harness, 'memory_write')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after'])
    const [before, after] = entries
    if (before === undefined || after === undefined) throw new Error('expected two memory_write entries')
    expect(before).toMatchObject({
      sessionId: AGENT_ID, turn: 4, target: { id: written['id'], scope: 'chat', scopeId: chatId },
    })
    expect(before.before).toBeNull()
    expect(before.after).toBeUndefined()
    expect(after.journalId).toBe(before.journalId)
    expect(after.after?.id).toBe(written['id'])
    expect(after.after?.content).toBe(content)
    expect(after.after?.revision).toBe(written['revision'])
  })

  it('memory_update journals the previous record before and the updated record after', async () => {
    const harness = createJournalSession(5)
    const created = await runTool('memory_write', {
      scope: 'chat', kind: 'semantic', content: 'The lantern is lit at dusk.',
    }, harness)
    const updated = await runTool('memory_update', {
      id: created['id'], scope: 'chat', expectedRevision: created['revision'], content: 'The lantern is lit at midnight.',
    }, harness)

    const entries = memoryEntries(harness, 'memory_update')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after'])
    const [before, after] = entries
    if (before === undefined || after === undefined) throw new Error('expected two memory_update entries')
    expect(before.before?.content).toBe('The lantern is lit at dusk.')
    expect(before.before?.revision).toBe(created['revision'])
    expect(after.after?.content).toBe('The lantern is lit at midnight.')
    expect(after.after?.revision).toBe(updated['revision'])
    expect(after.journalId).toBe(before.journalId)
  })

  it('memory_forget journals the live record before and the tombstone after', async () => {
    const harness = createJournalSession(6)
    const created = await runTool('memory_write', {
      scope: 'chat', kind: 'semantic', content: 'A glass key rests on the sill.',
    }, harness)
    await runTool('memory_forget', {
      id: created['id'], scope: 'chat', expectedRevision: created['revision'],
    }, harness)

    const entries = memoryEntries(harness, 'memory_forget')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after'])
    const [before, after] = entries
    if (before === undefined || after === undefined) throw new Error('expected two memory_forget entries')
    expect(before.before?.deletedAt).toBeUndefined()
    expect(after.after?.id).toBe(created['id'])
    expect(after.after?.deletedAt).toEqual(expect.any(String))
    expect(after.journalId).toBe(before.journalId)
  })

  it('aborts memory_write when the before journal append fails', async () => {
    const content = 'This memory must never be stored.'
    const harness = createJournalSession(7)
    harness.failPhase = 'before'

    await expect(runTool('memory_write', { scope: 'chat', kind: 'semantic', content }, harness))
      .rejects.toThrow(/synthetic journal append failure for phase 'before'/)

    expect(memoryEntries(harness, 'memory_write')).toEqual([])
    expect(await searchedContents('never stored')).not.toContain(content)
  })

  it('surfaces an after journal failure after the record was stored and leaves a before-only group', async () => {
    const content = 'The stored record survives a failed after append.'
    const harness = createJournalSession(8)
    harness.failPhase = 'after'

    await expect(runTool('memory_write', { scope: 'chat', kind: 'semantic', content }, harness))
      .rejects.toThrow(/after record/)

    const entries = memoryEntries(harness, 'memory_write')
    expect(entries.map((entry) => entry.phase)).toEqual(['before'])
    // The store accepted the write, so the before-only group must be resolved
    // against the store by the rollback port, not assumed uncommitted.
    expect(await searchedContents('failed after append')).toContain(content)
  })

  it('fails closed when the journal seam exists but no turn is open', async () => {
    const content = 'No open turn means no write.'
    const harness = createJournalSession(undefined)

    await expect(runTool('memory_write', { scope: 'chat', kind: 'semantic', content }, harness))
      .rejects.toThrow(/open turn/)

    expect(readWriteJournal(harness.session.events)).toEqual([])
    expect(await searchedContents('no open turn')).not.toContain(content)
  })
})

describe('variable tools journal their writes', () => {
  it('variable_set journals null before a create and the old snapshot before an update', async () => {
    const harness = createJournalSession(10)
    const created = await runTool('variable_set', { scope: 'chat', name: 'journal.mood', value: 'calm' }, harness)
    await runTool('variable_set', {
      scope: 'chat', name: 'journal.mood', value: 'alert', expectedRevision: created['revision'],
    }, harness)

    const entries = variableEntries(harness, 'variable_set')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after', 'before', 'after'])
    const [createBefore, createAfter, updateBefore, updateAfter] = entries
    if (createBefore === undefined || createAfter === undefined || updateBefore === undefined || updateAfter === undefined) {
      throw new Error('expected four variable_set entries')
    }
    expect(createBefore).toMatchObject({ sessionId: AGENT_ID, turn: 10, target: { scope: 'chat', scopeId: chatId } })
    expect(createBefore.names).toEqual(['journal.mood'])
    expect(createBefore.before).toBeNull()
    expect(createAfter.after?.[0]?.value).toBe('calm')
    expect(updateBefore.before?.[0]?.value).toBe('calm')
    expect(updateBefore.names).toEqual(['journal.mood'])
    expect(updateAfter.after?.[0]?.value).toBe('alert')
    expect(updateAfter.journalId).toBe(updateBefore.journalId)
    expect(updateBefore.journalId).not.toBe(createBefore.journalId)
  })

  it('variable_patch journals only the changed names that already existed', async () => {
    const harness = createJournalSession(11)
    await runTool('variable_set', { scope: 'chat', name: 'journal.weather', value: 'clear' }, harness)
    await runTool('variable_patch', {
      scope: 'chat',
      changes: [
        { name: 'journal.weather', value: 'storm' },
        { name: 'journal.tide', value: 'high' },
      ],
    }, harness)

    const entries = variableEntries(harness, 'variable_patch')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after'])
    const [before, after] = entries
    if (before === undefined || after === undefined) throw new Error('expected two variable_patch entries')
    expect(before.before?.map((snapshot) => snapshot.name)).toEqual(['journal.weather'])
    expect(before.names?.slice().sort()).toEqual(['journal.tide', 'journal.weather'])
    expect(after.after?.map((snapshot) => snapshot.name).sort()).toEqual(['journal.tide', 'journal.weather'])
    expect(after.after?.find((snapshot) => snapshot.name === 'journal.weather')?.value).toBe('storm')
    expect(after.journalId).toBe(before.journalId)
  })

  it('variable_delete journals the deleted snapshot before and null after', async () => {
    const harness = createJournalSession(12)
    await runTool('variable_set', { scope: 'chat', name: 'journal.flag', value: true }, harness)
    await runTool('variable_delete', { scope: 'chat', name: 'journal.flag' }, harness)

    const entries = variableEntries(harness, 'variable_delete')
    expect(entries.map((entry) => entry.phase)).toEqual(['before', 'after'])
    const [before, after] = entries
    if (before === undefined || after === undefined) throw new Error('expected two variable_delete entries')
    expect(before.before?.[0]?.name).toBe('journal.flag')
    expect(before.before?.[0]?.value).toBe(true)
    expect(after.after).toBeNull()
    expect(after.journalId).toBe(before.journalId)
  })

  it('aborts variable_set when the before journal append fails', async () => {
    const harness = createJournalSession(13)
    harness.failPhase = 'before'

    await expect(runTool('variable_set', { scope: 'chat', name: 'journal.abort', value: 'nope' }, harness))
      .rejects.toThrow(/synthetic journal append failure for phase 'before'/)

    const read = await runTool('variable_get', { scope: 'chat', name: 'journal.abort' }, createJournalSession(undefined))
    expect(read['found']).toBe(false)
  })
})

describe('write tools journal their no-ops', () => {
  it('memory_forget records a noop when the target does not exist', async () => {
    const harness = createJournalSession(20)
    const result = await runTool('memory_forget', {
      id: 'memory-that-does-not-exist', scope: 'chat', expectedRevision: 'rev-1',
    }, harness)

    expect(result['found']).toBe(false)
    const entries = memoryEntries(harness, 'memory_forget')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      phase: 'noop',
      sessionId: AGENT_ID,
      turn: 20,
      target: { id: 'memory-that-does-not-exist', scope: 'chat', scopeId: chatId },
    })
    expect(entries[0]?.before).toBeUndefined()
    expect(entries[0]?.after).toBeUndefined()
  })

  it('memory_update records a noop when the target does not exist', async () => {
    const harness = createJournalSession(24)

    await expect(runTool('memory_update', {
      id: 'memory-that-does-not-exist', scope: 'chat', expectedRevision: 'rev-1', content: 'never written',
    }, harness)).rejects.toThrow(/not found/)

    const entries = memoryEntries(harness, 'memory_update')
    expect(entries.map((entry) => entry.phase)).toEqual(['noop'])
    expect(entries[0]?.target).toMatchObject({ id: 'memory-that-does-not-exist', scope: 'chat', scopeId: chatId })
    expect(await searchedContents('never written')).not.toContain('never written')
  })

  it('variable_delete records a noop when the target does not exist', async () => {
    const harness = createJournalSession(21)
    const result = await runTool('variable_delete', { scope: 'chat', name: 'journal.missing' }, harness)

    expect(result['found']).toBe(false)
    const entries = variableEntries(harness, 'variable_delete')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      phase: 'noop',
      turn: 21,
      target: { scope: 'chat', scopeId: chatId },
      names: ['journal.missing'],
    })
    expect(entries[0]?.before).toBeUndefined()
    expect(entries[0]?.after).toBeUndefined()
  })

  it('records a memory noop when the global scope write is refused', async () => {
    const harness = createJournalSession(22)
    const content = 'A global memory that policy must refuse.'

    await expect(runTool('memory_write', { scope: 'global', kind: 'semantic', content }, harness))
      .rejects.toThrow(/global scope writes are disabled/)

    const entries = memoryEntries(harness, 'memory_write')
    expect(entries.map((entry) => entry.phase)).toEqual(['noop'])
    expect(entries[0]?.target).toMatchObject({ scope: 'global', scopeId: 'global' })
    expect(await searchedContents('policy must refuse')).not.toContain(content)
  })

  it('records a variable noop when the global scope write is refused', async () => {
    const harness = createJournalSession(23)

    await expect(runTool('variable_set', { scope: 'global', name: 'journal.denied', value: true }, harness))
      .rejects.toThrow(/global scope writes are disabled/)

    const entries = variableEntries(harness, 'variable_set')
    expect(entries.map((entry) => entry.phase)).toEqual(['noop'])
    expect(entries[0]).toMatchObject({
      target: { scope: 'global', scopeId: 'global' },
      names: ['journal.denied'],
    })
    const read = await runTool('variable_get', { scope: 'global', name: 'journal.denied' }, createJournalSession(undefined))
    expect(read['found']).toBe(false)
  })
})

describe('settle intents', () => {
  it('folds only unclosed intents and never into the ordinary write journal', () => {
    const first = settleIntentFixture('settle-open-1', [
      { name: 'mood', before: 'calm', after: 'alert' },
      { name: 'fresh', after: 1 },
    ])
    const second = settleIntentFixture('settle-open-2', [{ name: 'flag', before: true, after: false }])
    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: first.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 4 } },
      { seq: 1, type: SETTLE_INTENT_EVENT_TYPE, data: first },
      { seq: 2, type: SETTLE_INTENT_EVENT_TYPE, data: second },
      { seq: 3, type: SETTLE_INTENT_EVENT_TYPE, data: commit },
    ]

    expect(readSettleIntents(events)).toEqual([first, second, commit])
    expect(foldSettleIntents(events)).toEqual([second])
    expect(readWriteJournal(events)).toEqual([])
  })

  it('merges extend items into their open intent in append order', () => {
    const open = settleIntentFixture('settle-extend', [
      { name: 'mood', before: 'calm', after: 'alert' },
    ])
    const extend: SettleIntentExtendEntry = {
      kind: 'settle-intent',
      phase: 'extend',
      opId: open.opId,
      sessionId: AGENT_ID,
      at: CREATED_AT,
      items: [
        { name: 'mood', before: 'alert', after: 'furious' },
        { name: 'trust', before: 1, after: 2 },
      ],
    }
    const secondExtend: SettleIntentExtendEntry = {
      kind: 'settle-intent', phase: 'extend', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
      items: [{ name: 'debt', before: 5, after: 4 }],
    }
    const events = [
      { seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data: open },
      { seq: 1, type: SETTLE_INTENT_EVENT_TYPE, data: extend },
      { seq: 2, type: SETTLE_INTENT_EVENT_TYPE, data: secondExtend },
    ]

    expect(readSettleIntents(events)).toEqual([open, extend, secondExtend])
    expect(foldSettleIntents(events)).toEqual([{
      ...open,
      items: [...open.items, ...extend.items, ...secondExtend.items],
    }])

    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    expect(foldSettleIntents([...events, { seq: 3, type: SETTLE_INTENT_EVENT_TYPE, data: commit }])).toEqual([])
  })

  it('attaches a decide record to its open intent without reordering the items', () => {
    const open = settleIntentFixture('settle-decide', [
      { name: 'mood', before: 'calm', after: 'alert' },
      { name: 'trust', before: 1, after: 2 },
    ])
    const decision = settleDecisionFixture(open.opId)
    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    const events = settleEventsOf(open, decision)

    expect(readSettleIntents(events)).toEqual([open, decision])
    // The decision rides on the folded entry; items keep their write order.
    expect(foldSettleIntents(events)).toEqual([{ ...open, decision }])
    expect((foldSettleIntents(events)[0] as SettleIntentOpenEntry).items).toEqual(open.items)
    expect(foldSettleIntents(settleEventsOf(open, decision, commit))).toEqual([])
  })

  it('closes an aborted intent without restoring or replaying it', () => {
    const open = settleIntentFixture('settle-abort', [{ name: 'mood', before: 'calm', after: 'alert' }])
    const decision = settleDecisionFixture(open.opId)
    const abort: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'abort', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT, reason: 'flat writes restored',
    }

    // An abort is a closure: nothing stays open, so recovery neither restores
    // nor replays the batch.
    expect(foldSettleIntents(settleEventsOf(open, decision, abort))).toEqual([])
    expect(readSettleIntents(settleEventsOf(open, decision, abort))).toEqual([open, decision, abort])
  })

  it('rejects decide ordering violations and damaged decisions', () => {
    const open = settleIntentFixture('settle-decide-order', [{ name: 'mood', after: 'alert' }])
    const decision = settleDecisionFixture(open.opId)
    const extend: SettleIntentExtendEntry = {
      kind: 'settle-intent', phase: 'extend', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
      items: [{ name: 'trust', after: 1 }],
    }
    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    const abort: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'abort', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }

    expect(() => foldSettleIntents(settleEventsOf(decision))).toThrow(/decides without an open record/)
    expect(() => foldSettleIntents(settleEventsOf(open, commit, decision))).toThrow(/decides after it closed/)
    expect(() => foldSettleIntents(settleEventsOf(open, abort, decision))).toThrow(/decides after it closed/)
    expect(() => foldSettleIntents(settleEventsOf(open, decision, decision))).toThrow(/decides more than once/)
    expect(() => foldSettleIntents(settleEventsOf(open, decision, extend))).toThrow(/extends after it was decided/)
    expect(() => readSettleIntents(settleEventsOf(open, {
      ...decision,
      receipt: { ...decision.receipt, opId: 'another-op' },
    }))).toThrow(/must equal the decide record/)
    expect(() => readSettleIntents(settleEventsOf(open, {
      ...decision,
      receipt: { ...decision.receipt, status: 'bogus' },
    }))).toThrow(/status/)
    expect(() => readSettleIntents(settleEventsOf(open, {
      ...decision,
      receipt: { ...decision.receipt, changes: [{ name: 'mood', after: () => 1 }] },
    }))).toThrow(/changes\[0\] after/)
  })

  it('parses the receiptOpId marker and rejects a non-true flag', () => {
    const open = settleIntentFixture('settle-exact-only', [{ name: 'mood', after: 'alert' }])

    expect(readSettleIntents(settleEventsOf({ ...open, receiptOpId: true }))).toEqual([{ ...open, receiptOpId: true }])
    expect(() => readSettleIntents(settleEventsOf({ ...open, receiptOpId: false }))).toThrow(/receiptOpId/)
    expect(() => readSettleIntents(settleEventsOf({ ...open, receiptOpId: 'yes' }))).toThrow(/receiptOpId/)
  })

  it('rebuilds the decision receipt as JSON values only', () => {
    const receipt = settleDecisionFixture('settle-json').receipt
    expect(jsonSafeSettleReceipt('settle-json', receipt)).toEqual(receipt)
    expect(() => jsonSafeSettleReceipt('settle-json', {
      ...receipt,
      changes: [{ name: 'mood', after: (): number => 1 }],
    })).toThrow(/changes\[0\]\.after/)
  })

  it('rejects an extend record without an open intent or after it closed', () => {
    const open = settleIntentFixture('settle-extend-orphan', [{ name: 'mood', after: 'alert' }])
    const extend: SettleIntentExtendEntry = {
      kind: 'settle-intent', phase: 'extend', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
      items: [{ name: 'trust', after: 1 }],
    }
    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    const eventsOf = (...entries: SettleIntentEntry[]) =>
      entries.map((entry, seq) => ({ seq, type: SETTLE_INTENT_EVENT_TYPE, data: entry }))

    expect(() => foldSettleIntents(eventsOf(extend))).toThrow(/extends without an open record/)
    expect(() => foldSettleIntents(eventsOf(open, commit, extend))).toThrow(/extends after it closed/)
    expect(() => foldSettleIntents([{ seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data: { ...extend, items: [{ value: 1 }] } }]))
      .toThrow(/field 'name'/)
  })

  it('rejects duplicate, reopened and orphan closure records', () => {
    const open = settleIntentFixture('settle-duplicate', [{ name: 'mood', after: 'alert' }])
    const commit: SettleIntentEntry = {
      kind: 'settle-intent', phase: 'commit', opId: open.opId, sessionId: AGENT_ID, at: CREATED_AT,
    }
    const eventsOf = (...entries: SettleIntentEntry[]) =>
      entries.map((entry, seq) => ({ seq, type: SETTLE_INTENT_EVENT_TYPE, data: entry }))

    expect(() => foldSettleIntents(eventsOf(open, open))).toThrow(/opens more than once/)
    expect(() => foldSettleIntents(eventsOf(open, commit, commit))).toThrow(/closes more than once/)
    expect(() => foldSettleIntents(eventsOf(commit))).toThrow(/without an open record/)
  })

  it('rejects a malformed open record instead of skipping it', () => {
    const open = settleIntentFixture('settle-malformed', [{ name: 'mood', after: 'alert' }])

    expect(() => foldSettleIntents(settleEventsOf({ ...open, items: 'mood' })))
      .toThrow(/must be an array/)
    expect(() => foldSettleIntents([{ seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data: { ...open, turnKey: 'body:1' } }]))
      .toThrow(/floor index/)
    expect(() => readSettleIntents([{ seq: 0, type: SETTLE_INTENT_EVENT_TYPE, data: { kind: 'settle-intent', phase: 'other' } }]))
      .toThrow(/phase/)
  })

  it('accepts an intent with an empty undo list', () => {
    // Every request was rejected by the flat store: the batch has nothing to
    // undo, but its receipt decision must still recover.
    const open = settleIntentFixture('settle-empty-undo', [])

    expect(foldSettleIntents(settleEventsOf(open))).toEqual([open])
    expect(readSettleIntents(settleEventsOf(open))).toEqual([open])
  })

  it('appends settle intent records through the injected writer', () => {
    const harness = createJournalSession(1)
    const open = settleIntentFixture('settle-append', [{ name: 'mood', before: 'calm', after: 'alert' }])
    const writer = (session: unknown, type: string, data: unknown): unknown => {
      const method = asRecord(session)['appendPluginRecord']
      if (typeof method !== 'function') throw new Error('test session has no appendPluginRecord')
      return method.call(session, type, data)
    }

    expect(appendSettleIntentWith(writer, harness.session, open)).toBe('recorded')
    expect(readSettleIntents(harness.session.events)).toEqual([open])
    expect(readWriteJournal(harness.session.events)).toEqual([])
  })

  it('surfaces a rejected settle intent append with its phase and opId', () => {
    const harness = createJournalSession(1)
    const open = settleIntentFixture('settle-rejected', [{ name: 'mood', after: 'alert' }])

    expect(() => appendSettleIntentWith(() => { throw new Error('intent writer down') }, harness.session, open))
      .toThrow(/settle intent open record 'settle-rejected': intent writer down/)
    expect(readSettleIntents(harness.session.events)).toEqual([])
  })
})
