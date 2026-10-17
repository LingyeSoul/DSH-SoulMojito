import { confirmSessionAppend, hostSessionFormatVersion, readSessionEvents, sessionEvents } from '../../../bind/src/index.js'
import { createMessage } from '../message.js'
import { requestedArchitecture, requestedContextMode } from './binding.js'

export function occupyHostSession(agent, ctx?) {
  try {
    if (sessionEvents(agent.session).some((event) => event.type === 'turn/start')) return
    if (!canAdvanceHostTurnBase(agent)) return
    // D-2 confirmable write（决策 2026-10-11-confirmable-session-writes，逐条确
    // 认）：占位 turn 对是「必须成立」写入——基线推进依赖它在场，静默丢失会让
    // live 首轮重复/跳号，v4 准入判整个会话损坏。逐条读回验证 + 一次重写（缺席
    // 才重写，在场即停，append-only 日志不会重复轮号）；确认失败沿用既有降级：
    // 不推进基线、不阻断激活，宿主日志一行 error 可观测。
    const started = confirmSessionAppend({
      session: agent.session,
      logger: ctx?.logger,
      label: `session occupation turn/start (${agent.id})`,
      append: () => agent.session.append('turn/start', { turn: 1 }),
      present: (events) => events.some((event) => event.type === 'turn/start' && event.data?.turn === 1),
    })
    if (!started) return
    const ended = confirmSessionAppend({
      session: agent.session,
      logger: ctx?.logger,
      label: `session occupation turn/end (${agent.id})`,
      append: () => agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      present: (events) => events.some((event) => event.type === 'turn/end' && event.data?.turn === 1),
    })
    if (!ended) return
    advanceHostTurnBase(agent, 1)
  } catch {
    // 宿主拒绝插件追加 turn 事件时仅失去防复用保护，不阻断激活本身。
  }
}

/**
 * live loop 的轮次基线位于 `AgentLoop.phase.lastTurn`：构造函数从
 * `turnBoundary.lastTurn` 快照一次，此后只在每个 turn 结束时更新。插件写入 turn
 * 边界后必须把基线推到最后一个已写入的 turn，否则 loop 会重复轮号（v4 准入拒绝
 * `turn/start does not open the expected turn`，会话从此不可读）。
 *
 * 该字段不是宿主的公开 seam，因此只在确认「存在、idle、可写」时使用；探测失败时
 * 调用方必须放弃写入 turn 边界（见 canAdvanceHostTurnBase）。
 */
function loopPhase(agent) {
  const phase = agent?.phase
  return typeof phase === 'object' && phase !== null ? phase : undefined
}

/** 探测 live loop 的轮次基线是否可推进：phase 存在、idle、且字段可写。 */
export function canAdvanceHostTurnBase(agent) {
  const phase = loopPhase(agent)
  if (phase === undefined || phase.kind !== 'idle') return false
  if (!Number.isSafeInteger(phase.lastTurn)) return false
  // 回写同值：冻结对象 / 只读 getter 会让写入静默失败，这里提前发现。
  const before = phase.lastTurn
  try {
    phase.lastTurn = before
  } catch {
    return false
  }
  return phase.lastTurn === before
}

/** 把 live loop 的轮次基线推进到 turn（只增不减）。返回是否生效。 */
export function advanceHostTurnBase(agent, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) return false
  const phase = loopPhase(agent)
  if (phase === undefined || phase.kind !== 'idle') return false
  if (Number.isSafeInteger(phase.lastTurn) && phase.lastTurn >= turn) return true
  try {
    phase.lastTurn = turn
  } catch {
    return false
  }
  return phase.lastTurn === turn
}

/** 会话日志里已写入的最大 turn/start 轮号；没有 turn 边界时返回 undefined。 */
export function lastLoggedTurn(agent) {
  let last
  for (const event of sessionEvents(agent.session)) {
    if (event.type !== 'turn/start') continue
    const value = event.data?.turn
    if (Number.isSafeInteger(value) && (last === undefined || value > last)) last = value
  }
  return last
}

/**
 * 导入中断时兜底关闭仍然打开的 step/turn：无法确认宿主状态时以日志为准，
 * 否则半个导入会留下未关闭的 turn，live loop 的下一个 turn/start 会被准入拒绝。
 * 返回日志里已写入的最大轮号（供调用方推进基线）。
 */
export function closeImportBracket(agent, reason) {
  let openTurn
  let openStep
  for (const event of sessionEvents(agent.session)) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      openTurn = event.data.turn
      openStep = undefined
      continue
    }
    if (event.type === 'turn/end') { openTurn = undefined; openStep = undefined; continue }
    if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) {
      openStep = { turn: event.data.turn, step: event.data.step }
      continue
    }
    if (event.type === 'step/end') openStep = undefined
  }
  if (openStep !== undefined) {
    try {
      agent.session.append('step/end', { turn: openStep.turn, step: openStep.step })
    } catch {
      // 兜底关闭失败不再递归处理。
    }
  }
  if (openTurn !== undefined) {
    try {
      agent.session.append('turn/end', { turn: openTurn, reason })
    } catch {
      // 同上。
    }
  }
  return lastLoggedTurn(agent)
}

