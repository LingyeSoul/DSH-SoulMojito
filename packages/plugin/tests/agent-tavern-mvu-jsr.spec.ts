import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTavernProjector, type NativeSession } from '../src/agent-tavern/projector.js'
import {
  applyUpdateVariableToChat,
  cardUsesJsrMvu,
  seedJsrMvuVariables,
  STATUS_PLACEHOLDER,
} from '../src/agent-tavern/mvu-compat.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import type { CharacterCardIR, ChatLogIR } from '../../tavern-format/src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mvuCard(overrides: Record<string, unknown> = {}): CharacterCardIR {
  return {
    spec: 'chara_card_v2',
    specVersion: '2.0',
    data: {
      name: 'MVU Probe', description: '', personality: '', scenario: '', firstMes: '', mesExample: '',
      creatorNotes: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: [], creator: '',
      characterVersion: '',
      extensions: {
        tavern_helper: { scripts: [{ type: 'script', content: "import 'https://x/MagVarUpdate/bundle.js'" }] },
        regex_scripts: [{
          id: 'placeholder', scriptName: 'status placeholder', findRegex: '<StatusPlaceHolderImpl\\/>',
          replaceString: '<StatusPlaceHolderREADY/>', trimStrings: [], placement: [2], disabled: false,
          markdownOnly: true, promptOnly: false,
        }],
        ...overrides,
      },
      characterBook: {
        name: 'MVU Book',
        entries: [{
          keys: [], content: 'protocol: <UpdateVariable>', enabled: true, insertion_order: 10, constant: true,
          comment: 'protocol',
        }],
      },
    },
    raw: {},
  }
}

function chatWith(): ChatLogIR {
  return {
    header: { user_name: 'User', character_name: 'MVU Probe', chat_metadata: {} } as ChatLogIR['header'],
    messages: [],
  }
}

const updateText = (patch: string) => `Narrative line.\n<UpdateVariable>\n<Analysis>check</Analysis>\n<JSONPatch>\n${patch}\n</JSONPatch>\n</UpdateVariable>`

describe('JSR MVU compatibility core', () => {
  it('detects MagVarUpdate cards and seeds initial variables', () => {
    const card = mvuCard()
    expect(cardUsesJsrMvu(card)).toBe(true)
    const variables: Record<string, unknown> = {}
    expect(seedJsrMvuVariables(card, variables)).toBe(true)
    expect(variables).toEqual({
      initialized_lorebooks: true,
      stat_data: { 系统状态: { 主角创建完毕: false } },
    })
    expect(seedJsrMvuVariables(card, variables)).toBe(false)
  })

  it('applies replace/insert/delta/remove leniently and clamps 当前 bars', () => {
    const card = mvuCard()
    const chat = chatWith()
    chat.header.chat_metadata.variables = {}
    seedJsrMvuVariables(card, chat.header.chat_metadata.variables)
    const result = applyUpdateVariableToChat(card, chat, updateText(`[
      { "op": "replace", "path": "/主角/核心状态/体力值/当前", "value": 90 },
      { "op": "replace", "path": "/主角/核心状态/体力值/最大", "value": 100 },
      { "op": "delta", "path": "/主角/核心状态/体力值/当前", "value": -15 },
      { "op": "insert", "path": "/主角/个人信息/身份&职业", "value": "学生" },
      { "op": "delta", "path": "/主角/状态/技能/经验", "value": 50 },
      { "op": "remove", "path": "/系统状态/主角创建完毕" },
      { "op": "replace", "path": "/系统状态/主角创建完毕", "value": true },
    ]`))
    expect(result.found).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.applied).toBe(7)
    expect(result.text.endsWith(STATUS_PLACEHOLDER)).toBe(true)
    const stat = chat.header.chat_metadata.variables as Record<string, any>
    expect(stat.stat_data.主角.核心状态.体力值).toEqual({ 当前: 75, 最大: 100 })
    expect(stat.stat_data.主角.个人信息['身份&职业']).toBe('学生')
    expect(stat.stat_data.主角.状态.技能.经验).toBe(50)
    expect(stat.stat_data.系统状态.主角创建完毕).toBe(true)
    expect(stat.previous_stat_data).toEqual({ 系统状态: { 主角创建完毕: false } })
  })

  it('keeps the narrative when JSONPatch is invalid and still reports the placeholder', () => {
    const card = mvuCard()
    const chat = chatWith()
    chat.header.chat_metadata.variables = {}
    seedJsrMvuVariables(card, chat.header.chat_metadata.variables)
    const result = applyUpdateVariableToChat(card, chat, updateText('[{ "op": "replace", "path": "'))
    expect(result.found).toBe(true)
    expect(result.failures[0]).toContain('JSONPatch parse failed')
    expect(result.text).toContain('Narrative line.')
    expect(result.text.endsWith(STATUS_PLACEHOLDER)).toBe(true)
  })

  it('leaves non-MVU cards untouched', () => {
    const card = mvuCard({ tavern_helper: undefined, regex_scripts: undefined })
    card.data.characterBook = { name: 'plain', entries: [] }
    const chat = chatWith()
    const result = applyUpdateVariableToChat(card, chat, 'plain reply')
    expect(result.found).toBe(false)
    expect(result.text).toBe('plain reply')
    expect(chat.header.chat_metadata.variables).toBeUndefined()
  })
})

describe('AgentTavern projector applies JSR MVU updates', () => {
  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'agent-tavern-mvu-'))
    roots.push(root)
    const store = await TavernStore.open(root)
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'MVU Probe', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
        character_version: '',
        extensions: {
          tavern_helper: { scripts: [{ type: 'script', content: "import 'https://x/MagVarUpdate/bundle.js'" }] },
          regex_scripts: [{
            id: 'placeholder', scriptName: 'status placeholder', findRegex: '<StatusPlaceHolderImpl\\/>',
            replaceString: '<StatusPlaceHolderREADY/>', trimStrings: [], placement: [2], disabled: false,
            markdownOnly: true, promptOnly: false,
          }],
        },
      },
    })
    const chatId = await store.createChat('MVU Probe', {
      user_name: 'User', character_name: 'MVU Probe', chat_metadata: {},
    })
    const sessionId = 'mvu-native'
    await store.updateState(() => ({
      sessionBindings: {
        [sessionId]: {
          architecture: 'agent-tavern', contextMode: 'dsh-native', character: 'MVU Probe', chatId,
        },
      },
    }))
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        {
          type: 'user/message', seq: 1, time: 1100,
          data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: 2, time: 1200,
          data: {
            turn: 1, step: 1,
            message: {
              id: 'a1', role: 'assistant',
              content: [{ type: 'text', text: updateText('[{ "op": "replace", "path": "/进程/阶段", "value": "幕间休息" }]') }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    }
    return { root, store, chatId, sessionId, native }
  }

  it('writes stat_data to the chat, the floor variables and status placeholder', async () => {
    const { root, store, chatId, sessionId, native } = await fixture()
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('MVU Probe', chatId)
    expect(snapshot).toBeDefined()
    const assistant = snapshot!.chat.messages[1]!
    expect(assistant.mes).toContain('<UpdateVariable>')
    expect(assistant.mes.endsWith(STATUS_PLACEHOLDER)).toBe(true)
    const variables = snapshot!.chat.header.chat_metadata.variables as Record<string, any>
    expect(variables.initialized_lorebooks).toBe(true)
    expect(variables.stat_data.进程.阶段).toBe('幕间休息')
    expect(assistant.variables).toMatchObject({ stat_data: { 进程: { 阶段: '幕间休息' } } })
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 2, status: 'ok' })
  })
})
