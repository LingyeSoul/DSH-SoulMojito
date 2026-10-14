/**
 * 游戏桥服务层全流程（提案 0018 §4.1，P0）：temp root 开真实服务——
 * start / 人类与 Agent 交替落子 / resign / 重启续局（重开服务读回）/ revision
 * 变化 / actor 规则（人类回合 agentMove 报错、反向亦然）/ 孤儿会话（卸载
 * 游戏后 orphaned 且拒绝落子）/ 井字棋全流程到终局。
 *
 * HTTP 面：follow tavern-mods.spec.ts 的 fakeReq/fakeRes 范式直接打
 * handleGamesApi（不 boot index.ts）：list/revision/start/state/action 的
 * 409/400/404 状态码纪律、view 的 CSP 与桥标记、reload。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openGamesService, type GamesService } from '../src/games/service.js'
import { handleGamesApi } from '../src/games/http.js'
import { GameBridgeError } from '../src/games/sessions.js'

const home = mkdtempSync(join(tmpdir(), 'games-service-'))
const root = join(home, 'tavern')
const CHARACTER = 'Seraphina'
const CHAT = 'chat-1'

let service: GamesService

beforeAll(async () => {
  service = await openGamesService({ root, hostVersion: '0.6.0' })
})

afterAll(() => {
  service.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** 井字棋（builtin）开局；humanRole 缺省 x（人类先手），Agent 执 o。 */
async function startTicTacToe(): Promise<string> {
  const { session } = await service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: CHAT })
  return session.id
}

describe('开局与绑定', () => {
  it('start 返回 session + view：roles 归属（人类先手 x、Agent 后手 o）、初始建议集', async () => {
    const { session, view } = await service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: CHAT })
    expect(session.id).toMatch(/^g-[0-9a-f]{8}$/)
    expect(session.gameId).toBe('dsh-tavern.tic-tac-toe')
    expect(session.gameName).toBe('井字棋')
    expect(session.players).toEqual([
      { role: 'x', owner: 'human' },
      { role: 'o', owner: 'agent' },
    ])
    expect(session.turn).toBe('x')
    expect(session.finished).toBe(false)
    expect(session.orphaned).toBe(false)
    expect(view.legal).toHaveLength(9)
    expect(view.turn).toBe('x')
    expect(view.finished).toBe(false)
  })

  it('humanRole 显式 o 时归属对调', async () => {
    const { session } = await service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: CHAT, humanRole: 'o' })
    expect(session.players).toEqual([
      { role: 'x', owner: 'agent' },
      { role: 'o', owner: 'human' },
    ])
  })

  it('character/chatId 空（400 面）、未知游戏（404 面）、非法 humanRole（400 面）', async () => {
    await expect(service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: '', chatId: CHAT })).rejects.toThrow(GameBridgeError)
    await expect(service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: '', chatId: CHAT })).rejects.toThrow('不能为空')
    await expect(service.start({ gameId: 'no.such.game', character: CHARACTER, chatId: CHAT })).rejects.toThrow('不在注册表')
    await expect(service.start({ gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: CHAT, humanRole: 'black' })).rejects.toThrow('不在角色表')
  })

  it('list 按聊天过滤会话；revision 是会话目录水位', async () => {
    const { sessions } = await service.list({ character: CHARACTER, chatId: CHAT })
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(sessions.every((session) => session.chat.character === CHARACTER && session.chat.chatId === CHAT)).toBe(true)
    const other = await service.list({ character: CHARACTER, chatId: 'other-chat' })
    expect(other.sessions).toEqual([])
    expect(typeof await service.revision()).toBe('string')
  })
})

