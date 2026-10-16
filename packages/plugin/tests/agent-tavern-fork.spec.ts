/**
 * 宿主原生会话分叉的 AgentTavern 收养（decisions/2026-10-11-agent-tavern-host-fork）。
 *
 * 覆盖：谱系谓词 hostSessionForkInfo（fork 命中 / subagent / delegationDepth /
 * 非 fork 短路）、store.forkChat 物化（命名递增 / header 克隆 / 空楼层 / 谱系
 * 与回链元数据）、端到端收养（真实四件套 store tmpdir：聊天物化 + chat 作用域
 * 变量/记忆/向量拷贝 + 绑定继承 contextMode + 投影器 replay 回填楼层与身份）、
 * 幂等三态（重复收养 / 崩溃恢复复用 / 非目标父绑定与 subagent 跳过）、
 * 回链边界（父聊天越过切点时指到切点楼层）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostSessionForkInfo, type HostSessionLog } from '../../bind/src/index.js'
import {
  MemoryStore,
  MemoryVectorStore,
  TavernStore,
  VariableStore,
  encodeVector,
  memoryContentDigest,
} from '../../tavern-store/src/index.js'
import type { ChatLogIR } from '../../tavern-format/src/index.js'
import { AgentTavernProjector, type NativeSession } from '../src/agent-tavern/projector.js'
import { adoptAgentTavernFork, type ForkAdoptionDependencies } from '../src/agent-tavern/fork.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CHARACTER = 'Fork Character'

const cardData = () => ({
  name: CHARACTER, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
  character_version: '', extensions: {},
})

interface Fixture {
  root: string
  store: TavernStore
  variables: VariableStore
  memories: MemoryStore
  vectors: MemoryVectorStore
  chatId: string
  bindCalls: Array<{ sessionId: string; character: string; chatId: string; contextMode: string }>
  deps: () => ForkAdoptionDependencies
}

async function fixture(contextMode = 'dsh-native'): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-fork-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData() })
  const chatId = await store.createChat(CHARACTER, {
    user_name: 'Alice',
    character_name: CHARACTER,
    chat_metadata: {
      guides: [{ id: 'g1', text: '多写心理活动', createdAt: '2026-10-11T00:00:00.000Z' }],
      mvu: { receipts: [{ turnKey: 't1', status: 'updated', changes: [], failures: [] }] },
    },
  })
  await store.updateState(() => ({
    sessionBindings: {
      'parent-session': { architecture: 'agent-tavern', contextMode, character: CHARACTER, chatId },
    },
  }))
  const variables = await VariableStore.open(root)
  const memories = await MemoryStore.open(root)
  const vectors = await MemoryVectorStore.open(root)
  const bindCalls: Fixture['bindCalls'] = []
  const deps = (): ForkAdoptionDependencies => ({
    store,
    bind: async (sessionId, character, boundChatId, mode) => {
      bindCalls.push({ sessionId, character, chatId: boundChatId, contextMode: mode })
      await store.updateState((state) => ({
        sessionBindings: {
          ...state.sessionBindings,
          [sessionId]: { architecture: 'agent-tavern', contextMode: mode, character, chatId: boundChatId },
        },
      }))
    },
    variables,
    memories,
    vectors,
  })
  return { root, store, variables, memories, vectors, chatId, bindCalls, deps }
}

/** 带谱系 header 的宿主 fork 子会话桩（header 承载谱系，与真实宿主同形）。 */
function forkSession(
  id: string,
  parentSession: string,
  inheritedEventCount?: number,
  headerExtra: Record<string, unknown> = {},
): HostSessionLog {
  return {
    id,
    header: { version: 4, parentSession, isSeeded: true, ...headerExtra },
    ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
  } as unknown as HostSessionLog
}

/* ------------------------------ 谱系谓词 ------------------------------ */

describe('hostSessionForkInfo', () => {
  it('reads fork lineage from a v4 header', () => {
    expect(hostSessionForkInfo(forkSession('child', 'parent', 7))).toEqual({ parentSession: 'parent', inheritedEventCount: 7 })
  })

  it('omits inheritedEventCount when the host does not expose it', () => {
    expect(hostSessionForkInfo(forkSession('child', 'parent'))).toEqual({ parentSession: 'parent' })
  })

  it('excludes subagent children (origin and delegationDepth)', () => {
    expect(hostSessionForkInfo(forkSession('sub', 'parent', 3, { origin: 'subagent' }))).toBeUndefined()
    expect(hostSessionForkInfo(forkSession('sub', 'parent', 3, { delegationDepth: 1 }))).toBeUndefined()
  })

  it('returns undefined for non-fork sessions', () => {
    expect(hostSessionForkInfo({ id: 'plain', header: { version: 4 } } as HostSessionLog)).toBeUndefined()
    expect(hostSessionForkInfo({ id: 'plain' })).toBeUndefined()
    expect(hostSessionForkInfo(null)).toBeUndefined()
    // isSeeded 缺失 / parentSession 非字符串都不是 fork。
    expect(hostSessionForkInfo({ id: 'x', header: { version: 4, parentSession: 'p' } } as HostSessionLog)).toBeUndefined()
    expect(hostSessionForkInfo({ id: 'x', header: { version: 4, isSeeded: true, parentSession: 42 } } as unknown as HostSessionLog)).toBeUndefined()
  })
})

