/**
 * 游戏桥服务层全流程（提案 0018 §4.1，P0）：temp root 开真实服务——
 * start / 人类与 Agent 交替落子 / resign / 重启续局（重开服务读回）/ revision
 * 变化 / actor 规则（人类回合 agentMove 报错、反向亦然）/ 孤儿会话（卸载
 * 游戏后 orphaned 且拒绝落子）/ 井字棋全流程到终局 / history 动作日志窗口
 * （2026-10-14 增量修订：快照头只留 moveCount，日志经 history() 有界读取——
 * 缺省尾窗 20、上限 200、from 夹紧；长日志经会话文件注入构造）。
 *
 * HTTP 面：follow tavern-mods.spec.ts 的 fakeReq/fakeRes 范式直接打
 * handleGamesApi（不 boot index.ts）：list/revision/start/state/action 的
 * 409/400/404 状态码纪律、view 的 CSP 与桥标记、reload。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openGamesService, type GamesService } from '../src/games/service.js'
import { handleGamesApi } from '../src/games/http.js'
import { GameBridgeError } from '../src/games/sessions.js'

const home = mkdtempSync(join(tmpdir(), 'games-service-'))
const root = join(home, 'tavern')
const CHARACTER = 'ExampleCard'
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
  const { session } = await service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: CHAT })
  return session.id
}

describe('开局与绑定', () => {
  it('start 返回 session + view：roles 归属（人类先手 x、Agent 后手 o）、初始建议集', async () => {
    const { session, view } = await service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: CHAT })
    expect(session.id).toMatch(/^g-[0-9a-f]{8}$/)
    expect(session.gameId).toBe('dsh-soulmojito.tic-tac-toe')
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
    const { session } = await service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: CHAT, humanRole: 'o' })
    expect(session.players).toEqual([
      { role: 'x', owner: 'agent' },
      { role: 'o', owner: 'human' },
    ])
  })

  it('character/chatId 空（400 面）、未知游戏（404 面）、非法 humanRole（400 面）', async () => {
    await expect(service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: '', chatId: CHAT })).rejects.toThrow(GameBridgeError)
    await expect(service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: '', chatId: CHAT })).rejects.toThrow('不能为空')
    await expect(service.start({ gameId: 'no.such.game', character: CHARACTER, chatId: CHAT })).rejects.toThrow('不在注册表')
    await expect(service.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: CHAT, humanRole: 'black' })).rejects.toThrow('不在角色表')
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
    expect(outcome.session.moveCount).toBe(1)
    const { moves } = await service.history(sessionId)
    expect(moves.at(-1)!.describe).toBe('x 认输')
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
      expect(session.moveCount).toBe(1)
      // 续局：Agent 落子照常（引擎纯函数，重启零损失）。
      const outcome = await reopened.agentMove(firstSession, { type: 'place', x: 1, y: 1 })
      expect(outcome.session.moveCount).toBe(2)
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
    expect(session.moveCount).toBe(6)
    // 动作日志完整可重放（增量修订后经 history() 窗口读取，不在快照里）。
    const { moves } = await service.history(sessionId, { from: 0 })
    expect(moves.map((move) => move.actor)).toEqual(['x', 'o', 'x', 'o', 'x', 'o'])
    expect(moves.every((move) => move.at !== '' && move.summary !== '')).toBe(true)
  })
})

describe('history 动作日志窗口（2026-10-14 增量修订）', () => {
  it('缺省尾窗 / from+limit 分页 / 钳制（limit 非整数回落 20、越界夹紧、from 负值与越界）', async () => {
    const sessionId = await startTicTacToe()
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    await service.agentMove(sessionId, { type: 'place', x: 0, y: 1 })
    await service.humanAction(sessionId, { type: 'place', x: 1, y: 0 })
    // 缺省：moveCount 3 < 20 → 尾窗即全量。
    const all = await service.history(sessionId)
    expect(all.session.moveCount).toBe(3)
    expect(all.from).toBe(0)
    expect(all.moves.map((move) => move.actor)).toEqual(['x', 'o', 'x'])
    // from+limit 分页。
    const page = await service.history(sessionId, { from: 1, limit: 1 })
    expect(page.from).toBe(1)
    expect(page.moves).toHaveLength(1)
    expect(page.moves[0]!.actor).toBe('o')
    // from 越界 → 夹到 moveCount（空窗）；from 负值 → 0。
    const beyond = await service.history(sessionId, { from: 99 })
    expect(beyond.from).toBe(3)
    expect(beyond.moves).toEqual([])
    const negative = await service.history(sessionId, { from: -5 })
    expect(negative.from).toBe(0)
    // limit 非整数回落缺省 20；limit 0 夹到 1。
    const fallback = await service.history(sessionId, { limit: Number.NaN })
    expect(fallback.moves).toHaveLength(3)
    const floored = await service.history(sessionId, { limit: 0 })
    expect(floored.from).toBe(2)
    expect(floored.moves).toHaveLength(1)
    await service.agentMove(sessionId, { type: 'resign' })
  })

  it('长日志：缺省只回最近 20 手（from= moveCount-20）、limit 上界 200、窗口条目可复读', async () => {
    const sessionId = await startTicTacToe()
    // 井字棋九手即终局，长日志用会话文件注入构造（store 读取路径照常）。
    const file = join(root, 'games', 'sessions', `${sessionId}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8')) as { moves: unknown[] }
    for (let index = 0; index < 25; index += 1) {
      record.moves.push({
        actor: 'x', action: { type: 'place', x: 0, y: 0 }, at: new Date().toISOString(),
        summary: `第${index}手`, describe: `第${index}手`,
      })
    }
    writeFileSync(file, JSON.stringify(record))
    const tail = await service.history(sessionId)
    expect(tail.session.moveCount).toBe(25)
    expect(tail.from).toBe(5)
    expect(tail.moves).toHaveLength(20)
    expect(tail.moves[0]!.summary).toBe('第5手')
    expect(tail.moves.at(-1)!.summary).toBe('第24手')
    // 上界钳制：limit 9999 → 200（≥25 即全量）；from=0 从头读。
    const head = await service.history(sessionId, { from: 0, limit: 9999 })
    expect(head.from).toBe(0)
    expect(head.moves).toHaveLength(25)
    // 未知会话：与 state 同款 404 语义。
    await expect(service.history('g-00000000')).rejects.toThrow('不存在')
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
    route: url.pathname.replace('/api/dsh-soulmojito/', ''),
    method,
  })
  const text = res.body ?? ''
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* HTML 路由 */ }
  return { status: res.statusCode, headers: res.headers, text, body: parsed }
}

