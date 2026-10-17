/** AgentTavern games bridge tool slice (registration order 19-25) and its summary projection. */

import { beginGameWait, onGamesChanged, resolveGamesService } from '../../games/handle.js'
import type { GameMoveRecord, GameSessionSummary } from '../../games/sessions.js'
import { createLazyProjection } from '../../lazy-projection.js'
import { createHostPromptExpander, hostPromptSafe } from '../../prompt-safety.js'
import { clampInt, stringArg } from '../../tool-args.js'
import {
  DEFAULT_USER,
  bindingFor,
  objectOutput,
  tool,
  type BindingContext,
  type ToolDefinition,
} from './shared.js'
import { tavernStore } from './stores.js'


export function gameTools(): ToolDefinition[] {
  return [
    // ---- 游戏桥七件（提案 0018 §4.2，P0；2026-10-14 增量修订；2026-10-16
    // ---- 增 game_wait_full——带棋盘视图的等待变体）----
    // 服务经 globalThis 句柄逐调用解析（src/games/handle.ts）；句柄缺失（index
    // bundle 未装载游戏运行时）时返回明确错误，不影响其余工具。
    // **token 经济纪律（2026-10-14 用户裁定「尽可能考虑 token 经济性」）**：
    // 工具载荷全部扁平、字段最小——身份面（players/动作词汇表）只在
    // game_list/game_start 出现一次；回合载荷只带「下一步动作与叙述」所需，
    // 会话时钟/聊天绑定/审计字段（move.at/summary）不进载荷。棋盘与日志分别
    // 只经 game_state / game_history 读取。
    tool('game_list', "List installed games (id, name, players, action vocabulary) and this chat's sessions (sessionId, gameName, whose turn, finished, moveCount). Call it before game_start to pick a game (pass its id) or to resume an ongoing session.", {}, gameListOutput, async (_args, exec) => {
      const service = requireGamesService()
      // 无绑定的宿主（子代理等）也能看游戏清单——按任务语义「无 binding 只带
      // games」：不带任何聊天会话。
      let binding: BindingContext | null = null
      try {
        binding = await bindingFor(exec)
      } catch {
        binding = null
      }
      const { games, sessions } = binding === null
        ? { games: (await service.list({})).games, sessions: [] as GameSessionSummary[] }
        : await service.list({ character: binding.character, chatId: binding.chatId })
      return {
        games: games.map((game) => ({
          id: game.id,
          name: game.name,
          players: game.players,
          actionVocabulary: game.actionVocabulary,
          status: game.status,
          ...(game.status === 'ok' ? {} : { reason: game.reason }),
        })),
        sessions: sessions.map((session) => ({
          sessionId: session.id,
          gameName: session.gameName,
          ...turnBrief(session),
          finished: session.finished,
          moveCount: session.moveCount,
        })),
      }
    }),
    tool('game_start', 'Start a game session with the user, bound to this chat. The human plays one role and you (the Agent) play the other; role selects your side (default: the second role, so the human moves first). Returns the session identity (sessionId, gameName, players mapping role to owner, whose turn first) — the board is not included: read it with game_state when it is your turn to move. If the human moves first (the default), call game_wait right away to wait for their opening move.', {
      gameId: { type: 'string', required: true, description: 'Game id from game_list.' },
      role: { type: 'string', description: 'Role the Agent plays; defaults to the second role (human moves first).' },
    }, gameStartOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const gameId = stringArg(args.gameId)
      const manifest = await service.manifestOf(gameId)
      // 缺省 Agent 执 roles[1]（人类先手 roles[0]）；显式 role 时人类执另一方。
      let humanRole: string | undefined
      if (manifest.players.roles.length === 2) {
        const agentRole = args.role === undefined ? manifest.players.roles[1]! : stringArg(args.role)
        if (!manifest.players.roles.includes(agentRole)) {
          throw new Error(`game '${gameId}' roles are [${manifest.players.roles.join(', ')}]; cannot play '${agentRole}'`)
        }
        humanRole = manifest.players.roles.find((role) => role !== agentRole)!
      }
      const { session } = await service.start({
        gameId,
        character: binding.character,
        chatId: binding.chatId,
        humanRole,
      })
      await refreshAgentGamesSummaries(binding.character, binding.chatId)
      // 开局只回身份面：默认路径（人类先手）下一手是 game_wait，棋盘此刻没人
      // 需要——开局即回整盘棋盘是纯浪费（人类落子后经 game_state 读）。
      return {
        sessionId: session.id,
        gameName: session.gameName,
        players: session.players,
        ...turnBrief(session),
      }
    }),
    tool('game_state', 'Read the current position of a game session: state (the board), legal (suggested actions), whose turn (and whether it is yours), moveCount, finished with winner/summary. The move log is not included — read it with game_history. sessionId defaults to this chat\'s most recent active session.', {
      sessionId: { type: 'string', description: 'Session id; defaults to the most recent active session of this chat.' },
    }, gameStateOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const sessionId = args.sessionId === undefined
        ? await resolveActiveSession(service, binding)
        : stringArg(args.sessionId)
      const { session, view } = await service.state(sessionId)
      return {
        sessionId: session.id,
        gameName: session.gameName,
        ...turnBrief(session),
        moveCount: session.moveCount,
        finished: session.finished,
        ...terminalBrief(session),
        ...(session.orphaned ? { orphaned: true } : {}),
        state: view.state,
        legal: view.legal,
      }
    }),
    // game_history（2026-10-14 增量修订）：动作日志的唯一直读面。日志完整住在
    // 会话文件（可审计重放），这里只给窗口——from/limit 的钳制权威在会话端
    // （sessions.ts history()：limit 缺省 20、上限 200），工具只做整数形态检查。
    tool('game_history', 'Read the move log (interaction history) of a game session: each move as actor, action, describe (the narration text of that move). Returns the most recent `limit` moves by default; page with from (0-based index of the first returned move) and limit; moveCount is the total. The current position comes from game_state. sessionId defaults to this chat\'s most recent active session.', {
      sessionId: { type: 'string', description: 'Session id; defaults to the most recent active session of this chat.' },
      from: { type: 'integer', description: '0-based index of the first returned move; defaults to the start of the most recent limit moves.' },
      limit: { type: 'integer', description: 'Maximum number of moves to return, clamped to 1..200; default 20.' },
    }, gameHistoryOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const sessionId = args.sessionId === undefined
        ? await resolveActiveSession(service, binding)
        : stringArg(args.sessionId)
      const window = await service.history(sessionId, {
        ...(Number.isInteger(args.from) ? { from: args.from as number } : {}),
        ...(Number.isInteger(args.limit) ? { limit: args.limit as number } : {}),
      })
      return {
        sessionId: window.session.id,
        gameName: window.session.gameName,
        moveCount: window.session.moveCount,
        from: window.from,
        finished: window.session.finished,
        ...terminalBrief(window.session),
        moves: window.moves.map(moveBrief),
      }
    }),
    tool('game_move', 'Make your move in a game session. The actor is always the role to move and must be Agent-owned (otherwise the call fails and reports whose turn it is). action is the game action JSON (e.g. {type:"place",x:7,y:7}); {type:"resign"} resigns. Returns describe (the narration line to weave into your reply), whose turn is next, and finished with winner/summary when the game ended — the board is not echoed back; read it with game_state when you need the position. When it is the human turn next, call game_wait to block until they move (do not end your turn or ask them to send a chat message).', {
      sessionId: { type: 'string', description: 'Session id; defaults to the most recent active session of this chat.' },
      action: { type: 'object', required: true, description: 'Game action JSON with a type field, e.g. {type:"place",x:7,y:7}; {type:"resign"} resigns.' },
    }, gameMoveOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const action = args.action
      if (action === null || typeof action !== 'object' || Array.isArray(action)) throw new Error('action must be a JSON object')
      if (typeof (action as Record<string, unknown>).type !== 'string' || (action as Record<string, unknown>).type === '') {
        throw new Error('action requires a non-empty type field')
      }
      const sessionId = args.sessionId === undefined
        ? await resolveActiveSession(service, binding)
        : stringArg(args.sessionId)
      const outcome = await service.agentMove(sessionId, action as Record<string, unknown>)
      await refreshAgentGamesSummaries(binding.character, binding.chatId)
      // 增量面（2026-10-14 增量修订）：describe + 轮次 + 终局态——服务端
      // GameActionResult 的 view 保留给 HTTP 面，工具面「读归读、写归写」。
      return {
        sessionId: outcome.session.id,
        describe: outcome.describe,
        finished: outcome.session.finished,
        ...turnBrief(outcome.session),
        ...terminalBrief(outcome.session),
      }
    }),
    // game_wait（2026-10-14 修订；同日增量修订）：AgentLoop 的工具 Promise 即
    // 挂起面——本工具在自己回合内阻塞等人类在棋盘上落子，人类动作经
    // dsh-soulmojito:games-changed-listeners（跨 bundle）唤醒，Agent 同回合自动续弈，
    // 无需用户发消息触发。宿主无「游戏事件唤醒 agent」seam 的旧约束由此绕开：
    // 不是宿主推事件进来，而是 agent 自己挂起等事件。
    // 返回面只给**等待期增量**（newMoves + 轮次/终局态）：棋盘/日志按需经
    // game_state/game_history 读取——旧形态每手回吐全量日志，随对局线性膨胀。
    tool('game_wait', 'Block until the human player moves in a game session (they play on the on-screen board — no chat message from them is needed), until the game ends, or until the wait times out. Call it immediately whenever it becomes the human turn: right after game_start when the human moves first, and right after each of your own game_move calls. Returns only what changed while waiting: status (your-turn | finished | orphaned | timeout), newMoves (the moves that arrived during the wait — normally the human\'s move, with describe to narrate) and whose turn it is now; when the game ended, winner/summary. Read the position with game_state and the move log with game_history. status "timeout" means they have not moved yet — call game_wait again to keep waiting. When you need the board position to decide (complex boards), prefer game_wait_full: same wait, plus the board view in the return.', {
      sessionId: { type: 'string', description: 'Session id; defaults to the most recent active session of this chat.' },
      timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds, clamped to 1000..900000; default 300000 (5 minutes).' },
    }, gameWaitOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const sessionId = args.sessionId === undefined
        ? await resolveActiveSession(service, binding)
        : stringArg(args.sessionId)
      const timeoutMs = clampInt(args.timeoutMs, 1000, 900000, 300000)
      return await waitForHumanMove(service, sessionId, timeoutMs, exec.signal)
    }),

    // game_wait_full（2026-10-16）：同款阻塞等待 + 棋盘视图。真机会话实证
    // 「wait 返回后必跟一发 game_state」的双调用模式（重棋局上 describe 不足
    // 以决策）；轻量局上极简 wait 已是最优（模型不补读）——故不动 game_wait
    // 契约，按局选工具：需要局面决策的对局（地牢/大富翁/象棋）用本工具，
    // 等待返回自带 game_state 同款载荷，省一发往返。
    tool('game_wait_full', 'Same blocking wait as game_wait, plus the board: use it instead of game_wait when you need the current position to decide your move (complex boards — roguelike dungeons, property boards, chess). Blocks until the human player moves on the on-screen board, the game ends, or the wait times out. Returns status (your-turn | finished | orphaned | timeout), newMoves (the moves that arrived while waiting, with describe to narrate), whose turn it is now, and — when it is your turn or the game just ended — view: the current board payload (state + turn + legal suggestions + finished + summary), the same shape game_state returns; decide from it directly, no follow-up game_state call. status "timeout" means they have not moved yet — call game_wait_full again to keep waiting.', {
      sessionId: { type: 'string', description: 'Session id; defaults to the most recent active session of this chat.' },
      timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds, clamped to 1000..900000; default 300000 (5 minutes).' },
    }, gameWaitFullOutput, async (args, exec) => {
      const service = requireGamesService()
      const binding = await bindingFor(exec)
      const sessionId = args.sessionId === undefined
        ? await resolveActiveSession(service, binding)
        : stringArg(args.sessionId)
      const timeoutMs = clampInt(args.timeoutMs, 1000, 900000, 300000)
      return await waitForHumanMove(service, sessionId, timeoutMs, exec.signal, { includeView: true })
    }),
  ]
}