/* ------------------------------ forkChat 物化 ------------------------------ */

describe('TavernStore.forkChat', () => {
  it('clones the parent header, starts empty, and stamps lineage metadata', async () => {
    const { store, chatId } = await fixture()
    await seedParentMessages(store, chatId, 4)
    const result = await store.forkChat(CHARACTER, chatId, {
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      bookmarkMessageId: 2,
    })
    expect(result.chatId).toBe(`${chatId.replace(/\.jsonl$/i, '')} - fork 1.jsonl`)
    expect(result.chat.messages).toEqual([])
    const saved = await store.getChat(CHARACTER, result.chatId)
    expect(saved?.header.user_name).toBe('Alice')
    // guides 与 MVU 回执环随 header 克隆继承。
    expect(saved?.header.chat_metadata?.guides).toHaveLength(1)
    expect((saved?.header.chat_metadata?.mvu as { receipts: unknown[] }).receipts).toHaveLength(1)
    expect(saved?.header.chat_metadata?.agentTavernFork).toEqual({ sessionId: 'child-session', parentSessionId: 'parent-session' })
    expect(saved?.header.chat_metadata?.bookmark_link).toEqual({ character: CHARACTER, chatId, messageId: 2 })
  })

  it('increments the fork suffix without colliding and rejects blank lineage ids', async () => {
    const { store, chatId } = await fixture()
    const first = await store.forkChat(CHARACTER, chatId, { sessionId: 'a', parentSessionId: 'p' })
    const second = await store.forkChat(CHARACTER, chatId, { sessionId: 'b', parentSessionId: 'p' })
    expect(first.chatId.endsWith(' - fork 1.jsonl')).toBe(true)
    expect(second.chatId.endsWith(' - fork 2.jsonl')).toBe(true)
    await expect(store.forkChat(CHARACTER, chatId, { sessionId: '', parentSessionId: 'p' })).rejects.toThrow()
    await expect(store.forkChat(CHARACTER, chatId, { sessionId: 'c', parentSessionId: '' })).rejects.toThrow()
  })

  it('throws when the parent chat is missing', async () => {
    const { store } = await fixture()
    await expect(store.forkChat(CHARACTER, 'missing.jsonl', { sessionId: 'c', parentSessionId: 'p' })).rejects.toThrow(/not found/)
  })
})

/* ------------------------------ 端到端收养 ------------------------------ */

/** 父聊天里预置带投影身份的楼层（eventSeq 从 1 连续，可越过切点模拟父会话推进）。 */
async function seedParentMessages(store: TavernStore, chatId: string, count: number): Promise<void> {
  const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
  if (!snapshot) throw new Error('parent chat missing')
  const chat: ChatLogIR = structuredClone(snapshot.chat)
  for (let index = 0; index < count; index += 1) {
    chat.messages.push({
      name: index % 2 === 0 ? 'Alice' : CHARACTER,
      is_user: index % 2 === 0,
      is_system: false,
      send_date: new Date(1000 + index).toISOString(),
      mes: `floor ${index}`,
      extra: { agentTavern: { architecture: 'agent-tavern', contextMode: 'dsh-native', sessionId: 'parent-session', eventSeq: index + 1 } },
    })
  }
  await store.saveChat(CHARACTER, chatId, chat, snapshot.revision)
}

async function seedChatScope(variables: VariableStore, memories: MemoryStore, vectors: MemoryVectorStore, chatId: string): Promise<void> {
  await variables.patch('chat', chatId, [
    { name: 'affection', value: 3 },
    { name: 'trust', value: { level: 'low' } },
  ])
  await memories.put({
    id: 'mem-1', scope: 'chat', scopeId: chatId, kind: 'semantic',
    content: 'Alice 拿到了银钥匙', tags: ['key'], importance: 0.7, confidence: 0.9,
    source: { kind: 'agent-tool', sessionId: 'parent-session', chatId, character: CHARACTER },
  })
  await memories.put({
    id: 'mem-2', scope: 'chat', scopeId: chatId, kind: 'episodic',
    content: '门后的花园', importance: 0.4, confidence: 0.8,
    source: { kind: 'agent-tool', sessionId: 'parent-session', chatId, character: CHARACTER },
  })
  await vectors.put([{
    id: 'mem-1', scope: 'chat', scopeId: chatId,
    digest: memoryContentDigest('test-embed', 'Alice 拿到了银钥匙'),
    model: 'test-embed', vector: encodeVector([0.1, 0.2, 0.3, 0.4]),
  }])
}

