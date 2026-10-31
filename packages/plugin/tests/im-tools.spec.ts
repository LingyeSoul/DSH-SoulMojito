import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImRuntimeHandle } from '../src/im/handle.js'
import type { ImMessageRefEntry } from '../src/im/refs.js'
import { createImTools, IM_SEND_MAX_CHARS, imPeerAlias, type ImToolsDeps } from '../src/im/tools.js'
import { TavernStore } from '../../tavern-store/src/index.js'

interface PeerRow {
  alias: string
  channel: string
  scope: string
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
        scope: 'private',
        boundBy: 'manual',
        createdAt: new Date(0).toISOString(),
      },
      [GROUP]: {
        sessionId: 'session-a',
        scope: 'group',
        boundBy: 'auto',
        createdAt: new Date(0).toISOString(),
      },
      [BOB]: {
        sessionId: 'session-b',
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
  sent: Array<{ peerKey: string; text: string; options?: { passiveReplyTo?: string } }>
  media: Array<{ peerKey: string; media: unknown; options?: { passiveReplyTo?: string } }>
}

/**
 * 假 router 故意比公开接口多一个 `lastPeerOf`：`im_send` 已经不再咨询它，保留
 * 这个属性是为了证明「多个绑定并存时工具不回退到最近入站 peer」（见对应用例）。
 * 公开接口删掉该成员后，用这里的交叉类型断言让「故意多带」继续编译。
 */
type FakeImRouterHandle = ImRuntimeHandle['router'] & {
  lastPeerOf: (sessionId: string) => string | undefined
}