describe('actor 规则（§4.1：actor 恒等于当前回合，服务端定）', () => {
  it('人类回合 agentMove 报错（含轮到谁/owner），反向亦然', async () => {
    const sessionId = await startTicTacToe()
    // 初始轮人类 x：Agent 落子必拒。
    await expect(service.agentMove(sessionId, { type: 'place', x: 0, y: 0 })).rejects.toThrow('现在轮到 x（人类玩家），不是 Agent 的回合')
    // 人类落 (0,0) 后轮 Agent o：humanAction 再落必拒。
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    await expect(service.humanAction(sessionId, { type: 'place', x: 1, y: 0 })).rejects.toThrow('现在轮到 o（Agent），请等待 AI 落子')
    // Agent 合法落子成功，describe 是引擎文案。
    const outcome = await service.agentMove(sessionId, { type: 'place', x: 1, y: 1 })
    expect(outcome.describe).toContain('O落于 B2')
    expect(outcome.session.turn).toBe('x')
  })

  it('非法动作：引擎中文报错透传（illegal 400 面）', async () => {
    const sessionId = await startTicTacToe()
    await expect(service.humanAction(sessionId, { type: 'place', x: 9, y: 9 })).rejects.toThrow('0-2 的整数')
    await expect(service.humanAction(sessionId, { type: 'resign' })).resolves.toBeTruthy() // resign 是合法动作（运行时处理）
  })

  it('终局后落子 409 面：报对局已结束', async () => {
    const sessionId = await startTicTacToe()
    // X: (0,0)(1,0)(2,0) 三连；O: (0,1)(1,1)。
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    await service.agentMove(sessionId, { type: 'place', x: 0, y: 1 })
    await service.humanAction(sessionId, { type: 'place', x: 1, y: 0 })
    await service.agentMove(sessionId, { type: 'place', x: 1, y: 1 })
    const final = await service.humanAction(sessionId, { type: 'place', x: 2, y: 0 })
    expect(final.session.finished).toBe(true)
    expect(final.session.winner).toBe('x')
    expect(final.session.summary).toContain('三连')
    await expect(service.humanAction(sessionId, { type: 'place', x: 2, y: 2 })).rejects.toThrow('对局已结束')
    await expect(service.agentMove(sessionId, { type: 'place', x: 2, y: 2 })).rejects.toThrow('对局已结束')
  })
})

describe('resign 保留动作（§3.2：运行时统一处理）', () => {
  it('当前回合方认输：finished、winner=对方、summary「<角色> 认输」', async () => {
    const sessionId = await startTicTacToe()
    const outcome = await service.humanAction(sessionId, { type: 'resign' })
    expect(outcome.session.finished).toBe(true)
    expect(outcome.session.winner).toBe('o')
    expect(outcome.session.summary).toBe('x 认输')
    expect(outcome.session.moves.at(-1)!.describe).toBe('x 认输')
    // state 不变（引擎未参与）。
    expect((outcome.view.state as { ply: number }).ply).toBe(0)
  })

  it('Agent 认输同理', async () => {
    const sessionId = await startTicTacToe()
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    const outcome = await service.agentMove(sessionId, { type: 'resign' })
    expect(outcome.session.winner).toBe('x')
    expect(outcome.session.summary).toBe('o 认输')
  })
})

describe('revision 水位（镜像 storeRevision 的便宜纪律）', () => {
  it('落子后 revision 变化', async () => {
    const before = await service.revision()
    const sessionId = await startTicTacToe()
    expect(await service.revision()).not.toBe(before)
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    expect(await service.revision()).not.toBe(before)
  })
})

describe('重启续局（重开服务读回）', () => {
  it('dispose 后重开：会话原样、可继续落子到终局', async () => {
    const firstSession = await startTicTacToe()
    await service.humanAction(firstSession, { type: 'place', x: 0, y: 0 })
    service.dispose()
    const reopened = await openGamesService({ root, hostVersion: '0.6.0' })
    try {
      const { session, view } = await reopened.state(firstSession)
      expect(session.id).toBe(firstSession)
      expect((view.state as { ply: number }).ply).toBe(1)
      expect(session.moves).toHaveLength(1)
      // 续局：Agent 落子照常（引擎纯函数，重启零损失）。
      const outcome = await reopened.agentMove(firstSession, { type: 'place', x: 1, y: 1 })
      expect(outcome.session.moves).toHaveLength(2)
    } finally {
      reopened.dispose()
    }
    // 重开期间旧句柄已摘：重发布的是新服务——恢复本 suite 的句柄供后续用例。
    service = await openGamesService({ root, hostVersion: '0.6.0' })
  })
})

