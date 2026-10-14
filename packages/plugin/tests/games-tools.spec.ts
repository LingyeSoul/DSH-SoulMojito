/**
 * 游戏桥 Agent 工具五件（提案 0018 §4.2，P0；game_wait 为 2026-10-14 修订）：
 * createTools 注册面（存在与名字）、假服务注入下的完整对局（服务经同一
 * globalThis 注册表注入——resolveGamesService seam 的可测试性证明）、
 * 非 Agent 回合结构化报错、缺服务明确报文、game_wait 阻塞等待四路
 * （立即返回/人类落子唤醒/超时/中止）、BUILTIN_TOOL_NAMES_SEED 种子对账、
 * order -63 懒提示段的注入与内容。
 *
 * 假服务：内存版（真实井字棋引擎驱动、owner 规则同款），不经文件系统——
 * 证明工具面对「任何实现了 GamesService 形状的服务」都能工作（跨 bundle
 * 契约的唯一面就是句柄形状）。start/落子成功后 emitGamesChanged（真服务
 * service.ts 同款写穿——game_wait 的唤醒路径依赖该 emit 跨监听器可见）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, agentPromptSectionsFor, type AgentContextLike } from '../src/agent-tavern/agent.js'
import { TavernStore } from '../../tavern-store/src/index.js'
import { ticTacToeEngine as ticTacToe, manifest as ticManifest } from '../src/games/builtin/tic-tac-toe.js'
import { clearGamesServiceForTest, emitGamesChanged, publishGamesService } from '../src/games/handle.js'
import type { GamesService } from '../src/games/service.js'
import type { GameSession, GameSessionSummary } from '../src/games/sessions.js'
import { clearModRegistryForTest, claimedToolNames } from '../src/mods/cross-bundle.js'

const AGENT = 'games-tools-agent'
const CHARACTER = '维克多'
const CHAT = 'chat-tools'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<any>
}

/**
 * 内存假服务：真实井字棋引擎 + Map 存储；owner 规则（actor=当前回合）与
 * 真服务同款。view/install/reload 是与工具面无关的桩。
 */
