import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import {
  beginStreamEpoch,
  drainStreamDeltas,
  emitChatSaved,
  emitStreamDelta,
  modEvents,
  type ModEventPayloads,
} from '../src/mods/events.js'
import { ModHost } from '../src/mods/host.js'
import { TavernStore } from '../../tavern-store/src/index.js'

// A-3 Mod 流式 token 事件（stream-delta，decisions/2026-10-11-mod-stream-delta.md）：
// - 接线：runGeneration 的 llm.stream 消费点逐 text-delta chunk 发射（apply 真跑
//   生成路径），send/regenerate 两 mode 的 payload 形状与累积 text 正确性；
// - 发射纪律：无订阅快路径、投递保序、handler 抛错不中断生成（总线吞错）；
// - 审计防洪：宿主适配层（ModHost events.on 包装）每流代次每 mod 只记首条
//   event-error，同代次静默、新代次再审计；其余 kind 逐次审计不变；
// - 生命周期：disable 反注册（hasListeners 归 false）；未知 kind 注册期抛错。
// 不动 tavern-mods.spec.ts（并发施工避让），夹具沿用其与 tavern-generation-hooks
// 的既有模式。

const CHAR = 'Stream Character'

/* ------------------------------ 夹具（既有模式） ------------------------------ */

function makeRequest(body: unknown, url: string, method = 'POST') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
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

function writeMod(root: string, id: string, manifest: unknown, entry: string): string {
  const directory = join(root, 'mods', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'mod.json'), JSON.stringify(manifest), 'utf8')
  writeFileSync(join(directory, 'index.mjs'), entry, 'utf8')
  return directory
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sample.mod',
    name: 'Sample',
    version: '1.0.0',
    author: 'tester',
    description: 'sample mod',
    main: 'index.mjs',
    ...overrides,
  }
}

/** 假 state store：只实现 ModHost 用到的 getState/updateState 两个面。 */
function fakeStateStore(initial: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {}) {
  let state = {
    modsEnabled: initial.modsEnabled === true,
    mods: { enabled: { ...(initial.enabled ?? {}) } },
  }
  return {
    getState: async () => structuredClone(state),
    updateState: async (update: (current: typeof state) => Partial<typeof state>) => {
      state = { ...state, ...update(structuredClone(state)) }
      return structuredClone(state)
    },
  }
}

/* --------------------- 接线：runGeneration 流式消费点 --------------------- */

