import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { createImRouter, ImSendError } from '../src/im/router.js'
import { imPeerAlias } from '../src/im/types.js'
import type { ImInbound } from '../src/im/types.js'
import { DEFAULT_IM_SETTINGS } from '../src/im/types.js'

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
  followups: Array<{ sessionId: string; text: string; id: string }>
  sent: Array<{ peerId: string; texts: string[] }>
  /** 与 `sent` 逐轮对齐：每轮各 part 的 kind 与非文本 part 的载荷。 */
  sentKinds: string[][]
  sentMedia: Array<Array<{ kind: string; localPath?: string; url?: string }>>
  seen: Set<string>
  now: () => number
  tick: (ms: number) => void
}

function harness(options: {
  bindingMode?: 'manual' | 'independent' | 'shared'
  ensure?: () => Promise<{ sessionId: string; character: string; chatId: string }>
  workspaceRoot?: () => Promise<string>
} = {}): Harness {
  const followups: Harness['followups'] = []
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
    ensureSession: options.ensure ?? (async () => ({ sessionId: 'session-new', character: 'Example', chatId: 'chat.jsonl' })),
    followup: async (sessionId, message) => {
      followups.push({ sessionId, text: message.text, id: message.id })
    },
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    render: async (_target, text) => text,
    send: async (target, parts) => {
      sent.push({
        peerId: target.peerId,
        texts: parts.filter((part) => part.kind === 'text').map((part) => part.text),
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
    followups,
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

async function allowAll(): Promise<void> {
  await db.patchState({
    imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'open', groupMode: 'open', bindingMode: 'manual' },
  })
}

describe('im router inbound', () => {
  it('refuses an unbound peer and tells the user once within the window', async () => {
    await allowAll()
    const h = harness()
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m1' }))
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m2' }))
    expect(h.followups).toHaveLength(0)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toContain('还没有绑定')
  })

  it('delivers immediately, with the group sender prefixed, and records the origin', async () => {
    await allowAll()
    await db.patchState({
      imPeers: {
        'qq:acct:group:g1': {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'group',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    await h.router.inbound(inbound({ scope: 'group', peerId: 'g1', senderName: 'Bob', text: '大家早' }))
    expect(h.followups).toEqual([{ sessionId: 'session-a', text: '[Bob] 大家早', id: expect.stringMatching(/^im-/) }])
    expect(h.router.pending('session-a')).toBe(1)
  })

  it('drops a replayed message id', async () => {
    await allowAll()
    await db.patchState({
      imPeers: {
        'qq:acct:private:peer-a': {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    await h.router.inbound(inbound())
    await h.router.inbound(inbound())
    expect(h.followups).toHaveLength(1)
  })

  it('drops a peer that the access policy rejects', async () => {
    await db.patchState({ imSettings: { ...DEFAULT_IM_SETTINGS, bindingMode: 'manual' } })
    const h = harness()
    await h.router.inbound(inbound())
    expect(h.followups).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })

  it('auto-binds an unknown peer and persists the binding', async () => {
    await db.patchState({
      imSettings: {
        ...DEFAULT_IM_SETTINGS,
        privateMode: 'open',
        bindingMode: 'independent',
        sourceChat: { character: 'Example', chatId: 'source.jsonl' },
      },
    })
    const h = harness()
    await h.router.inbound(inbound())
    const state = await db.getState()
    expect(state.imPeers?.['qq:acct:private:peer-a']).toMatchObject({
      sessionId: 'session-new',
      character: 'Example',
      chatId: 'chat.jsonl',
      boundBy: 'auto',
    })
    expect(h.followups).toHaveLength(1)
  })
})

describe('im router sendText', () => {
  const BOUND_PEER = 'qq:acct:private:peer-a'

  it('splits by the channel limit and sends to the bound peer', async () => {
    await db.patchState({
      imSettings: { ...DEFAULT_IM_SETTINGS, bindingMode: 'manual', chunkLimit: 5 },
      imPeers: {
        [BOUND_PEER]: {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    const receipt = await h.router.sendText(BOUND_PEER, 'abcdefghij')
    expect(h.sent).toEqual([{ peerId: 'peer-a', texts: ['abcde', 'fghij'] }])
    expect(receipt).toEqual({ parts: 2, at: 1_000 })
  })

  it('refuses a peer without a binding', async () => {
    const h = harness()
    const failure = h.router.sendText('qq:acct:private:ghost', 'hi')
    await expect(failure).rejects.toBeInstanceOf(ImSendError)
    await expect(failure).rejects.toThrow("IM peer 'qq:acct:private:ghost' has no binding")
    expect(h.sent).toEqual([])
  })

  it('wraps a transport failure with the peer key instead of swallowing it', async () => {
    await db.patchState({
      imPeers: {
        [BOUND_PEER]: {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const router = createImRouter({
      db,
      now: () => 1_000,
      seenDedupe: async () => false,
      ensureSession: async () => ({ sessionId: 'session-new', character: 'Example', chatId: 'chat.jsonl' }),
      followup: async () => {},
      render: async (_target, text) => text,
      send: async () => { throw new Error('socket closed') },
    })
    // 错误里的对端是 alias：peerKey/peerId 不进日志环与模型上下文。
    const alias = imPeerAlias('qq', 'private', BOUND_PEER)
    await expect(router.sendText(BOUND_PEER, 'hi')).rejects.toThrow(`IM send to ${alias} failed: socket closed`)
  })
})

describe('im router sendMedia', () => {
  const BOUND_PEER = 'qq:acct:private:peer-a'

  async function bind(): Promise<void> {
    await allowAll()
    await db.patchState({
      imPeers: {
        [BOUND_PEER]: {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
  }

  it('sends the caption first, then the media from a local path', async () => {
    await bind()
    const h = harness()
    const receipt = await h.router.sendMedia(BOUND_PEER, {
      kind: 'image',
      localPath: 'C:\\work\\pic.png',
      caption: '看这个',
    })
    expect(receipt.parts).toBe(2)
    expect(h.sent).toEqual([{ peerId: 'peer-a', texts: ['看这个'] }])
    expect(h.sentKinds).toEqual([['text', 'image']])
    expect(h.sentMedia).toEqual([[{ kind: 'image', localPath: 'C:\\work\\pic.png' }]])
  })


  it('delivers the message without local copies when media loading throws', async () => {
    await bind()
    const delivered: string[] = []
    const router = createImRouter({
      db,
      now: () => 1_000,
      seenDedupe: async () => false,
      ensureSession: async () => ({ sessionId: 'session-a', character: 'Example', chatId: 'chat.jsonl' }),
      followup: async (_sessionId, message) => { delivered.push(message.text) },
      render: async (_target, text) => text,
      send: async () => {},
    })
    await router.inbound(inbound({
      text: '看图',
      media: [{ kind: 'image', url: 'https://example.invalid/p.png' }],
    }), { loadMedia: async () => { throw new Error('the attachment host resolved to a private address') } })
    // 媒体物化失败只降级：正文照常投递（去重条目已写，抛错等于永久丢这条消息）。
    expect(delivered).toEqual(['看图\n（附件：图片（未下载））'])
  })

  it('refuses a media path outside the workspace root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'im-router-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'im-router-out-'))
    try {
      const insideFile = join(workspace, 'shot.png')
      const outsideFile = join(outside, 'secret.json')
      await writeFile(insideFile, 'png')
      await writeFile(outsideFile, '{"token":"x"}')
      await bind()
      const h = harness({ workspaceRoot: async () => workspace })
      await h.router.sendMedia(BOUND_PEER, { kind: 'image', localPath: insideFile })
      expect(h.sentMedia[0]).toEqual([{ kind: 'image', localPath: insideFile }])
      // 模型不能被诱导把工作区外的文件（密钥、聊天记录）当附件发出去。
      await expect(h.router.sendMedia(BOUND_PEER, { kind: 'file', localPath: outsideFile }))
        .rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('sends a bare media part without a caption', async () => {
    await bind()
    const h = harness()
    await h.router.sendMedia(BOUND_PEER, { kind: 'file', url: 'https://example.invalid/a.pdf' })
    expect(h.sentKinds[0]).toEqual(['file'])
    expect(h.sentMedia[0]).toEqual([{ kind: 'file', url: 'https://example.invalid/a.pdf' }])
  })

  it('rejects media without a source and keeps the unbound check', async () => {
    await bind()
    const h = harness()
    await expect(h.router.sendMedia(BOUND_PEER, { kind: 'image' })).rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
    await expect(h.router.sendMedia('qq:acct:private:other', { kind: 'image', localPath: 'C:\\a.png' }))
      .rejects.toMatchObject({ code: 'IM_SEND_UNBOUND' })
  })
})

describe('im router sendText', () => {
  it('rejects a malformed peer key, an unknown channel and an unbound peer', async () => {
    await allowAll()
    const h = harness()
    await expect(h.router.sendText('not-a-key', 'hi')).rejects.toMatchObject({ code: 'IM_SEND_INVALID_TARGET' })
    await expect(h.router.sendText('telegram:acct:private:p1', 'hi')).rejects.toMatchObject({ code: 'IM_SEND_INVALID_TARGET' })
    await expect(h.router.sendText('qq:acct:private:peer-a', 'hi')).rejects.toMatchObject({ code: 'IM_SEND_UNBOUND' })
    expect(h.sent).toHaveLength(0)
  })

  it('refuses blank text before touching the channel', async () => {
    await allowAll()
    const h = harness()
    await expect(h.router.sendText('qq:acct:private:peer-a', '   ')).rejects.toMatchObject({ code: 'IM_SEND_INVALID' })
  })
})

describe('im router finishTurn', () => {
  // 真实宿主里 IM 的 followup 只落 `agent/inbox/spliced`（没有 user/message）：
  // 先 insert 进 next-turn，下一轮开始时再以 removedCount 的 splice 取出消费。
  function turnStartedByInbox(turn: number, messageId: string, text: string) {
    return [
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: messageId }] } },
      { type: 'turn/start', data: { turn } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ]
  }

  it('replies to the peer that started the turn', async () => {
    await allowAll()
    await db.patchState({
      imPeers: {
        'qq:acct:private:peer-a': {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    await h.router.inbound(inbound())
    const messageId = h.followups[0]?.id ?? ''
    await h.router.finishTurn('session-a', 2, turnStartedByInbox(2, messageId, '晚上好。'))
    expect(h.sent).toEqual([{ peerId: 'peer-a', texts: ['晚上好。'] }])
    expect(h.router.pending('session-a')).toBe(0)
  })

  it('stays silent for a turn nobody triggered from IM', async () => {
    await allowAll()
    const h = harness()
    await h.router.finishTurn('session-a', 2, turnStartedByInbox(2, 'im-other', '晚上好。'))
    expect(h.sent).toHaveLength(0)
  })

  it('sends a fixed notice instead of the model output on an error turn', async () => {
    await allowAll()
    await db.patchState({
      imPeers: {
        'qq:acct:private:peer-a': {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    await h.router.inbound(inbound())
    const messageId = h.followups[0]?.id ?? ''
    await h.router.finishTurn('session-a', 2, [
      { type: 'user/message', data: { id: messageId, turn: 2 } },
      { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '内部错误细节' }] } } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } } },
    ])
    expect(h.sent[0]?.texts[0]).toBe('（这一轮没有生成成功，稍后再试）')
  })

  it('tells the peer to unarchive when the host blocks the turn', async () => {
    await allowAll()
    await db.patchState({
      imPeers: {
        'qq:acct:private:peer-a': {
          sessionId: 'session-a',
          character: 'Example',
          chatId: 'chat.jsonl',
          scope: 'private',
          boundBy: 'manual',
          createdAt: new Date(0).toISOString(),
        },
      },
    })
    const h = harness()
    await h.router.inbound(inbound())
    const messageId = h.followups[0]?.id ?? ''
    // 归档会话的真实形状：消息进来、turn 打开，pre-step 被拒后直接 blocked。
    await h.router.finishTurn('session-a', 2, [
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: messageId }] } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } } },
    ])
    expect(h.sent[0]?.texts[0]).toContain('取消归档')
    expect(h.router.pending('session-a')).toBe(0)
  })
})
