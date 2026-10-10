import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// 群聊 nudge 接线（决策 2026-10-10-group-nudge-and-regex-slash）：buildGroupTurn
// 算出的 nudge 必须进装配输入（历史末尾、post-history 之前的合成 user 楼层），
// 且不落 chat.messages。ST openai.js groupNudge 条目同位。
const GROUP = 'Test Group'
const ALICE = 'Alice'
const BOB = 'Bob'

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function importBody(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name, description: `A test character ${name}`, personality: '', scenario: '', first_mes: 'Hello',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
    },
  }
}

describe('group chat nudge injection', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let llmRequests: Array<{ messages?: Array<{ role?: string; content?: Array<{ text?: string }> }> }>
  let chatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-tavern-nudge-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importCharacter(importBody(ALICE))
    await store.importCharacter(importBody(BOB))
    await store.putGroup({
      id: 'group-test', name: GROUP, members: [ALICE, BOB],
      allowSelfResponses: false, activationStrategy: 2, disabledMembers: [],
      chatId: '', chats: [], autoModeDelay: 3,
    })
    // 带 group_nudge_prompt 的极简预设：prompt_order 只挂 chatHistory marker，
    // 装配产物 = 历史 + nudge，断言不受其他条目干扰。
    await store.putPreset('nudge-preset', {
      prompts: [{ identifier: 'chatHistory', marker: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
      group_nudge_prompt: 'Reply only as {{char}}.',
    })
    await store.patchState({ activePreset: 'nudge-preset' })
    chatId = await store.createChat(GROUP, {
      user_name: 'unused', character_name: 'unused',
      chat_metadata: {
        createdAt: new Date().toISOString(),
        group: { members: [ALICE, BOB], disabledMembers: [] },
      },
    }, [])

    llmRequests = []
    apply({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent, presetId) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: {
        stream: async function* (request: { messages?: Array<{ role?: string; content?: Array<{ text?: string }> }> }) {
          llmRequests.push(request)
          yield { type: 'text-delta', text: 'reply' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn) => { fn(); return () => {} },
    } as never)
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('appends the nudge as the last user message of the assembled prompt (send mode)', async () => {
    const snapshot = await store.getChatSnapshot(GROUP, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: GROUP, chatId, message: 'hello group', revision: snapshot!.revision, group: true,
    }, '/api/dsh-tavern/generate'), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)

    const messages = llmRequests.at(-1)!.messages!
    // 历史两条：用户楼层 + 合成 nudge 楼层；nudge 位于最末（ST insertAtEnd(chatHistory)）
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[0]!.content![0]!.text).toBe('hello group')
    expect(messages[1]).toMatchObject({ role: 'user' })
    // {{char}} 已按发言者替换（LIST 策略无上一位发言者 → 首个启用成员 Alice）
    expect(messages[1]!.content![0]!.text).toBe('Reply only as Alice.')

    // 合成 nudge 楼层不落盘：保存后的 chat 只有 用户 + 助手 两条
    const saved = await store.getChatSnapshot(GROUP, chatId)
    expect(saved!.chat.messages).toHaveLength(2)
    expect(saved!.chat.messages[0]!.is_user).toBe(true)
    expect(saved!.chat.messages[1]!.is_user).toBe(false)
    expect(saved!.chat.messages[1]!.name).toBe('Alice')
    expect(saved!.chat.messages.some((m) => m.mes.includes('Reply only as'))).toBe(false)
  })

  it('keeps the nudge on regenerate after popping the old reply', async () => {
    const snapshot = await store.getChatSnapshot(GROUP, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({
      character: GROUP, chatId, mode: 'regenerate', message: '', revision: snapshot!.revision, group: true,
    }, '/api/dsh-tavern/generate'), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)

    const messages = llmRequests.at(-1)!.messages!
    expect(messages.at(-1)).toMatchObject({ role: 'user' })
    expect(messages.at(-1)!.content![0]!.text).toBe('Reply only as Alice.')
  })
})
