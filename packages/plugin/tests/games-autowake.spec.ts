/**
 * 人类落子自动续弈（提案 0018 §15，2026-10-14 用户需求）：Agent 没调
 * game_wait 就结束回合后，用户落子由插件自动 followup 唤起绑定会话——
 * 通知消息的形状（插件来源 + form notice + 幂等 id + token 经济文本）、
 * 等待中不重复唤起（跨 bundle 等待登记）、绑定/冷会话/宿主的逐级降级、
 * 投递失败不外溢。
 *
 * 假宿主：结构性替身（agents.get + bindingOf + logger）——与 agent-novel
 * driver 的宿主纪律同款；不 boot index.ts。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginGameWait, clearGameWaitersForTest, gameWaiters } from '../src/games/handle.js'
import type { GameSessionSummary } from '../src/games/sessions.js'
import { wakeAgentOnHumanMove, type GamesWakeHost } from '../src/games/wake.js'

const CHARACTER = '芙萝'
const CHAT = '2026-10-14@11h 35m 31s 664ms.jsonl'
const AGENT_ID = 'sess-agent-1'
const SESSION_ID = 'g-8bb76697'

/** 会话摘要 fixture（token 经济修订后的 store 形状：无 moves、有 moveCount）。 */
function summary(overrides: Partial<GameSessionSummary> = {}): GameSessionSummary {
  return {
    id: SESSION_ID,
    gameId: 'dsh-tavern.gomoku',
    gameName: '五子棋',
    actionVocabulary: '落子 {type:\'place\', x, y}',
    players: [
      { role: 'black', owner: 'human' },
      { role: 'white', owner: 'agent' },
    ],
    turn: 'white',
    finished: false,
    winner: null,
    summary: '黑棋落于 J10',
    orphaned: false,
    chat: { character: CHARACTER, chatId: CHAT },
    createdAt: '2026-10-14T04:12:00.395Z',
    updatedAt: '2026-10-14T04:13:17.899Z',
    moveCount: 4,
    ...overrides,
  }
}

interface FakeAgent {
  id: string
  session: { id: string; header?: { version: number } }
  followup: ReturnType<typeof vi.fn>
}

function fakeAgent(header: { version: number } | null = { version: 4 }): FakeAgent {
  // null（而非 undefined）= 旧宿主：无 header.version（default 参数会吞 undefined）。
  return {
    id: AGENT_ID,
    session: header === null ? { id: AGENT_ID } : { id: AGENT_ID, header },
    followup: vi.fn(async () => undefined),
  }
}

function fakeHost(options: { agent?: FakeAgent | undefined; bind?: boolean; throwGet?: boolean; throwBind?: boolean } = {}): GamesWakeHost & { followup: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; agent: FakeAgent } {
  const agent = options.agent === undefined ? fakeAgent() : options.agent
  const warn = vi.fn()
  const host: GamesWakeHost = {
    agents: agent === undefined
      ? undefined
      : {
          get: (id: string) => {
            if (options.throwGet === true) throw new Error('inactive fiber')
            return id === AGENT_ID ? agent : undefined
          },
        },
    bindingOf: async (character: string, chatId: string) => {
      if (options.throwBind === true) throw new Error('store offline')
      if (options.bind === false) return undefined
      return character === CHARACTER && chatId === CHAT ? AGENT_ID : undefined
    },
    logger: { warn },
  }
  return Object.assign(host, { warn, agent: agent as FakeAgent, followup: (agent as FakeAgent).followup })
}

afterEach(() => {
  clearGameWaitersForTest()
  vi.restoreAllMocks()
})