// 游戏桥七件的输出面（提案 0018 §4.2；2026-10-14 增量修订的 token 经济裁定；
// 2026-10-16 game_wait_full 附带棋盘视图）：
// 全部扁平、字段最小——身份面只在 game_start/game_list，回合载荷只带下一步
// 动作与叙述所需；state 对运行时不透明（引擎自定义，schema 不锁字段）。
const gameListOutput = objectOutput({
  games: { type: 'array', items: { type: 'object', additionalProperties: true } },
  sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const gameStartOutput = objectOutput({
  sessionId: { type: 'string' },
  gameName: { type: 'string' },
  players: { type: 'array', items: { type: 'object', additionalProperties: true } },
  turn: { type: 'string' },
  turnOwner: { type: 'string' },
})
const gameStateOutput = objectOutput(
  {
    sessionId: { type: 'string' },
    gameName: { type: 'string' },
    turn: { type: 'string' },
    turnOwner: { type: 'string' },
    moveCount: { type: 'integer' },
    finished: { type: 'boolean' },
    winner: {},
    summary: { type: 'string' },
    orphaned: { type: 'boolean' },
    state: {},
    legal: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  ['turn', 'turnOwner', 'winner', 'summary', 'orphaned'],
)
const gameHistoryOutput = objectOutput(
  {
    sessionId: { type: 'string' },
    gameName: { type: 'string' },
    moveCount: { type: 'integer' },
    from: { type: 'integer', description: '0-based index of the first returned move within the full log.' },
    finished: { type: 'boolean' },
    winner: {},
    summary: { type: 'string' },
    moves: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  ['winner', 'summary'],
)
const gameMoveOutput = objectOutput(
  {
    sessionId: { type: 'string' },
    describe: { type: 'string', description: 'Narration line for the move you just made.' },
    finished: { type: 'boolean' },
    turn: { type: 'string' },
    turnOwner: { type: 'string' },
    winner: {},
    summary: { type: 'string' },
  },
  ['turn', 'turnOwner', 'winner', 'summary'],
)
const gameWaitOutput = objectOutput(
  {
    status: { type: 'string', description: 'your-turn | finished | orphaned | timeout' },
    sessionId: { type: 'string' },
    newMoves: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Moves that arrived while waiting (normally the human move to narrate); empty on timeout or when it was already your turn.' },
    turn: { type: 'string' },
    turnOwner: { type: 'string' },
    winner: {},
    summary: { type: 'string' },
  },
  ['turn', 'turnOwner', 'winner', 'summary'],
)

// objectOutput 第二参是 optionalKeys（required = 属性键全集 − 可选表）——view 必须
// 进可选表：timeout/orphaned 路径有意不带棋盘（token 经济），若被判必填，宿主
// 的输出 schema 校验会整体拒收（2026-10-16 实弹：600000ms 等满超时路径报
// missing required property "value.view"）。
const gameWaitFullOutput = objectOutput(
  {
    status: { type: 'string', description: 'your-turn | finished | orphaned | timeout' },
    sessionId: { type: 'string' },
    newMoves: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Moves that arrived while waiting (normally the human move to narrate); empty on timeout or when it was already your turn.' },
    turn: { type: 'string' },
    turnOwner: { type: 'string' },
    winner: {},
    summary: { type: 'string' },
    view: { type: 'object', additionalProperties: true, description: 'Board payload (state + turn + legal + finished + summary, same as game_state) — present when status is your-turn or finished; omitted on timeout/orphaned (nothing changed).' },
  },
  ['turn', 'turnOwner', 'winner', 'summary', 'view'],
)

/**
 * 游戏服务句柄解析 seam（提案 0018 §4.2）：agent bundle 与 index bundle 无共享
 * 模块态，逐调用经 globalThis 句柄解析（src/games/handle.ts）。句柄缺失 = 
 * index bundle 未装载游戏运行时——明确报错而非静默空结果。测试经同一
 * globalThis 注册表注入假服务（publishGamesService）。
 */
function requireGamesService() {
  const service = resolveGamesService()
  if (service === undefined) throw new Error('游戏运行时不可用（index bundle 未装载游戏服务）')
  return service
}

/** game_state/game_history/game_move/game_wait 的缺省寻址：本聊天最近活跃会话；无会话时明确报文。 */
async function resolveActiveSession(
  service: ReturnType<typeof requireGamesService>,
  binding: BindingContext,
): Promise<string> {
  const sessionId = await service.latestActive(binding.character, binding.chatId)
  if (sessionId === undefined) {
    throw new Error('本聊天没有进行中的游戏对局：先用 game_list 查看可用游戏，再 game_start 开局')
  }
  return sessionId
}

/** game_wait 的唤醒节拍（毫秒）：onGamesChanged 事件驱动为主，1s tick 兜底
 *  （覆盖不经 emit 的外部改动，如手改会话文件）；二者都只是「可能变了」信号，
 *  循环每拍重读会话快照判定真伪。 */
const GAME_WAIT_TICK_MS = 1000

/** game_wait 增量窗口的条数：等待期真实增量恒 ≤1 手（任何一手都翻转回合、
 *  循环首读即返回），取会话端单窗口上限 200（sessions.ts 的权威 clamp）只作
 *  恒等上界——增量面不为任何情形静默截断。 */
const GAME_WAIT_DELTA_LIMIT = 200

/** 等「游戏可能变更」信号（事件/tick/中止），三路唤醒任何一路即返回。 */
function waitForGameSignal(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try {
        signal.throwIfAborted()
        resolve()
      } catch (cause) {
        reject(cause)
      }
      return
    }
    let settled = false
    let off: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => {}
    const finish = (aborted: boolean) => {
      if (settled) return
      settled = true
      off()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!aborted) {
        resolve()
        return
      }
      try {
        signal?.throwIfAborted()
        resolve()
      } catch (cause) {
        reject(cause)
      }
    }
    off = onGamesChanged(() => finish(false))
    timer = setTimeout(() => finish(false), ms)
    onAbort = () => finish(true)
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * 工具面回合载荷的投影助手（2026-10-14 用户裁定「游戏系统尽可能考虑 token
 * 经济性」）：回合载荷只带「下一步动作与叙述」所需——轮次（角色 + 归属）、
 * 终局结果、动作记录的精简形态；身份面（players/动作词汇表）只在
 * game_start/game_list 出现一次，会话时钟/聊天绑定/审计字段（move.at/summary）
 * 不进载荷（盘上记录原样完整）。
 */
function turnBrief(session: Pick<GameSessionSummary, 'turn' | 'players' | 'finished' | 'orphaned'>): Record<string, unknown> {
  // 终局/孤儿没有「轮到谁」——引擎 state.turn 停在最后一手，别把它读成下一手；
  // 模型以 finished/status/winner 判定局面（缺 owner 同理不给）。
  if (session.finished || session.orphaned || session.turn === '') return {}
  const owner = session.players.find((player) => player.role === session.turn)?.owner
  if (owner === undefined) return {}
  return { turn: session.turn, turnOwner: owner }
}

function terminalBrief(session: Pick<GameSessionSummary, 'finished' | 'winner' | 'summary'>): Record<string, unknown> {
  return session.finished ? { winner: session.winner, summary: session.summary } : {}
}

/** 动作记录的工具面投影：actor + action + describe 够叙述与复盘（at/summary 留在盘上）。 */
function moveBrief(move: GameMoveRecord): Record<string, unknown> {
  return { actor: move.actor, action: move.action, describe: move.describe }
}

/**
 * game_wait 主体（2026-10-14 修订；同日增量修订）：阻塞直到轮到 Agent /
 * 对局终局 / 孤儿 / 超时。每拍经 history() 读会话头 + 增量（只读，无副作用；
 * 首读只取会话头立 moveCount 基线——增量语义 =「等待期间到达的手」）。
 * 醒来返回**等待期增量**：newMoves（唤醒场景即人类刚落的那手，describe 供
 * 叙述；已在 agent 回合时恒空——落子前的局面经 game_state 读取）+ 轮次/终局态。
 * 用户停止生成时 exec.signal 中止——与其它工具的 throwIfAborted 同语义
 * （宿主结束本次运行）。
 */
async function waitForHumanMove(
  service: ReturnType<typeof requireGamesService>,
  sessionId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  options: { includeView: boolean } = { includeView: false },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let baseline: number | undefined
  // includeView（game_wait_full，2026-10-16）：your-turn / finished 时附带
  // game_state 同款棋盘视图（state + legal + 轮次/终局）——真机会话实证
  // 「wait 后必跟 game_state」的双调用模式，返回面自带视图即省一发往返。
  // timeout/orphaned 不带（局面未变，无决策可做）。
  const payload = async (status: string, session: GameSessionSummary, newMoves: GameMoveRecord[]): Promise<Record<string, unknown>> => ({
    status,
    sessionId,
    newMoves: newMoves.map(moveBrief),
    ...turnBrief(session),
    ...terminalBrief(session),
    ...(options.includeView && (status === 'your-turn' || status === 'finished')
      ? { view: (await service.state(sessionId)).view }
      : {}),
  })
  // 等待登记（2026-10-14 自动续弈修订）：index bundle 的人类落子入口据此判定
  // 「该手已由工具内唤醒覆盖」——挂起期间绝不重复 followup 唤起；返回/中止/
  // 抛错都必须注销（finally），否则后续人类落子会被误判为「有人在等」而静默
  // 不唤起。
  const releaseWait = beginGameWait(sessionId)
  try {
    for (;;) {
      signal?.throwIfAborted()
      const snapshot = await service.history(sessionId, baseline === undefined
        // 首读：只为会话头（moveCount 基线）——limit 1 的窗口内容不用。
        ? { limit: 1 }
        : { from: baseline, limit: GAME_WAIT_DELTA_LIMIT })
      const { session } = snapshot
      const newMoves = baseline === undefined ? [] : snapshot.moves
      if (baseline === undefined) baseline = session.moveCount
      if (session.finished) return await payload('finished', session, newMoves)
      if (session.orphaned) return await payload('orphaned', session, newMoves)
      const turnOwner = session.players.find((player) => player.role === session.turn)?.owner
      if (turnOwner === 'agent') return await payload('your-turn', session, newMoves)
      const remaining = deadline - Date.now()
      if (remaining <= 0) return await payload('timeout', session, newMoves)
      await waitForGameSignal(signal, Math.min(GAME_WAIT_TICK_MS, remaining))
    }
  } finally {
    releaseWait()
  }
}

/** 游戏对局摘要文本通道（提案 0018 §4.2 懒段，order -63）：与 guides/script
 *  同款 best-effort 异步装载——首次为某 agent 装配时异步读一次本聊天的活跃
 *  会话，装载完成前返回空串（段摘除，无对局零 token 消耗），失败静默留空。
 *  写穿两条：本 bundle 的 game_start/game_move 落子后即时刷新；index bundle
 *  的 HTTP 人类落子经 dsh-soulmojito:games-changed-listeners 跨 bundle 通知刷新
 *  （见文件底部的 onGamesChanged 订阅）。 */
const gamesSummaryProjection = createLazyProjection<string>({
  getState: async () => (await tavernStore()).getState(),
  load: async (agentId, settle) => {
    const db = await tavernStore()
    const state = await db.getState()
    const binding = state.sessionBindings[agentId]
    if (!binding || binding.architecture !== 'agent-tavern' || binding.group === true) return
    const service = resolveGamesService()
    if (service === undefined) return
    const { sessions } = await service.list({ character: binding.character, chatId: binding.chatId })
    const active = sessions.filter((session) => session.finished !== true && session.orphaned !== true)
    if (active.length === 0) {
      // 空串 settle（非留旧值）：终局/认输后的写穿刷新要把段**摘除**——懒段
      // 语义是「仅活跃会话时注入」，否则缓存会让已结束的对局一直占着 token。
      settle('')
      return
    }
    const lines = active.map((session) => {
      const turnOwner = session.players.find((player) => player.role === session.turn)?.owner
      const whose = turnOwner === 'agent' ? '你（Agent）' : '人类玩家'
      // 「你执 <角色>」在段里常驻（token 经济裁定下 players 映射不进回合载荷，
      // 角色归属由段携带——压缩/换上下文后不需工具补读）。
      const agentRole = session.players.find((player) => player.owner === 'agent')?.role
      return `- ${session.gameName}（sessionId ${session.id}）：${agentRole === undefined ? '' : `你执 ${agentRole}，`}轮到 ${session.turn}（${whose}）；动作词汇表：${session.actionVocabulary}`
    })
    const text = [
      '本聊天有进行中的游戏对局：',
      ...lines,
      '轮到你时先 game_state 读局面、再用 game_move 落子；落到人类回合立即调用 game_wait 阻塞等待对方在棋盘上落子（对方无需发送聊天消息；wait 只返回等待期增量——该手与轮次）。局面复杂、需要看着棋盘决策的对局改用 game_wait_full：同款等待，返回附带棋盘局面（state + legal），无需再跟发 game_state。工具返回后自动继续；describe/summary 文案可直接用于对话叙述这一手，往手用 game_history 查询。',
    ].join('\n')
    // 会话快照里的游戏名/词汇表是用户资产数据，可能含 {{...}}——与 facts/guides
    // 同款宏展开 + 宿主安全化（prompt-safety.ts）。
    const expand = createHostPromptExpander(binding.character, state.activePersona ?? DEFAULT_USER)
    settle(hostPromptSafe(text, expand))
  },
})

export function agentGamesText(agentId: string | undefined): string {
  return gamesSummaryProjection.valueOf(agentId) ?? ''
}

/** 写穿：本 bundle 的 game_start/game_move 成功后按 character/chatId 刷新对局摘要。 */
async function refreshAgentGamesSummaries(character: string, chatId: string): Promise<void> {
  await gamesSummaryProjection.refreshWhere((binding) =>
    binding.architecture === 'agent-tavern' && binding.character === character && binding.chatId === chatId)
}


export function refreshAllAgentGamesSummaries(): void {
  void gamesSummaryProjection.refreshWhere((binding) => binding.architecture === 'agent-tavern')
}