// Tavern generation runs outside the native agent loop. Mirror its durable
// boundaries into the host session so native projections (stats/token usage)
// observe the same work as the injected Tavern surface.
export function beginTavernSessionTurn(agent, userText) {
  const session = agent?.session
  if (!session?.append || readSessionEvents(session) === undefined) return null
  const logEvents = sessionEvents(session)
  let openTurn = false
  for (const event of logEvents) {
    if (event.type === 'turn/start') openTurn = true
    else if (event.type === 'turn/end') openTurn = false
  }
  if (openTurn) return null
  const turn = Math.max(0, ...logEvents
    .filter((event) => event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn))
    .map((event) => event.data.turn)) + 1
  let started = false
  try {
    session.append('turn/start', { turn })
    started = true
    if (userText.trim() !== '') {
      session.append('user/message', createMessage({
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    // agent 随 trace 走：ST 的 turn 闭合时要用它推进 live loop 轮次基线。
    return { session, turn, step: 1, stepOpen: false, turnOpen: true, logging: true, completed: false, agent }
  } catch {
    if (started) {
      try {
        session.append('turn/end', {
          turn,
          reason: { kind: 'error', error: { message: 'Tavern session trace failed', code: 'TAVERN_TRACE' } },
        })
        advanceHostTurnBase(agent, turn)
      } catch {
      }
    }
    return null
  }
}

export function startTavernSessionStep(trace) {
  if (!trace?.logging) return trace
  try {
    trace.session.append('step/start', { turn: trace.turn, step: trace.step })
    trace.stepOpen = true
  } catch {
    trace.logging = false
  }
  return trace
}

export function recordTavernSessionAssistant(trace, text, reasoning, provider, model, usage) {
  if (!trace?.logging || !trace.stepOpen) return trace
  try {
    const content = [{ type: 'text', text }]
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    const version = hostSessionFormatVersion(trace.session)
    trace.session.append('assistant/message', {
      turn: trace.turn,
      step: trace.step,
      message: createMessage({
        role: 'assistant',
        content,
        source: { kind: 'model', provider, model },
      }),
      ...(usage ? { usage } : {}),
      // v4 加载边界强制 settlement 形状（seed 校验无条件要求 data.stream 为数组，
      // 有 usage 也不豁免），缺失时 append 照常成功但会话重启即拒载；token-meter
      // 的 usageOf() 同样要求 usage/stream 至少一个，空流可保投影物化。v0-v3
      // 格式无此成员，多写反而毒化老宿主工件，故按版本分支。
      ...(version !== undefined && version >= 4 ? { stream: [] } : {}),
    }, { surfaceOp: 'append' })
    trace.completed = true
  } catch {
    trace.logging = false
  }
  return trace
}

export function finishTavernSessionTrace(trace) {
  if (!trace?.turnOpen) return
  if (trace.stepOpen) {
    try {
      trace.session.append('step/end', { turn: trace.turn, step: trace.step })
    } catch {
      // step/end 落不下去意味着 open step 仍留在日志里，其后任何 turn/end 都
      // 会被 v4 关系校验拒绝（"turn/end does not match the open turn with no
      // open step"）；「未关闭的尾巴」本身合法——宁可留下未关闭的 turn，也
      // 不追加注定拒载的事件。立即终止 trace。
      trace.stepOpen = false
      trace.turnOpen = false
      return
    }
    trace.stepOpen = false
  }
  try {
    trace.session.append('turn/end', {
      turn: trace.turn,
      reason: trace.completed
        ? { kind: 'completed' }
        : { kind: 'error', error: { message: 'Tavern generation failed', code: 'TAVERN_GENERATION' } },
    })
    // ST trace 的 turn 已闭合：推进 live loop 轮次基线。宿主 AgentLoop 的
    // phase.lastTurn 只在构造时快照、不重扫磁盘——ST 与原生 loop 混用的会话里
    // 不推进则 live 首轮会重复本轮号，v4 关系准入直接判会话损坏。
    if (trace.agent !== undefined) advanceHostTurnBase(trace.agent, trace.turn)
  } catch {
  }
  trace.turnOpen = false
}

export function normalizeChatId(name) {
  const stem = name.replace(/\.jsonl$/i, '').trim()
  if (stem === '') throw new Error('chat name is required')
  return `${stem}.jsonl`
}

export function parseTavernSessionCommand(rawInput) {
  const payload = rawInput.trim()
  if (payload === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (parsed.action === 'close') return { action: 'close' }
    // AgentNovel bridge (proposal 0005 §4.2): management commands ride the
    // existing internal bridge and are never registered as author directives.
    if (parsed.action === 'novel-open') {
      return typeof parsed.novelId === 'string' && parsed.novelId.trim() !== ''
        ? { action: 'novel-open', novelId: parsed.novelId }
        : null
    }
    // CardWorkbench bridge（提案 0013）：面板「新建角色卡」引导的写卡 Agent
    // 会话启动；sourceCharacter/sourceChatId 成对可选——聊天侧「交给工作台」
    // 携带来源聊天身份（每个聊天对应一个写卡工作会话），面板自由拉起不带。
    if (parsed.action === 'workbench-open') {
      const sourceCharacter = typeof parsed.sourceCharacter === 'string' ? parsed.sourceCharacter : ''
      const sourceChatId = typeof parsed.sourceChatId === 'string' ? parsed.sourceChatId : ''
      if ((sourceCharacter !== '') !== (sourceChatId !== '')) return null
      return { action: 'workbench-open', sourceCharacter, sourceChatId }
    }
    if (typeof parsed.character !== 'string' || typeof parsed.chatId !== 'string') return null
    const group = parsed.group === true
    const architecture = group ? 'st' : requestedArchitecture(parsed.architecture)
    return {
      action: 'open',
      character: parsed.character,
      chatId: parsed.chatId,
      group,
      architecture,
      contextMode: requestedContextMode(parsed.contextMode),
    }
  } catch {
    return null
  }
}