function fakeGamesService(): GamesService {
  const sessions = new Map<string, GameSession>()
  let sequence = 0

  const summarize = (session: GameSession): GameSessionSummary => ({
    id: session.id,
    gameId: session.gameId,
    gameName: ticManifest.name,
    actionVocabulary: ticManifest.actionVocabulary,
    players: session.players.map((player) => ({ ...player })),
    turn: (session.state as { turn: string }).turn,
    finished: session.finished,
    winner: session.winner,
    summary: session.summary,
    orphaned: false,
    chat: { ...session.chat },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    moves: session.moves.map((move) => ({ ...move })),
  })
  const viewOf = (session: GameSession) => ({
    state: session.state,
    turn: (session.state as { turn: string }).turn,
    legal: session.finished ? [] : ticTacToe.legalActions(session.state),
    finished: session.finished,
    summary: session.summary,
  })

  const act = (session: GameSession, action: Record<string, unknown>, owner: 'human' | 'agent') => {
    if (session.finished) throw new Error(`对局已结束（${session.summary}），不能再落子`)
    const actor = (session.state as { turn: string }).turn
    const player = session.players.find((candidate) => candidate.role === actor)!
    if (player.owner !== owner) {
      throw new Error(owner === 'agent'
        ? `现在轮到 ${actor}（${player.owner === 'human' ? '人类玩家' : 'Agent'}），不是 Agent 的回合`
        : `现在轮到 ${actor}（${player.owner === 'human' ? '人类玩家' : 'Agent'}），请等待 AI 落子`)
    }
    let describe: string
    let result
    if (action.type === 'resign') {
      const winner = session.players.find((candidate) => candidate.role !== actor)!.role
      session.finished = true
      session.winner = winner
      describe = `${actor} 认输`
      session.summary = describe
    } else {
      describe = ticTacToe.describe(session.state, actor, action)
      result = ticTacToe.applyAction(session.state, action, actor)
      session.state = result.state
      session.finished = result.finished
      session.winner = result.winner
      session.summary = result.summary
    }
    session.moves.push({ actor, action: action as never, at: new Date().toISOString(), summary: session.summary, describe })
    return { session: summarize(session), view: viewOf(session), describe }
  }

  const service: GamesService = {
    async list(params = {}) {
      const all = [...sessions.values()].map(summarize)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      const filtered = params.character !== undefined && params.chatId !== undefined
        ? all.filter((session) => session.chat.character === params.character && session.chat.chatId === params.chatId)
        : all
      return {
        games: [{
          id: ticManifest.id, name: ticManifest.name, version: ticManifest.version, source: 'builtin' as const,
          players: ticManifest.players, turnBased: true, actionVocabulary: ticManifest.actionVocabulary, status: 'ok' as const,
        }],
        sessions: filtered,
      }
    },
    revision: async () => 'fake-revision',
    async start(params) {
      const humanRole = params.humanRole ?? ticManifest.players.roles[0]!
      const agentRole = ticManifest.players.roles.find((role) => role !== humanRole)!
      const now = new Date().toISOString()
      const session: GameSession = {
        id: `g-${String(++sequence).padStart(8, '0')}`,
        gameId: ticManifest.id,
        players: [
          { role: humanRole, owner: 'human' },
          { role: agentRole, owner: 'agent' },
        ],
        state: ticTacToe.createGame().state,
        moves: [],
        createdAt: now,
        updatedAt: now,
        chat: { character: params.character, chatId: params.chatId },
        finished: false,
        winner: null,
        summary: '',
      }
      sessions.set(session.id, session)
      void emitGamesChanged()
      return { session: summarize(session), view: viewOf(session) }
    },
    async state(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error(`会话 '${sessionId}' 不存在`)
      return { session: summarize(session), view: viewOf(session) }
    },
    async humanAction(sessionId, action) {
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error(`会话 '${sessionId}' 不存在`)
      const outcome = act(session, action as Record<string, unknown>, 'human')
      void emitGamesChanged()
      return outcome
    },
    async agentMove(sessionId, action) {
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error(`会话 '${sessionId}' 不存在`)
      const outcome = act(session, action as Record<string, unknown>, 'agent')
      void emitGamesChanged()
      return outcome
    },
    manifestOf: async () => ticManifest,
    async latestActive(character, chatId) {
      const active = [...sessions.values()]
        .filter((session) => !session.finished && session.chat.character === character && session.chat.chatId === chatId)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      return active[0]?.id
    },
    view: async () => {
      throw new Error('fake service has no view')
    },
    install: async () => {
      throw new Error('fake service has no install')
    },
    reload: async () => ({ games: [] }),
    registerModGame: () => {},
    unregisterModGame: () => {},
    dispose: () => {},
  }
  return service
}

const home = mkdtempSync(join(tmpdir(), 'games-tools-'))
let tools: Map<string, RegisteredTool>
const exec = { agent: { id: AGENT } }

beforeAll(async () => {
  process.env.DSH_HOME = home
  const store = await TavernStore.open(join(home, 'tavern'))
  await store.updateState(() => ({
    sessionBindings: {
      [AGENT]: { architecture: 'agent-tavern', contextMode: 'dsh-native', character: CHARACTER, chatId: CHAT },
    },
  }))
  publishGamesService(fakeGamesService())
  const registered = new Map<string, RegisteredTool>()
  apply({
    systemPrompt: { section: () => {}, context: () => {} },
    tools: { register: (tool) => { registered.set(tool.name, tool as RegisteredTool) } },
    effect: (factory) => factory(),
  } satisfies AgentContextLike)
  tools = registered
})