describe('wakeAgentOnHumanMove（人类落子 → 自动唤起）', () => {
  it('冷启动（无等待者/有绑定/有 live agent）→ 投递恰一条插件来源通知，文本自足且 token 经济', async () => {
    const host = fakeHost()
    const delivered = await wakeAgentOnHumanMove(host, summary())
    expect(delivered).toBe(true)
    expect(host.followup).toHaveBeenCalledTimes(1)
    const message = host.followup.mock.calls[0]![0] as { id: string; role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown> }
    // 幂等 id：一次人类动作恰一条（sessionId + moveCount）。
    expect(message.id).toBe(`game-notice-${SESSION_ID}-4`)
    expect(message.role).toBe('user')
    const text = message.content[0]!.text
    expect(text).toContain('非用户消息')
    expect(text).toContain('五子棋')
    expect(text).toContain(SESSION_ID)
    expect(text).toContain('落子')
    // 插件来源（v4 宿主 producer-owned kind）+ form notice；不含 user 身份。
    expect(message.source).toMatchObject({ kind: 'plugin:dsh-tavern', form: 'notice' })
    expect(String(message.source.summary)).toContain(SESSION_ID)
    expect(host.warn).not.toHaveBeenCalled()
  })

  it('game_wait 挂起中（等待登记 > 0）→ 不投递（工具内唤醒覆盖）；注销后恢复投递', async () => {
    const host = fakeHost()
    const release = beginGameWait(SESSION_ID)
    expect(gameWaiters(SESSION_ID)).toBe(1)
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(false)
    expect(host.followup).not.toHaveBeenCalled()
    release()
    expect(gameWaiters(SESSION_ID)).toBe(0)
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(true)
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('等待登记按会话隔离：别的会话在等不拦本会话的唤起', async () => {
    const host = fakeHost()
    const release = beginGameWait('g-00000001')
    try {
      expect(await wakeAgentOnHumanMove(host, summary())).toBe(true)
      expect(host.followup).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  it('无绑定（非 agent-tavern / 群聊 / 未绑定）→ 静默跳过，无日志噪声', async () => {
    const host = fakeHost({ bind: false })
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(false)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.warn).not.toHaveBeenCalled()
  })

  it('冷会话与宿主面缺失逐级降级：agents 缺失 / get 抛错 / get 返回 undefined / 句柄无 followup', async () => {
    const noAgents = fakeHost()
    delete (noAgents as { agents?: unknown }).agents
    expect(await wakeAgentOnHumanMove(noAgents, summary())).toBe(false)

    const throwing = fakeHost({ throwGet: true })
    expect(await wakeAgentOnHumanMove(throwing, summary())).toBe(false)

    const cold = fakeHost()
    expect(await wakeAgentOnHumanMove({ ...cold, agents: { get: () => undefined } }, summary())).toBe(false)

    const shapeLess = fakeHost()
    expect(await wakeAgentOnHumanMove({ ...shapeLess, agents: { get: () => ({ session: {} }) } }, summary())).toBe(false)
    expect(shapeLess.followup).not.toHaveBeenCalled()
  })

  it('绑定反查抛错 / followup 抛错 → 记日志且不外溢（落子回执不受影响）', async () => {
    const bindBroken = fakeHost({ throwBind: true })
    expect(await wakeAgentOnHumanMove(bindBroken, summary())).toBe(false)
    expect(bindBroken.warn).toHaveBeenCalledTimes(1)
    expect(String(bindBroken.warn.mock.calls[0]![0])).toContain('binding lookup failed')

    const host = fakeHost()
    host.followup.mockRejectedValueOnce(new Error('driver gone'))
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(false)
    expect(String(host.warn.mock.calls[0]![0])).toContain('followup failed')
  })

  it('终局（对手落子/认输终结）→ 文本带结果与收尾指引', async () => {
    const host = fakeHost()
    await wakeAgentOnHumanMove(host, summary({ finished: true, winner: 'white', summary: '黑方认输', turn: '' }))
    const text = (host.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('已结束')
    expect(text).toContain('黑方认输')
    expect(text).toContain('收尾')
  })

  it('旧宿主（无 header.version）→ v0 形状的插件 source（kind plugin + plugin 名）', async () => {
    const host = fakeHost({ agent: fakeAgent(null) })
    await wakeAgentOnHumanMove(host, summary())
    const source = (host.followup.mock.calls[0]![0] as { source: Record<string, unknown> }).source
    expect(source).toMatchObject({ kind: 'plugin', plugin: 'dsh-tavern', form: 'notice' })
  })
})