describe('adoptAgentTavernFork', () => {
  it('materializes the fork chat, copies chat scope, and inherits the binding', async () => {
    const { store, variables, memories, vectors, chatId, bindCalls, deps } = await fixture('agent-managed')
    await seedParentMessages(store, chatId, 4)
    await seedChatScope(variables, memories, vectors, chatId)

    const outcome = await adoptAgentTavernFork(forkSession('child-session', 'parent-session', 5), deps())
    expect(outcome).toBe('adopted')

    const forkChatId = `${chatId.replace(/\.jsonl$/i, '')} - fork 1.jsonl`
    expect(bindCalls).toEqual([{ sessionId: 'child-session', character: CHARACTER, chatId: forkChatId, contextMode: 'agent-managed' }])
    const binding = (await store.getState()).sessionBindings['child-session']
    expect(binding).toMatchObject({ architecture: 'agent-tavern', character: CHARACTER, chatId: forkChatId, contextMode: 'agent-managed' })

    // chat 作用域变量：逐项 {name, value} 拷贝。
    expect((await variables.get('chat', forkChatId, 'affection'))?.value).toBe(3)
    expect((await variables.get('chat', forkChatId, 'trust'))?.value).toEqual({ level: 'low' })

    // 记忆同 id 拷贝、source 保留父谱系；向量按 (scope, scopeId, id) 迁移。
    const record = await memories.read('mem-1', 'chat', forkChatId)
    expect(record?.content).toBe('Alice 拿到了银钥匙')
    expect(record?.source.sessionId).toBe('parent-session')
    expect(await memories.read('mem-2', 'chat', forkChatId)).toBeDefined()
    expect(await vectors.get('mem-1', 'chat', forkChatId)).toMatchObject({ model: 'test-embed' })
  })

  it('is idempotent: a bound session is never re-adopted', async () => {
    const { store, chatId, deps } = await fixture()
    await seedParentMessages(store, chatId, 2)
    const session = forkSession('child-session', 'parent-session', 3)
    expect(await adoptAgentTavernFork(session, deps())).toBe('adopted')
    expect(await adoptAgentTavernFork(session, deps())).toBe('bound')
    const chats = (await store.listChats(CHARACTER)).filter((id) => id.includes(' - fork '))
    expect(chats).toHaveLength(1)
  })

  it('reuses a previously materialized fork chat after a crash before binding', async () => {
    const { store, chatId, bindCalls, deps } = await fixture()
    await seedParentMessages(store, chatId, 2)
    // 模拟崩溃残留：聊天带谱系标记落盘，但绑定从未写入。
    await store.forkChat(CHARACTER, chatId, { sessionId: 'child-session', parentSessionId: 'parent-session' })
    expect(await adoptAgentTavernFork(forkSession('child-session', 'parent-session', 3), deps())).toBe('adopted')
    const chats = (await store.listChats(CHARACTER)).filter((id) => id.includes(' - fork '))
    expect(chats).toHaveLength(1)
    expect(bindCalls[0]?.chatId).toBe(chats[0])
  })

  it('survives a partial memory copy from an interrupted adoption (idempotent re-run)', async () => {
    const { store, variables, memories, vectors, chatId, deps } = await fixture()
    await seedParentMessages(store, chatId, 2)
    await seedChatScope(variables, memories, vectors, chatId)
    // 模拟「记忆拷了一半崩溃」：fork 聊天已落盘 + 第一条记忆已进子作用域。
    const partial = await store.forkChat(CHARACTER, chatId, { sessionId: 'child-session', parentSessionId: 'parent-session' })
    await memories.put({
      id: 'mem-1', scope: 'chat', scopeId: partial.chatId, kind: 'semantic',
      content: 'Alice 拿到了银钥匙', importance: 0.7, confidence: 0.9,
      source: { kind: 'agent-tool', sessionId: 'parent-session', chatId, character: CHARACTER },
    })
    expect(await adoptAgentTavernFork(forkSession('child-session', 'parent-session', 3), deps())).toBe('adopted')
    // 已存在的记录跳过、缺失的补齐；收养完整落绑定。
    expect(await memories.read('mem-1', 'chat', partial.chatId)).toBeDefined()
    expect(await memories.read('mem-2', 'chat', partial.chatId)).toBeDefined()
    expect((await store.getState()).sessionBindings['child-session']?.chatId).toBe(partial.chatId)
  })

  it('points the backlink at the last projected floor at or before the fork cut', async () => {
    const { store, chatId, deps } = await fixture()
    await seedParentMessages(store, chatId, 4)
    // 父聊天楼层 eventSeq 1..4；inheritedEventCount 3 → 边界 seq 2（下标 1 的
    // 楼层），父会话越过切点的楼层（seq 3/4）不进回链。
    await adoptAgentTavernFork(forkSession('child-session', 'parent-session', 3), deps())
    const binding = (await store.getState()).sessionBindings['child-session']!
    const saved = await store.getChat(CHARACTER, binding.chatId)
    expect(saved?.header.chat_metadata?.bookmark_link).toEqual({ character: CHARACTER, chatId, messageId: 1 })
  })

  it('skips non-fork sessions, subagents, and non-AgentTavern parents without side effects', async () => {
    const { store, chatId, deps } = await fixture()
    await seedParentMessages(store, chatId, 2)

    expect(await adoptAgentTavernFork({ id: 'plain', header: { version: 4 } } as HostSessionLog, deps())).toBe('skipped')
    expect(await adoptAgentTavernFork(forkSession('sub-agent', 'parent-session', 3, { origin: 'subagent' }), deps())).toBe('skipped')
    expect(await adoptAgentTavernFork(undefined, deps())).toBe('skipped')

    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'parent-session': { architecture: 'st', character: CHARACTER, chatId },
      },
    }))
    const logs: string[] = []
    expect(await adoptAgentTavernFork(forkSession('st-child', 'parent-session', 3), { ...deps(), logger: { info: (m) => logs.push(m) } })).toBe('skipped')
    expect(logs[0]).toContain('st-child')
    expect((await store.listChats(CHARACTER)).some((id) => id.includes(' - fork '))).toBe(false)
  })

  it('skips when the parent chat is missing (no chat to clone a header from)', async () => {
    const { store, deps } = await fixture()
    // 把父绑定指向一个不存在的聊天 id 来构造「父聊天缺失」。
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        'parent-session': { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: 'ghost.jsonl' },
      },
    }))
    const warns: string[] = []
    expect(await adoptAgentTavernFork(forkSession('child-session', 'parent-session', 3), { ...deps(), logger: { warn: (m) => warns.push(m) } })).toBe('skipped')
    expect(warns[0]).toContain('child-session')
    expect((await store.listChats(CHARACTER)).some((id) => id.includes(' - fork '))).toBe(false)
  })
})