describe('HTTP 路由（handleGamesApi 直打，fakeReq/fakeRes 范式）', () => {
  it('GET games/list：ok + games + sessions；双全参数过滤', async () => {
    const result = await call('GET', '/api/dsh-soulmojito/games/list?character=x&chatId=y')
    expect(result.status).toBe(200)
    expect((result.body as { ok: boolean }).ok).toBe(true)
    expect((result.body as { games: unknown[] }).games.map((game) => (game as { id: string }).id)).toContain('dsh-soulmojito.tic-tac-toe')
    expect((result.body as { sessions: unknown[] }).sessions).toEqual([])
  })

  it('GET games/revision：ok + revision 字符串', async () => {
    const result = await call('GET', '/api/dsh-soulmojito/games/revision')
    expect(result.status).toBe(200)
    expect(typeof (result.body as { revision: string }).revision).toBe('string')
  })

  it('POST games/start：缺参数 400；成功 200 带 session/view', async () => {
    const missing = await call('POST', '/api/dsh-soulmojito/games/start', { gameId: 'dsh-soulmojito.tic-tac-toe', character: '', chatId: 'c' })
    expect(missing.status).toBe(400)
    expect((missing.body as { message: string }).message).toContain('character')
    const ok = await call('POST', '/api/dsh-soulmojito/games/start', { gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'http-chat' })
    expect(ok.status).toBe(200)
    expect((ok.body as { session: { id: string } }).session.id).toMatch(/^g-/)
  })

  it('POST games/action/:id：非人类回合 409、非法动作 400（引擎中文透传）、成功 200', async () => {
    const start = await call('POST', '/api/dsh-soulmojito/games/start', { gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'http-chat-2' })
    const sessionId = (start.body as { session: { id: string } }).session.id
    // 初始轮人类：动作体形状非法 → 400。
    const badShape = await call('POST', `/api/dsh-soulmojito/games/action/${sessionId}`, { action: 'place' })
    expect(badShape.status).toBe(400)
    // 越界动作 → 引擎报错透传 400。
    const illegal = await call('POST', `/api/dsh-soulmojito/games/action/${sessionId}`, { action: { type: 'place', x: 5, y: 5 } })
    expect(illegal.status).toBe(400)
    expect((illegal.body as { message: string }).message).toContain('0-2 的整数')
    // 合法人类落子 → 200；再落（已轮 Agent）→ 409。
    const ok = await call('POST', `/api/dsh-soulmojito/games/action/${sessionId}`, { action: { type: 'place', x: 0, y: 0 } })
    expect(ok.status).toBe(200)
    const wrongTurn = await call('POST', `/api/dsh-soulmojito/games/action/${sessionId}`, { action: { type: 'place', x: 1, y: 0 } })
    expect(wrongTurn.status).toBe(409)
    expect((wrongTurn.body as { message: string }).message).toContain('现在轮到 o')
    // 未知会话 → 404。
    const missing = await call('POST', '/api/dsh-soulmojito/games/action/g-00000000', { action: { type: 'resign' } })
    expect(missing.status).toBe(404)
  })

  it('GET games/state/:id：200；GET games/:gid/view/:sid：HTML + CSP + 桥标记', async () => {
    const start = await call('POST', '/api/dsh-soulmojito/games/start', { gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'http-chat-3' })
    const sessionId = (start.body as { session: { id: string } }).session.id
    const state = await call('GET', `/api/dsh-soulmojito/games/state/${sessionId}`)
    expect(state.status).toBe(200)
    expect((state.body as { view: { turn: string } }).view.turn).toBe('x')

    const view = await call('GET', `/api/dsh-soulmojito/games/dsh-soulmojito.tic-tac-toe/view/${sessionId}`)
    expect(view.status).toBe(200)
    expect(view.headers['content-type']).toContain('text/html')
    expect(view.text).toContain('Content-Security-Policy')
    expect(view.text).toContain("script-src 'unsafe-inline'")
    expect(view.text).toContain("connect-src 'none'")
    expect(view.text).toContain('dsh-soulmojito:game-state')
    expect(view.text).toContain('dsh-soulmojito:game-action')
    expect(view.text).toContain('井字棋')
    // 会话不属于该游戏 → 404。
    const mismatch = await call('GET', `/api/dsh-soulmojito/games/no.such.game/view/${sessionId}`)
    expect(mismatch.status).toBe(404)
  })

  it('未知 games 子路由 404；resolveService 缺失 503「游戏运行时不可用」', async () => {
    const missing = await call('GET', '/api/dsh-soulmojito/games/nope')
    expect(missing.status).toBe(404)
    const res = fakeRes()
    await handleGamesApi({
      resolveService: () => undefined,
      req: fakeReq('GET', '/api/dsh-soulmojito/games/list'),
      res,
      url: new URL('http://localhost/api/dsh-soulmojito/games/list'),
      route: 'games/list',
      method: 'GET',
    })
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('游戏运行时不可用')
  })

  it('POST games/reload：200 + games 快照', async () => {
    const result = await call('POST', '/api/dsh-soulmojito/games/reload', {})
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

describe('投降门与出回合投降（2026-10-14 用户需求）', () => {
  it('人类可在任意时刻投降（含 AI 回合）：actor/winner/describe 锚在人类角色', async () => {
    const sessionId = await startTicTacToe()
    // 人类落一手后轮到 Agent o——此刻人类入口的「落子」仍被拒，但「投降」放行
    // （认输是会话级终止，不是行棋动作）。
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    await expect(service.humanAction(sessionId, { type: 'place', x: 1, y: 1 })).rejects.toThrow('现在轮到 o（Agent），请等待 AI 落子')
    const outcome = await service.humanAction(sessionId, { type: 'resign' })
    expect(outcome.session.finished).toBe(true)
    expect(outcome.session.winner).toBe('o')
    expect(outcome.session.summary).toBe('x 认输')
    // actor 重锚为人类角色：日志与 describe 一致。
    const { moves } = await service.history(sessionId, { from: 0 })
    expect(moves.at(-1)!.actor).toBe('x')
    expect(moves.at(-1)!.describe).toBe('x 认输')
  })

  it('Agent 的 resign 仍受回合纪律约束（人类回合拒、自己回合允）', async () => {
    const sessionId = await startTicTacToe()
    await expect(service.agentMove(sessionId, { type: 'resign' })).rejects.toThrow('现在轮到 x（人类玩家），不是 Agent 的回合')
    await service.humanAction(sessionId, { type: 'place', x: 0, y: 0 })
    const outcome = await service.agentMove(sessionId, { type: 'resign' })
    expect(outcome.session.winner).toBe('x')
    expect(outcome.session.summary).toBe('o 认输')
  })

  it('禁用投降：两个入口一致拒绝，普通动作不受影响；开关翻转即时生效（逐次读策略）', async () => {
    let disabled = true
    const gated = await openGamesService({
      root,
      hostVersion: '0.6.0',
      resignAllowed: () => !disabled,
    })
    try {
      const { session } = await gated.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'resign-chat' })
      await expect(gated.humanAction(session.id, { type: 'resign' })).rejects.toThrow('投降已被禁用')
      await expect(gated.agentMove(session.id, { type: 'resign' })).rejects.toThrow('投降已被禁用')
      // 普通动作不受门控影响。
      const moved = await gated.humanAction(session.id, { type: 'place', x: 0, y: 0 })
      expect(moved.session.moveCount).toBe(1)
      // 面板翻转开关 → 投降恢复（策略逐次读取，无缓存写穿）。
      disabled = false
      const resigned = await gated.agentMove(session.id, { type: 'resign' })
      expect(resigned.session.finished).toBe(true)
      expect(resigned.session.summary).toBe('o 认输')
    } finally {
      gated.dispose()
    }
  })

  it('形状校验前移：出回合的畸形动作报 invalid（而不是回合错误）', async () => {
    const sessionId = await startTicTacToe()
    await expect(service.agentMove(sessionId, { x: 1 })).rejects.toThrow('动作缺少 type 字段')
    await expect(service.humanAction(sessionId, 'nope' as unknown as { type: string })).rejects.toThrow('动作必须是 JSON 对象')
  })
})

describe('onHumanAction 自动续弈回调（2026-10-14 用户需求）', () => {
  // 说明：本 describe 排在文件最后——两个 ad-hoc 服务 open/dispose 会改写
  // globalThis 句柄（openGamesService 发布 / dispose 摘除），放在末尾避免
  // 影响前面的用例（与「重启续局」describe 的句柄恢复纪律同一考虑）。
  it('人类落子/认输成功后回调收到会话摘要；被拒动作与 Agent 落子不回调；回调抛错不回退落子', async () => {
    const calls: Array<{ id: string; moveCount: number; finished: boolean }> = []
    const hooked = await openGamesService({
      root,
      hostVersion: '0.6.0',
      onHumanAction: async (session) => {
        calls.push({ id: session.id, moveCount: session.moveCount, finished: session.finished })
      },
    })
    try {
      const { session } = await hooked.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'wake-chat' })
      await hooked.humanAction(session.id, { type: 'place', x: 0, y: 0 })
      expect(calls).toEqual([{ id: session.id, moveCount: 1, finished: false }])
      // 非人类回合的人类入口被拒（409 面）：回调不触发——被拒的动作从未发生。
      await expect(hooked.humanAction(session.id, { type: 'place', x: 2, y: 2 })).rejects.toThrow()
      expect(calls).toHaveLength(1)
      // Agent 落子不经人类回调：自动续弈只挂人类棋盘入口。
      await hooked.agentMove(session.id, { type: 'place', x: 1, y: 1 })
      expect(calls).toHaveLength(1)
      // 人类认输（终局路径）同样回调，带 finished 摘要。
      await hooked.humanAction(session.id, { type: 'resign' })
      expect(calls).toHaveLength(2)
      expect(calls[1]).toMatchObject({ id: session.id, finished: true })
    } finally {
      hooked.dispose()
    }
    // 回调抛错：落子回执照常送达（错误降级为日志）。
    const warnings: string[] = []
    const throwing = await openGamesService({
      root,
      hostVersion: '0.6.0',
      logger: { warn: (message: string) => { warnings.push(message); return undefined } },
      onHumanAction: async () => {
        throw new Error('wake boom')
      },
    })
    try {
      const { session } = await throwing.start({ gameId: 'dsh-soulmojito.tic-tac-toe', character: CHARACTER, chatId: 'wake-chat-2' })
      const outcome = await throwing.humanAction(session.id, { type: 'place', x: 0, y: 0 })
      expect(outcome.session.moveCount).toBe(1)
      expect(warnings.some((line) => line.includes('wake failed') && line.includes('wake boom'))).toBe(true)
    } finally {
      throwing.dispose()
    }
  })
})
