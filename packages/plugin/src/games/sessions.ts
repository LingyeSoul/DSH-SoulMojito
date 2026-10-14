/**
 * 游戏会话生命周期（提案 0018 §4.1 sessions.ts，P0）。
 *
 * 权威状态在 Node（提案 §1 第一性结论）：引擎无状态纯函数，会话状态 JSON 落盘
 * `$DSH_HOME/tavern/games/sessions/<sessionId>.json`（sessionId 形如
 * `g-<8 位随机十六进制>`），写路径用 writeFileAtomic（src/update/apply.ts 同款）。
 * 重启续局 = 重开会话文件重建（引擎纯函数，零损失）。
 *
 * actor 推导规则（任务定案，提案 §4.1 的服务端收敛）：actor 恒等于 state 当前
 * 回合的角色（currentRoleOf），服务端定，客户端/工具不传 actor。HTTP
 * POST games/action/:id 要求当前回合 owner==='human' 否则 409；工具 game_move
 * 要求 owner==='agent' 否则结构化报错（含轮到谁/owner）。v1 会话恒为
 * 「一人类一 Agent」（提案 §6 开放问题 ① 的裁剪）：players.max !== 2 的游戏
 * start 时拒绝并说明。
 *
 * resign 保留动作由运行时处理（引擎不实现，提案 §3.2）：action {type:'resign'}
 * → finished、winner=对方、summary「<角色> 认输」。
 *
 * 孤儿会话：gameId 不在注册表（或 broken）的会话 orphaned:true——可查看不可
 * 落子（镜像 Mod 工具卸载语义，提案 §4.5 第 3 源的同款边界）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../update/apply.js'
import type { GameRegistry } from './registry.js'
import {
  GAME_ACTION_MAX_BYTES,
  GAME_SESSION_ID_PATTERN,
  GAME_STATE_MAX_BYTES,
  currentRoleOf,
  isJsonSafe,
  jsonSizeOf,
  type GameAction,
  type GameOwner,
} from './standard.js'

/** 会话玩家（角色 + 执子归属）。 */
export interface GamePlayerView {
  role: string
  owner: GameOwner
}

/** 落子记录（动作日志完整保留，可审计重放——提案开工前八项表「持久态及理由」）。 */
export interface GameMoveRecord {
  actor: string
  action: GameAction
  at: string
  summary: string
  /** 引擎 describe（resign 时由运行时合成）。 */
  describe: string
}

/** 会话落盘形态（JSON-safe 整体）。 */
export interface GameSession {
  id: string
  gameId: string
  players: GamePlayerView[]
  state: unknown
  moves: GameMoveRecord[]
  createdAt: string
  updatedAt: string
  chat: { character: string; chatId: string }
  finished: boolean
  winner: string | null
  /** 最近一手的 summary（终局横幅文案，§9 摩擦 2 的下行载荷补齐）。 */
  summary: string
}

/** 视图载荷（§3.3 下行 dsh-tavern:game-state 的 view 字段，全量无增量）。 */
export interface GameViewPayload {
  state: unknown
  turn: string
  legal: GameAction[]
  finished: boolean
  summary: string
}

/** 会话快照（list/state/action 响应里的 session 字段）。 */
export interface GameSessionSummary {
  id: string
  gameId: string
  gameName: string
  /** 该游戏的动作词汇表（懒提示段每会话一行要用，取自注册表 meta）。 */
  actionVocabulary: string
  players: GamePlayerView[]
  turn: string
  finished: boolean
  winner: string | null
  summary: string
  orphaned: boolean
  chat: { character: string; chatId: string }
  createdAt: string
  updatedAt: string
  /** 动作日志（提案开工前八项表：完整保留，可审计重放）。 */
  moves: GameMoveRecord[]
}

export interface GameActionResult {
  session: GameSessionSummary
  view: GameViewPayload
  /** 本手的可叙述文案（game_move 工具返回给 Agent 用）。 */
  describe: string
}

/** 传输层错误分类（http.ts 据此映射状态码）。 */
export class GameBridgeError extends Error {
  constructor(
    public readonly code: 'not-found' | 'turn' | 'illegal' | 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message)
  }
}

