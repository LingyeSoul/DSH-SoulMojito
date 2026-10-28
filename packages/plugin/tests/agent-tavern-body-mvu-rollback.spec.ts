import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatLogIR } from '../../tavern-format/src/index.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'
import { AgentTavernProjector, type NativeSession } from '../src/agent-tavern/projector.js'
import {
  appendMvuReceipt,
  mvuReceiptsForBody,
  readMvuReceipts,
  redoMvuReceipts,
  undoMvuReceipts,
  type MvuReceipt,
} from '../src/mvu.js'

// Proposal 0022 §4: body `<UpdateVariable>` writes become rollback-addressable
// receipts keyed by `body:<messageId>`, and the same floor's settle receipts use
// the floor index. These specs use a synthetic MVU card/chat only.

const CHARACTER = 'Body MVU Character'
const SESSION_ID = 'body-mvu-session'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface ProjectorFixture {
  root: string
  store: TavernStore
  chatId: string
}

async function projectorFixture(variables: Record<string, unknown> | undefined): Promise<ProjectorFixture> {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-body-mvu-rollback-'))
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
      extensions: {
        // MagVarUpdate marker only; no script is ever executed.
        tavern_helper: { scripts: [{ type: 'script', content: "import 'https://example.invalid/MagVarUpdate/bundle.js'" }] },
      },
    },
  })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'User',
    character_name: CHARACTER,
    chat_metadata: variables === undefined ? {} : { variables },
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
  return { root, store, chatId }
}

function updateText(patch: string): string {
  return `Narrative line.\n<UpdateVariable>\n<JSONPatch>\n${patch}\n</JSONPatch>\n</UpdateVariable>`
}

function nativeSession(messageId: string, text: string): NativeSession {
  return {
    id: SESSION_ID,
    events: [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 1100,
        data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Go on.' }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        time: 1200,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
          },
        },
      },
    ],
  }
}

function receipt(turnKey: string, at: string, changes: MvuReceipt['changes']): MvuReceipt {
  return { at, turnKey, status: 'updated', changes, failures: [] }
}

function syntheticChat(variables: Record<string, unknown>, receipts: MvuReceipt[]): ChatLogIR {
  return {
    header: {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: {
        ...(Object.keys(variables).length === 0 ? {} : { variables }),
        ...(receipts.length === 0 ? {} : { mvu: { receipts } }),
      },
    },
    messages: [],
  }
}

async function snapshotOf(store: TavernStore, chatId: string): Promise<ChatLogIR> {
  const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
  if (snapshot === undefined) throw new Error('fixture chat is missing')
  return snapshot.chat
}