describe('井字棋全流程到终局（P0 验收：无头完成一整局，动作日志可重放）', () => {
  it('六手对局：O（Agent）列三连获胜，moves 日志完整', async () => {
    const sessionId = await startTicTacToe()
    const script: Array<['human' | 'agent', number, number]> = [
      ['human', 0, 0],
      ['agent', 0, 2],
      ['human', 1, 0],
      ['agent', 1, 2],
      ['human', 2, 1],
      ['agent', 2, 2],
    ]
    let last: Awaited<ReturnType<GamesService['agentMove']>> | undefined
    for (const [who, x, y] of script) {
      last = who === 'human'
        ? await service.humanAction(sessionId, { type: 'place', x, y })
        : await service.agentMove(sessionId, { type: 'place', x, y })
    }
    expect(last!.session.finished).toBe(true)
    expect(last!.session.winner).toBe('o')
    expect(last!.session.summary).toContain('O三连')
    const { session } = await service.state(sessionId)
    expect(session.moves.map((move) => move.actor)).toEqual(['x', 'o', 'x', 'o', 'x', 'o'])
    expect(session.moves.every((move) => move.at !== '' && move.summary !== '')).toBe(true)
  })
})

/* ------------------------------ HTTP 路由面 ------------------------------ */

function fakeReq(method: string, pathname: string, body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: pathname,
    on(event: string, handler: (chunk?: unknown) => void) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') handler()
      return this
    },
  }
}

function fakeRes() {
  const response = {
    body: '',
    statusCode: 0,
    headers: {} as Record<string, string>,
    writableEnded: false,
    setHeader(name: string, value: string) { response.headers[name] = value },
    end(chunk?: string) {
      if (chunk !== undefined) response.body = String(chunk)
      response.writableEnded = true
    },
  }
  return response
}

async function call(method: string, pathname: string, body?: unknown) {
  const res = fakeRes()
  const url = new URL(`http://localhost${pathname}`)
  await handleGamesApi({
    resolveService: () => service,
    req: fakeReq(method, pathname, body),
    res,
    url,
    // route 只取 path 段（query 留在 url.searchParams），与 index.ts 的
    // handleApi 切法一致。
    route: url.pathname.replace('/api/dsh-tavern/', ''),
    method,
  })
  const text = res.body ?? ''
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* HTML 路由 */ }
  return { status: res.statusCode, headers: res.headers, text, body: parsed }
}

