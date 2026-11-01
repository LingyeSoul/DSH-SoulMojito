/**
 * IM 斜杠指令（决策 2026-11-01-im-global-owner-and-commands）：
 * `/status`、`/bind`、`/unbind`、`/help` 只认账号的全局主人，指令文本永不
 * 进入会话；去重与访问控制先于指令执行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore, type TavernState } from '../../tavern-store/src/index.js'
import {
  IM_COMMAND_BIND_USAGE,
  IM_COMMAND_CHANNEL_UNSUPPORTED,
  IM_COMMAND_DENIED,
  IM_COMMAND_HELP,
  IM_COMMAND_PRESET_FAILED,
  IM_COMMAND_UNBOUND_NONE,
  IM_COMMAND_UNBOUND_OK,
  IM_COMMAND_USAGE,
  imMaskSessionId,
  isImCommandText,
  parseImCommand,
} from '../src/im/commands.js'
import { createImLog, type ImLogSink } from '../src/im/log.js'
import { imSenderHash } from '../src/im/owner.js'
import { createImRouter } from '../src/im/router.js'
import type { ImPresetSwitchResult } from '../src/im/handle.js'
import type { ImSendStatusView } from '../src/im/types.js'
import { DEFAULT_IM_SETTINGS, imPeerAlias, imPeerKey } from '../src/im/types.js'
import type { ImInbound } from '../src/im/types.js'

let root: string
let db: TavernStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-commands-'))
  db = await TavernStore.open(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const ACCOUNT_KEY = 'qq:acct'
const GROUP_KEY = imPeerKey('qq', 'acct', 'group', 'group-1')
const OWNER_SENDER = 'owner-user'
const OWNER_HASH = imSenderHash('qq', 'acct', OWNER_SENDER)

interface Harness {
  router: ReturnType<typeof createImRouter>
  inserts: Array<{ sessionId: string; text: string }>
  sent: Array<{ peerId: string; texts: string[] }>
  seen: Set<string>
  send: (inbound: ImInbound) => Promise<void>
}

function harness(options: {
  sendStatuses?: () => readonly ImSendStatusView[]
  applyImPreset?: (sessionId: string) => Promise<ImPresetSwitchResult>
  /** 让出站发送挂在测试手里：验证指令回执不阻塞后续入站。 */
  sendGate?: Promise<void>
  /** 运行日志接缝：验证失败原因进日志而不进回执。 */
  log?: ImLogSink
} = {}): Harness {
  const inserts: Harness['inserts'] = []
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
    insert: async (sessionId, message) => {
      inserts.push({ sessionId, text: message.text })
    },
    send: async (target, parts) => {
      if (options.sendGate !== undefined) await options.sendGate
      sent.push({
        peerId: target.peerId,
        texts: parts.filter((part) => part.kind === 'text').map((part) => part.text),
      })
      clock += 1_000
      return { parts: parts.length, at: clock }
    },
    ...(options.sendStatuses === undefined ? {} : { sendStatuses: options.sendStatuses }),
    ...(options.applyImPreset === undefined ? {} : { applyImPreset: options.applyImPreset }),
    ...(options.log === undefined ? {} : { log: options.log }),
    scheduleFlush: (_delayMs, run) => {
      void run()
      return () => {}
    },
  })
  return {
    router,
    inserts,
    sent,
    seen,
    send: async (message) => {
      await router.inbound(message)
      await router.flushPending()
    },
  }
}

let nextDedupe = 0

function command(overrides: Partial<ImInbound> = {}): ImInbound {
  nextDedupe += 1
  return {
    channel: 'qq',
    accountId: 'acct',
    scope: 'group',
    peerId: 'group-1',
    senderId: OWNER_SENDER,
    senderName: '主人甲',
    text: '/status',
    media: [],
    dedupeKey: `qq:acct:cmd-${nextDedupe}`,
    receivedAt: 1_000,
    ...overrides,
  }
}

async function openAccess(): Promise<void> {
  await db.patchState({
    imSettings: { ...DEFAULT_IM_SETTINGS, privateMode: 'open', groupMode: 'open' },
  })
}

async function setGlobalOwner(id: string = OWNER_HASH, name = '主人甲'): Promise<void> {
  await setAccountOwner(ACCOUNT_KEY, id, name)
}

async function setAccountOwner(accountKey: string, id: string, name = ''): Promise<void> {
  await db.patchState({
    imAccountOwners: { [accountKey]: { id, name, setAt: new Date(0).toISOString() } },
  })
}

async function bindGroup(sessionId = 'session-a'): Promise<void> {
  await bindAt(GROUP_KEY, 'group', sessionId)
}

async function bindAt(key: string, scope: 'private' | 'group', sessionId = 'session-a'): Promise<void> {
  await db.patchState({
    imPeers: {
      [key]: { sessionId, scope, boundBy: 'manual', createdAt: new Date(0).toISOString() },
    },
  })
}

