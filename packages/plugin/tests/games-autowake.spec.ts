/**
 * 人类落子自动续弈（提案 0018 §15，2026-10-14 用户需求）：Agent 没调
 * game_wait 就结束回合后，用户落子由插件自动 followup 唤起绑定会话——
 * 通知消息的形状（插件来源 + form notice + 幂等 id + token 经济文本）、
 * 等待中不重复唤起（跨 bundle 等待登记）、绑定/冷会话/宿主的逐级降级、
 * 投递失败不外溢。
 *
 * 2026-10-15 竞态修订（真机 g-60bfb716「通知在 agent 循环输出中异常触发」）：
 * 投递还须过两道闸——回合判定（该手交出回合或终局；大富翁决定窗 roll 等
 * 中途动作不投递）与运行中判定（agent status === 'running' 不投递，运行中
 * 回合经自己的 game_wait/game_state 读面吸收该手）。
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
    gameId: 'dsh-soulmojito.gomoku',
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
  /** 宿主回合状态；缺省 undefined = 旧宿主形态（测试逐例显式覆盖）。 */
  status?: string
}

function fakeAgent(header: { version: number } | null = { version: 4 }): FakeAgent {
  // null（而非 undefined）= 旧宿主：无 header.version（default 参数会吞 undefined）。
  return {
    id: AGENT_ID,
    session: header === null ? { id: AGENT_ID } : { id: AGENT_ID, header },
    followup: vi.fn(async () => undefined),
  }
}

function fakeHost(options: { agent?: FakeAgent | undefined; bind?: boolean; throwGet?: boolean; throwBind?: boolean } = {}): GamesWakeHost & { followup: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; binding: ReturnType<typeof vi.fn>; agent: FakeAgent } {
  const agent = options.agent === undefined ? fakeAgent() : options.agent
  const warn = vi.fn()
  const binding = vi.fn(async (character: string, chatId: string) => {
    if (options.throwBind === true) throw new Error('store offline')
    if (options.bind === false) return undefined
    return character === CHARACTER && chatId === CHAT ? AGENT_ID : undefined
  })
  const host: GamesWakeHost = {
    agents: agent === undefined
      ? undefined
      : {
          get: (id: string) => {
            if (options.throwGet === true) throw new Error('inactive fiber')
            return id === AGENT_ID ? agent : undefined
          },
        },
    bindingOf: binding,
    logger: { warn },
  }
  return Object.assign(host, { warn, agent: agent as FakeAgent, binding, followup: (agent as FakeAgent).followup })
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
    expect(message.source).toMatchObject({ kind: 'plugin:dsh-soulmojito', form: 'notice' })
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

  it('回合未交出（大富翁式决定窗：roll 后 turn 仍在人类）→ 不投递且零成本短路（不查绑定）；同回合收尾动作交出回合后照常投递', async () => {
    const host = fakeHost()
    // 2026-10-15 真机 g-60bfb716：人类 roll 命中「可购买或跳过」决定窗——turn 仍在
    // 人类手上，Agent 此刻不可行动（引擎 actor===turn 必拒），「对手已落子」是假陈述。
    const midTurn = summary({ gameId: 'dsh-soulmojito.monopoly', gameName: '大富翁', turn: 'black', moveCount: 6 })
    expect(await wakeAgentOnHumanMove(host, midTurn)).toBe(false)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.binding).not.toHaveBeenCalled()
    expect(host.warn).not.toHaveBeenCalled()
    // 同一人类回合的收尾动作（buy/build/pass）交出回合 → 幂等 id 取那一刻的 moveCount。
    const handedOver = summary({ gameId: 'dsh-soulmojito.monopoly', gameName: '大富翁', turn: 'white', moveCount: 7 })
    expect(await wakeAgentOnHumanMove(host, handedOver)).toBe(true)
    expect(host.followup).toHaveBeenCalledTimes(1)
    expect((host.followup.mock.calls[0]![0] as { id: string }).id).toBe(`game-notice-${SESSION_ID}-7`)
  })

  it('终局不受回合闸限制：人类投降/人类动作终局（turn 停在人类）→ 仍投递收尾叙述', async () => {
    const host = fakeHost()
    const ended = summary({ finished: true, winner: 'white', summary: '黑方认输', turn: 'black' })
    expect(await wakeAgentOnHumanMove(host, ended)).toBe(true)
    const text = (host.followup.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('已结束')
    expect(text).toContain('收尾')
  })

  it('turn 不可判定（空串且未终局）→ 不投递（无法证明轮到 Agent，走懒段兜底）', async () => {
    const host = fakeHost()
    expect(await wakeAgentOnHumanMove(host, summary({ turn: '' }))).toBe(false)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.binding).not.toHaveBeenCalled()
  })

  it('agent 运行中（status running）→ 不投递（运行中的回合自行吸收该手）；回到 idle 恢复投递', async () => {
    const agent = fakeAgent()
    agent.status = 'running'
    const host = fakeHost({ agent })
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(false)
    expect(host.followup).not.toHaveBeenCalled()
    expect(host.warn).not.toHaveBeenCalled()
    agent.status = 'idle'
    expect(await wakeAgentOnHumanMove(host, summary())).toBe(true)
    expect(host.followup).toHaveBeenCalledTimes(1)
  })

  it('旧宿主句柄无 status / status 为未知值 → 不拦（逐属性降级不误杀）', async () => {
    const legacy = fakeHost()
    expect(await wakeAgentOnHumanMove(legacy, summary())).toBe(true)
    const weird = fakeHost({ agent: Object.assign(fakeAgent(), { status: 'paused' }) })
    expect(await wakeAgentOnHumanMove(weird, summary())).toBe(true)
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
    expect(source).toMatchObject({ kind: 'plugin', plugin: 'dsh-soulmojito', form: 'notice' })
  })
})
