import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTavernProjector, historyImportAppends, type NativeSession } from '../src/agent-tavern/projector.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'
import type { ChatLogIR, RegexScriptIR } from '../../tavern-format/src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const cardData = (extensions: Record<string, unknown> = {}) => ({
  name: 'Projector Character', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
  character_version: '', extensions,
})

async function fixture(sessionId = 'native-session') {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-projector-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: cardData(),
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

  it('replays a DSH 0.1.2 host session whose log rides snapshotEvents()', async () => {
    const { root, store, chatId, sessionId } = await fixture('snapshot-session')
    const native = session(sessionId)
    // DSH 0.1.2 形状：无 events 属性，事件日志经 snapshotEvents() 冻结快照暴露。
    const legacy = { id: sessionId, snapshotEvents: () => native.events } as unknown as NativeSession
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(legacy)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.'])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 4, status: 'ok' })
  })

  it('does not project dsh-tavern mirrored imports back into the chat', async () => {
    const { root, store, chatId, sessionId } = await fixture('import-session')
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 1010, data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message', seq: 2, time: 1100,
          data: {
            turn: 1, step: 1,
            message: {
              id: 'imported-greeting', role: 'assistant',
              content: [{ type: 'text', text: 'Hello, traveler.' }],
              source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import', plugin: 'dsh-tavern', form: 'greeting' },
            },
          },
        },
        { type: 'step/end', seq: 3, time: 1110, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4, time: 1120, data: { turn: 1, reason: { kind: 'completed' } } },
        {
          type: 'user/message', seq: 5, time: 1200,
          data: { id: 'imported-user', role: 'user', content: [{ type: 'text', text: 'Imported turn.' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'history' } },
        },
        {
          type: 'user/message', seq: 6, time: 1300,
          data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Live message.' }], source: { kind: 'user' } },
        },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Live message.'])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 6, status: 'ok' })
  })

  it('retries a chat CAS conflict without duplicating the event', async () => {
    const { root, store, chatId, sessionId } = await fixture('cas-session')
    let conflict = true
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
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

  it('applies USER_INPUT and non-layered AI_OUTPUT regex when projecting live messages', async () => {
    const { root, store, chatId, sessionId } = await fixture('regex-session')
    // 卡内嵌脚本经导入物化为全局脚本；collectRegexScripts 按名去重后只应用一次。
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData({
        regex_scripts: [
          { scriptName: 'Echo Input', findRegex: 'door', replaceString: 'gate', placement: [1] },
          { scriptName: 'Trim Quotes', findRegex: '"([^"]*)"', replaceString: '$1', placement: [2] },
          { scriptName: 'Display Only', findRegex: 'opens', replaceString: 'unlocks', placement: [2], markdownOnly: true },
          { scriptName: 'Prompt Only', findRegex: 'The door', replaceString: 'A door', placement: [2], promptOnly: true },
        ],
      }),
    })
    const native: NativeSession = {
      id: sessionId,
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
              id: 'assistant-1', role: 'assistant',
              content: [{ type: 'text', text: 'The door "opens".' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    // USER_INPUT 落库变换；AI_OUTPUT 只应用非 promptOnly、非 markdownOnly 脚本。
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual([
      'Open the gate.',
      'The door opens.',
    ])
  })

  it('imports history as session-level messages before the live loop first turn', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Greeting.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' },
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Welcome.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Continue.' },
      ],
    }
    const original = structuredClone(chat)
    const appends = historyImportAppends(chat, 'session-1', [], undefined)
    expect(appends.map((event) => event.type)).toEqual([
      'assistant/message', 'user/message', 'assistant/message', 'user/message',
    ])
    expect(appends.every((event) => !['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type))).toBe(true)
    expect(appends.filter((event) => event.type === 'assistant/message').every((event) => (
      !('turn' in event.data) && !('step' in event.data)
    ))).toBe(true)
    expect(appends.filter((event) => event.type === 'user/message')).toHaveLength(2)
    expect(appends.filter((event) => event.type === 'assistant/message')).toHaveLength(2)
    expect(appends.at(0)?.data).toMatchObject({
      message: {
        source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import', form: 'greeting' },
      },
    })
    expect(appends.at(2)?.data).toMatchObject({
      message: {
        source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import', form: 'history' },
      },
    })
    // The first live AgentLoop turn remains one because imports reserve no turn.
    expect([...appends.filter((event) => event.type === 'turn/start'), { type: 'turn/start', data: { turn: 1 } }])
      .toEqual([{ type: 'turn/start', data: { turn: 1 } }])
    expect(chat).toEqual(original)
  })

  it('does not import empty, system-only or already projected history', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'System', is_user: false, is_system: true, send_date: '', mes: 'System.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: ' ' },
        {
          name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Already here.',
          extra: { agentTavern: { sessionId: 'session-1' } },
        },
      ],
    }
    expect(historyImportAppends(chat, 'session-1', [], undefined)).toEqual([])
    expect(historyImportAppends({ ...chat, messages: [] }, 'session-1', [], undefined)).toEqual([])
  })

  it('applies prompt-only regex to imported history without touching stored text', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'first word' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'second word' },
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'third word' },
      ],
    }
    const script = (overrides: Partial<RegexScriptIR>): RegexScriptIR => ({
      id: 's', scriptName: 's', findRegex: 'word', replaceString: '<$&>', trimStrings: [], placement: [2],
      disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false,
      minDepth: null, maxDepth: null, ...overrides,
    })
    const appends = historyImportAppends(chat, 'session-1', [
      script({ scriptName: 'Prompt Wrap', promptOnly: true }),
      // 深度限制：depth 0（最新）之内才生效
      script({ scriptName: 'Depth Shout', promptOnly: true, maxDepth: 0, findRegex: 'third', replaceString: 'THIRD' }),
      // 非 promptOnly 脚本已含在落库文本里，导入时不得重复应用
      script({ scriptName: 'Save Wrap', replaceString: '!' }),
    ], undefined)
    const texts = appends
      .filter((item) => item.type === 'user/message' || item.type === 'assistant/message')
      .map((item) => {
        const data = item.data as { content?: Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }
        return (data.message?.content ?? data.content)?.[0]?.text
      })
    // depth 2 / 1 / 0：Depth Shout 只作用于最新一条，Prompt Wrap 作用于全部
    expect(texts).toEqual(['first <word>', 'second <word>', 'THIRD <word>'])
    expect(chat.messages.map((message) => message.mes)).toEqual(['first word', 'second word', 'third word'])
  })

  it('expands macros in the imported prompt view without touching stored text', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: '{{char}} waves at {{user}}.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'hello {{char}}' },
      ],
    }
    const appends = historyImportAppends(chat, 'session-1', [], (text) =>
      text.replaceAll('{{char}}', 'Nova').replaceAll('{{user}}', 'Alice'))
    const texts = appends
      .filter((item) => item.type === 'user/message' || item.type === 'assistant/message')
      .map((item) => {
        const data = item.data as { content?: Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }
        return (data.message?.content ?? data.content)?.[0]?.text
      })
    expect(texts).toEqual(['Nova waves at Alice.', 'hello Nova'])
    expect(chat.messages.map((message) => message.mes)).toEqual(['{{char}} waves at {{user}}.', 'hello {{char}}'])
  })
})
