import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { createImRouter, ImSendError } from '../src/im/router.js'
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
  seen: Set<string>
  now: () => number
  tick: (ms: number) => void
}

function harness(options: {
  bindingMode?: 'manual' | 'independent' | 'shared'
  ensure?: () => Promise<{ sessionId: string; character: string; chatId: string }>
} = {}): Harness {
  const followups: Harness['followups'] = []
  const sent: Harness['sent'] = []
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
    render: async (_target, text) => text,
    send: async (target, parts) => {
      sent.push({ peerId: target.peerId, texts: parts.map((part) => part.text) })
    },
  })
  return {
    router,
    followups,
    sent,
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
    await expect(router.sendText(BOUND_PEER, 'hi')).rejects.toThrow(`IM send to ${BOUND_PEER} failed: socket closed`)
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
  const events = [
    { type: 'user/message', data: { id: 'im-1', turn: 2 } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '晚上好。' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]

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
    const withId = events.map((event) => event.type === 'user/message'
      ? { ...event, data: { ...event.data, id: messageId } }
      : event)
    await h.router.finishTurn('session-a', 2, withId)
    expect(h.sent).toEqual([{ peerId: 'peer-a', texts: ['晚上好。'] }])
    expect(h.router.pending('session-a')).toBe(0)
  })

  it('stays silent for a turn nobody triggered from IM', async () => {
    await allowAll()
    const h = harness()
    await h.router.finishTurn('session-a', 2, events)
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
})
