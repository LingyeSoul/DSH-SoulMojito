import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, type AgentContextLike } from '../src/agent-tavern/agent.js'
import type { ImRuntimeHandle } from '../src/im/handle.js'
import { createImTools, IM_SEND_MAX_CHARS, imPeerAlias, type ImToolsDeps } from '../src/im/tools.js'
import { TavernStore } from '../../tavern-store/src/index.js'

interface PeerRow {
  alias: string
  channel: string
  scope: string
  character: string
  chatId: string
}

const ALICE = 'qq:acct-a:private:alice'
const BOB = 'qq:acct-a:private:bob'
const GROUP = 'qq:acct-a:group:g1'
const aliceAlias = imPeerAlias('qq', 'private', ALICE)
const bobAlias = imPeerAlias('qq', 'private', BOB)
const groupAlias = imPeerAlias('qq', 'group', GROUP)

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-tools-'))
  process.env.DSH_HOME = root
  delete process.env.DSH_SOULMOJITO_DISABLE_IM
  db = await TavernStore.open(root)
  await db.updateState(() => ({
    imPeers: {
      [ALICE]: {
        sessionId: 'session-a',
        character: 'Example',
        chatId: 'chat-a.jsonl',
        scope: 'private',
        boundBy: 'manual',
        createdAt: new Date(0).toISOString(),
      },
      [GROUP]: {
        sessionId: 'session-a',
        character: 'Example',
        chatId: 'chat-a.jsonl',
        scope: 'group',
        boundBy: 'auto',
        createdAt: new Date(0).toISOString(),
      },
      [BOB]: {
        sessionId: 'session-b',
        character: 'Example',
        chatId: 'chat-b.jsonl',
        scope: 'private',
        boundBy: 'manual',
        createdAt: new Date(0).toISOString(),
      },
    },
  }))
})

