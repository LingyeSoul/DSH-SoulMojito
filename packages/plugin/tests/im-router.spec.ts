import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { createImRouter, IM_DELIVERY_FAILED, IM_SESSION_NOT_LIVE, IM_UNBOUND_NOTICE, ImSendError, relayTextOf } from '../src/im/router.js'
import { ImSessionNotLiveError } from '../src/im/session-host.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey } from '../src/im/types.js'
import type { ImInbound } from '../src/im/types.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-router-'))
  db = await TavernStore.open(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Harness {
  router: ReturnType<typeof createImRouter>
  inserts: Array<{ sessionId: string; text: string; id: string; summary: string }>
  sent: Array<{ peerId: string; texts: string[]; replyTo?: string }>
  sentKinds: string[][]
  sentMedia: Array<Array<{ kind: string; localPath?: string; url?: string }>>
  seen: Set<string>
  now: () => number
  tick: (ms: number) => void
}

function harness(options: {
  insert?: (sessionId: string, message: { id: string; text: string; summary: string }) => Promise<void>
  workspaceRoot?: () => Promise<string>
} = {}): Harness {
  const inserts: Harness['inserts'] = []
  const sent: Harness['sent'] = []
  const sentKinds: Harness['sentKinds'] = []
  const sentMedia: Harness['sentMedia'] = []
  const seen = new Set<string>()
  let clock = 1_000
  const router = createImRouter({
    db,
    now: () => clock,
    seenDedupe: async (key) => {
      if (seen.has(key)) return true
      seen.add(key)
      return false
    },
    insert: async (sessionId, message) => {
      if (options.insert !== undefined) {
        await options.insert(sessionId, message)
        return
      }
      inserts.push({ sessionId, text: message.text, id: message.id, summary: message.summary })
    },
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    send: async (target, parts) => {
      sent.push({
        peerId: target.peerId,
        texts: parts.filter((part) => part.kind === 'text').map((part) => part.text),
        ...(target.replyTo === undefined ? {} : { replyTo: target.replyTo }),
      })
      sentKinds.push(parts.map((part) => part.kind))
      sentMedia.push(parts.filter((part) => part.kind !== 'text').map((part) => ({
        kind: part.kind,
        ...(part.localPath === undefined ? {} : { localPath: part.localPath }),
        ...(part.url === undefined ? {} : { url: part.url }),
      })))
    },
  })
  return {
    router,
    inserts,
    sent,
    sentKinds,
    sentMedia,
    seen,
    now: () => clock,
    tick: (ms: number) => { clock += ms },
  }
}

function inbound(overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    channel: 'qq',
    accountId: 'acct',
    scope: 'private',
    peerId: 'peer-a',
    senderId: 'peer-a',
    senderName: 'Alice',
    text: '在吗',
    media: [],
    dedupeKey: 'qq:acct:m1',
    receivedAt: 1_000,
    ...overrides,
  }
}

const PEER_KEY = imPeerKey('qq', 'acct', 'private', 'peer-a')
const PEER_ALIAS = imPeerAlias('qq', 'private', PEER_KEY)

async function allowAll(): Promise<void> {
  await db.patchState({
    imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'open', groupMode: 'open' },
  })
}

async function bindPeer(overrides: { sessionId?: string; scope?: 'private' | 'group'; key?: string } = {}): Promise<void> {
  const key = overrides.key ?? PEER_KEY
  await db.patchState({
    imPeers: {
      [key]: {
        sessionId: overrides.sessionId ?? 'session-a',
        scope: overrides.scope ?? 'private',
        boundBy: 'manual',
        createdAt: new Date(0).toISOString(),
      },
    },
  })
}