afterAll(() => {
  clearGamesServiceForTest()
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('注册面与种子对账', () => {
  it('五工具存在且名字正确', () => {
    for (const name of ['game_list', 'game_start', 'game_state', 'game_move', 'game_wait']) {
      expect(tools.has(name), name).toBe(true)
    }
  })

  it('BUILTIN_TOOL_NAMES_SEED 静态种子含五名（clearModRegistryForTest 回落种子）', () => {
    clearModRegistryForTest()
    for (const name of ['game_list', 'game_start', 'game_state', 'game_move', 'game_wait']) {
      expect(claimedToolNames().has(name), name).toBe(true)
    }
  })
})

describe('假服务注入下的完整对局', () => {
  it('game_start 开局（默认 Agent 执 roles[1]）→ 人类回合 game_move 报错（含轮到谁/owner）', async () => {
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    expect(started.session.players).toEqual([
      { role: 'x', owner: 'human' },
      { role: 'o', owner: 'agent' },
    ])
    expect(started.view.legal).toHaveLength(9)
    // 初始轮人类 x：Agent 落子结构化报错。
    await expect(tools.get('game_move')!.execute({ action: { type: 'place', x: 0, y: 0 } }, exec))
      .rejects.toThrow('现在轮到 x（人类玩家），不是 Agent 的回合')
  })

  it('人类经服务落子 → game_move（Agent）完整走完到 O 三连胜；game_state 双寻址', async () => {
    // 服务（假）的 humanAction 即人类入口——工具面对「另一个入口落子」无感。
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    const script: Array<['human' | 'agent', number, number]> = [
      ['human', 0, 0],
      ['agent', 0, 2],
      ['human', 1, 0],
      ['agent', 1, 2],
      ['human', 2, 1],
      ['agent', 2, 2],
    ]
    let last
    // 人类先落一手后，缺省寻址（不带 sessionId）应取到本会话（最近活跃）。
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    const midState = await tools.get('game_state')!.execute({}, exec)
    expect(midState.session.id).toBe(sessionId)
    expect(midState.session.turn).toBe('o')
    await service.agentMove(sessionId, { type: 'place', x: 0, y: 2 })
    for (const [who, x, y] of script.slice(2)) {
      if (who === 'human') await service.humanAction(sessionId, { type: 'place', x, y })
      else last = await tools.get('game_move')!.execute({ sessionId, action: { type: 'place', x, y } }, exec)
    }
    expect(last!.session.finished).toBe(true)
    expect(last!.session.winner).toBe('o')
    expect(last!.describe).toContain('O落于')
    // 终局后显式寻址仍可读取。
    const state = await tools.get('game_state')!.execute({ sessionId }, exec)
    expect(state.session.finished).toBe(true)
  })

  it('game_list：绑定存在时带本聊天会话；无绑定时只带 games', async () => {
    const withBinding = await tools.get('game_list')!.execute({}, exec)
    expect(withBinding.games).toHaveLength(1)
    expect(withBinding.sessions.length).toBeGreaterThanOrEqual(1)
    const noBinding = await tools.get('game_list')!.execute({}, { agent: { id: 'unbound-agent' } })
    expect(noBinding.games).toHaveLength(1)
    expect(noBinding.sessions).toEqual([])
  })

  it('game_state/game_move 无活跃会话时明确报文；动作形状校验', async () => {
    await expect(tools.get('game_state')!.execute({}, { agent: { id: 'unbound-agent' } })).rejects.toThrow()
    await expect(tools.get('game_move')!.execute({ action: 'not-an-object' }, exec)).rejects.toThrow('action must be a JSON object')
    await expect(tools.get('game_move')!.execute({ action: { x: 1 } }, exec)).rejects.toThrow('type')
  })

  it('句柄缺失（index bundle 未装载）→ 明确报文「游戏运行时不可用」', async () => {
    clearGamesServiceForTest()
    try {
      await expect(tools.get('game_list')!.execute({}, exec)).rejects.toThrow('游戏运行时不可用')
      await expect(tools.get('game_start')!.execute({ gameId: 'x' }, exec)).rejects.toThrow('游戏运行时不可用')
      await expect(tools.get('game_wait')!.execute({}, exec)).rejects.toThrow('游戏运行时不可用')
    } finally {
      publishGamesService(fakeGamesService())
    }
  })
})

describe('game_wait 阻塞等待（2026-10-14 修订）', () => {
  // 清理：按当前回合归属走对应入口认输（AI 回合走 humanAction 会像真服务一样
  // 409/结构化报错——遗留活跃会话会污染后续用例的懒提示段断言）。
  const resignSession = async (service: GamesService, sessionId: string) => {
    const { session } = await service.state(sessionId)
    if (session.finished) return
    const owner = session.players.find((player) => player.role === session.turn)!.owner
    await (owner === 'human'
      ? service.humanAction(sessionId, { type: 'resign' })
      : service.agentMove(sessionId, { type: 'resign' }))
  }

  it('已轮到 Agent → 立即返回 your-turn（含人类最后一手的 describe 供叙述）+ 缺省寻址', async () => {
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    const waited = await tools.get('game_wait')!.execute({}, exec) as Record<string, any>
    expect(waited.status).toBe('your-turn')
    expect(waited.sessionId).toBe(sessionId)
    expect(waited.session.turn).toBe('o')
    expect(waited.lastMove.actor).toBe('x')
    expect(waited.lastMove.describe).toContain('X落于')
    await resignSession(service, sessionId)
  })

  it('人类回合 → 阻塞；人类经服务落子（emit 写穿）后唤醒，返回新局面', async () => {
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    let settled = false
    const pending = tools.get('game_wait')!.execute({ sessionId, timeoutMs: 5000 }, exec)
      .then((outcome) => { settled = true; return outcome as Record<string, any> })
    // 等待工具确实挂起（人类回合无唤醒信号）。
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(settled).toBe(false)
    await service.humanAction(sessionId, { type: 'place', x: 1, y: 1 })
    const outcome = await pending
    expect(outcome.status).toBe('your-turn')
    expect(outcome.session.turn).toBe('o')
    expect(outcome.lastMove.action).toEqual({ type: 'place', x: 1, y: 1 })
    await resignSession(service, sessionId)
  })

  it('人类回合 → 超时不报错，返回 status timeout 与未变局面（模型可再 wait）', async () => {
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    const outcome = await tools.get('game_wait')!.execute({ sessionId, timeoutMs: 1000 }, exec) as Record<string, any>
    expect(outcome.status).toBe('timeout')
    expect(outcome.session.turn).toBe('x')
    expect(outcome.lastMove).toBe(null)
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    await resignSession(service, sessionId)
  }, 10000)

  it('等待中被中止（用户停止生成）→ 抛 AbortError 语义的拒绝', async () => {
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    const controller = new AbortController()
    const pending = tools.get('game_wait')!.execute(
      { sessionId, timeoutMs: 30000 },
      { agent: { id: AGENT }, signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    controller.abort()
    await expect(pending).rejects.toThrow()
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    await resignSession(service, sessionId)
  })

  it('等待中人类认输 → 唤醒返回 finished（winner/summary 就绪）', async () => {
    const service = (await import('../src/games/handle.js')).resolveGamesService()!
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    const pending = tools.get('game_wait')!.execute({ sessionId, timeoutMs: 5000 }, exec)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await service.humanAction(sessionId, { type: 'resign' })
    const outcome = await pending as Record<string, any>
    expect(outcome.status).toBe('finished')
    expect(outcome.session.winner).toBe('o')
    expect(outcome.session.summary).toContain('认输')
  })

  it('无活跃会话 → 与 game_state 同款明确报文', async () => {
    await expect(tools.get('game_wait')!.execute({}, { agent: { id: 'unbound-agent' } })).rejects.toThrow()
  })
})

describe('order -63 懒提示段（仅活跃会话时注入）', () => {
  it('无活跃会话段摘除 → 开局后段出现（游戏名/sessionId/轮到谁/词汇表/指引）→ 终局后段再摘除', async () => {
    const { emitGamesChanged, resolveGamesService } = await import('../src/games/handle.js')
    const service = resolveGamesService()!
    const gamesSections = () => agentPromptSectionsFor(AGENT).filter((section) => section.name === 'dsh-tavern:agent-games')

    // 清场：把此前用例遗留的活跃会话全部认输终结（按当前回合归属走对应入口）。
    const { sessions } = await service.list({ character: CHARACTER, chatId: CHAT })
    for (const session of sessions) {
      if (session.finished) continue
      const owner = session.players.find((player) => player.role === session.turn)!.owner
      await (owner === 'human'
        ? service.humanAction(session.id, { type: 'resign' })
        : service.agentMove(session.id, { type: 'resign' }))
    }
    // 真实服务的 humanAction 内部 emit；假服务手工 emit 同款写穿。
    await emitGamesChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(gamesSections()).toHaveLength(0)

    // 开局（工具内自带写穿）：段即时出现。
    const started = await tools.get('game_start')!.execute({ gameId: 'dsh-tavern.tic-tac-toe' }, exec)
    const sessionId = started.session.id as string
    const sections = gamesSections()
    expect(sections).toHaveLength(1)
    expect(sections[0]!.order).toBe(-63)
    expect(sections[0]!.text).toContain('井字棋')
    expect(sections[0]!.text).toContain(sessionId)
    expect(sections[0]!.text).toContain('动作词汇表')
    expect(sections[0]!.text).toContain('game_move')
    // 2026-10-14 修订：指引教的是 wait 循环（落到人类回合阻塞等待，无需用户发消息）。
    expect(sections[0]!.text).toContain('game_wait')
    // 轮到 x（人类）：会话行标注人类玩家。
    expect(sections[0]!.text).toContain('人类玩家')

    // 终局 + 跨 bundle 写穿（emitGamesChanged）：段摘除。
    await service.humanAction(sessionId, { type: 'resign' })
    await emitGamesChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(gamesSections()).toHaveLength(0)
  })
})