async function pendingPeer(): Promise<void> {
  await db.patchState({ imPendingPeers: { [GROUP_KEY]: { lastAt: 500 } } })
}

function stateOf(): Promise<TavernState> {
  return db.getState()
}

describe('im command parsing', () => {
  it('recognizes slash text and splits the command from its argument', () => {
    expect(isImCommandText('  /status  ')).toBe(true)
    expect(isImCommandText('你好 /status')).toBe(false)
    expect(parseImCommand('/STATUS')).toEqual({ name: 'status', argument: '' })
    expect(parseImCommand('/bind session-a')).toEqual({ name: 'bind', argument: 'session-a' })
    expect(parseImCommand('/bind   session-a  ')).toEqual({ name: 'bind', argument: 'session-a' })
    expect(parseImCommand('/')).toEqual({ name: '', argument: '' })
    expect(parseImCommand('hello')).toBeUndefined()
  })

  it('recognizes commands after leading platform mentions and repeated mentions', () => {
    // OneBot 把 at 段渲染成 `@<qq>`；QQ 的 content 可能保留 `<@appid>` / `<@!appid>`。
    expect(isImCommandText('@999 /status')).toBe(true)
    expect(isImCommandText('<@!12345> /bind session-a')).toBe(true)
    expect(isImCommandText('@999 <@123> /help')).toBe(true)
    expect(parseImCommand('@999 /bind session-a')).toEqual({ name: 'bind', argument: 'session-a' })
    // 提及后不是指令（或者根本没提机器人）：继续走普通消息路径。
    expect(isImCommandText('@999 你好')).toBe(false)
    expect(isImCommandText('@全体成员 /status')).toBe(false)
    expect(isImCommandText('<@!12345>')).toBe(false)
  })

  it('masks only long session ids', () => {
    expect(imMaskSessionId('session-a')).toBe('session-a')
    expect(imMaskSessionId('session-abcdefghijklmnop')).toBe('session-…')
  })
})

describe('im slash commands from the account-global owner', () => {
  it('answers /status with channel, scope, alias, session, owner, time and send pacing', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup()
    const h = harness({
      sendStatuses: () => [{
        channel: 'qq',
        accountId: 'acct',
        allowedNow: false,
        nextSendAt: new Date(2026, 10, 1, 12, 0, 5).getTime(),
        throttleUntil: new Date(2026, 10, 1, 12, 5, 5).getTime(),
        queueDepth: 2,
      }],
    })
    await h.send(command())
    const reply = h.sent[0]?.texts[0] ?? ''
    expect(reply).toContain('状态')
    expect(reply).toContain('渠道：qq · 群聊')
    expect(reply).toContain(`对端：${imPeerAlias('qq', 'group', GROUP_KEY)}`)
    expect(reply).toContain('会话：session-a')
    expect(reply).toContain('全局主人：主人甲')
    expect(reply).toContain('时间：')
    expect(reply).toContain('需要等待')
    expect(reply).toContain('队列 2 条')
    // 指令不是会话消息：没有插入，也没有被记录成发言人。
    expect(h.inserts).toHaveLength(0)
    expect((await stateOf()).imSenders?.[GROUP_KEY]).toBeUndefined()
  })

  it('degrades /status when no send-status projection is wired', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command())
    const reply = h.sent[0]?.texts[0] ?? ''
    expect(reply).toContain('状态')
    expect(reply).not.toContain('发送：')
  })

  it('masks a long bound session id in /status', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup('session-abcdefghijklmnop')
    const h = harness()
    await h.send(command())
    expect(h.sent[0]?.texts[0]).toContain('会话：session-…')
  })

  it('binds the peer with /bind <sessionId> and keeps the command text out of the session', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command({ text: '/bind session-abcdefghijklmnop' }))
    expect(h.inserts).toHaveLength(0)
    expect(h.sent[0]?.texts[0]).toContain('已绑定到会话 session-…')
    const binding = (await stateOf()).imPeers?.[GROUP_KEY]
    expect(binding?.sessionId).toBe('session-abcdefghijklmnop')
    expect(binding?.boundBy).toBe('command')
    expect(binding?.scope).toBe('group')
  })

  it('replies with usage for a blank /bind and writes no binding', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command({ text: '/bind   ' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_BIND_USAGE)
    expect((await stateOf()).imPeers?.[GROUP_KEY]).toBeUndefined()
  })

  it('removes both the binding and the pending row on /unbind, then reports nothing bound', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup()
    await pendingPeer()
    const h = harness()
    await h.send(command({ text: '/unbind' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_UNBOUND_OK)
    expect((await stateOf()).imPeers?.[GROUP_KEY]).toBeUndefined()
    expect((await stateOf()).imPendingPeers?.[GROUP_KEY]).toBeUndefined()
    await h.send(command({ text: '/unbind' }))
    expect(h.sent[1]?.texts[0]).toBe(IM_COMMAND_UNBOUND_NONE)
  })

  it('lists the four commands on /help', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command({ text: '/help' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_HELP)
    for (const name of ['/status', '/bind', '/unbind', '/help']) expect(IM_COMMAND_HELP).toContain(name)
    expect(IM_COMMAND_HELP).toContain('全局主人')
  })

  it('replies with a usage hint for an unknown command from the owner', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command({ text: '/deploy' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_USAGE)
  })

  it('does not block inbound delivery on a slow command reply', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({ sendGate: gate })
    await h.router.inbound(command({ text: '/help' }))
    // 指令回执还挂在发送上：普通消息必须已经能投递进会话。
    await h.send(command({ text: '普通消息', dedupeKey: 'qq:acct:after-command' }))
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.text).toContain('普通消息')
    expect(h.sent).toHaveLength(0)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sent).toHaveLength(1)
  })
})