function runtimeHarness(options: { available?: boolean; reasons?: string[]; fail?: string; lastPeer?: string; messageRefs?: Record<string, ImMessageRefEntry> } = {}): RuntimeHarness {
  const sent: RuntimeHarness['sent'] = []
  const media: RuntimeHarness['media'] = []
  const refs = new Map(Object.entries(options.messageRefs ?? {}))
  return {
    sent,
    media,
    runtime: {
      capabilities: {
        available: options.available ?? true,
        reasons: options.reasons ?? [],
      },
      views: () => [
        { channel: 'qq', accountId: 'acct-a', status: { state: 'online', since: 1_000 }, peers: 2 },
        { channel: 'weixin', accountId: 'acct-b', status: { state: 'paused', reason: 'token expired' }, peers: 0 },
      ],
      // 账号管理与 OneBot webhook 不属于工具面用例的覆盖范围；补空实现只为
      // 让这个假运行时保持与 ImRuntimeHandle 同形。
      upsertAccount: async () => {},
      removeAccount: async () => false,
      handleOneBotWebhook: async () => false,
      dispose: async () => {},
      router: {
        sendText: async (peerKey, text, sendOptions) => {
          if (options.fail !== undefined) throw new Error(options.fail)
          sent.push({ peerKey, text, ...(sendOptions === undefined ? {} : { options: sendOptions }) })
          return { parts: 1, at: 1_700_000_000_000 }
        },
        sendMedia: async (peerKey, payload, sendOptions) => {
          if (options.fail !== undefined) throw new Error(options.fail)
          media.push({ peerKey, media: payload, ...(sendOptions === undefined ? {} : { options: sendOptions }) })
          return { parts: 1, at: 1_700_000_000_000 }
        },
        resolveMessageRef: (ref) => refs.get(ref),
        // 故意保留 lastPeerOf：见 FakeImRouterHandle 的说明，用于证明工具忽略它。
        lastPeerOf: (sessionId) => (sessionId === 'session-a' ? options.lastPeer : undefined),
      } as FakeImRouterHandle,
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
      { alias: groupAlias, channel: 'qq', scope: 'group' },
      { alias: aliceAlias, channel: 'qq', scope: 'private' },
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

  it('skips a malformed peer key instead of failing the whole tool surface', async () => {
    await db.updateState((state) => ({
      imPeers: {
        ...(state.imPeers ?? {}),
        'broken-key': { sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
    }))
    const { runtime } = runtimeHarness()
    const { call } = toolsOf(runtime)
    const result = await call('im_identity', {}) as { peers: PeerRow[] }
    expect(result.peers.map((peer) => peer.alias)).toEqual([groupAlias, aliceAlias])
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

  it('does not fall back to the most recent inbound peer when several are bound', async () => {
    // 运行时仍报得出「最近入站对端」，但多对端交错时那不是确定目标：
    // 省略 peer 必须直接拒绝，绝不替模型猜。
    const { runtime, sent } = runtimeHarness({ lastPeer: ALICE })
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: '收到' }))
      .rejects.toThrow(`this session is bound to 2 IM peers; pass peer to choose one of: ${groupAlias}, ${aliceAlias}`)
    expect(sent).toEqual([])
  })

  it('anchors a reply to a message ref and passes the passive anchor to the send', async () => {
    const ref = 'msg-1a2b3c4d5e'
    const { runtime, sent, media } = runtimeHarness({ messageRefs: {
      [ref]: { peerKey: ALICE, sessionId: 'session-a', replyTo: 'platform-msg-1', at: 1_000 },
    } })
    const { call } = toolsOf(runtime)
    const result = await call('im_send', { text: '收到', replyTo: ref }) as { peer: string; parts: number }
    expect(result).toMatchObject({ peer: aliceAlias, parts: 1 })
    expect(sent).toEqual([{ peerKey: ALICE, text: '收到', options: { passiveReplyTo: 'platform-msg-1' } }])
    // 媒体发送也带同一个被动锚点（文本与媒体同一条消息引用）。
    await call('im_send', { mediaKind: 'file', mediaPath: 'C:\\tmp\\a.pdf', replyTo: ref })
    expect(media).toEqual([{
      peerKey: ALICE,
      media: { kind: 'file', localPath: 'C:\\tmp\\a.pdf' },
      options: { passiveReplyTo: 'platform-msg-1' },
    }])
  })

  it('rejects an unknown ref and a ref whose peer is not bound to this session', async () => {
    const foreign = 'msg-9876543210'
    const { runtime, sent } = runtimeHarness({ messageRefs: {
      [foreign]: { peerKey: BOB, sessionId: 'session-b', at: 1_000 },
    } })
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: 'hi', replyTo: 'msg-deadbeef00' }))
      .rejects.toThrow("message ref 'msg-deadbeef00' is unknown or expired for this session")
    await expect(call('im_send', { text: 'hi', replyTo: foreign }))
      .rejects.toThrow(`message ref '${foreign}' does not belong to this session`)
    expect(sent).toEqual([])
  })

  it('rejects a peer argument that disagrees with the replyTo ref', async () => {
    const ref = 'msg-1a2b3c4d5e'
    const { runtime, sent } = runtimeHarness({ messageRefs: {
      [ref]: { peerKey: ALICE, sessionId: 'session-a', at: 1_000 },
    } })
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { text: 'hi', replyTo: ref, peer: groupAlias }))
      .rejects.toThrow(`replyTo targets a different peer than peer='${groupAlias}'`)
    expect(sent).toEqual([])
    // 与 ref 一致的 peer 照常通过：ref 没有被动锚点时回退自动锚点。
    await call('im_send', { text: 'hi', replyTo: ref, peer: aliceAlias })
    expect(sent).toEqual([{ peerKey: ALICE, text: 'hi' }])
  })

  it('lets replyTo alone pick the peer when several peers are bound', async () => {
    const ref = 'msg-1a2b3c4d5e'
    const { runtime, sent } = runtimeHarness({ messageRefs: {
      [ref]: { peerKey: ALICE, sessionId: 'session-a', at: 1_000 },
    } })
    const { call } = toolsOf(runtime)
    // session-a 同时绑了 alice + group：正常省略 peer 会被拒绝；ref 自己指明目标，
    // 这是「多绑定必须显式传 peer」的唯一例外。
    const result = await call('im_send', { text: '收到', replyTo: ref }) as { peer: string }
    expect(result.peer).toBe(aliceAlias)
    expect(sent).toEqual([{ peerKey: ALICE, text: '收到' }])
  })

  it('documents the msg ref and the optional replyTo in the tool description', () => {
    const { runtime } = runtimeHarness()
    const { list } = toolsOf(runtime)
    const send = list.find((entry) => entry.name === 'im_send')
    expect(send?.description).toContain('msg=')
    expect(send?.description).toContain('replyTo')
  })

  it('rejects an omitted peer with the zero-binding error and an unknown alias with its own error', async () => {
    const { runtime, sent } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await db.updateState((state) => {
      const peers = { ...(state.imPeers ?? {}) }
      delete peers[ALICE]
      delete peers[GROUP]
      return { imPeers: peers }
    })
    // 零绑定 + 省略 peer：必须是「本会话没有绑定」这条，不能落到别名消息上。
    await expect(call('im_send', { text: 'hi' }))
      .rejects.toThrow('this session has no IM peer binding; bind one in the dsh-soulmojito IM panel first')
    // 零绑定 + 显式不存在的 alias：仍走别名分支，两条错误各归各。
    await expect(call('im_send', { text: 'hi', peer: 'peer-missing' }))
      .rejects.toThrow("peer 'peer-missing' is not bound to this session")
    expect(sent).toEqual([])
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


describe('im_send media', () => {
  it('sends an absolute local file and reports the media kind', async () => {
    const { runtime, media } = runtimeHarness()
    const { call } = toolsOf(runtime)
    const result = await call('im_send', {
      mediaKind: 'image',
      mediaPath: 'C:\\tmp\\shot.png',
      text: '看这个',
      peer: aliceAlias,
    })
    expect(result).toMatchObject({ peer: aliceAlias, mediaKind: 'image', parts: 1 })
    expect(media).toEqual([{
      peerKey: ALICE,
      media: { kind: 'image', localPath: 'C:\\tmp\\shot.png', caption: '看这个' },
    }])
  })

  it('rejects both sources at once, relative paths, unknown kinds and dangling names', async () => {
    const { runtime } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await expect(call('im_send', { mediaKind: 'image', mediaPath: 'C:\\a.png', mediaUrl: 'https://example.invalid/a.png' }))
      .rejects.toThrow(/either mediaPath or mediaUrl/)
    await expect(call('im_send', { mediaKind: 'image', mediaPath: 'relative.png' }))
      .rejects.toThrow(/not absolute/)
    await expect(call('im_send', { mediaKind: 'sticker', mediaPath: 'C:\\a.png' }))
      .rejects.toThrow(/mediaKind must be one of/)
    await expect(call('im_send', { mediaName: 'x.png' }))
      .rejects.toThrow(/need mediaPath or mediaUrl/)
    await expect(call('im_send', {}))
      .rejects.toThrow(/needs text, mediaPath or mediaUrl/)
  })

  it('accepts an http(s) url and rejects other protocols', async () => {
    const { runtime, media } = runtimeHarness()
    const { call } = toolsOf(runtime)
    await call('im_send', { mediaKind: 'video', mediaUrl: 'https://example.invalid/v.mp4', peer: aliceAlias })
    expect(media[0]?.media).toEqual({ kind: 'video', url: 'https://example.invalid/v.mp4' })
    await expect(call('im_send', { mediaKind: 'video', mediaUrl: 'file:///c:/v.mp4' }))
      .rejects.toThrow(/expected http\(s\)/)
  })

  it('reports a runtime that cannot send media instead of faking success', async () => {
    const { runtime } = runtimeHarness()
    const patched: ImRuntimeHandle = { ...runtime, router: { sendText: runtime.router.sendText } }
    const { call } = toolsOf(patched)
    await expect(call('im_send', { mediaKind: 'file', mediaPath: 'C:\\tmp\\a.pdf', peer: aliceAlias }))
      .rejects.toThrow(/cannot send media/)
  })
})


