import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTavernProjector, type NativeSession } from '../src/agent-tavern/projector.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(sessionId = 'native-session') {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-projector-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: 'Projector Character', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
      character_version: '', extensions: {},
    },
  })
  const chatId = await store.createChat('Projector Character', {
    user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {},
  })
  await store.updateState(() => ({
    sessionBindings: {
      [sessionId]: {
        architecture: 'agent-tavern', contextMode: 'dsh-native',
        character: 'Projector Character', chatId,
      },
    },
  }))
  return { root, store, chatId, sessionId }
}

function session(id: string): NativeSession {
  return {
    id,
    events: [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 1100,
        data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message', seq: 2, time: 1200,
        data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant-tool', role: 'assistant',
            content: [{ type: 'tool-call', callId: 'call-1', name: 'memory_search', arguments: '{}' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      },
      {
        type: 'tool/result', seq: 3, time: 1300,
        data: { turn: 1, step: 1, message: { id: 'result-1', role: 'user', content: [], source: { kind: 'tool' } } },
      },
      {
        type: 'assistant/message', seq: 4, time: 1400,
        data: {
          turn: 1, step: 2,
          message: {
            id: 'assistant-final', role: 'assistant', content: [{ type: 'text', text: 'The door opens.' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      },
    ],
  }
}

describe('AgentTavern native event projector', () => {
  it('projects human and final assistant messages exactly once across replay and restart', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const native = session(sessionId)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    let snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => [message.name, message.mes])).toEqual([
      ['Alice', 'Open the door.'],
      ['Projector Character', 'The door opens.'],
    ])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).eventSeq)).toEqual([1, 4])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 4, status: 'ok' })

    const resumed = await AgentTavernProjector.open(root, store)
    const next = { ...native, events: [...native.events, {
      type: 'user/message', seq: 5, time: 1500,
      data: { id: 'user-2', role: 'user', content: [{ type: 'text', text: 'Step inside.' }], source: { kind: 'user' } },
    }] }
    await resumed.replay(next)
    snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.', 'Step inside.'])
  })

  it('retries a chat CAS conflict without duplicating the event', async () => {
    const { root, store, chatId, sessionId } = await fixture('cas-session')
    let conflict = true
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      saveChat: async (character, id, chat, revision) => {
        if (conflict) {
          conflict = false
          throw new ChatRevisionConflictError(revision!, 'changed')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    const native = session(sessionId)
    await projector.project(native, native.events[1]!)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.'])
  })

  it('records a pending checkpoint and can replay after the target is repaired', async () => {
    const { root, store, chatId, sessionId } = await fixture('repair-session')
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: { ...state.sessionBindings[sessionId]!, chatId: 'missing.jsonl' },
      },
    }))
    const projector = await AgentTavernProjector.open(root, store)
    const native = session(sessionId)
    await expect(projector.project(native, native.events[1]!)).rejects.toThrow('target chat not found')
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 1 })

    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: { ...state.sessionBindings[sessionId]!, chatId },
      },
    }))
    await projector.project(native, native.events[1]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 1 })
  })
})
