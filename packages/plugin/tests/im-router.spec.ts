import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '../../tavern-store/src/index.js'
import { IM_COALESCE_MAX_MESSAGES } from '../src/im/coalesce.js'
import { createImRouter, IM_DELIVERY_FAILED, IM_FLUSH_PENDING_MAX_PASSES, IM_SESSION_NOT_LIVE, IM_UNBOUND_NOTICE, ImSendError, relayTextOf } from '../src/im/router.js'
import { ImSessionNotLiveError } from '../src/im/session-host.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey } from '../src/im/types.js'
import type { ImInbound, ImMediaRef } from '../src/im/types.js'

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
  /** `seenDedupe` 被查询的次数：钉住「去重只发生在冲刷时」。 */
  dedupeCalls: () => number
  /**
   * 入站 + 冲刷合流窗口：缺省调度器「立即执行」窗口回调，旧用例因此仍是单条语义。
   * flushPending 保证等到插入真的完成，而不是只等到窗口回调触发。
   */
  deliver: (message: ImInbound, options?: { loadMedia?: () => Promise<readonly ImMediaRef[]> }) => Promise<void>
}

interface HarnessOptions {
  insert?: (sessionId: string, message: { id: string; text: string; summary: string }) => Promise<void>
  workspaceRoot?: () => Promise<string>
  /** 缺省「立即执行」调度器；合流用例传手动调度器，精确控制窗口。 */
  scheduleFlush?: (delayMs: number, run: () => void) => () => void
  coalesceWindowMs?: number
}