export interface GameSessionStoreOptions {
  /** tavern 数据根（`$DSH_HOME/tavern`）。会话目录是 `<root>/games/sessions/`。 */
  root: string
  /** 注册表访问器（孤儿判定与引擎取用；registry 初始化晚于本 store 时用函数面）。 */
  registry: () => GameRegistry
}

const OWNER_LABEL: Record<GameOwner, string> = { human: '人类玩家', agent: 'Agent' }

export class GameSessionStore {
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(private readonly options: GameSessionStoreOptions) {}

  static async open(options: GameSessionStoreOptions): Promise<GameSessionStore> {
    await fs.mkdir(join(options.root, 'games', 'sessions'), { recursive: true })
    return new GameSessionStore(options)
  }

  private get sessionsRoot(): string {
    return join(this.options.root, 'games', 'sessions')
  }

  /* ------------------------------ 查询面 ------------------------------ */

  /** 会话目录 name+size+mtimeMs 的 sha256（镜像 tavern-store storeRevision 的便宜纪律：只 stat 不读内容）。 */
  async revision(): Promise<string> {
    const hash = createHash('sha256')
    const names = (await fs.readdir(this.sessionsRoot).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    for (const name of names) {
      const stat = await fs.stat(join(this.sessionsRoot, name)).catch(() => undefined)
      hash.update(`${name}\u0000${stat === undefined ? 'missing' : `${stat.size}\u0000${stat.mtimeMs}`}\n`)
    }
    return hash.digest('base64url')
  }

  /** 全部会话快照（updatedAt 降序）；character+chatId 双全时按聊天过滤。 */
  async list(filter: { character?: string; chatId?: string } = {}): Promise<GameSessionSummary[]> {
    const sessions = await this.loadAll()
    const summaries = sessions.map((session) => this.summarize(session))
    if (filter.character !== undefined && filter.chatId !== undefined && filter.character !== '' && filter.chatId !== '') {
      return summaries.filter((summary) => summary.chat.character === filter.character && summary.chat.chatId === filter.chatId)
    }
    return summaries
  }

  /** 会话视图快照（含孤儿标记）。 */
  async get(sessionId: string): Promise<{ session: GameSessionSummary; view: GameViewPayload }> {
    const session = await this.load(sessionId)
    return { session: this.summarize(session), view: this.viewOf(session) }
  }

  /** 本聊天最近活跃（未终局）会话 id；无则 undefined（game_state/game_move 缺省寻址）。 */
  async latestActive(character: string, chatId: string): Promise<string | undefined> {
    const sessions = await this.loadAll()
    const active = sessions
      .filter((session) => !session.finished && session.chat.character === character && session.chat.chatId === chatId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1))
    return active[0]?.id
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /** 开局（POST games/start 与工具 game_start 共用）。 */
  async start(params: {
    gameId: string
    character: string
    chatId: string
    /** 人类执方；缺省 roles[0]（人类先手），另一方 owner='agent'。 */
    humanRole?: string
  }): Promise<{ session: GameSessionSummary; view: GameViewPayload }> {
    if (typeof params.character !== 'string' || params.character.trim() === ''
      || typeof params.chatId !== 'string' || params.chatId.trim() === '') {
      throw new GameBridgeError('invalid', 'character 与 chatId 不能为空（会话必须绑定聊天）')
    }
    const entry = this.options.registry().get(params.gameId)
    if (entry === undefined) throw new GameBridgeError('not-found', `游戏 '${params.gameId}' 不在注册表`)
    if (entry.status !== 'ok' || entry.engine === null) {
      throw new GameBridgeError('unavailable', `游戏 '${params.gameId}' 不可用: ${entry.reason}`)
    }
    const roles = entry.manifest.players.roles
    // v1 会话恒为「一人类一 Agent」：>2 人（或非双人）开局即拒（提案 §6 ①裁剪）。
    if (entry.manifest.players.max !== 2 || roles.length !== 2) {
      throw new GameBridgeError('invalid', `「${entry.manifest.name}」声明 ${entry.manifest.players.max} 名玩家；游戏桥 v1 只支持一人类一 Agent 的双人对局`)
    }
    const humanRole = params.humanRole ?? roles[0]!
    if (!roles.includes(humanRole)) {
      throw new GameBridgeError('invalid', `humanRole「${humanRole}」不在角色表 [${roles.join(', ')}] 内`)
    }

    const created = entry.engine.createGame()
    const state = created.state
    if (!isJsonSafe(state) || jsonSizeOf(state) > GAME_STATE_MAX_BYTES) {
      throw new GameBridgeError('invalid', '引擎 createGame 产出的初始 state 违反 JSON-safe/尺寸契约')
    }
    currentRoleOf(state, roles) // turn 合法性（抛错即拒绝开局）

    const now = new Date().toISOString()
    const session: GameSession = {
      id: `g-${randomBytes(4).toString('hex')}`,
      gameId: entry.manifest.id,
      // 玩家按 manifest roles 的规范序排列（展示与 turn 推导都以角色表为锚）。
      players: roles.map((role) => ({ role, owner: role === humanRole ? 'human' as const : 'agent' as const })),
      state,
      moves: [],
      createdAt: now,
      updatedAt: now,
      chat: { character: params.character, chatId: params.chatId },
      finished: false,
      winner: null,
      summary: '',
    }
    await this.persist(session)
    return { session: this.summarize(session), view: this.viewOf(session) }
  }

  /** 人类落子（HTTP POST games/action/:id）：当前回合 owner 必须是 human。 */
  humanAction(sessionId: string, action: GameAction): Promise<GameActionResult> {
    return this.enqueue(() => this.act(sessionId, action, 'human'))
  }

  /** Agent 落子（工具 game_move）：当前回合 owner 必须是 agent。 */
  agentMove(sessionId: string, action: GameAction): Promise<GameActionResult> {
    return this.enqueue(() => this.act(sessionId, action, 'agent'))
  }

  /** 串行化读-改-写（镜像 tavern-store chatMutationTail：防止并发落子丢手）。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async act(sessionId: string, action: GameAction, owner: GameOwner): Promise<GameActionResult> {
    if (typeof sessionId !== 'string' || !GAME_SESSION_ID_PATTERN.test(sessionId)) {
      throw new GameBridgeError('not-found', `会话 id「${String(sessionId)}」不合法`)
    }
    const session = await this.load(sessionId)
    const entry = this.options.registry().get(session.gameId)
    if (entry === undefined || entry.status !== 'ok' || entry.engine === null) {
      // 孤儿会话：游戏已不在注册表（卸载/损坏）——可查看不可落子。
      throw new GameBridgeError('unavailable', `会话的游戏 '${session.gameId}' 已不在注册表（orphaned），对局只读不可落子`)
    }
    const engine = entry.engine
    const roles = entry.manifest.players.roles

    if (session.finished) {
      throw new GameBridgeError('turn', `对局已结束（${session.summary}），不能再落子`)
    }
    const actor = currentRoleOf(session.state, roles)
    const player = session.players.find((candidate) => candidate.role === actor)
    if (player === undefined) {
      throw new GameBridgeError('unavailable', `会话角色表 [${session.players.map((p) => p.role).join(', ')}] 与 state.turn「${actor}」不一致`)
    }
    if (player.owner !== owner) {
      throw new GameBridgeError(
        'turn',
        owner === 'agent'
          ? `现在轮到 ${actor}（${OWNER_LABEL[player.owner]}），不是 Agent 的回合`
          : `现在轮到 ${actor}（${OWNER_LABEL[player.owner]}），请等待 AI 落子`,
      )
    }

    // 动作形状（§3.4）：JSON 对象、type 字符串、≤4KB。
    if (action === null || typeof action !== 'object' || Array.isArray(action)) {
      throw new GameBridgeError('invalid', '动作必须是 JSON 对象')
    }
    if (typeof action.type !== 'string' || action.type === '') {
      throw new GameBridgeError('invalid', '动作缺少 type 字段')
    }
    if (jsonSizeOf(action) > GAME_ACTION_MAX_BYTES) {
      throw new GameBridgeError('invalid', `动作序列化超过 ${GAME_ACTION_MAX_BYTES} 字节上限`)
    }

    let describe: string
    let summary: string
    let winner: string | null
    let finished: boolean
    let nextState = session.state
    if (action.type === 'resign') {
      // 保留动作：运行时统一处理（提案 §3.2）——引擎不参与。
      winner = session.players.find((candidate) => candidate.role !== actor)!.role
      finished = true
      describe = `${actor} 认输`
      summary = describe
    } else {
      // describe 在 applyAction 之前取（落子前 state）—— narration 基于决策时的局面。
      try {
        describe = engine.describe(session.state, actor, action)
      } catch {
        describe = `${actor} 的动作 ${action.type}`
      }
      let result
      try {
        result = engine.applyAction(session.state, action, actor)
      } catch (cause) {
        // 非法动作：引擎中文报错透传（HTTP 400 / 工具结构化错误的同一来源）。
        throw new GameBridgeError('illegal', cause instanceof Error ? cause.message : String(cause))
      }
      nextState = result.state
      if (!isJsonSafe(nextState) || jsonSizeOf(nextState) > GAME_STATE_MAX_BYTES) {
        throw new GameBridgeError('invalid', '引擎 applyAction 产出的新 state 违反 JSON-safe/尺寸契约')
      }
      summary = result.summary
      winner = result.winner
      finished = result.finished === true
    }

    session.moves.push({ actor, action, at: new Date().toISOString(), summary, describe })
    session.state = nextState
    session.finished = finished
    session.winner = finished ? winner : session.winner
    session.summary = summary
    session.updatedAt = new Date().toISOString()
    await this.persist(session)
    return { session: this.summarize(session), view: this.viewOf(session), describe }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async persist(session: GameSession): Promise<void> {
    await fs.mkdir(this.sessionsRoot, { recursive: true })
    writeFileAtomic(join(this.sessionsRoot, `${session.id}.json`), `${JSON.stringify(session, null, 2)}\n`)
  }

  private async load(sessionId: string): Promise<GameSession> {
    if (!GAME_SESSION_ID_PATTERN.test(sessionId)) {
      throw new GameBridgeError('not-found', `会话 '${sessionId}' 不存在`)
    }
    let raw: string
    try {
      raw = await fs.readFile(join(this.sessionsRoot, `${sessionId}.json`), 'utf8')
    } catch {
      throw new GameBridgeError('not-found', `会话 '${sessionId}' 不存在`)
    }
    try {
      const session = JSON.parse(raw) as GameSession
      if (session === null || typeof session !== 'object' || session.id !== sessionId) {
        throw new Error('shape mismatch')
      }
      return session
    } catch (cause) {
      throw new GameBridgeError('unavailable', `会话 '${sessionId}' 文件损坏: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  private async loadAll(): Promise<GameSession[]> {
    const names = (await fs.readdir(this.sessionsRoot).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
    const sessions: GameSession[] = []
    for (const name of names) {
      try {
        sessions.push(await this.load(name.slice(0, -'.json'.length)))
      } catch {
        // 单个损坏会话不阻断列表（坏文件按缺失处理）。
      }
    }
    return sessions
  }

  /** 孤儿判定：gameId 不在注册表或 broken。 */
  private orphaned(session: GameSession): boolean {
    const entry = this.options.registry().get(session.gameId)
    return entry === undefined || entry.status !== 'ok' || entry.engine === null
  }

  private summarize(session: GameSession): GameSessionSummary {
    const entry = this.options.registry().get(session.gameId)
    let turn = ''
    try {
      turn = currentRoleOf(session.state, entry?.manifest.players.roles)
    } catch {
      turn = ''
    }
    return {
      id: session.id,
      gameId: session.gameId,
      gameName: entry?.manifest.name ?? session.gameId,
      actionVocabulary: entry?.manifest.actionVocabulary ?? '',
      players: session.players.map((player) => ({ ...player })),
      turn,
      finished: session.finished,
      winner: session.winner,
      summary: session.summary,
      orphaned: this.orphaned(session),
      chat: { ...session.chat },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      moves: session.moves.map((move) => ({ ...move, action: { ...move.action } })),
    }
  }

  private viewOf(session: GameSession): GameViewPayload {
    const entry = this.options.registry().get(session.gameId)
    let turn = ''
    try {
      turn = currentRoleOf(session.state, entry?.manifest.players.roles)
    } catch {
      turn = ''
    }
    let legal: GameAction[] = []
    if (!session.finished && entry?.engine != null) {
      try {
        legal = entry.engine.legalActions(session.state)
      } catch {
        legal = []
      }
    }
    return { state: session.state, turn, legal, finished: session.finished, summary: session.summary }
  }
}