describe('AgentTavern body MVU receipt (proposal 0022 §4)', () => {
  it('records a body:<messageId> receipt with the seeded baseline as before', async () => {
    const { root, store, chatId } = await projectorFixture({ stat_data: { mvu: { favor: 10 } } })
    const projector = await AgentTavernProjector.open(root, store)
    const session = nativeSession(
      'assistant-1',
      updateText('[{ "op": "replace", "path": "/mvu/favor", "value": 15 }]'),
    )
    await projector.replay(session)

    const chat = await snapshotOf(store, chatId)
    const receipts = readMvuReceipts(chat)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ turnKey: 'body:assistant-1', status: 'updated', failures: [] })
    // Baseline is the seeded tree: only the patch-induced leaf and the
    // previous_stat_data snapshot are recorded, the seed itself is not undone.
    expect(receipts[0]!.changes).toEqual([
      { name: 'previous_stat_data.mvu.favor', after: 10 },
      { name: 'stat_data.mvu.favor', before: 10, after: 15 },
    ])
    expect(chat.header.chat_metadata.variables).toMatchObject({ stat_data: { mvu: { favor: 15 } } })

    // Replaying into a fresh projection root skips the already-projected
    // message by projection identity and must not append a second receipt.
    const replayRoot = mkdtempSync(join(tmpdir(), 'agent-tavern-body-mvu-replay-'))
    roots.push(replayRoot)
    const fresh = await AgentTavernProjector.open(replayRoot, store)
    await fresh.replay(session)
    expect(readMvuReceipts(await snapshotOf(store, chatId))).toHaveLength(1)
  })

  it('keeps exactly one body receipt across a CAS retry', async () => {
    const { root, store, chatId } = await projectorFixture(undefined)
    const projector = await AgentTavernProjector.open(root, store)
    const original = TavernStore.prototype.saveChat
    let conflicts = 0
    TavernStore.prototype.saveChat = async function (
      this: TavernStore,
      character: string,
      id: string,
      chat: ChatLogIR,
      expectedRevision?: string,
    ): Promise<string> {
      // Fail the assistant append once: the retry re-reads the snapshot, so the
      // receipt produced by the failed attempt must not survive.
      if (conflicts === 0 && chat.messages.length === 2) {
        conflicts += 1
        throw new ChatRevisionConflictError(expectedRevision ?? 'stale', 'forced-retry')
      }
      return original.call(this, character, id, chat, expectedRevision)
    }
    try {
      await projector.replay(nativeSession(
        'assistant-cas',
        updateText('[{ "op": "replace", "path": "/mvu/favor", "value": 7 }]'),
      ))
    } finally {
      TavernStore.prototype.saveChat = original
    }

    expect(conflicts).toBe(1)
    const chat = await snapshotOf(store, chatId)
    expect(readMvuReceipts(chat).filter((entry) => entry.turnKey === 'body:assistant-cas')).toHaveLength(1)
  })

  it('finds the body receipt and the floor settle receipt in stored order', async () => {
    const { root, store, chatId } = await projectorFixture({ stat_data: { mvu: { favor: 10 } } })
    await (await AgentTavernProjector.open(root, store)).replay(nativeSession(
      'assistant-2',
      updateText('[{ "op": "replace", "path": "/mvu/favor", "value": 15 }]'),
    ))
    const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
    if (snapshot === undefined) throw new Error('fixture chat is missing')
    appendMvuReceipt(
      snapshot.chat,
      receipt('1', '2026-10-28T01:00:00.000Z', [{ name: 'stat_data.mvu.favor', before: 15, after: 20 }]),
    )
    await store.saveChat(CHARACTER, chatId, snapshot.chat, snapshot.revision)

    const chat = await snapshotOf(store, chatId)
    expect(mvuReceiptsForBody(chat, { messageId: 'assistant-2', floorIndex: 1 }).map((entry) => entry.turnKey))
      .toEqual(['body:assistant-2', '1'])
    expect(mvuReceiptsForBody(chat, { messageId: 'assistant-2' }).map((entry) => entry.turnKey))
      .toEqual(['body:assistant-2'])
    expect(mvuReceiptsForBody(chat, { floorIndex: 1 }).map((entry) => entry.turnKey)).toEqual(['1'])
    expect(() => mvuReceiptsForBody(chat, {})).toThrowError(/requires messageId or floorIndex/)
  })

  it('undoes the projected body to the seeded tree and redo replays the patch', async () => {
    const { root, store, chatId } = await projectorFixture({ stat_data: { mvu: { favor: 10 } } })
    await (await AgentTavernProjector.open(root, store)).replay(nativeSession(
      'assistant-3',
      updateText('[{ "op": "replace", "path": "/mvu/favor", "value": 15 }]'),
    ))
    const chat = await snapshotOf(store, chatId)
    const receipts = mvuReceiptsForBody(chat, { messageId: 'assistant-3' })
    expect(receipts).toHaveLength(1)

    const undone = undoMvuReceipts(chat, receipts, { at: '2026-10-28T02:00:00.000Z' })
    expect(undone.restores).toEqual([
      { path: 'previous_stat_data.mvu.favor' },
      { path: 'stat_data.mvu.favor', value: 10 },
    ])
    expect(chat.header.chat_metadata.variables).toEqual({
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 10 } },
    })
    expect(readMvuReceipts(chat)[0]!.undoneAt).toBe('2026-10-28T02:00:00.000Z')

    // Re-undoing an undone receipt is idempotent (stale live copies included).
    expect(undoMvuReceipts(chat, receipts)).toEqual({ receipts: [], restores: [] })

    const redone = redoMvuReceipts(chat, receipts)
    expect(redone.restores).toEqual([
      { path: 'previous_stat_data.mvu.favor', value: 10 },
      { path: 'stat_data.mvu.favor', value: 15 },
    ])
    expect(readMvuReceipts(chat)[0]!.undoneAt).toBeUndefined()
    expect(chat.header.chat_metadata.variables).toEqual({
      initialized_lorebooks: true,
      previous_stat_data: { mvu: { favor: 10 } },
      stat_data: { mvu: { favor: 15 } },
    })
  })

  it('undoes receipts newest-first and redo replays them oldest-first', () => {
    const settle = receipt('1', '2026-10-28T00:00:01.000Z', [
      { name: 'mvu.favor', before: 10, after: 20 },
      { name: 'mvu.location', after: 'cellar' },
    ])
    const body = receipt('body:assistant-4', '2026-10-28T00:00:02.000Z', [
      { name: 'mvu.favor', before: 20, after: 35 },
      { name: 'mvu.scene', after: '夜' },
    ])
    const chat = syntheticChat({ mvu: { favor: 35, scene: '夜' } }, [settle, body])
    const found = mvuReceiptsForBody(chat, { messageId: 'assistant-4', floorIndex: 1 })
    expect(found.map((entry) => entry.turnKey)).toEqual(['1', 'body:assistant-4'])

    undoMvuReceipts(chat, found)
    expect(chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 10 } })

    redoMvuReceipts(chat, found)
    expect(chat.header.chat_metadata.variables).toEqual({ mvu: { favor: 35, location: 'cellar', scene: '夜' } })
  })

  it('refuses incomplete or foreign receipts without writing anything', () => {
    const incomplete = receipt('body:assistant-5', '2026-10-28T00:00:03.000Z', [{ name: 'mvu.legacy' }])
    const chat = syntheticChat({ mvu: { favor: 1 } }, [incomplete])
    const before = structuredClone(chat)

    expect(() => undoMvuReceipts(chat, readMvuReceipts(chat))).toThrowError(/incomplete/i)
    expect(chat).toEqual(before)

    const foreign = receipt('body:assistant-6', '2026-10-28T00:00:04.000Z', [
      { name: 'mvu.favor', before: 1, after: 2 },
    ])
    expect(() => undoMvuReceipts(chat, [foreign])).toThrowError(/not stored/)
    expect(chat).toEqual(before)
  })

  it('refuses to redo an undone receipt whose data is incomplete', () => {
    const broken: MvuReceipt = {
      at: '2026-10-28T00:00:05.000Z',
      turnKey: 'body:assistant-7',
      status: 'updated',
      changes: [{ name: 'mvu.legacy' }],
      failures: [],
      undoneAt: '2026-10-28T00:00:06.000Z',
    }
    const chat = syntheticChat({ mvu: { favor: 2 } }, [broken])
    const before = structuredClone(chat)

    expect(() => redoMvuReceipts(chat, readMvuReceipts(chat))).toThrowError(/incomplete/i)
    expect(chat).toEqual(before)
  })
})