function harness(options: HarnessOptions = {}): Harness {
  const inserts: Harness['inserts'] = []
  const sent: Harness['sent'] = []
  const sentKinds: Harness['sentKinds'] = []
  const sentMedia: Harness['sentMedia'] = []
  const seen = new Set<string>()
  let dedupeCalls = 0
  let clock = 1_000
  const router = createImRouter({
    db,
    now: () => clock,
    seenDedupe: async (key) => {
      dedupeCalls += 1
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
    // 测试不真等 600ms：缺省窗口回调立即执行，合流用例用手动调度器替换。
    scheduleFlush: options.scheduleFlush ?? ((_delayMs, run) => { run(); return () => {} }),
    ...(options.coalesceWindowMs === undefined ? {} : { coalesceWindowMs: options.coalesceWindowMs }),
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
    dedupeCalls: () => dedupeCalls,
    deliver: async (message, inboundOptions) => {
      await router.inbound(message, inboundOptions)
      await router.flushPending()
    },
  }
}

interface ManualScheduler {
  schedule(delayMs: number, run: () => void): () => void
  /** 触发当前排队的全部窗口回调，模拟窗口到期。 */
  fireAll(): void
  /** 排队中的窗口回调数；0 表示没有 peer 在等窗口。 */
  pending(): number
}

/**
 * 手动窗口调度器：回调排队，测试用 `fireAll()` 精确触发，代替真等 600ms。
 * 取消（触限立即冲刷时）会把回调从队列里摘掉。
 */
function manualScheduler(): ManualScheduler {
  const queue: Array<{ run: () => void }> = []
  return {
    schedule: (_delayMs, run) => {
      const item = { run }
      queue.push(item)
      return () => {
        const at = queue.indexOf(item)
        if (at >= 0) queue.splice(at, 1)
      }
    },
    fireAll: () => {
      for (const item of queue.splice(0)) item.run()
    },
    pending: () => queue.length,
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
    await h.deliver(inbound())
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
    await h.deliver(inbound({ dedupeKey: 'qq:acct:m1' }))
    await h.deliver(inbound({ dedupeKey: 'qq:acct:m2' }))
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
    await h.deliver(inbound({
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

  it('does not materialize media before the access policy passes', async () => {
    // 默认白名单为空：拒绝所有人，loadMedia 不能被调用。
    const h = harness()
    let loads = 0
    const loadMedia = async (): Promise<readonly []> => { loads += 1; return [] }
    await h.deliver(inbound(), { loadMedia })
    expect(loads).toBe(0)
    expect(h.sent).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)

    // 未绑定对端也不能触发下载：先记待办/回提示，媒体根本不需要物化。
    await allowAll()
    await h.deliver(inbound({ dedupeKey: 'qq:acct:unbound', media: [{ kind: 'image' }] }), { loadMedia })
    expect(loads).toBe(0)
    expect(h.sent).toHaveLength(1)
    expect(h.inserts).toHaveLength(0)

    await bindPeer()
    await h.deliver(inbound({ dedupeKey: 'qq:acct:m2', media: [{ kind: 'image' }] }), { loadMedia })
    expect(loads).toBe(1)
    expect(h.inserts).toHaveLength(1)
  })

  it('delivers the text when materializing media throws', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.deliver(inbound({ media: [{ kind: 'image' }] }), {
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
    await h.deliver(inbound({ dedupeKey: 'same' }))
    await h.deliver(inbound({ dedupeKey: 'same' }))
    expect(h.inserts).toHaveLength(1)
    expect(h.sent).toHaveLength(0)
  })

  it('tells the peer when the bound session is not open', async () => {
    await allowAll()
    await bindPeer()
    const h = harness({ insert: async () => { throw new ImSessionNotLiveError('session-a') } })
    await h.deliver(inbound())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toBe(IM_SESSION_NOT_LIVE)
  })

  it('uses a generic retry notice for other insertion failures', async () => {
    await allowAll()
    await bindPeer()
    const h = harness({ insert: async () => { throw new Error('inbox append failed') } })
    await h.deliver(inbound())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.texts[0]).toBe(IM_DELIVERY_FAILED)
  })

  it('drops a message with neither text nor attachments', async () => {
    await allowAll()
    await bindPeer()
    const h = harness()
    await h.deliver(inbound({ text: '   ' }))
    expect(h.inserts).toHaveLength(0)
    expect(h.sent).toHaveLength(0)
  })
})

describe('im router inbound coalescing', () => {
  it('merges a same-peer burst inside the window into one insert', async () => {
    await allowAll()
    await bindPeer()
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m1', text: '第一句' }))
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m2', text: '第二句' }))
    // 窗口未到：只缓冲，不插入；同一 peer 只挂一个定时器。
    expect(h.inserts).toHaveLength(0)
    expect(scheduler.pending()).toBe(1)
    scheduler.fireAll()
    await h.router.flushPending()
    expect(h.inserts).toHaveLength(1)
    const delivered = h.inserts[0]!
    expect(delivered.id).toMatch(/^im-/)
    expect(delivered.text.startsWith(`[IM qq/私聊 peer=${PEER_ALIAS}]（连续 2 条消息）`)).toBe(true)
    expect(delivered.text).toContain('第一句')
    expect(delivered.text).toContain('第二句')
    expect(delivered.text.indexOf('第一句')).toBeLessThan(delivered.text.indexOf('第二句'))
    // 尾部仍要让模型知道用 im_send 回给谁。
    expect(delivered.text).toContain(`这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${PEER_ALIAS}。）`)
    expect(delivered.summary).toBe(`IM qq/private 2 messages from ${PEER_ALIAS}`)
  })

  it('reorders same-peer messages by platform time before merging', async () => {
    await allowAll()
    await bindPeer()
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    // 平台时间乱序：本地先收到 platformAt=200，后收到 platformAt=100。
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:late', text: '平台时间晚的一条', platformAt: 200 }))
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:early', text: '平台时间早的一条', platformAt: 100 }))
    scheduler.fireAll()
    await h.router.flushPending()
    expect(h.inserts).toHaveLength(1)
    const text = h.inserts[0]!.text
    expect(text.indexOf('平台时间早的一条')).toBeLessThan(text.indexOf('平台时间晚的一条'))
  })

  it('keeps same-window bursts from different peers in separate inserts', async () => {
    await allowAll()
    const otherKey = imPeerKey('qq', 'acct', 'private', 'peer-b')
    await db.patchState({
      imPeers: {
        [PEER_KEY]: { sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
        [otherKey]: { sessionId: 'session-b', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
    })
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:a1', text: 'A 的话' }))
    await h.router.inbound(inbound({ peerId: 'peer-b', senderId: 'peer-b', dedupeKey: 'qq:acct:b1', text: 'B 的话' }))
    // 两个 peer 各挂一个窗口，各自成条。
    expect(scheduler.pending()).toBe(2)
    scheduler.fireAll()
    await h.router.flushPending()
    expect(h.inserts).toHaveLength(2)
    expect(h.inserts.map((entry) => entry.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect(h.inserts.map((entry) => entry.text).join('\n')).toContain('A 的话')
    expect(h.inserts.map((entry) => entry.text).join('\n')).toContain('B 的话')
    // 每个 peer 各自一条：都不带合流头。
    expect(h.inserts.every((entry) => !entry.text.includes('连续'))).toBe(true)
  })

  it('delivers a batch containing media individually and materializes media after access control', async () => {
    await allowAll()
    await bindPeer()
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    let loads = 0
    const loadMedia = async (): Promise<readonly ImMediaRef[]> => {
      loads += 1
      return [{ kind: 'image', localPath: 'C:/tmp/shot.png' }]
    }
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:late', text: '带图的话', platformAt: 200 }), { loadMedia })
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:early', text: '纯文字', platformAt: 100 }))
    // 窗口未到：连去重与访问控制都还没跑，媒体更不能物化。
    expect(loads).toBe(0)
    scheduler.fireAll()
    await h.router.flushPending()
    expect(loads).toBe(1)
    expect(h.inserts).toHaveLength(2)
    // 平台时间早的先投；含媒体的批次逐条投递，不合并。
    expect(h.inserts[0]?.text).toContain('纯文字')
    expect(h.inserts[1]?.text).toContain('带图的话')
    expect(h.inserts[1]?.text).toContain('图片（C:/tmp/shot.png）')
    expect(h.inserts.every((entry) => !entry.text.includes('连续'))).toBe(true)
  })

  it('filters duplicates, denied and unbound bursts individually inside the window', async () => {
    await db.patchState({
      imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'allowlist', privateAllow: ['peer-a', 'peer-c'] },
      imPeers: {
        [PEER_KEY]: { sessionId: 'session-a', scope: 'private', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
    })
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    // peer-a：同一条消息重放两次（同一 dedupeKey）。
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:replay', text: '重放的消息' }))
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:replay', text: '重放的消息' }))
    // peer-b：不在私聊白名单里。
    await h.router.inbound(inbound({ peerId: 'peer-b', senderId: 'peer-b', dedupeKey: 'qq:acct:b1', text: 'B 的消息' }))
    // peer-c：未绑定，连发两条。
    await h.router.inbound(inbound({ peerId: 'peer-c', senderId: 'peer-c', dedupeKey: 'qq:acct:c1', text: 'C 的第一条' }))
    await h.router.inbound(inbound({ peerId: 'peer-c', senderId: 'peer-c', dedupeKey: 'qq:acct:c2', text: 'C 的第二条' }))
    scheduler.fireAll()
    await h.router.flushPending()
    // peer-a：去重后只剩一条可投递，走单条路径；没有合流头。
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.sessionId).toBe('session-a')
    expect(h.inserts[0]?.text).toContain('重放的消息')
    expect(h.inserts[0]?.text).not.toContain('连续')
    // peer-b：白名单拒绝，没有插入也没有提示（提示只给未绑定）。
    expect(h.sent.some((record) => record.peerId === 'peer-b')).toBe(false)
    // peer-c：记一条待办，两条消息只回一次提示（同一 peer 的抑制窗口）。
    const pending = (await db.getState()).imPendingPeers?.[imPeerKey('qq', 'acct', 'private', 'peer-c')]
    expect(pending).toBeDefined()
    const notices = h.sent.filter((record) => record.peerId === 'peer-c')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.texts[0]).toBe(IM_UNBOUND_NOTICE)
  })

  it('flushes immediately when the buffered batch hits the message cap', async () => {
    await allowAll()
    await bindPeer()
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    for (let index = 0; index < IM_COALESCE_MAX_MESSAGES; index += 1) {
      await h.router.inbound(inbound({ dedupeKey: `qq:acct:m${index}`, text: `第 ${index + 1} 条` }))
    }
    // 触到上限的那一条已经冲刷完，窗口定时器也被撤了：不用等 600ms。
    expect(scheduler.pending()).toBe(0)
    await h.router.flushPending()
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.text).toContain(`（连续 ${IM_COALESCE_MAX_MESSAGES} 条消息）`)
    expect(h.inserts[0]?.text).toContain('第 1 条')
    expect(h.inserts[0]?.text).toContain(`第 ${IM_COALESCE_MAX_MESSAGES} 条`)
  })

  it('checks dedupe only at the window flush, exactly once per buffered message', async () => {
    await allowAll()
    await bindPeer()
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    await h.router.inbound(inbound({ dedupeKey: 'qq:acct:m1', text: '第一句' }))
    // 去重必须发生在冲刷时：窗口内一次都不能查（崩溃窗口才不会留下「已去重但没投递」的键）。
    expect(h.dedupeCalls()).toBe(0)
    scheduler.fireAll()
    await h.router.flushPending()
    expect(h.dedupeCalls()).toBe(1)
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.text).toContain('第一句')
  })

  it('keeps the per-sender prefix on every body when merging a group burst', async () => {
    await allowAll()
    const key = imPeerKey('qq', 'acct', 'group', 'group-1')
    const alias = imPeerAlias('qq', 'group', key)
    await db.patchState({
      imPeers: {
        [key]: { sessionId: 'session-g', scope: 'group', boundBy: 'manual', createdAt: new Date(0).toISOString() },
      },
    })
    const scheduler = manualScheduler()
    const h = harness({ scheduleFlush: scheduler.schedule })
    await h.router.inbound(inbound({
      scope: 'group',
      peerId: 'group-1',
      senderId: 'member-1',
      senderName: '小明',
      text: '大家好',
      dedupeKey: 'qq:acct:g1',
    }))
    await h.router.inbound(inbound({
      scope: 'group',
      peerId: 'group-1',
      senderId: 'member-2',
      senderName: '小红',
      text: '晚上好',
      dedupeKey: 'qq:acct:g2',
    }))
    scheduler.fireAll()
    await h.router.flushPending()
    expect(h.inserts).toHaveLength(1)
    const delivered = h.inserts[0]!
    expect(delivered.sessionId).toBe('session-g')
    expect(delivered.text.startsWith(`[IM qq/群聊 peer=${alias}]（连续 2 条消息）`)).toBe(true)
    // 群聊发言人是安全可读的昵称，每条正文都保留 [昵称] 前缀。
    expect(delivered.text).toContain('[小明] 大家好')
    expect(delivered.text).toContain('[小红] 晚上好')
    expect(delivered.summary).toBe(`IM qq/group 2 messages from ${alias}`)
  })

  it('stops flushing after the pass cap instead of hanging on endless inbound', async () => {
    await allowAll()
    await bindPeer()
    const logs: Array<{ level: string; text: string }> = []
    const inserts: string[] = []
    let router: ReturnType<typeof createImRouter>
    router = createImRouter({
      db,
      now: () => 1_000,
      seenDedupe: async () => false,
      insert: async (_sessionId, message) => {
        inserts.push(message.id)
        // 每投递一条就再压一条新消息：模拟「冲刷期间持续入站」。
        await router.inbound(inbound({ dedupeKey: `qq:acct:loop-${inserts.length}`, text: `第 ${inserts.length} 条` }))
      },
      // 窗口定时器永不触发：只剩 flushPending 自己会冲刷。
      scheduleFlush: () => () => {},
      send: async () => {},
      log: {
        note: (level, text) => { logs.push({ level, text }) },
        read: () => ({ entries: [], nextSeq: 0 }),
      },
    })
    await router.inbound(inbound({ dedupeKey: 'qq:acct:loop-0', text: '第 0 条' }))
    await router.flushPending()
    // 上限一到就返回：不挂死，且有一条 warn 说明剩余批次交给窗口定时器。
    expect(inserts).toHaveLength(IM_FLUSH_PENDING_MAX_PASSES)
    const warnings = logs.filter((entry) => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).toContain('flushPending stopped after')
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
    await h.deliver(inbound({ replyTo: 'platform-msg-1' }))
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