describe('im /bind preset switch', () => {
  const SWITCHED = '已切换到 AgentTavernIM'

  it('reports an applied AgentTavernIM switch in the /bind receipt', async () => {
    await openAccess()
    await setGlobalOwner()
    const switched: string[] = []
    const h = harness({
      applyImPreset: async (sessionId) => {
        switched.push(sessionId)
        return { applied: true }
      },
    })
    await h.send(command({ text: '/bind session-a' }))
    expect(switched).toEqual(['session-a'])
    expect(h.sent[0]?.texts[0]).toContain(`已绑定到会话 session-a；${SWITCHED}`)
  })

  it('marks a deferred preset and degrades when the runtime exposes no switch', async () => {
    await openAccess()
    await setGlobalOwner()
    const deferred = harness({ applyImPreset: async () => ({ applied: false, reason: 'the session is not open' }) })
    await deferred.send(command({ text: '/bind session-a' }))
    expect(deferred.sent[0]?.texts[0]).toContain('预设待切换（会话未打开或正在运行）')
    expect((await stateOf()).imPeers?.[GROUP_KEY]?.sessionId).toBe('session-a')

    const missing = harness()
    await missing.send(command({ text: '/bind session-b' }))
    expect(missing.sent[0]?.texts[0]).toContain('预设未切换（运行时未提供切换能力）')
    expect((await stateOf()).imPeers?.[GROUP_KEY]?.sessionId).toBe('session-b')
  })

  it('reports a failed preset without leaking the reason into the receipt', async () => {
    await openAccess()
    await setGlobalOwner()
    const log = createImLog({ capacity: 20, now: () => 1_000 })
    const h = harness({
      log,
      applyImPreset: async () => ({ applied: false, reason: 'host prompt assembly rejected the section' }),
    })
    await h.send(command({ text: '/bind session-c' }))
    const reply = h.sent[0]?.texts[0] ?? ''
    // 群聊可见的回执只给固定文案：host 术语/异常原文不出现在对端。
    expect(reply).toContain(IM_COMMAND_PRESET_FAILED)
    expect(reply).not.toContain('host prompt assembly rejected the section')
    expect((await stateOf()).imPeers?.[GROUP_KEY]?.sessionId).toBe('session-c')
    // 原因只进运行日志，排障时仍可找到。
    const entries = log.read({ limit: 20 }).entries
    expect(entries.some((entry) => entry.level === 'warn' && entry.text.includes('host prompt assembly rejected the section'))).toBe(true)
  })

  it('keeps the binding when the preset switch throws and logs the error only', async () => {
    await openAccess()
    await setGlobalOwner()
    const log = createImLog({ capacity: 20, now: () => 1_000 })
    const h = harness({
      log,
      applyImPreset: async () => { throw new Error('recompose failed') },
    })
    await h.send(command({ text: '/bind session-d' }))
    const reply = h.sent[0]?.texts[0] ?? ''
    expect(reply).toContain(IM_COMMAND_PRESET_FAILED)
    expect(reply).not.toContain('recompose failed')
    expect((await stateOf()).imPeers?.[GROUP_KEY]?.sessionId).toBe('session-d')
    const entries = log.read({ limit: 20 }).entries
    expect(entries.some((entry) => entry.level === 'warn' && entry.text.includes('recompose failed'))).toBe(true)
  })
})