describe('im router inbound', () => {
  it('inserts an inbound message into the bound native session', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound())
    expect(h.inserts).toHaveLength(1)
    const delivered = h.inserts[0]!
    expect(delivered.sessionId).toBe('session-a')
    expect(delivered.id).toMatch(/^im-/)
    // 头部给模型来源与回复目标；正文原样保留。
    expect(delivered.text).toContain(`peer=${PEER_ALIAS}`)
    expect(delivered.text).toContain('在吗')
    expect(delivered.text).toContain('im_send')
    expect(delivered.summary).toBe(`IM qq/private message from ${PEER_ALIAS}`)
    // 插件不自动回复：回复由模型调用 im_send。
    expect(h.sent).toHaveLength(0)
  })

  it('records an unbound peer in the panel pending list and sends the bind notice once', async () => {
    await allowAll()
    const h = harness()
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m1' }))
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m2' }))
    expect(h.inserts).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toBe(IM_UNBOUND_NOTICE)
    const pending = (await db.getState()).imPendingPeers?.[PEER_KEY]
    expect(pending?.lastAt).toBe(1_000)
    // 私聊 senderName 是 openid 前缀时不能当显示名存进 state。
    expect(pending?.senderName).toBeUndefined()
  })

  it('keeps a safe group nickname in the pending entry', async () => {
    await allowAll()
    const h = harness()
    const key = imPeerKey('qq', 'acct', 'group', 'group-1')
    await h.router.inbound(inbound({
      scope: 'group',
      peerId: 'group-1',
      senderId: 'member-openid-9',
      senderName: '小明',
      text: '大家好',
      dedupeKey: 'qq:acct:g1',
    }))
    expect(h.sent).toHaveLength(1)
    expect((await db.getState()).imPendingPeers?.[key]?.senderName).toBe('小明')
  })

  it('remembers the latest inbound peer per session for im_send fallback', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound())
    expect(h.router.lastPeerOf('session-a')).toBe(PEER_KEY)
    h.tick(11 * 60_000)
    expect(h.router.lastPeerOf('session-a')).toBeUndefined()
  })

  it('does not materialize media before the access policy passes', async () => {
    // 默认白名单为空：拒绝所有人，loadMedia 不能被调用。
    const h = harness()
    let loads = 0
    const loadMedia = async (): Promise<readonly []> => { loads += 1; return [] }
    await h.router.inbound(inbound(), { loadMedia })
    expect(loads).toBe(0)
    expect(h.sent).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)

    // 未绑定对端也不能触发下载：先记待办/回提示，媒体根本不需要物化。
    await allowAll()
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:unbound', media: [{ kind: 'image' }] }), { loadMedia })
    expect(loads).toBe(0)
    expect(h.sent).toHaveLength(1)
    expect(h.inserts).toHaveLength(0)

    await bindPeer()
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m2', media: [{ kind: 'image' }] }), { loadMedia })
    expect(loads).toBe(1)
    expect(h.inserts).toHaveLength(1)
  })

  it('delivers the text when materializing media throws', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound({ media: [{ kind: 'image' }] }), {
      loadMedia: async () => { throw new Error('the attachment host resolved to a private address') },
    })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.text).toContain('在吗')
    // 占位 ref 仍然让正文带上「有附件」这一事实。
    expect(h.inserts[0]?.text).toContain('附件')
  })

  it('ignores a duplicate platform message', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound({ dedupeKey: 'same' }))
    await h.router.inbound(inbound({ dedupeKey: 'same' }))
    expect(h.inserts).toHaveLength(1)
    expect(h.sent).toHaveLength(0)
  })

  it('tells the peer when the bound session is not open', async () => {
    await allowAll()
    await bindPeer()
    const h = harness({ insert: async () => { throw new ImSessionNotLiveError('session-a') } })
    await h.router.inbound(inbound())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toBe(IM_SESSION_NOT_LIVE)
  })

  it('uses a generic retry notice for other insertion failures', async () => {
    await allowAll()
    await bindPeer()
    const h = harness({ insert: async () => { throw new Error('inbox append failed') } })
    await h.router.inbound(inbound())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toBe(IM_DELIVERY_FAILED)
  })

  it('drops a message with neither text nor attachments', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound({ text: '   ' }))
    expect(h.inserts).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })
})