/* ------------------------------ 投影回填 ------------------------------ */

describe('fork chat projection replay', () => {
  it('fills the adopted chat from the child session events with child identity', async () => {
    const { root, store, chatId, deps } = await fixture()
    await seedParentMessages(store, chatId, 2)

    const childSession = {
      id: 'child-session',
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        {
          // 激活 marker（插件 notice source）不投影回 JSONL。
          type: 'user/message', seq: 1, time: 1100,
          data: {
            id: 'marker', role: 'user',
            content: [{ type: 'text', text: `Tavern roleplay chat for ${CHARACTER}.` }],
            source: { kind: 'plugin:dsh-soulmojito', form: 'notice', summary: `Tavern: ${CHARACTER}` },
          },
        },
        {
          type: 'user/message', seq: 2, time: 1200,
          data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '继续走。' }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: 3, time: 1300,
          data: {
            turn: 1, step: 1, stream: [],
            message: {
              id: 'a1', role: 'assistant',
              content: [{ type: 'text', text: '她推开了门。' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    } as unknown as NativeSession

    const adopted = await adoptAgentTavernFork(
      { ...childSession, header: { version: 4, parentSession: 'parent-session', isSeeded: true } } as unknown as HostSessionLog,
      deps(),
    )
    expect(adopted).toBe('adopted')

    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(childSession)

    const binding = (await store.getState()).sessionBindings['child-session']!
    const chat = await store.getChat(CHARACTER, binding.chatId)
    expect(chat?.messages.map((message) => message.mes)).toEqual(['继续走。', '她推开了门。'])
    for (const message of chat?.messages ?? []) {
      const origin = message.extra?.agentTavern as Record<string, unknown>
      expect(origin?.sessionId).toBe('child-session')
    }
    // 幂等重放不叠楼层。
    await projector.replay(childSession)
    const again = await store.getChat(CHARACTER, binding.chatId)
    expect(again?.messages).toHaveLength(2)
  })
})