afterEach(async () => {
  delete process.env.DSH_HOME
  delete process.env.DSH_SOULMOJITO_DISABLE_IM
  // apply() 的预设预热是 fire-and-forget，临时目录可能在下一个 tick 才落文件：
  // 删除重试几轮，避免测试清理与异步装载竞态（生产路径本来就是异步装载）。
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

interface RuntimeHarness {
  runtime: ImRuntimeHandle
  sent: Array<{ peerKey: string; text: string }>
}

function runtimeHarness(options: { available?: boolean; reasons?: string[]; fail?: string } = {}): RuntimeHarness {
  const sent: RuntimeHarness['sent'] = []
  return {
    sent,
    runtime: {
      capabilities: {
        available: options.available ?? true,
        reasons: options.reasons ?? [],
      },
      views: () => [
        { channel: 'qq', accountId: 'acct-a', status: { state: 'online', since: 1_000 }, peers: 2 },
        { channel: 'weixin', accountId: 'acct-b', status: { state: 'paused', reason: 'token expired' }, peers: 0 },
      ],
      bindChat: async (chat) => ({ sessionId: 'session-a', character: chat.character, chatId: chat.chatId }),
      handleSessionEvent: () => {},
      dispose: async () => {},
      router: {
        sendText: async (peerKey, text) => {
          if (options.fail !== undefined) throw new Error(options.fail)
          sent.push({ peerKey, text })
          return { parts: 1, at: 1_700_000_000_000 }
        },
      },
    },
  }
}

function depsWith(runtime: ImRuntimeHandle | undefined): ImToolsDeps {
  return { db: async () => db, runtime: () => runtime }
}

function toolsOf(runtime: ImRuntimeHandle | undefined) {
  const tools = createImTools(depsWith(runtime))
  return {
    list: tools,
    call: async (name: string, args: Record<string, unknown>, agentId = 'session-a'): Promise<any> => {
      const tool = tools.find((entry) => entry.name === name)
      if (tool === undefined) throw new Error(`tool ${name} is not registered`)
      return tool.execute(args, { agent: { id: agentId } })
    },
  }
}

describe('im_identity', () => {
  it('lists only the peers bound to the executing session, with aliases and no platform ids', async () => {
    const { runtime } = runtimeHarness()
    const { call, list } = toolsOf(runtime)
    const result = await call('im_identity', {}) as { peers: PeerRow[] }
    expect(result.peers).toEqual([
      { alias: groupAlias, channel: 'qq', scope: 'group', character: 'Example', chatId: 'chat-a.jsonl' },
      { alias: aliceAlias, channel: 'qq', scope: 'private', character: 'Example', chatId: 'chat-a.jsonl' },
    ])
    // 平台身份（openid/openid-like）不得进入模型上下文。
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('acct-a')
    const identity = list.find((tool) => tool.name === 'im_identity')
    expect(identity?.parameters).not.toHaveProperty('sessionId')
  })

  it('returns an empty peer list for an unbound session', async () => {
    const { runtime } = runtimeHarness()
    const { call } = toolsOf(runtime)
    expect(await call('im_identity', {}, 'session-unknown')).toEqual({ peers: [] })
  })
})

describe('im_channels', () => {
  it('degrades to available:false with a reason when the runtime is missing', async () => {
    const { call } = toolsOf(undefined)
    expect(await call('im_channels', {})).toEqual({
      available: false,
      reasons: ['IM runtime is not mounted in this host process'],
      channels: [],
    })
  })

  it('projects channel states from the runtime without any secret fields', async () => {
    const { runtime } = runtimeHarness()
    const { call } = toolsOf(runtime)
    expect(await call('im_channels', {})).toEqual({
      available: true,
      reasons: [],
      channels: [
        { channel: 'qq', accountId: 'acct-a', state: 'online' },
        { channel: 'weixin', accountId: 'acct-b', state: 'paused' },
      ],
    })
  })

  it('reports capability reasons when the host cannot host IM sessions', async () => {
    const { runtime } = runtimeHarness({ available: false, reasons: ['the host exposes no agents service'] })
    const { call } = toolsOf(runtime)
    expect(await call('im_channels', {})).toMatchObject({
      available: false,
      reasons: ['the host exposes no agents service'],
    })
  })
})

describe('im_send', () => {
  it('uses the single binding when peer is omitted and sends trimmed text', async () => {
    const { runtime, sent } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await db.updateState((state) => {
      const peers = { ...(state.imPeers ?? {}) }
      delete peers[GROUP]
      delete peers[BOB]
      return { imPeers: peers }
    })
    const result = await call('im_send', { text: '  在吗  ' }) as { peer: string; parts: number }
    expect(result).toMatchObject({ peer: aliceAlias, parts: 1 })
    expect(sent).toEqual([{ peerKey: ALICE, text: '在吗' }])
  })

  it('rejects an alias bound to another session', async () => {
    const { runtime, sent } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: 'hi', peer: bobAlias }))
      .rejects.toThrow(`peer '${bobAlias}' is not bound to this session`)
    expect(sent).toEqual([])
  })

  it('requires an explicit peer when several peers are bound', async () => {
    const { runtime, sent } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: 'hi' }))
      .rejects.toThrow(`this session is bound to 2 IM peers; pass peer to choose one of: ${groupAlias}, ${aliceAlias}`)
    expect(sent).toEqual([])
    await call('im_send', { text: 'hi', peer: aliceAlias })
    expect(sent).toEqual([{ peerKey: ALICE, text: 'hi' }])
  })

  it('refuses blank and over-long text before touching the runtime', async () => {
    const { runtime, sent } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: '   ' })).rejects.toThrow('text must not be blank')
    await expect(call('im_send', { text: 'x'.repeat(IM_SEND_MAX_CHARS + 1) }))
      .rejects.toThrow(`text must be at most ${IM_SEND_MAX_CHARS} characters, received ${IM_SEND_MAX_CHARS + 1}`)
    expect(sent).toEqual([])
  })

  it('fails loudly when the IM runtime is missing', async () => {
    const { call } = toolsOf(undefined)
    await expect(call('im_send', { text: 'hi', peer: aliceAlias }))
      .rejects.toThrow('IM runtime is not available in this host process')
  })

  it('propagates transport failures instead of reporting a silent success', async () => {
    const { runtime } = runtimeHarness({ fail: 'socket closed' })
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: 'hi', peer: aliceAlias }))
      .rejects.toThrow('socket closed')
  })
})

function registeredToolNames(): string[] {
  const names: string[] = []
  apply({
    systemPrompt: { section: () => {}, context: () => {} },
    tools: { register: (entry) => { names.push(entry.name) } },
    effect: (factory) => factory(),
  } satisfies AgentContextLike)
  return names
}

describe('IM tool registration', () => {
  it('appends the IM tools after the existing surface whenever IM is not disabled by env', () => {
    const baseline = registeredToolNames()
    expect(baseline.slice(-3)).toEqual(['im_identity', 'im_channels', 'im_send'])
    // 运行时是否已发布不影响注册：发布是异步的，用它做门控会让启动期会话少三件工具。
    expect(baseline.length).toBeGreaterThan(3)
  })

  it('registers no IM tool at all when the env kill switch is on', () => {
    process.env.DSH_SOULMOJITO_DISABLE_IM = '1'
    try {
      expect(registeredToolNames()).not.toContain('im_identity')
    } finally {
      delete process.env.DSH_SOULMOJITO_DISABLE_IM
    }
  })
})