describe('im relay text', () => {
  it('carries the alias and tells the model to answer with im_send', () => {
    const text = relayTextOf(inbound({ text: '你好' }), '你好', PEER_ALIAS)
    expect(text.startsWith(`[IM qq/私聊 peer=${PEER_ALIAS}]`)).toBe(true)
    expect(text).toContain('你好')
    expect(text).toContain(`peer 参数用 ${PEER_ALIAS}`)
  })

  it('labels a group message with the safe sender nickname', () => {
    const text = relayTextOf(
      inbound({ scope: 'group', senderName: '小明', text: '大家好' }),
      '[小明] 大家好',
      PEER_ALIAS,
    )
    expect(text).toContain('qq/群聊')
    expect(text).toContain('[小明] 大家好')
  })
})

describe('im router sendText', () => {
  it('splits a long text by the channel limit and reports the parts', async () => {
    await allowAll()
    await db.patchState({ imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'open', groupMode: 'open', chunkLimit: 5 } })
    await bindPeer()
    const h = harness()
    const receipt = await h.router.sendText(PEER_KEY, 'abcdefghij')
    expect(receipt.parts).toBe(2)
    expect(h.sent[0]?.texts).toEqual(['abcde', 'fghij'])
  })

  it('reuses the most recent inbound passive anchor for im_send', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.inbound(inbound({ replyTo: 'platform-msg-1' }))
    await h.router.sendText(PEER_KEY, '回复')
    expect(h.sent.at(-1)?.replyTo).toBe('platform-msg-1')
    // 锚点过期后不再带回：被动回复窗口已过，只能主动推送。
    h.tick(6 * 60_000)
    await h.router.sendText(PEER_KEY, '过期')
    expect(h.sent.at(-1)?.replyTo).toBeUndefined()
  })

  it('refuses a peer without a binding', async () => {
    await allowAll()
    const h = harness()
    const failure = await h.router.sendText(PEER_KEY, 'hi').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImSendError)
    expect((failure as ImSendError).code).toBe('IM_SEND_UNBOUND')
  })

  it('rejects blank text', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await expect(h.router.sendText(PEER_KEY, '   ')).rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
  })

  it('wraps a transport failure with the alias instead of swallowing it', async () => {
    await allowAll()
    await bindPeer()
    const failing = createImRouter({
      db,
      now: () => 1_000,
      seenDedupe: async () => false,
      insert: async () => {},
      send: async () => { throw new Error('socket closed') },
    })
    await expect(failing.sendText(PEER_KEY, 'hi'))
      .rejects.toThrow(`IM send to ${PEER_ALIAS} failed: socket closed`)
  })
})

describe('im router sendMedia', () => {
  it('sends the caption before the media and numbers the parts', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    const receipt = await h.router.sendMedia(PEER_KEY, { kind: 'image', url: 'https://example.invalid/p.png', caption: '看图' })
    expect(receipt.parts).toBe(2)
    expect(h.sentKinds[0]).toEqual(['text', 'image'])
    expect(h.sent[0]?.texts).toEqual(['看图'])
    expect(h.sentMedia[0]).toEqual([{ kind: 'image', url: 'https://example.invalid/p.png' }])
  })

  it('sends a bare media part without a caption', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.router.sendMedia(PEER_KEY, { kind: 'file', localPath: 'C:/tmp/a.pdf' })
    expect(h.sentKinds[0]).toEqual(['file'])
  })

  it('rejects media without a source and a blank local path', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await expect(h.router.sendMedia(PEER_KEY, { kind: 'image' })).rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
    await expect(h.router.sendMedia(PEER_KEY, { kind: 'image', localPath: '  ' })).rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
  })

  it('refuses a media path outside the workspace root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'im-router-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'im-router-out-'))
    try {
      const insideFile = join(workspace, 'shot.png')
      const outsideFile = join(outside, 'secret.json')
      await writeFile(insideFile, 'png')
      await writeFile(outsideFile, '{"token":"x"}')
      await allowAll()
      await bindPeer()
      const h = harness({ workspaceRoot: async () => workspace })
      await h.router.sendMedia(PEER_KEY, { kind: 'image', localPath: insideFile })
      expect(h.sentMedia[0]).toEqual([{ kind: 'image', localPath: insideFile }])
      // 模型不能被诱导把工作区外的文件（密钥、聊天记录）当附件发出去。
      await expect(h.router.sendMedia(PEER_KEY, { kind: 'file', localPath: outsideFile }))
        .rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