describe('stream-delta wiring in runGeneration (A-3)', () => {
  let home: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let chatId: string
  const offs: Array<() => void> = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-stream-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter(importBody(CHAR))
    await store.putPreset('stream-preset', {
      prompts: [{ identifier: 'chatHistory', marker: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
    })
    await store.patchState({ activePreset: 'stream-preset' })
    chatId = await store.createChat(CHAR, {
      user_name: 'Alice', character_name: CHAR, chat_metadata: { createdAt: new Date().toISOString() },
    }, [])

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
        // 三个正文 text-delta + 一个 reasoning-delta：reasoning 不进 stream-delta
        // 事件（v1 只观察正文）是断言点之一。
        stream: async function* () {
          yield { type: 'reasoning-delta', text: '(inner monologue)' }
          yield { type: 'text-delta', text: 'Hello' }
          yield { type: 'text-delta', text: ', ' }
          yield { type: 'text-delta', text: 'world' }
          yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
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

  afterEach(() => {
    for (const off of offs.splice(0)) off()
  })

  async function generate(body: Record<string, unknown>) {
    const snapshot = await store.getChatSnapshot(CHAR, chatId)
    const res = makeResponse()
    await apiHandler(makeRequest({ character: CHAR, chatId, revision: snapshot!.revision, ...body }, '/api/dsh-soulmojito/generate'), res)
    expect(res.chunks.some((chunk) => chunk.includes('"type":"saved"'))).toBe(true)
    await drainStreamDeltas() // stream-delta 投递是 fire-and-forget，先排空再断言
  }

  it('emits one event per text-delta chunk with accumulated text (send mode)', async () => {
    const seen: ModEventPayloads['stream-delta'][] = []
    offs.push(modEvents.on('stream-delta', (payload) => { seen.push(payload) }))
    await generate({ message: 'stream probe' })
    expect(seen.map((p) => p.delta)).toEqual(['Hello', ', ', 'world'])
    expect(seen.map((p) => p.text)).toEqual(['Hello', 'Hello, ', 'Hello, world'])
    for (const payload of seen) {
      expect(payload.mode).toBe('send')
      expect(payload.character).toBe(CHAR)
      expect(payload.chatId).toBe(chatId)
      // reasoning 增量不进事件：text 只含正文累积
      expect(payload.text).not.toContain('(inner monologue)')
    }
  })

  it('labels the regenerate mode on the same stream consumption point', async () => {
    // 先垫一轮 send，保证 regenerate 有旧助手楼层可弹
    await generate({ message: 'seed turn' })
    const modes: string[] = []
    offs.push(modEvents.on('stream-delta', (payload) => { modes.push(payload.mode) }))
    await generate({ mode: 'regenerate' })
    expect(modes).toEqual(['regenerate', 'regenerate', 'regenerate'])
  })

  it('keeps the zero-overhead fast path when no mod subscribes', async () => {
    expect(modEvents.hasListeners('stream-delta')).toBe(false)
    await generate({ message: 'no listener turn' }) // 生成照常 saved（快路径不炸）
    expect(modEvents.hasListeners('stream-delta')).toBe(false)
  })

  it('a throwing handler never interrupts generation and other listeners still get every chunk', async () => {
    const served: string[] = []
    offs.push(modEvents.on('stream-delta', () => { throw new Error('stream listener exploded') }))
    offs.push(modEvents.on('stream-delta', (payload) => { served.push(payload.delta) }))
    await generate({ message: 'throwing listener turn' }) // 内部断言 saved
    expect(served).toEqual(['Hello', ', ', 'world'])
  })
})

/* --------------------- 审计防洪与生命周期（ModHost 面） --------------------- */

describe('stream-delta audit flood control and lifecycle (api.events adapter)', () => {
  const openedHosts: ModHost[] = []
  const homes: string[] = []

  async function open(
    state: { modsEnabled?: boolean; enabled?: Record<string, boolean> } = {},
    write?: (home: string) => void,
  ) {
    const home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-streammod-'))
    homes.push(home)
    write?.(home)
    const fake = fakeStateStore(state)
    const host = await ModHost.open({
      ctx: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
      root: home,
      hostVersion: '0.4.1',
      dbProvider: async () => fake as never,
    })
    openedHosts.push(host)
    return { host, home }
  }

  afterEach(async () => {
    for (const host of openedHosts.splice(0)) await host.disposeAll()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const auditLines = (home: string, event: string) =>
    readFileSync(join(home, 'mods', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"${event}"`))

  /** 每次 delivery 必炸的 stream-delta 订阅者。 */
  const BAD_STREAM_ENTRY = `
    export async function setup(api) {
      api.events.on('stream-delta', async () => { throw new Error('stream kaboom') })
    }
  `

  const emitChunks = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      emitStreamDelta({ mode: 'send', character: 'C', chatId: 'c1', text: 'x'.repeat(i + 1), delta: 'x' })
    }
  }

  it('audits only the first failing stream-delta handler per generation epoch and silences the rest', async () => {
    const { home } = await open(
      { modsEnabled: true, enabled: { 'bad-stream': true } },
      (h) => { writeMod(h, 'bad-stream', validManifest({ id: 'bad-stream' }), BAD_STREAM_ENTRY) },
    )
    beginStreamEpoch()
    emitChunks(3) // 逐 chunk 抛错：一轮生成只许一条审计
    await drainStreamDeltas()
    const errors = auditLines(home, 'event-error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"mod":"bad-stream"')
    expect(errors[0]).toContain('stream-delta: stream kaboom')
    expect(errors[0]).toContain('silenced')

    // 新代次（下一次生成）首错重新可审计：mod 修不好自己会持续暴露
    beginStreamEpoch()
    emitChunks(2)
    await drainStreamDeltas()
    expect(auditLines(home, 'event-error')).toHaveLength(2)
  })

  it('keeps per-occurrence auditing for the low-frequency kinds (behavior unchanged)', async () => {
    const { home } = await open(
      { modsEnabled: true, enabled: { 'chat-thrower': true } },
      (h) => {
        writeMod(h, 'chat-thrower', validManifest({ id: 'chat-thrower' }), `
          export async function setup(api) {
            api.events.on('chat-saved', async () => { throw new Error('chat kaboom') })
          }
        `)
      },
    )
    await emitChatSaved('C', 'c1', 'r1', 2)
    await emitChatSaved('C', 'c1', 'r2', 4)
    const errors = auditLines(home, 'event-error')
    expect(errors).toHaveLength(2) // 非 stream-delta：逐次审计，无静默
    for (const line of errors) expect(line).toContain('chat kaboom')
  })

  it('unregisters stream-delta listeners when the mod is disabled', async () => {
    const { host } = await open(
      { modsEnabled: true, enabled: { 'bad-stream': true } },
      (h) => { writeMod(h, 'bad-stream', validManifest({ id: 'bad-stream' }), BAD_STREAM_ENTRY) },
    )
    expect(modEvents.hasListeners('stream-delta')).toBe(true)
    await host.setModEnabled('bad-stream', false)
    expect(modEvents.hasListeners('stream-delta')).toBe(false)
  })

  it('still rejects unknown event kinds at registration time', async () => {
    const { host } = await open(
      { modsEnabled: true, enabled: { 'bad-kind': true } },
      (h) => {
        writeMod(h, 'bad-kind', validManifest({ id: 'bad-kind' }), `
          export async function setup(api) { api.events.on('bogus-kind', () => {}) }
        `)
      },
    )
    const mod = host.snapshot().mods.find((entry) => entry.id === 'bad-kind')!
    expect(mod.status).toBe('error')
    expect(mod.error).toContain('unknown mod event kind')
  })
})