describe('im slash command authorization', () => {
  it('denies a non-owner without inserting the command text', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup()
    const h = harness()
    await h.send(command({ senderId: 'member-2', senderName: '小红', text: '/bind session-b' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_DENIED)
    expect(h.inserts).toHaveLength(0)
    expect((await stateOf()).imPeers?.[GROUP_KEY]?.sessionId).toBe('session-a')
  })

  it('denies when no account-global owner is configured', async () => {
    await openAccess()
    const h = harness()
    await h.send(command({ text: '/status' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_DENIED)
    expect(h.inserts).toHaveLength(0)
  })

  it('does not treat a per-conversation owner as command authority', async () => {
    await openAccess()
    await db.patchState({
      imOwners: { [GROUP_KEY]: { id: OWNER_HASH, name: '主人甲', setAt: new Date(0).toISOString() } },
    })
    const h = harness()
    await h.send(command({ text: '/help' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_DENIED)
  })

  it('rejects commands on WeChat even with stale owner tables', async () => {
    await openAccess()
    await db.patchState({
      imAccountOwners: {
        'weixin:wx-bot': { id: imSenderHash('weixin', 'wx-bot', 'user-1'), name: '', setAt: new Date(0).toISOString() },
      },
    })
    const h = harness()
    await h.send(command({
      channel: 'weixin',
      accountId: 'wx-bot',
      scope: 'private',
      peerId: 'user-1',
      senderId: 'user-1',
      text: '/status',
    }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_CHANNEL_UNSUPPORTED)
    expect(h.inserts).toHaveLength(0)
  })

  it('still applies the access policy before any command handling', async () => {
    await setGlobalOwner()
    const h = harness()
    // 默认白名单为空 = 拒绝所有人：没有回执，也没有插入。
    await h.send(command({ text: '/status' }))
    expect(h.sent).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('burns the dedupe key before access control, so a denied command cannot be replayed', async () => {
    await setGlobalOwner()
    const h = harness()
    const message = command({ text: '/help', dedupeKey: 'qq:acct:denied-replay' })
    await h.send(message)
    await h.send(message)
    expect(h.sent).toHaveLength(0)
    // 之后放开白名单，重放同一条消息仍然被去重表挡住：拒绝过的指令不会复活。
    await openAccess()
    await h.send(message)
    expect(h.sent).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('runs a replayed command only once', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    const message = command({ text: '/help', dedupeKey: 'qq:acct:replay' })
    await h.send(message)
    await h.send(message)
    expect(h.sent).toHaveLength(1)
    expect(h.inserts).toHaveLength(0)
  })

  it('never touches the owner or sender ledgers for command text', async () => {
    await openAccess()
    await setGlobalOwner()
    const h = harness()
    await h.send(command({ text: '/bind session-c' }))
    const state = await stateOf()
    expect(state.imOwners).toEqual({})
    expect(state.imSenders).toEqual({})
    expect(state.imAccountOwners?.[ACCOUNT_KEY]?.id).toBe(OWNER_HASH)
  })
})

describe('im slash commands behind platform mentions', () => {
  const ONEBOT_KEY = imPeerKey('onebot', '10001', 'group', '20001')
  const ONEBOT_OWNER = 'onebot-owner'
  const ONEBOT_OWNER_HASH = imSenderHash('onebot', '10001', ONEBOT_OWNER)

  function oneBotCommand(overrides: Partial<ImInbound> = {}): ImInbound {
    return command({
      channel: 'onebot',
      accountId: '10001',
      scope: 'group',
      peerId: '20001',
      senderId: ONEBOT_OWNER,
      senderName: '群主',
      text: '@999 /status',
      ...overrides,
    })
  }

  async function seedOneBot(): Promise<void> {
    await openAccess()
    await setAccountOwner('onebot:10001', ONEBOT_OWNER_HASH, '群主')
    await bindAt(ONEBOT_KEY, 'group', 'session-a')
  }

  it('executes @999 /status from the global owner and never inserts the text', async () => {
    await seedOneBot()
    const h = harness()
    await h.send(oneBotCommand())
    expect(h.sent[0]?.texts[0]).toContain('会话：session-a')
    expect(h.inserts).toHaveLength(0)
    expect((await stateOf()).imPeers?.[ONEBOT_KEY]?.sessionId).toBe('session-a')
  })

  it('denies @999 /bind from a non-owner and keeps the binding', async () => {
    await seedOneBot()
    const h = harness()
    await h.send(oneBotCommand({ senderId: 'member-9', senderName: '路人', text: '@999 /bind session-b' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_DENIED)
    expect(h.inserts).toHaveLength(0)
    expect((await stateOf()).imPeers?.[ONEBOT_KEY]?.sessionId).toBe('session-a')
  })

  it('recognizes the QQ <@…> mention form too', async () => {
    await openAccess()
    await setGlobalOwner()
    await bindGroup()
    const h = harness()
    await h.send(command({ text: '<@!app-12345> /help' }))
    expect(h.sent[0]?.texts[0]).toBe(IM_COMMAND_HELP)
    expect(h.inserts).toHaveLength(0)
  })
})