describe('HTTP 路由（handleGamesApi 直打，fakeReq/fakeRes 范式）', () => {
  it('GET games/list：ok + games + sessions；双全参数过滤', async () => {
    const result = await call('GET', '/api/dsh-tavern/games/list?character=x&chatId=y')
    expect(result.status).toBe(200)
    expect((result.body as { ok: boolean }).ok).toBe(true)
    expect((result.body as { games: unknown[] }).games.map((game) => (game as { id: string }).id)).toContain('dsh-tavern.tic-tac-toe')
    expect((result.body as { sessions: unknown[] }).sessions).toEqual([])
  })

  it('GET games/revision：ok + revision 字符串', async () => {
    const result = await call('GET', '/api/dsh-tavern/games/revision')
    expect(result.status).toBe(200)
    expect(typeof (result.body as { revision: string }).revision).toBe('string')
  })

  it('POST games/start：缺参数 400；成功 200 带 session/view', async () => {
    const missing = await call('POST', '/api/dsh-tavern/games/start', { gameId: 'dsh-tavern.tic-tac-toe', character: '', chatId: 'c' })
    expect(missing.status).toBe(400)
    expect((missing.body as { message: string }).message).toContain('character')
    const ok = await call('POST', '/api/dsh-tavern/games/start', { gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: 'http-chat' })
    expect(ok.status).toBe(200)
    expect((ok.body as { session: { id: string } }).session.id).toMatch(/^g-/)
  })

  it('POST games/action/:id：非人类回合 409、非法动作 400（引擎中文透传）、成功 200', async () => {
    const start = await call('POST', '/api/dsh-tavern/games/start', { gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: 'http-chat-2' })
    const sessionId = (start.body as { session: { id: string } }).session.id
    // 初始轮人类：动作体形状非法 → 400。
    const badShape = await call('POST', `/api/dsh-tavern/games/action/${sessionId}`, { action: 'place' })
    expect(badShape.status).toBe(400)
    // 越界动作 → 引擎报错透传 400。
    const illegal = await call('POST', `/api/dsh-tavern/games/action/${sessionId}`, { action: { type: 'place', x: 5, y: 5 } })
    expect(illegal.status).toBe(400)
    expect((illegal.body as { message: string }).message).toContain('0-2 的整数')
    // 合法人类落子 → 200；再落（已轮 Agent）→ 409。
    const ok = await call('POST', `/api/dsh-tavern/games/action/${sessionId}`, { action: { type: 'place', x: 0, y: 0 } })
    expect(ok.status).toBe(200)
    const wrongTurn = await call('POST', `/api/dsh-tavern/games/action/${sessionId}`, { action: { type: 'place', x: 1, y: 0 } })
    expect(wrongTurn.status).toBe(409)
    expect((wrongTurn.body as { message: string }).message).toContain('现在轮到 o')
    // 未知会话 → 404。
    const missing = await call('POST', '/api/dsh-tavern/games/action/g-00000000', { action: { type: 'resign' } })
    expect(missing.status).toBe(404)
  })

  it('GET games/state/:id：200；GET games/:gid/view/:sid：HTML + CSP + 桥标记', async () => {
    const start = await call('POST', '/api/dsh-tavern/games/start', { gameId: 'dsh-tavern.tic-tac-toe', character: CHARACTER, chatId: 'http-chat-3' })
    const sessionId = (start.body as { session: { id: string } }).session.id
    const state = await call('GET', `/api/dsh-tavern/games/state/${sessionId}`)
    expect(state.status).toBe(200)
    expect((state.body as { view: { turn: string } }).view.turn).toBe('x')

    const view = await call('GET', `/api/dsh-tavern/games/dsh-tavern.tic-tac-toe/view/${sessionId}`)
    expect(view.status).toBe(200)
    expect(view.headers['content-type']).toContain('text/html')
    expect(view.text).toContain('Content-Security-Policy')
    expect(view.text).toContain("script-src 'unsafe-inline'")
    expect(view.text).toContain("connect-src 'none'")
    expect(view.text).toContain('dsh-tavern:game-state')
    expect(view.text).toContain('dsh-tavern:game-action')
    expect(view.text).toContain('井字棋')
    // 会话不属于该游戏 → 404。
    const mismatch = await call('GET', `/api/dsh-tavern/games/no.such.game/view/${sessionId}`)
    expect(mismatch.status).toBe(404)
  })

  it('未知 games 子路由 404；resolveService 缺失 503「游戏运行时不可用」', async () => {
    const missing = await call('GET', '/api/dsh-tavern/games/nope')
    expect(missing.status).toBe(404)
    const res = fakeRes()
    await handleGamesApi({
      resolveService: () => undefined,
      req: fakeReq('GET', '/api/dsh-tavern/games/list'),
      res,
      url: new URL('http://localhost/api/dsh-tavern/games/list'),
      route: 'games/list',
      method: 'GET',
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('游戏运行时不可用')
  })

  it('POST games/reload：200 + games 快照', async () => {
    const result = await call('POST', '/api/dsh-tavern/games/reload', {})
    expect(result.status).toBe(200)
    expect((result.body as { games: unknown[] }).games.length).toBeGreaterThanOrEqual(1)
  })
})

describe('孤儿会话（gameId 不在注册表：可查看不可落子）', () => {
  it('内置游戏不可能卸载——用假注册表演绎：直接删掉注册表条目后 state 可读、落子被拒', async () => {
    // 真实卸载路径（删 installed 目录 + reload）在 games-import.spec 覆盖；
    // 这里用服务重启 + 注册表变更的最小复现：内置恒在，故借 sessions.get 的
    // orphaned 判定单元语义——通过删除会话对应的注册表项不可行，改用行为面：
    // 构造一个 gameId 指向不存在游戏的会话文件（手工落盘），state 可读、
    // 落子拒绝（unavailable/orphaned）。
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const orphan = {
      id: 'g-deadbeef',
      gameId: 'uninstalled.game',
      players: [{ role: 'a', owner: 'human' }, { role: 'b', owner: 'agent' }],
      state: { turn: 'a' },
      moves: [],
      createdAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
      chat: { character: CHARACTER, chatId: CHAT },
      finished: false,
      winner: null,
      summary: '',
    }
    mkdirSync(join(root, 'games', 'sessions'), { recursive: true })
    writeFileSync(join(root, 'games', 'sessions', 'g-deadbeef.json'), JSON.stringify(orphan), 'utf8')
    const { session, view } = await service.state('g-deadbeef')
    expect(session.orphaned).toBe(true)
    expect(session.gameName).toBe('uninstalled.game') // 注册表无此游戏时回落 gameId
    expect(view.legal).toEqual([])
    await expect(service.humanAction('g-deadbeef', { type: 'place', x: 0, y: 0 })).rejects.toThrow('orphaned')
    await expect(service.agentMove('g-deadbeef', { type: 'resign' })).rejects.toThrow('orphaned')
  })
})
